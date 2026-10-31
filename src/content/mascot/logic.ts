// P1.6 · 豆包纯逻辑（无 DOM/browser 依赖，单测覆盖）：
// 会话状态→表情映射、拖拽阈值与位置钳位（原型 setupMascotDrag 语义）、
// 视口相对坐标持久化（02-数据模型 §2 mascotPos {x,y} 为视口相对坐标）、打字机节奏。
import type { JobRow, SummaryRow } from '../../lib/storage';

export type MascotState = 'idle' | 'happy' | 'thinking' | 'note' | 'sleep';
export type UiSessionState = 'ACTIVE' | 'GRACE' | 'EXPIRED_PENDING_CONFIRM' | 'CLOSED' | 'INACTIVE';

/** 状态气泡只消费脱敏后的任务元信息，不接收字幕、摘要或密钥。 */
export interface CurrentVideoStatus {
  job?: Pick<JobRow, 'id' | 'type' | 'status' | 'stage' | 'runId'>;
  summary?: Pick<SummaryRow, 'status' | 'source' | 'asrOutdated'> & { errorCode?: string };
  lastJob?: Pick<JobRow, 'type' | 'status'> & { errorCode?: string };
}

/** 将当前页面的主任务快照转换为简短状态；分段预取不进入此快照。 */
export function currentVideoStatusText(
  session: UiSessionState,
  paused: boolean,
  hasVideo: boolean,
  snapshot?: CurrentVideoStatus,
): string | null {
  if (session === 'INACTIVE') return null; // 现有开始陪看按钮仍是唯一入口
  if (session === 'EXPIRED_PENDING_CONFIRM') return '陪看数据待确认，点豆包查看';
  if (session === 'GRACE' || session === 'CLOSED') return '陪看已结束，数据帮你留着哦';
  const job = hasVideo ? snapshot?.job : undefined;
  const summary = hasVideo ? snapshot?.summary : undefined;
  const lastJob = hasVideo ? snapshot?.lastJob : undefined;
  const regenFailed = summary?.status === 'done' && lastJob?.type === 'REGENERATE' && lastJob.status === 'failed';
  if (paused) {
    if (regenFailed) return '陪看已暂停；重新生成失败，已保留旧笔记';
    if (job?.status === 'running') return '陪看已暂停，已开始的任务会继续';
    if (summary?.status === 'done') return '陪看已暂停，本视频摘要已完成';
    return '陪看已暂停，已开始的任务可能继续';
  }
  if (!hasVideo) return '陪看中，等待打开视频';
  if (job?.status === 'pending') return '视频正在排队等待处理';
  if (job?.status === 'running') {
    const stages: Partial<Record<NonNullable<JobRow['stage']>, string>> = {
      subtitle: '正在获取字幕…', audio: '正在下载音频…', asr: '正在进行语音转写…',
      llm_map: '正在整理视频要点…', llm_reduce: '正在撰写视频摘要…',
    };
    return (job.stage && stages[job.stage]) || '正在处理当前视频…';
  }
  const code = summary?.errorCode;
  if (code && ['ASR_NO_SPEECH', 'ASR_TOO_SHORT', 'LOW_CONTENT'].includes(code)) return '语音内容不足，未生成摘要';
  if ((code === 'KEY_INVALID' || lastJob?.errorCode === 'KEY_INVALID') && summary?.status !== 'done') return '模型 Key 无效，请到设置检查';
  if (code === 'NEED_ASR_CONFIG') return '没有字幕，请配置语音服务';
  if (code === 'ASR_PERMISSION_DENIED') return '语音服务未授权，点豆包查看';
  if (code === 'AUTO_ASR_PENDING') return '没有字幕，正在准备语音识别…';
  if (regenFailed) return '重新生成失败，已保留旧笔记';
  if (summary?.status === 'done') return summary.asrOutdated ? '摘要已生成，转写内容需核对' : '摘要已完成，点豆包查看';
  if (summary?.status === 'need_asr' || job?.status === 'need_confirm') return '语音转写待处理，点豆包查看';
  if (summary?.status === 'failed' || lastJob?.status === 'failed') return '视频处理未完成，点豆包查看';
  return '等待播放达到设定时长';
}

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
 * 正常视口上边界 170px 保证头顶气泡空间；极矮窗口优先保证收起入口可见。
 */
export function clampMascotPos(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  const maxY = vh < 170 + MASCOT_H
    ? Math.max(48 - MASCOT_H, vh - MASCOT_H)
    : Math.max(170, vh - MASCOT_H - 10);
  return {
    x: Math.min(Math.max(4, x), Math.max(4, vw - MASCOT_WRAP_W - 8)),
    y: Math.min(Math.max(Math.min(170, maxY), y), maxY),
  };
}

/** 默认左下贴边；保留完整立绘的空间供展开与拖拽。 */
export function defaultMascotPos(vw: number, vh: number): { x: number; y: number } {
  return clampMascotPos(4, vh - MASCOT_H - 10, vw, vh);
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
