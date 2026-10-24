// P1.5 · 陪看面板（content script Shadow DOM 内，原型 renderList/renderDetail 移植）：
// 列表（封面/进度/五态徽章）· 详情（摘要流式/大纲/豆包说/转写节选）· 空态。
// 数据：LIST_QUERY（列表快照）/ SUMMARY_OPEN（按需生成或取缓存 + 详情载荷）；
// 推送：SUMMARY_PROGRESS(deltaText 流式打字) / SUMMARY_DONE|FAILED|NEED_ASR|UPDATED（终态刷新）。
// 大纲/转写行点击 seek 已于 1.8 接入（SEEK_TO，onSeek 依赖）；【重新生成】已于 2.7a 接入
// （REGENERATE → force 覆盖；人设切换联动询问属 2.5 设置页 = 2.7b）。
import { browser } from 'wxt/browser';
import type { Bridge, UiEvent } from '../bridge';
import { LOGIN_CARD_TEXT, shouldShowLoginCard } from '../login';
import { estimateAudioBytes } from '../../lib/asr';
import { esc, toast, type DoubaoUi } from '../ui/root';
import {
  BADGE_HTML,
  SOURCE_LABEL,
  STAGE_LABEL,
  clockOf,
  excerptOf,
  extractStreamingSummary,
  fmtCountdown,
  fmtSec,
  isJobActive,
  relativeTimeLabel,
  sortListItems,
  starsHtml,
  toListItemVM,
  type ListQueryItem,
  type ListItemVM,
  type SummaryOpenResponse,
  type TranscriptExcerpt,
} from './view-models';
import { renderSettingsView, type SaveResult, type SettingsData } from './settings';

export interface ListQueryResponse {
  ok: boolean;
  items: ListQueryItem[];
  sessionState: string;
  /** P2.1：GRACE 倒计时数据（面板打开时经 LIST_QUERY 静默判定后的最新值）。 */
  closedAt?: number;
  retainUntil?: number;
  triggerSeconds: number;
  /** P2.5：「暂停陪看」总开关（状态行提示与设置开关数据源）。 */
  paused?: boolean;
  loggedIn: boolean | null; // P1.10 引导卡数据源（SW 30s 缓存）
}

/** P1.11 F13 分段解读注记视图模型（与 storage.SegmentNote 同形）。 */
export interface SegNoteVM {
  text: string;
  status: 'streaming' | 'done' | 'failed';
  error?: { code: string; msg: string };
  truncated?: boolean;
}

export interface PanelDeps {
  ui: DoubaoUi;
  bridge: Bridge;
  /** 会话操作（P1.6）：开始/恢复 与 结束——流程由 content 侧持有（含 onboarding 门槛）。 */
  onSessionStart: () => void;
  onSessionEnd: () => void;
  /** 大纲/转写条目点击 → 播放器 seek（P1.8；同页/跨标签页路由在 content 侧）。 */
  onSeek: (videoKey: string, timeSec: number) => void;
  /** P2.3 F6-③：未配置 ASR 时点【调用 ASR 解析】→ 打开 onboarding 的 ASR 补配模式（content 侧持有弹窗流程）。 */
  onNeedAsrConfig: () => void;
  /** P2.5/2.7b：本页当前视频（人设切换联动询问的对象）；隐藏豆包开关（content 内存态）。 */
  getCurrentVideoKey?: () => string | null;
  mascotHidden?: () => boolean;
  onMascotHiddenChange?: (hidden: boolean) => void;
  /** 测试可注入的定时器。 */
  setTimeout?: typeof setTimeout;
}

export class PanelController {
  #open = false;
  #view: 'list' | 'detail' | 'settings' = 'list';
  #detailKey: string | null = null;
  #items: ListItemVM[] = [];
  #triggerSeconds = 20;
  #sessionState = 'INACTIVE';
  /** P2.5：暂停陪看（状态行提示）。 */
  #paused = false;
  /** 当前详情的流式累计（LLM 原始 JSON token 流）。 */
  #stream: { videoKey: string; acc: string; stage?: string } | null = null;
  #refreshTimer: unknown = null;
  /** 路由代数：followVideo 递增，作废在途 #openDetail 应答（审查 P2-5）。 */
  #routeGen = 0;
  /** P1.10 登录态（null=未知）：引导卡显隐依据。 */
  #loggedIn: boolean | null = null;
  /** P1.11 F13：分段解读注记视图状态（segIndex → 流式/成品/失败）与展开集合。 */
  #segNotes = new Map<number, SegNoteVM>();
  #segOpen = new Set<number>();
  /** P2.1：保留截止时刻（GRACE 倒计时数据源；来自 LIST_QUERY 应答/SESSION_STATE 广播）。 */
  #retainUntil: number | null = null;
  /** P2.1：倒计时 1s 滴答句柄（面板开且 GRACE 态才跑，递归 setTimeout 链）。 */
  #cdTimer: unknown = null;
  /** P2.2：本次面板打开是否已弹过超期清除确认（F10-④「稍后提醒」= 本开口内不再打扰，重开再弹）。 */
  #expiredPrompted = false;

  readonly #setTimeout: (cb: () => void, ms?: number) => unknown;

  constructor(private readonly deps: PanelDeps) {
    this.#setTimeout =
      deps.setTimeout ?? ((cb: () => void, ms?: number) => {
        setTimeout(cb, ms);
      });
    deps.ui.root.ownerDocument.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.#open) return;
      const modalRoot = this.deps.ui.root.getElementById('modal-root');
      // P2.5（P2.2 审查 N-1 收口）：可取消的二级确认弹窗 Esc=取消（原型 showModal 口径）；
      // 超期清除确认（expired-confirm）不可 Esc——F10 必须显式二选一
      if (modalRoot?.classList.contains('show')) {
        if (modalRoot.dataset.owner === 'manual-wipe' || modalRoot.dataset.owner === 'llm-clear' || modalRoot.dataset.owner === 'persona-regen') {
          modalRoot.classList.remove('show');
          modalRoot.replaceChildren();
          delete modalRoot.dataset.owner;
        }
        return;
      }
      this.close();
    });
    // P2.5：面板头部齿轮 → 设置视图（原型 #btn-settings）
    deps.ui.root.getElementById('btn-settings')?.addEventListener('click', () => {
      if (this.#open) void this.#showSettings();
    });
  }

  #modalShown(): boolean {
    return this.deps.ui.root.getElementById('modal-root')?.classList.contains('show') ?? false;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  open(): void {
    this.#open = true;
    this.#expiredPrompted = false; // P2.2：每次打开面板重置——「稍后提醒」后重开面板要再弹（F10-④）
    this.deps.ui.root.getElementById('panel')?.classList.add('open');
    // P1.10 时机②：面板打开强制复核登录态（绕 SW 30s 缓存；翻转经 LOGIN_STATE 广播回卡）
    void this.deps.bridge
      .request<{ ok: boolean; loggedIn: boolean | null }>({ type: 'LOGIN_CHECK', force: 1 })
      .then((r) => {
        if (r?.ok) this.setLoginState(r.loggedIn);
      })
      .catch(() => {});
    void this.refresh();
  }

  close(): void {
    this.#open = false;
    this.#stopCountdown(); // P2.1：面板关=倒计时停（数据保留判定在 SW，与面板无关）
    this.deps.ui.root.getElementById('panel')?.classList.remove('open');
    // 审查 P1-2：设置视图开着时关面板——重开会滞留陈旧设置 DOM；复位回列表（open() 自会 refresh）
    if (this.#view === 'settings') {
      this.#view = 'list';
      this.deps.ui.root.getElementById('view-settings')?.classList.add('hidden');
      this.deps.ui.root.getElementById('view-list')?.classList.remove('hidden');
    }
  }

  /** P1.10：登录态 → 面板顶部引导卡显隐。null=未知态：保持上一确定态（审查 P1-2——
   *  SW 重启缓存清空/风控窗口回 null 不得吃掉已确认的未登录态而隐藏引导卡）。 */
  setLoginState(loggedIn: boolean | null | undefined): void {
    const v = loggedIn ?? null;
    if (v === null) return;
    if (v === this.#loggedIn) return;
    this.#loggedIn = v;
    this.#renderLoginCard();
  }

  #renderLoginCard(): void {
    const card = this.deps.ui.root.getElementById('login-card');
    if (!card) return;
    if (!shouldShowLoginCard(this.#loggedIn)) {
      card.classList.add('hidden');
      card.innerHTML = '';
      return;
    }
    card.classList.remove('hidden');
    card.innerHTML = `<b>⚠ ${esc(LOGIN_CARD_TEXT.title)}</b><span>${esc(LOGIN_CARD_TEXT.desc)}</span><button class="btn btn-primary" id="btn-login">${esc(LOGIN_CARD_TEXT.button)}</button>`;
    card.querySelector('#btn-login')?.addEventListener('click', () => {
      window.open(LOGIN_CARD_TEXT.url, '_blank'); // 用户手势内新开标签页到 B 站登录页
    });
  }

  /**
   * P1.9 准则#5 上下文自动跟随：SPA 切视频后若面板开着，刷新为当前视频卡片。
   * 详情态且目标变化 → 回列表刷新（新视频置顶）；不自动开详情/不触发生成（零副作用跟随）。
   */
  followVideo(videoKey: string): void {
    if (!this.#open || !videoKey) return;
    this.#routeGen += 1; // 作废在途 #openDetail 应答（审查 P2-5 竞态）
    if (this.#view === 'detail' && this.#detailKey !== videoKey) {
      this.#view = 'list';
      this.#detailKey = null;
      this.#stream = null;
    }
    void this.refresh();
  }

  /** LIST_QUERY → 渲染当前视图。 */
  async refresh(): Promise<void> {
    try {
      const r = await this.deps.bridge.request<ListQueryResponse>({ type: 'LIST_QUERY' });
      if (!r?.ok) return;
      this.#items = sortListItems((r.items ?? []).map(toListItemVM));
      this.#sessionState = r.sessionState ?? 'INACTIVE';
      this.#retainUntil = r.retainUntil ?? null; // P2.1 倒计时（应答经 SW 静默判定后的最新值）
      this.#triggerSeconds = r.triggerSeconds ?? 20;
      this.#paused = r.paused === true; // P2.5：状态行「已暂停」提示
      this.setLoginState(r.loggedIn ?? null); // P1.10 引导卡（SW 缓存值；强制复核在 open()）
      this.#renderStatus();
      if (this.#view === 'list') this.#renderList();
      // P2.2 F10-②：超期待确认 → 打开面板即弹清除确认（本次开口只弹一次；「稍后提醒」重开再弹）
      if (
        this.#open &&
        this.#sessionState === 'EXPIRED_PENDING_CONFIRM' &&
        !this.#expiredPrompted &&
        !this.#modalShown()
      ) {
        this.#expiredPrompted = true;
        this.#showWipeModal('expired');
      }
    } catch {
      /* SW 未就绪等瞬时错误：面板下次打开/事件到达时再刷 */
    }
  }

  // ---- P2.5 · 设置视图（齿轮入口；数据=SETTINGS_GET，Key 打码） ----------------------

  /** 打开设置：取 SETTINGS_GET 渲染；列表/详情容器隐藏（返回时恢复）。 */
  async #showSettings(): Promise<void> {
    try {
      const data = await this.deps.bridge.request<SettingsData>({ type: 'SETTINGS_GET' });
      if (!data?.ok) {
        toast(this.deps.ui, '设置加载失败，稍后再试');
        return;
      }
      this.#view = 'settings';
      this.#stream = null;
      this.deps.ui.root.getElementById('view-list')?.classList.add('hidden');
      const box = this.deps.ui.root.getElementById('view-settings');
      box?.classList.remove('hidden');
      renderSettingsView({
        ui: this.deps.ui,
        bridge: this.deps.bridge,
        data,
        mascotHidden: this.deps.mascotHidden?.() ?? false,
        onBack: () => this.#backToList(),
        onSaved: (r) => void this.#onSettingsSaved(r),
        onWipe: () => this.#showWipeModal('manual'),
        onMascotHiddenChange: (h) => this.deps.onMascotHiddenChange?.(h),
      });
    } catch {
      toast(this.deps.ui, '设置加载失败，稍后再试');
    }
  }

  /** 设置保存成功：刷新（状态行「已暂停」/列表徽章都要新数据）；人设切换 → 2.7b 联动询问；
   *  LLM 清除 → 收口提示。E2E 实测教训：不刷新会拿旧 #items（need_asr 期徽章）误判联动条件。 */
  async #onSettingsSaved(r: SaveResult): Promise<void> {
    if (r.llmCleared) {
      toast(this.deps.ui, 'LLM 配置已清除，重新配置后可继续陪看', 3200);
      await this.refresh();
      if (this.#view === 'settings') await this.#showSettings(); // 审查 P2-1：重渲染防陈旧打码 Key 再保存
      return;
    }
    await this.refresh(); // 刷新 #items/#paused（persona 联动与状态行依据；设置视图 DOM 不动）
    if (r.personaChanged) {
      // 2.7b（F8「切换后【重新生成】」）：当前视频已有点评 → 询问是否立即用新人设重生成；
      // 不静默重跑（成本护栏）；无当前视频/无点评 → 仅提示后续生效
      const cur = this.deps.getCurrentVideoKey?.() ?? null;
      const item = cur ? this.#items.find((i) => i.videoKey === cur) : undefined;
      if (cur && item && item.badge === 'summarized') {
        this.#showPersonaRegenPrompt(cur);
        return;
      }
      toast(this.deps.ui, '人设已切换，之后的点评将使用新人设');
    }
  }

  /** 2.7b：人设切换联动询问弹窗（确认=跳当前视频详情并发起 REGENERATE=2.7a 链路）。 */
  #showPersonaRegenPrompt(videoKey: string): void {
    const root = this.deps.ui.root;
    const modalRoot = root.getElementById('modal-root');
    if (!modalRoot) return;
    modalRoot.dataset.owner = 'persona-regen';
    const m = root.ownerDocument.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      `<div class="modal-head"><div class="m-emoji"><img src="${browser.runtime.getURL('/mascot/mascot-happy.png')}" alt="豆包" style="width:52px;height:52px;border-radius:12px;display:block"></div>` +
      `<div><h2>用新人设重新生成本视频的点评？</h2><p>当前视频已有旧人设的点评。摘要内容保持客观不变，点评会按新人设重写。</p></div></div>` +
      `<div class="modal-foot"><button class="btn btn-ghost" id="pr-no">暂不</button>` +
      `<button class="btn btn-primary" id="pr-yes">重新生成</button></div>`;
    modalRoot.replaceChildren(m);
    modalRoot.classList.add('show');
    const close = () => {
      modalRoot.classList.remove('show');
      modalRoot.replaceChildren();
      delete modalRoot.dataset.owner;
    };
    m.querySelector('#pr-no')?.addEventListener('click', close);
    m.querySelector('#pr-yes')?.addEventListener('click', () => {
      close();
      void this.#regenAfterPersonaSwitch(videoKey);
    });
  }

  async #regenAfterPersonaSwitch(videoKey: string): Promise<void> {
    await this.#openDetail(videoKey); // 回详情（#detailKey 就位）
    await this.#onRegenerate(); // 2.7a 链路：force 重跑（新 persona 随 job 下发）
  }


  #renderStatus(): void {
    const el = this.deps.ui.root.getElementById('p-status');
    const acts = this.deps.ui.root.getElementById('p-head-actions');
    if (!el) return;
    acts?.classList.toggle('hidden', false);
    this.#stopCountdown();
    if (this.#sessionState === 'ACTIVE') {
      // F1-③：激活期状态行的保留期「占位」——倒计时本体在 GRACE 态（结束后起算），此处预告规则
      el.innerHTML = '<span class="dot-live"></span> 陪看中 · 仅记录激活期间的视频 · 结束后保留 1 小时';
      this.#renderActions(acts, '<button class="btn btn-ghost" id="btn-end" style="flex:1">⏻ 结束陪看</button>', () =>
        this.deps.onSessionEnd(),
      );
    } else if (this.#sessionState === 'GRACE') {
      // P2.1 F10：倒计时续算（retainUntil 来自持久化 closedAt+1h，与刷新/重开无关）
      const ru = this.#retainUntil;
      el.innerHTML =
        ru !== null
          ? `<span class="countdown-pill">⏳ 本次陪看数据保留至 ${clockOf(ru)}（<b id="cd">${fmtCountdown(ru - Date.now())}</b>）</span>`
          : '<span class="countdown-pill">⏳ 陪看已结束 · 数据保留中</span>';
      this.#startCountdown();
      this.#renderActions(acts, '<button class="btn btn-primary" id="btn-resume" style="flex:1">▶ 恢复陪看</button>', () =>
        this.deps.onSessionStart(),
      );
    } else if (this.#sessionState === 'EXPIRED_PENDING_CONFIRM') {
      // P2.1：超期待确认（清除确认弹窗属 2.2）；不再提供「开始陪看」——须先经确认链路处置数据
      el.innerHTML = '<span class="countdown-pill">⏸ 陪看数据已超保留期 · 待确认清除</span>';
      this.#renderActions(acts, '', () => undefined);
    } else {
      el.textContent = '未激活 · 点豆包「开始陪看」';
      this.#renderActions(acts, '<button class="btn btn-primary" id="btn-start2" style="flex:1">▶ 开始陪看</button>', () =>
        this.deps.onSessionStart(),
      );
    }
    // P2.5：「暂停陪看」状态行提示（任何会话态都可叠加；解除后消失）
    if (this.#paused) {
      el.innerHTML = `${el.innerHTML}<span class="countdown-pill" style="margin-left:6px">⏸ 已暂停 · 不采集不请求（设置中可恢复）</span>`;
    }
  }

  /** P2.1：GRACE 倒计时滴答（面板开时每秒刷 #cd；到 0 触发 LIST_QUERY 重判 → EXPIRED 态）。
   *  审查 P2-5：到点 refresh 失败（SW 瞬时不可达，refresh 内部吞错）也要慢速重试——否则停在 00:00:00 不自愈。 */
  #startCountdown(): void {
    this.#stopCountdown();
    const tick = () => {
      const ru = this.#retainUntil;
      if (ru === null || this.#sessionState !== 'GRACE') return; // 重判成功（EXPIRED）后自行退出
      const left = ru - Date.now();
      if (left <= 0) {
        void this.refresh();
        this.#cdTimer = this.#setTimeout(tick, 5000);
        return;
      }
      const cd = this.deps.ui.root.getElementById('cd');
      if (cd) cd.textContent = fmtCountdown(left);
      else return; // 面板已切走（详情态/重渲染无 #cd）
      this.#cdTimer = this.#setTimeout(tick, 1000);
    };
    this.#cdTimer = this.#setTimeout(tick, 1000);
  }

  #stopCountdown(): void {
    if (this.#cdTimer !== null) {
      clearTimeout(this.#cdTimer as ReturnType<typeof setTimeout>);
      this.#cdTimer = null;
    }
  }

  // ---- P2.2 · F10 清除确认弹窗（超期确认 / 手动清除） ------------------------------

  /**
   * 清除确认弹窗（原型 showExpiredModal 1:1；手动清除=同构危险区文案）。
   * mode='expired'：不可取消——只有【稍后提醒】【立即清除】两个出口（F10：不自动删、必须确认）；
   * mode='manual'：【取消】可退出（二次确认=按钮点击+弹窗确认）。
   */
  #showWipeModal(mode: 'expired' | 'manual'): void {
    const root = this.deps.ui.root;
    const modalRoot = root.getElementById('modal-root');
    if (!modalRoot) return;
    const expired = mode === 'expired';
    modalRoot.dataset.owner = expired ? 'expired-confirm' : 'manual-wipe';
    const m = root.ownerDocument.createElement('div');
    m.className = 'modal';
    m.innerHTML =
      `<div class="modal-head"><div class="m-emoji">${expired ? '💤' : '⚠️'}</div>` +
      `<div><h2>${expired ? '本次陪看数据已超过保留时间' : '清除全部陪看数据？'}</h2>` +
      `<p>${expired ? '你结束陪看已超过 1 小时。按数据保留规则，需要确认后清除本次陪看的列表、摘要与转写。' : '将删除列表、摘要与转写全部本地数据（模型配置与 Key 保留）。此操作不可恢复。'}</p></div></div>` +
      `<div class="modal-foot">` +
      `<button class="btn btn-ghost" id="wipe-later">${expired ? '稍后提醒' : '取消'}</button>` +
      `<button class="btn btn-danger" id="wipe-now">立即清除${expired ? '' : '全部数据'}</button>` +
      `</div>`;
    modalRoot.replaceChildren(m);
    modalRoot.classList.add('show');
    const close = () => {
      modalRoot.classList.remove('show');
      modalRoot.replaceChildren();
      delete modalRoot.dataset.owner;
    };
    m.querySelector('#wipe-later')?.addEventListener('click', () => {
      close();
      toast(this.deps.ui, expired ? '好的，稍后再提醒你处理' : '已取消');
    });
    m.querySelector('#wipe-now')?.addEventListener('click', () => {
      close();
      void this.#doWipe(expired ? 'WIPE_CONFIRM' : 'WIPE_NOW');
    });
  }

  /** F10 清除执行：SW 事务清六表+pointer → INACTIVE 广播/直接刷新双路兜底。 */
  async #doWipe(msgType: 'WIPE_CONFIRM' | 'WIPE_NOW'): Promise<void> {
    try {
      const r = await this.deps.bridge.request<{ ok: boolean }>({ type: msgType, confirm: true });
      if (!r?.ok) {
        toast(this.deps.ui, '清除失败，稍后再试');
        return;
      }
      toast(this.deps.ui, '已清除全部陪看数据（配置保留）');
      this.#detailKey = null;
      this.#stream = null;
      this.#segNotes = new Map();
      this.#segOpen = new Set();
      // 审查 P1-2：从设置视图发起的清除必须回收容器（#view-list 仍挂 hidden 会渲染进隐形容器，
      // 面板滞留陈旧设置视图）；#backToList 含全部复位
      this.#backToList();
      return;
    } catch {
      toast(this.deps.ui, '清除失败，稍后再试');
    }
  }

  #renderActions(acts: HTMLElement | null, html: string, onClick: () => void): void {
    if (!acts) return;
    acts.innerHTML = html;
    acts.firstElementChild?.addEventListener('click', () => onClick());
  }

  // ---- 列表 ----

  #renderList(): void {
    const box = this.deps.ui.root.getElementById('view-list');
    if (!box) return;
    // P2.5：手动清除入口已迁设置页危险操作（P2.2 过渡位 🗑 移除，验收记录 §2 N-2 收口）
    const head = `<div class="list-head"><b>本次陪看 · ${this.#items.length} 个视频</b><span>点击条目查看摘要</span></div>`;
    const body =
      this.#items.length === 0
        ? `<div class="d-sec" style="text-align:center;padding:36px 16px;color:#9499a0;font-size:13px"><img class="empty-mascot" src="${browser.runtime.getURL('/mascot/mascot-idle.png')}" alt=""><br>还没有陪看记录<br>点击豆包「开始陪看」，<br>播放超过 ${this.#triggerSeconds} 秒我就会记笔记</div>`
        : this.#items
        .map((it) => {
          const badge = BADGE_HTML[it.badge];
          const spinner = it.badge === 'generating' ? '<span class="spinner"></span>' : '';
          const srcLabel = it.source ? `来源：${SOURCE_LABEL[it.source]}` : '&nbsp;';
          return `<div class="v-item" data-video-key="${esc(it.videoKey)}">
            <div class="v-item-top">
              <div class="v-cover"><img src="${esc(it.cover)}" referrerpolicy="no-referrer" alt=""><span class="dur">${fmtSec(it.durationSec)}</span></div>
              <div class="v-info">
                <div class="v-name">${esc(it.title)}</div>
                <div class="v-sub">${esc(it.owner)} · ${relativeTimeLabel(it.lastSeenAt)}</div>
                <div class="v-prog-row"><div class="v-prog"><i style="width:${it.progressPct}%"></i></div><span class="v-pct">${it.progressPct >= 100 ? '看完' : `${it.progressPct}%`}</span></div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:9px">
              <span style="font-size:11px;color:#9499a0">${srcLabel}</span>
              <span class="badge badge-${it.badge}">${spinner}${badge}</span>
            </div>
          </div>`;
        })
        .join('');
    box.innerHTML = head + body;
    this.#bindCoverFallback(box);
    box.querySelectorAll<HTMLElement>('.v-item').forEach((el) => {
      el.addEventListener('click', () => void this.#onItemClick(el.getAttribute('data-video-key')!));
    });
  }

  /** 封面加载失败 → 渐变占位块（不用内联 onerror，规避页面 CSP 限制内联句柄）。 */
  #bindCoverFallback(scope: ParentNode): void {
    scope.querySelectorAll<HTMLImageElement>('.v-cover img').forEach((img) => {
      img.addEventListener('error', () => {
        const fb = this.deps.ui.root.ownerDocument.createElement('div');
        fb.className = 'cover-fallback';
        fb.textContent = '🫘';
        img.replaceWith(fb);
      });
    });
  }

  async #onItemClick(videoKey: string): Promise<void> {
    const item = this.#items.find((i) => i.videoKey === videoKey);
    if (!item) return;
    // nosub（need_asr/need_confirm）也进详情——ASR 确认卡在详情摘要区（P2.3 F6）
    // 已总结 → 直接取缓存；生成中/未生成/失败 → SUMMARY_OPEN（无缓存时按需建 job）→ 流式详情
    // retry:1 = 用户显式点击——仅此路径允许对 failed 摘要重新入队（F11 重试由用户发起；
    // 广播刷新路径不带 retry，否则 failed+详情打开 = 无限自动重试环）
    await this.#openDetail(videoKey, { userClick: true });
  }

  // ---- 详情 ----

  async #openDetail(videoKey: string, opts: { userClick?: boolean } = {}): Promise<void> {
    const gen = this.#routeGen;
    try {
      const r = await this.deps.bridge.request<SummaryOpenResponse>({
        type: 'SUMMARY_OPEN',
        videoKey,
        ...(opts.userClick ? { retry: 1 } : {}),
      });
      // 在途应答落地前路由已切（followVideo 递增代数）→ 作废，避免视图被旧视频详情抢回（审查 P2-5）
      if (gen !== this.#routeGen) return;
      if (!r?.ok || !r.item) {
        toast(this.deps.ui, '打开摘要失败，稍后再试');
        return;
      }
      this.#view = 'detail';
      // P2.5：详情与列表共用 #view-list 容器——从设置视图（人设联动重生成）进入时须切回
      this.deps.ui.root.getElementById('view-settings')?.classList.add('hidden');
      this.deps.ui.root.getElementById('view-list')?.classList.remove('hidden');
      // 任务在跑 → 进入流式模式（重置累计）；否则直接渲染成品
      this.#stream = isJobActive(r.item.job) && r.item.job?.status !== 'need_confirm' ? { videoKey, acc: '' } : null;
      // F13 注记状态仅随「视频真切换」重置（审查 P1-3：SUMMARY_* 广播重开同视频详情时
      // 保留已展开/流式中的段卡；缓存本体在 DB，切走的视频零请求可再取）；
      // 收口轮审查 P2-5：行上已无 segmentNotes 而内存仍有注记（重新生成覆盖旧行后）同样清空，
      // 防旧文本挂到新大纲条目下（分段流式中不受影响：runSegmentJob 先写 streaming 占位注记）
      if (this.#detailKey !== videoKey || (this.#segNotes.size > 0 && !r.item.summary?.segmentNotes)) {
        this.#segNotes = new Map();
        this.#segOpen = new Set();
      }
      this.#detailKey = videoKey;
      this.#renderDetail(r.item, r.transcript);
    } catch {
      if (gen !== this.#routeGen) return;
      toast(this.deps.ui, '打开摘要失败，稍后再试');
    }
  }

  #backToList(): void {
    this.#view = 'list';
    this.#detailKey = null;
    this.#stream = null;
    this.#segNotes = new Map();
    this.#segOpen = new Set();
    // P2.5：详情/设置共用返回路径——确保列表容器可见、设置容器隐藏
    this.deps.ui.root.getElementById('view-settings')?.classList.add('hidden');
    this.deps.ui.root.getElementById('view-list')?.classList.remove('hidden');
    void this.refresh();
  }

  /**
   * 2.7a【重新生成】（F7/F8）：REGENERATE 强制重跑；成功覆盖经 SUMMARY_DONE→#openDetail 重渲染。
   * 旧分段注记点击即作废（新大纲语义不同；DB 缓存随成功覆盖清空）；失败时旧摘要/注记保留，
   * 【AI 解读】再点仍从 DB 缓存取回。
   */
  async #onRegenerate(): Promise<void> {
    const videoKey = this.#detailKey;
    if (!videoKey) return;
    try {
      const r = await this.deps.bridge.request<{ ok: boolean; started?: boolean; error?: string }>({
        type: 'REGENERATE',
        videoKey,
      });
      if (!r?.ok || !r.started) {
        toast(
          this.deps.ui,
          r?.error === 'busy'
            ? '已有任务进行中，稍后再试重新生成'
            : r?.error === 'paused'
              ? '已暂停陪看，先在设置中恢复后再生成'
              : '重新生成发起失败，稍后再试',
        );
        return;
      }
      this.#segNotes = new Map();
      this.#segOpen = new Set();
      this.#stream = { videoKey, acc: '' };
      this.#paintStream(); // 立即切「记笔记中」等待态；增量经 SUMMARY_PROGRESS 进 #stream
    } catch {
      toast(this.deps.ui, '重新生成发起失败，稍后再试');
    }
  }

  /**
   * P2.3 F6：【调用 ASR 解析】→ ASR_CONFIRM。成功 → 详情切流式（阶段动画 audio→asr→llm）；
   * 未配置 → onNeedAsrConfig（onboarding ASR 补配模式，配置后回卡片可继续）；
   * busy（同视频任务在途）→ toast。
   */
  async #onAsrConfirm(videoKey: string): Promise<void> {
    try {
      const r = await this.deps.bridge.request<{ ok: boolean; started?: boolean; reason?: string; error?: string }>({
        type: 'ASR_CONFIRM',
        videoKey,
      });
      if (r?.reason === 'NEED_ASR_CONFIG') {
        this.deps.onNeedAsrConfig();
        return;
      }
      if (!r?.ok || !r.started) {
        toast(
          this.deps.ui,
          r?.error === 'no-session'
            ? '会话未激活'
            : r?.error === 'paused'
              ? '已暂停陪看，先在设置中恢复'
              : '已有任务进行中，稍后再试',
        );
        return;
      }
      this.#segNotes = new Map();
      this.#segOpen = new Set();
      this.#stream = { videoKey, acc: '' };
      this.#paintStream(); // 立即切「下载音频中…」等待态；增量经 SUMMARY_PROGRESS 进 #stream
    } catch {
      toast(this.deps.ui, 'ASR 解析发起失败，稍后再试');
    }
  }

  /** P2.3 F6-⑥：【暂不】→ 保持橙色标注（无状态迁移），回列表。 */
  async #onAsrDecline(videoKey: string): Promise<void> {
    try {
      await this.deps.bridge.request({ type: 'ASR_DECLINE', videoKey });
    } catch {
      /* SW 未就绪：decline 无状态迁移，忽略 */
    }
    this.#backToList();
  }

  #renderDetail(item: ListQueryItem, transcript?: TranscriptExcerpt): void {
    const root = this.deps.ui.root;
    const box = root.getElementById('view-list');
    if (!box) return;
    const v = item.video;
    const s = item.summary;
    const streaming = this.#stream !== null;
    const title = v?.title ?? item.visit.videoKey;
    const srcBadge = s && s.status === 'done' ? `<span class="src-badge src-${s.source === 'manual_sub' ? 'manual' : s.source === 'asr' ? 'asr' : 'ai'}">${SOURCE_LABEL[s.source]}</span>` : '';
    const pct = Math.max(0, Math.min(100, Math.round(item.visit.progressPct)));
    const pctLabel = pct >= 100 ? '结尾' : `${pct}%`;

    // 摘要区：流式（阶段文案 + 已抽取文本 + 光标）/ 成品 / 失败 / 待确认
    let summaryHtml: string;
    if (streaming) {
      const partial = extractStreamingSummary(this.#stream?.acc ?? '');
      const stage = STAGE_LABEL[this.#stream?.stage ?? ''] ?? '豆包正在记笔记…';
      summaryHtml = partial
        ? `${esc(partial)}<span class="caret"></span>`
        : `<div class="d-summary-empty"><span class="spinner"></span>${stage}</div>`;
    } else if (s?.status === 'done' && s.summary) {
      summaryHtml = esc(s.summary);
    } else if (s?.status === 'need_asr') {
      // P2.3 F6-①：卡片文案逐字（总纲口径）；【调用 ASR 解析】【暂不】+ 超长预告（音频估算 >25MB）
      const estMB = Math.round(estimateAudioBytes(v?.duration ?? 0) / 1048576);
      const tooBig = estMB > 25; // settings.asrMaxMB 默认 25；预告口径用默认值即可（实际拦截在执行体）
      // 审查 P1-1：上次 ASR 尝试失败原因（音频链失败保留 need_asr 行、错误在 job 行）——不显示则
      // 用户「点确认→闪一下→回原卡」零反馈，反复点＝反复下载整段音频（F6-⑦ 明确提示不成立）
      const lastErr = !isJobActive(item.job) && item.lastJob?.status === 'failed' ? item.lastJob?.error : undefined;
      summaryHtml =
        '<div class="d-summary-empty">该视频文字信息较少，请确认是否调用 ASR 做进一步解析？</div>' +
        (lastErr ? `<div class="d-summary-empty" style="color:#dc2626">上次尝试失败：${esc(lastErr.msg)}</div>` : '') +
        (tooBig ? `<div class="d-summary-empty" style="color:#f59e0b">视频较长：音频约 ${estMB}MB，可能超出 25MB 上限</div>` : '') +
        '<div style="display:flex;gap:10px;margin-top:12px"><button class="btn btn-primary" id="btn-asr-ok" style="flex:1">调用 ASR 解析</button><button class="btn btn-ghost" id="btn-asr-no" style="flex:1">暂不</button></div>';
    } else if (s?.status === 'failed') {
      summaryHtml = `<div class="d-summary-empty" style="color:#dc2626">解析失败：${esc(s.error?.msg ?? '未知错误')}</div>`;
    } else {
      summaryHtml = '<div class="d-summary-empty">还没有摘要</div>';
    }

    // P1.11 F13：大纲条目 = seek 行（.ol-row）+ 独立【AI 解读】入口 + 内联注记容器（流式/缓存/失败重试）
    const outlineHtml = (s?.outline ?? [])
      .map(
        (o, i) =>
          `<li data-sec="${Math.max(0, Math.floor(o.time))}"><div class="ol-row"><span class="ot">${fmtSec(o.time)}</span><span>${esc(o.text)}</span><button class="seg-btn" data-seg="${i}" title="解读该时间段">AI 解读</button></div><div class="seg-note hidden" data-segnote="${i}"></div></li>`,
      )
      .join('');
    const sayHtml =
      s?.status === 'done' && s.evaluation
        ? `<div class="d-sec mascot-card"><h3>🫘 豆包说</h3><div class="mascot-say">
            <div class="mascot-say-avatar"><img src="${browser.runtime.getURL('/mascot/mascot-avatar.png')}" alt="豆包"></div>
            <div class="mascot-say-body"><div class="mascot-stars">${starsHtml(s.rating)}</div><div class="mascot-say-text">${esc(s.evaluation)}</div></div>
          </div></div>`
        : '';
    const trHtml = transcript
      ? `<details class="d-sec d-transcript"><summary>📄 转写节选（共 ${transcript.total} 条${transcript.total > transcript.cues.length ? `，前 ${transcript.cues.length} 条` : ''}）</summary>${transcript.cues
          .map((c) => `<div class="tr-line" data-sec="${Math.max(0, Math.floor(c.from))}"><span class="tt">[${fmtSec(c.from)}]</span><span>${esc(c.text)}</span></div>`)
          .join('')}</details>`
      : '';

    box.innerHTML =
      `<div class="d-head"><button class="d-back" id="d-back" title="返回列表">←</button><b>视频摘要</b></div>` +
      `<div class="d-cover"><img src="${esc(v?.cover ?? '')}" referrerpolicy="no-referrer" alt=""><span class="dur">${fmtSec(v?.duration ?? 0)}</span></div>` +
      `<div class="d-title">${esc(title)}</div>` +
      `<div class="d-meta"><span>${esc(v?.owner ?? '')}</span><span>·</span><span>看到 ${pctLabel}</span>${srcBadge}</div>` +
      `<div class="d-sec"><h3>📝 摘要</h3><div class="d-summary" id="d-summary">${summaryHtml}</div></div>` +
      (outlineHtml ? `<div class="d-sec"><h3>🧭 要点大纲</h3><ul class="d-outline">${outlineHtml}</ul></div>` : '') +
      sayHtml +
      trHtml +
      (s && s.status !== 'need_asr'
        ? `<div class="d-foot"><button class="btn btn-ghost" id="d-regen">↻ 重新生成</button><button class="btn btn-primary" id="d-copy">⧉ 复制摘要</button></div>`
        : '');

    root.getElementById('d-back')?.addEventListener('click', () => this.#backToList());
    root.getElementById('d-regen')?.addEventListener('click', () => void this.#onRegenerate());
    root.getElementById('btn-asr-ok')?.addEventListener('click', () => void this.#onAsrConfirm(item.visit.videoKey));
    root.getElementById('btn-asr-no')?.addEventListener('click', () => void this.#onAsrDecline(item.visit.videoKey));
    // P1.8：大纲条目与转写行点击 → seek（F5「点大纲项播放器跳到对应时间」/F7「点击某条可 seek」）；
    // P1.11：【AI 解读】按钮与注记卡内的点击不触发 seek（两动作互不干扰，PRD F13）
    const seekKey = item.visit.videoKey;
    box.querySelectorAll<HTMLElement>('.d-outline li, .tr-line').forEach((el) => {
      el.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement | null;
        if (t?.closest('.seg-btn, .seg-note')) return;
        this.deps.onSeek(seekKey, Number(el.getAttribute('data-sec')) || 0);
      });
    });
    box.querySelectorAll<HTMLButtonElement>('.seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => void this.#onSegToggle(Number(btn.getAttribute('data-seg'))));
    });
    // 重渲染后恢复已展开注记（详情内刷新路径）
    for (const i of this.#segOpen) this.#paintSegNote(i);
    root.getElementById('d-copy')?.addEventListener('click', () => {
      const text = s?.summary ?? '';
      if (!text) return;
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast(this.deps.ui, '摘要已复制到剪贴板'))
        .catch(() => toast(this.deps.ui, '复制失败（页面剪贴板权限）'));
    });
    const cover = box.querySelector<HTMLImageElement>('.d-cover img');
    cover?.addEventListener('error', () => cover.remove());
  }

  // ---- 桥事件 ----

  handleEvent(e: UiEvent): void {
    if (e.type === 'LOGIN_STATE') {
      this.setLoginState(e.loggedIn ?? null); // P1.10 引导卡实时翻转
      return;
    }
    // P1.11 F13：分段解读流式/终态 → 内联注记卡（仅当前详情视频消费）
    if (e.type === 'SEGMENT_NOTE_STREAM' || e.type === 'SEGMENT_NOTE_DONE' || e.type === 'SEGMENT_NOTE_FAILED') {
      if (e.videoKey !== this.#detailKey || e.segIndex === undefined) return;
      const i = e.segIndex;
      if (e.type === 'SEGMENT_NOTE_STREAM') {
        const st = this.#segNotes.get(i);
        if (st && st.status === 'streaming') {
          st.text += e.deltaText ?? '';
          this.#paintSegNote(i);
        }
        return;
      }
      if (e.type === 'SEGMENT_NOTE_DONE') {
        this.#segNotes.set(i, { status: 'done', text: e.text ?? '', truncated: e.truncated });
      } else {
        this.#segNotes.set(i, { status: 'failed', text: '', error: e.error });
      }
      this.#paintSegNote(i);
      return;
    }
    if (e.type === 'SUMMARY_PROGRESS') {
      // stage 更新与 delta 解耦：stage 变化常在 LLM 流式窗口之外单独成包（审查 P1-1）
      if (this.#stream && e.videoKey === this.#stream.videoKey) {
        if (e.stage) this.#stream.stage = e.stage;
        if (e.deltaText) this.#stream.acc += e.deltaText;
        this.#paintStream();
      }
      return;
    }
    if (e.type === 'SESSION_STATE') {
      // P2.1：SESSION_STATE 随带倒计时数据（SESSION_END 广播/清除等变化时无需等 LIST_QUERY）
      if (e.retainUntil !== undefined) this.#retainUntil = e.retainUntil;
      else if (e.state === 'ACTIVE' || e.state === 'INACTIVE') this.#retainUntil = null;
      // 重连补偿（审查 P2-6）：SW 每次 Port 连接都回放 SESSION_STATE → 顺带全量刷新，
      // 兜住断线退避窗口内丢失的终态广播（徽章滞留「生成中」自愈）
      if (this.#open) void this.refresh();
      return;
    }
    if (e.type === 'SUMMARY_DONE' || e.type === 'SUMMARY_FAILED' || e.type === 'SUMMARY_NEED_ASR' || e.type === 'SUMMARY_UPDATED') {
      if (!this.#open) return;
      // 终态/排队变化：节流刷新（列表整体重查；详情重开载荷）
      if (this.#refreshTimer) return;
      this.#refreshTimer = this.#setTimeout(() => {
        this.#refreshTimer = null;
        if (this.#view === 'detail' && this.#detailKey) void this.#openDetail(this.#detailKey);
        else void this.refresh();
      }, 300);
    }
  }

  /** 流式打字：只重绘摘要区，避免整屏 innerHTML 重建打断阅读/滚动。 */
  #paintStream(): void {
    if (!this.#stream) return;
    const el = this.deps.ui.root.getElementById('d-summary');
    if (!el) return;
    const partial = extractStreamingSummary(this.#stream.acc);
    const stage = STAGE_LABEL[this.#stream.stage ?? ''] ?? '豆包正在记笔记…';
    el.innerHTML = partial
      ? `${esc(partial)}<span class="caret"></span>`
      : `<div class="d-summary-empty"><span class="spinner"></span>${stage}</div>`;
  }

  // ---- P1.11 · F13 分段解读内联注记 ----

  /** 展开/收起【AI 解读】；首次展开取缓存或发起 SEGMENT_ANALYZE（流式经广播回填）。 */
  async #onSegToggle(i: number): Promise<void> {
    if (!this.#detailKey) return;
    if (this.#segOpen.has(i)) {
      this.#segOpen.delete(i);
      this.#paintSegNote(i);
      return;
    }
    this.#segOpen.add(i);
    const st = this.#segNotes.get(i);
    // 审查 P2-6：残留 streaming（终态广播被 SW 死亡/断连吞掉）重展开也重发 OPEN 自愈
    // （OPEN 幂等：健康流式中仅多一条消息、不覆盖已累计文本；残留态触发重建）
    if (!st || st.status === 'streaming') {
      if (!st) this.#segNotes.set(i, { status: 'streaming', text: '' });
      this.#paintSegNote(i);
      await this.#requestSegNote(i, 0);
    } else {
      this.#paintSegNote(i);
    }
  }

  async #onSegRetry(i: number): Promise<void> {
    if (!this.#detailKey) return;
    this.#segNotes.set(i, { status: 'streaming', text: '' });
    this.#segOpen.add(i);
    this.#paintSegNote(i);
    await this.#requestSegNote(i, 1); // retry=1：用户显式重试（同 SUMMARY_OPEN 口径，F11）
  }

  async #requestSegNote(i: number, retry: number): Promise<void> {
    try {
      const r = await this.deps.bridge.request<{
        ok: boolean;
        note?: SegNoteVM;
        error?: string;
        started?: boolean;
      }>({ type: 'SEGMENT_NOTE_OPEN', videoKey: this.#detailKey, segIndex: i, ...(retry === 1 ? { retry: 1 } : {}) });
      if (this.#detailKey === null) return; // 已返回列表：丢弃
      if (!r?.ok) {
        this.#segNotes.set(i, {
          status: 'failed',
          text: '',
          error: { code: r?.error ?? 'OPEN_FAIL', msg: r?.error === 'NO_OUTLINE' ? '大纲不可用' : '解读发起失败' },
        });
        this.#paintSegNote(i);
        return;
      }
      // 本次新入队（重试/残留重建）→ 清空旧增量残留，从空占位重新累计
      if (r.started) this.#segNotes.set(i, { status: 'streaming', text: '' });
      const n = r.note;
      if (n?.status === 'done') this.#segNotes.set(i, { status: 'done', text: n.text ?? '', truncated: n.truncated });
      else if (n?.status === 'failed') this.#segNotes.set(i, { status: 'failed', text: '', error: n.error });
      // streaming：保持占位，等 SEGMENT_NOTE_STREAM/DONE 广播回填
      this.#paintSegNote(i);
    } catch {
      this.#segNotes.set(i, { status: 'failed', text: '', error: { code: 'OPEN_FAIL', msg: '解读发起失败，稍后再试' } });
      this.#paintSegNote(i);
    }
  }

  /** 只重绘单条注记容器（不整屏重建）。 */
  #paintSegNote(i: number): void {
    const el = this.deps.ui.root.querySelector<HTMLElement>(`[data-segnote="${i}"]`);
    if (!el) return;
    const open = this.#segOpen.has(i);
    el.classList.toggle('hidden', !open);
    if (!open) return;
    const st = this.#segNotes.get(i);
    if (!st) return;
    if (st.status === 'streaming') {
      el.innerHTML = st.text
        ? `${esc(st.text)}<span class="caret"></span>`
        : '<span class="spinner"></span>豆包正在解读该段…';
    } else if (st.status === 'done') {
      el.innerHTML = `${esc(st.text)}${st.truncated ? '<span class="seg-trunc">段过长：仅解读了段内前部分字幕</span>' : ''}`;
    } else {
      el.innerHTML = `<span class="seg-err">解读失败：${esc(st.error?.msg ?? '未知错误')}</span><button class="btn btn-ghost seg-retry" data-segretry="${i}">重试</button>`;
      el.querySelector(`[data-segretry="${i}"]`)?.addEventListener('click', () => void this.#onSegRetry(i));
    }
  }
}
