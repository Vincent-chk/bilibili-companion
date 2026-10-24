// P1.6 · 豆包 DOM 模块：五表情状态机（切图+CSS 动画）、气泡（打字机+自动消失，
// 后到覆盖的原型队列语义）、拖拽（pointer events，视口相对坐标持久化）、点击开合面板。
// 素材：public/mascot/mascot-<state>.png（预加载防切图闪白）。依赖注入便于单测。
import type { DoubaoUi } from '../ui/root';
import {
  BUBBLE_MS,
  IDLE_DIM_MS,
  bubbleThrottled,
  clampMascotPos,
  defaultMascotPos,
  fromRelative,
  isDragMoved,
  isTypingTarget,
  mascotStateForSession,
  snapToEdge,
  toRelative,
  typeDelay,
  type MascotState,
  type UiSessionState,
} from './logic';

export interface MascotStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface MascotDeps {
  ui: DoubaoUi;
  assetUrl: (path: string) => string;
  storage: MascotStorage;
  /** 激活中（ACTIVE）点击身体 → 开合面板；未激活点击/「开始陪看」→ 走激活流程（onboarding 门槛在 content 侧）。 */
  onBodyClickActive: () => void;
  onStartClick: () => void;
  /** 气泡开关（settings.bubbles，F3：设置关闭后不再出现）。 */
  bubblesEnabled: () => Promise<boolean>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
}

const STATES: MascotState[] = ['idle', 'happy', 'thinking', 'note', 'sleep'];

export class MascotController {
  #state: MascotState = 'idle';
  #session: UiSessionState = 'INACTIVE';
  /** P2.5：隐藏豆包（本次会话）——content 内存态，不落盘。 */
  #hidden = false;
  #typeTimer: ReturnType<typeof setInterval> | null = null;
  #hideTimer: unknown = null;
  #pulseTimer: unknown = null;
  /** P1.9 准则#1：闲时半透明计时；#4：同 kind 气泡限频记录。 */
  #idleTimer: unknown = null;
  #snapTimer: unknown = null;
  readonly #lastKindAt = new Map<string, number>();
  readonly #el: {
    wrap: HTMLElement;
    mascot: HTMLElement;
    img: HTMLImageElement;
    bubble: HTMLElement;
  };
  readonly #timers: {
    setTimeout: (cb: () => void, ms?: number) => unknown;
    clearTimeout: (t: unknown) => void;
    clearInterval: (t: ReturnType<typeof setInterval>) => void;
  };

  constructor(private readonly deps: MascotDeps) {
    const { root } = deps.ui;
    const wrap = root.getElementById('mascot-wrap');
    const mascot = root.getElementById('mascot');
    const img = root.querySelector<HTMLImageElement>('#mascot-img');
    const bubble = root.getElementById('mascot-bubble');
    if (!wrap || !mascot || !img || !bubble) throw new Error('mascot 容器未挂载');
    this.#el = { wrap, mascot, img, bubble };
    this.#timers = {
      setTimeout: deps.setTimeout ?? ((cb: () => void, ms?: number) => setTimeout(cb, ms)),
      clearTimeout: (t) => (deps.clearTimeout ?? clearTimeout)(t as Parameters<typeof clearTimeout>[0]),
      clearInterval: deps.clearInterval ?? ((t) => clearInterval(t)),
    };
    // 预加载五态图（切换不闪白，原型同款）
    for (const s of STATES) {
      const pre = root.ownerDocument.createElement('img');
      pre.src = deps.assetUrl(`/mascot/mascot-${s}.png`);
    }
    wrap.classList.remove('hidden');
    img.src = deps.assetUrl(`/mascot/mascot-idle.png`);
    // 同步先落默认位，异步 storage 覆盖（避免 fixed 静态位闪一帧再跳位——审查 P2）
    this.#applyPos(defaultMascotPos(this.#viewport().vw, this.#viewport().vh));
    void this.#restorePos();
    this.#bindDrag();
    // P1.9 准则#1：hover/按压即恢复全透明并重计闲时
    wrap.addEventListener('pointerenter', () => this.#wake());
    wrap.addEventListener('pointerdown', () => this.#wake());
    this.#armIdle();
  }

  /** 准则#1：任何「豆包在活动/被交互」的信号都唤醒（去半透明）并重计闲时计时。 */
  #wake(): void {
    this.#el.wrap.classList.remove('idle-dim');
    this.#armIdle();
    // 审查 P2-3：常驻开始 CTA 曾被输入聚焦抑制且未再触发 → 唤醒时补一次（INACTIVE 且气泡空）
    if (this.#session === 'INACTIVE' && this.#el.bubble.classList.contains('hidden')) this.showStartBubble();
  }

  #armIdle(): void {
    if (this.#idleTimer !== null) this.#timers.clearTimeout(this.#idleTimer);
    this.#idleTimer = this.#timers.setTimeout(() => {
      this.#idleTimer = null;
      // 审查 P2-4：气泡展示中不降透明（用户正在读的通知不该自己变淡），改重计等气泡消失
      if (!this.#el.bubble.classList.contains('hidden')) {
        this.#armIdle();
        return;
      }
      this.#el.wrap.classList.add('idle-dim');
    }, IDLE_DIM_MS);
  }

  #viewport(): { vw: number; vh: number } {
    const v = this.deps.ui.root.ownerDocument.defaultView;
    return { vw: v?.innerWidth ?? 1440, vh: v?.innerHeight ?? 900 };
  }

  /** 表情切换：换 class（CSS 动画）+ 换图。 */
  setState(st: MascotState): void {
    this.#state = st;
    this.#el.mascot.className = `st-${st}`;
    this.#el.img.src = this.deps.assetUrl(`/mascot/mascot-${st}.png`);
  }

  get state(): MascotState {
    return this.#state;
  }

  get session(): UiSessionState {
    return this.#session;
  }

  /** 会话态变化驱动：GRACE/关闭 → sleep；INACTIVE → idle + 常驻「开始陪看」气泡（F1）。 */
  setSessionState(session: UiSessionState): void {
    this.#session = session;
    if (session === 'ACTIVE') {
      // 激活/恢复：happy 弹跳 + 气泡，随后回落 idle（原型 activate/resumeSession 语义）
      this.pulse('happy');
      void this.say('开始陪看！我会偷偷记笔记的～', 4200);
      return;
    }
    const st = mascotStateForSession(session); // INACTIVE→idle / GRACE·过期·关闭→sleep
    if (st) this.setState(st);
    if (session === 'INACTIVE') this.showStartBubble();
    else void this.say('那我先睡一觉…数据帮你留着哦 zZ', 4200);
  }

  /**
   * P2.5 准则#6 可消失性：「隐藏豆包（本次会话）」开关（content 内存，不落盘）。
   * 隐藏≠结束会话：观看计时/生成照常；气泡与表情一并静默；解除途径=设置关闭开关/
   * 页面刷新（内存态自然回归）/会话回到 INACTIVE（自动解除，激活入口必须可见）。
   */
  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
    this.#el.wrap.classList.toggle('hidden', hidden);
    if (hidden) this.hideBubble();
    else if (this.#session === 'INACTIVE') this.showStartBubble(); // 解除隐藏即恢复激活入口
  }

  get hidden(): boolean {
    return this.#hidden;
  }

  /** 瞬时表情：切到 st 并在 ms 后回落 idle（happy/note 等事件表情，原型同款节奏）。
   *  回落句柄独立于气泡定时器（say 打断不应取消 happy→idle 回落），但同表情连发时清旧防提前回落。 */
  pulse(st: MascotState, ms = 4200): void {
    if (this.#pulseTimer !== null) this.#timers.clearTimeout(this.#pulseTimer);
    this.setState(st);
    this.#wake(); // 准则#1：豆包有动作=非闲时
    this.#pulseTimer = this.#timers.setTimeout(() => {
      this.#pulseTimer = null;
      if (this.#state === st) this.setState('idle');
    }, ms);
  }

  /**
   * 气泡（打字机 + 自动消失）。队列语义=后到覆盖（原型 mascotSay：新消息打断旧消息），
   * 常驻气泡（开始陪看）与普通气泡互斥。settings.bubbles=false 时静默跳过（F3）。
   * P1.9 准则#3：页面输入框聚焦时不弹；准则#4：同 kind（事件类气泡）10min 限频——
   * kind 缺省=用户动作直接后果（开始/结束/恢复），不限频。
   */
  async say(text: string, ms = BUBBLE_MS, kind?: string): Promise<void> {
    if (this.#hidden) return; // P2.5：隐藏豆包期间气泡静默（计时/生成不受影响）
    if (!(await this.deps.bubblesEnabled())) return;
    if (isTypingTarget(this.deps.ui.root.ownerDocument.activeElement as never)) return;
    if (kind) {
      const now = Date.now();
      if (bubbleThrottled(this.#lastKindAt.get(kind), now)) return;
      this.#lastKindAt.set(kind, now);
    }
    this.#wake();
    this.#stopTimers();
    const b = this.#el.bubble;
    b.classList.remove('hidden');
    b.innerHTML = '';
    const caret = this.deps.ui.root.ownerDocument.createElement('span');
    caret.className = 'caret';
    b.appendChild(caret);
    let i = 0;
    const per = typeDelay(text, Math.min(1200, text.length * 55)); // 原型 typeText 节奏（6–40ms 钳位）
    const timer = setInterval(() => {
      i++;
      b.textContent = text.slice(0, i);
      b.appendChild(caret);
      if (i >= text.length) {
        this.#timers.clearInterval(timer);
        this.#typeTimer = null;
      }
    }, per);
    this.#typeTimer = timer;
    this.#hideTimer = this.#timers.setTimeout(() => {
      this.hideBubble();
    }, ms);
  }

  /** 常驻「开始陪看」按钮气泡（未激活态，F1）。准则#3 输入聚焦不弹；准则#4 以 kind='start' 限频（重连回放不轰炸）。 */
  showStartBubble(): void {
    if (this.#hidden) return; // P2.5：隐藏期间不弹常驻 CTA
    if (isTypingTarget(this.deps.ui.root.ownerDocument.activeElement as never)) return;
    const now = Date.now();
    if (bubbleThrottled(this.#lastKindAt.get('start'), now)) return;
    this.#lastKindAt.set('start', now);
    this.#wake();
    this.#stopTimers();
    const b = this.#el.bubble;
    b.classList.remove('hidden');
    b.innerHTML = '要我陪你一起看吗？<br><button class="bubble-btn" id="btn-start">▶ 开始陪看</button>';
    b.querySelector('#btn-start')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.deps.onStartClick();
    });
  }

  hideBubble(): void {
    this.#stopTimers();
    this.#el.bubble.classList.add('hidden');
    this.#el.bubble.innerHTML = '';
  }

  #stopTimers(): void {
    if (this.#typeTimer) this.#timers.clearInterval(this.#typeTimer);
    if (this.#hideTimer !== null) this.#timers.clearTimeout(this.#hideTimer);
    this.#typeTimer = null;
    this.#hideTimer = null;
  }

  // ---- 位置与拖拽 ----

  async #restorePos(): Promise<void> {
    const saved = await this.deps.storage.get<{ x: number; y: number }>('mascotPos');
    const { vw, vh } = this.#viewport();
    const pos = saved ? fromRelative(saved, vw, vh) : defaultMascotPos(vw, vh);
    this.#applyPos(pos);
  }

  #applyPos(p: { x: number; y: number }): void {
    this.#el.wrap.style.left = `${p.x}px`;
    this.#el.wrap.style.top = `${p.y}px`;
  }

  get position(): { x: number; y: number } {
    return { x: this.#el.wrap.offsetLeft, y: this.#el.wrap.offsetTop };
  }

  #bindDrag(): void {
    const doc = this.deps.ui.root.ownerDocument;
    let dragging = false;
    let moved = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;

    const onDown = (e: PointerEvent): void => {
      dragging = true;
      moved = false;
      sx = e.clientX;
      sy = e.clientY;
      ox = this.#el.wrap.offsetLeft;
      oy = this.#el.wrap.offsetTop;
      e.preventDefault();
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (isDragMoved(dx, dy)) moved = true;
      const { vw, vh } = this.#viewport();
      this.#applyPos(clampMascotPos(ox + dx, oy + dy, vw, vh));
    };
    let lastPointerClickAt = 0;
    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      // 无论 moved 与否，原生 click 都会随后派发（pointerdown 的 preventDefault 不抑制 click）
      // ——凡源自 pointer 的 up 一律先记时间戳，click 兜底据此去重，防拖拽结束误触发
      lastPointerClickAt = Date.now();
      if (moved) {
        const { vw, vh } = this.#viewport();
        // 准则#1 贴边收起：松手吸附最近横边（.snapping 给 200ms 过渡），落盘吸附后坐标
        const snapped = snapToEdge(this.#el.wrap.offsetLeft, this.#el.wrap.offsetTop, vw, vh);
        this.#el.wrap.classList.add('snapping');
        this.#applyPos(snapped);
        if (this.#snapTimer !== null) this.#timers.clearTimeout(this.#snapTimer);
        this.#snapTimer = this.#timers.setTimeout(() => {
          this.#snapTimer = null;
          this.#el.wrap.classList.remove('snapping');
        }, 250);
        void this.deps.storage.set('mascotPos', toRelative(snapped.x, snapped.y, vw, vh));
        this.#wake();
      } else {
        this.#onClick();
      }
    };

    this.#el.mascot.addEventListener('pointerdown', onDown as EventListener);
    doc.addEventListener('pointermove', onMove as EventListener);
    doc.addEventListener('pointerup', onUp as EventListener);
    // 合成激活兜底：element.click() / 键盘触发不产生 pointer 事件（自动化与无障碍路径）；
    // 真鼠标路径在 pointerup 已处理并随后派发 click——400ms 内去重防双触发
    this.#el.mascot.addEventListener('click', () => {
      if (Date.now() - lastPointerClickAt < 400) return;
      this.#onClick();
    });
  }

  /** 点击路由：未激活 → 激活流程；激活/保留期/超期待确认 → 开合面板（F3：单击 ≤300ms，拖拽不误触）。
   *  P2.1：EXPIRED_PENDING_CONFIRM 也走面板——数据处置（清除确认弹窗）在面板里，点身体必须可达。 */
  #onClick(): void {
    if (this.#session !== 'INACTIVE') this.deps.onBodyClickActive();
    else this.deps.onStartClick();
  }
}
