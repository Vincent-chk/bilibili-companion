// P1.6 · 豆包纯逻辑（无 DOM/browser 依赖，单测覆盖）：
// 会话状态→表情映射、拖拽阈值与位置钳位（原型 setupMascotDrag 语义）、
// 视口相对坐标持久化（02-数据模型 §2 mascotPos {x,y} 为视口相对坐标）、打字机节奏。
export type MascotState = 'idle' | 'happy' | 'thinking' | 'note' | 'sleep';
export type UiSessionState = 'ACTIVE' | 'GRACE' | 'EXPIRED_PENDING_CONFIRM' | 'CLOSED' | 'INACTIVE';

/** 会话态 → 表情（ACTIVE 不切表情：保留最近一次事件表情；结束后睡觉）。 */
export function mascotStateForSession(session: UiSessionState): MascotState | null {
  if (session === 'GRACE' || session === 'EXPIRED_PENDING_CONFIRM' || session === 'CLOSED') return 'sleep';
  if (session === 'INACTIVE') return 'idle';
  return null; // ACTIVE：维持现状
}

/** 位移超过阈值才算拖拽（否则视为点击）——F3「拖拽与点击不误触」。 */
export const DRAG_THRESHOLD_PX = 4;
export const isDragMoved = (dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean =>
  Math.abs(dx) > threshold || Math.abs(dy) > threshold;

/** 立绘尺寸（px，与 styles.ts 的 #mascot-wrap 170 / #mascot 150 一致）。 */
export const MASCOT_WRAP_W = 170;
export const MASCOT_H = 150;

/**
 * 位置钳位（原型边界）：上边界 170px 保证头顶气泡不出视口；四周留白。
 */
export function clampMascotPos(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(4, x), Math.max(4, vw - MASCOT_WRAP_W - 8)),
    y: Math.min(Math.max(170, y), Math.max(170, vh - MASCOT_H - 10)),
  };
}

/** 默认位（原型：右下区域，避开播放器控件；顶部预留气泡空间）。 */
export function defaultMascotPos(vw: number, vh: number): { x: number; y: number } {
  return clampMascotPos(vw - 380, vh - 280, vw, vh);
}

/** 视口相对坐标（02-数据模型 §2：mascotPos 为相对坐标，窗口缩放后按比例还原）。 */
export function toRelative(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  return { x: +(x / Math.max(1, vw)).toFixed(4), y: +(y / Math.max(1, vh)).toFixed(4) };
}

export function fromRelative(
  p: { x: number; y: number },
  vw: number,
  vh: number,
): { x: number; y: number } {
  return clampMascotPos(p.x * vw, p.y * vh, vw, vh);
}

/** 打字机每字间隔（原型 typeText：6–40ms 钳位）。 */
export function typeDelay(text: string, totalMs: number): number {
  return Math.max(6, Math.min(40, totalMs / Math.max(1, text.length)));
}

/** 气泡默认驻留（F3：打字机 + 5s 自动消失）。 */
export const BUBBLE_MS = 5000;

// ---- P1.9 · 浮层七准则纯逻辑（对标调研 05 §1.2，单测覆盖） ----

/** 准则 #1 闲时半透明：无交互 N 毫秒后降透明度。 */
export const IDLE_DIM_MS = 5000;

/** 准则 #4 克制提醒：同 kind 气泡限频窗口（≤1 次/10min）。 */
export const BUBBLE_RATE_WINDOW_MS = 10 * 60 * 1000;

/** 同 kind 气泡在限频窗口内已出现过 → 本次跳过（lastAt 为 undefined=从未出现，不跳）。 */
export function bubbleThrottled(lastAt: number | undefined, now: number, windowMs = BUBBLE_RATE_WINDOW_MS): boolean {
  return lastAt !== undefined && now - lastAt < windowMs;
}

/**
 * 准则 #1 拖拽贴边收起：松手后吸附到最近横边（左=4 / 右=钳位上界），纵坐标保持。
 * 以立绘中心与视口中线比较选边。
 */
export function snapToEdge(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  const right = Math.max(4, vw - MASCOT_WRAP_W - 8);
  const left = 4;
  const centerX = x + MASCOT_WRAP_W / 2;
  return { x: centerX < vw / 2 ? left : right, y: clampMascotPos(x, y, vw, vh).y };
}

/** 最小可交互 activeElement 面（document/shadowRoot 同构），便于单测注入。 */
export interface ActiveElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  shadowRoot?: { activeElement?: ActiveElementLike | null } | null;
}

/**
 * 准则 #3 输入聚焦不弹气泡：焦点在输入框/可编辑区（含 Shadow DOM 内——本扩展自己的
 * onboarding/设置输入也计入）时抑制气泡。逐层 shadowRoot 下钻。
 */
export function isTypingTarget(active: ActiveElementLike | null | undefined): boolean {
  let cur = active ?? null;
  for (let depth = 0; cur && depth < 8; depth++) {
    const tag = (cur.tagName ?? '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || cur.isContentEditable) return true;
    cur = cur.shadowRoot?.activeElement ?? null;
  }
  return false;
}

/**
 * 准则 #3 全屏避让：浏览器全屏时 Shadow 宿主需迁入全屏元素子树（否则被全屏层遮挡）；
 * 退出全屏迁回 documentElement。返回应挂载的父节点；null=无需迁移。
 * 网页全屏（B 站 CSS 全屏）不走 Fullscreen API，靠 z-index 2147483000 段位保持在上层。
 */
export function fullscreenHostParent(
  fullscreenElement: Element | null,
  host: Element,
  documentElement: Element,
): Element | null {
  if (fullscreenElement) {
    // 原生 <video> 全屏：宿主挂进 video 子树会成为 fallback content 不渲染（审查 P2-2）→ 改挂其父
    const target =
      (fullscreenElement as Element & { tagName?: string }).tagName === 'VIDEO'
        ? fullscreenElement.parentElement
        : fullscreenElement;
    if (!target) return null;
    return target.contains(host) ? null : target;
  }
  return host.parentElement === documentElement || host.parentElement === null ? null : documentElement;
}
