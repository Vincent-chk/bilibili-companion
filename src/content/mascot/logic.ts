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
