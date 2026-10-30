// P1.5 · 面板视图模型（纯函数，无 DOM/browser 依赖，单测覆盖）：
// LIST_QUERY 原始行 → 列表/详情展示模型；徽章映射（F4）；流式摘要抽取（F5/F7）。
import type { JobRow, SummaryRow, TranscriptRow, VideoRow, VisitRow } from '../../lib/storage';
import { looksLikeStructuredSummary } from '../../lib/llm/summary';
import { hasAsrSemanticMismatch, verifiedAsrSentences } from '../../lib/asr/doubao';

// ---- 后端 LIST_QUERY / SUMMARY_OPEN 的行形状（background 组装，见 handleListQuery） ----

export interface JobInfo {
  type?: JobRow['type'];
  status: JobRow['status'];
  stage?: JobRow['stage'];
  progress?: number;
}

export interface SummaryInfo {
  status: SummaryRow['status'];
  source: SummaryRow['source'];
  summary: string;
  outline: { time: number; text: string }[];
  evaluation: string;
  rating: number;
  error?: { code: string; msg: string };
  segmentNotes?: SummaryRow['segmentNotes']; // 行本体随 LIST_QUERY/SUMMARY_OPEN 全量下发；面板据其判定注记内存态是否失效（审查 P2-5）
  asrProgress?: SummaryRow['asrProgress'];
  asrOutdated?: boolean;
}

export interface ListQueryItem {
  visit: VisitRow;
  video?: VideoRow;
  summary?: SummaryInfo;
  job?: JobInfo;
  /** P2.3 审查 P1-1：最近一次 job 终态（failed 时的 error 是 need_asr 卡片的失败反馈数据源）。 */
  lastJob?: { type?: JobRow['type']; status: JobRow['status']; error?: { code: string; msg: string } };
}

export interface ListItemVM {
  videoKey: string;
  title: string;
  cover: string;
  owner: string;
  durationSec: number;
  progressPct: number;
  lastSeenAt: number;
  badge: BadgeKind;
  source?: SummaryInfo['source'];
}

export type BadgeKind = 'summarized' | 'generating' | 'nosub' | 'insufficient' | 'ungenerated' | 'failed';

/** 活动任务（含 need_confirm——无字幕待确认仍在「等待用户」语义下）判定。 */
export const isJobActive = (j?: JobInfo): boolean =>
  !!j && (j.status === 'pending' || j.status === 'running' || j.status === 'need_confirm');

/**
 * 徽章映射（F4）：
 * 活动任务（pending/running）→ 生成中（蓝）；
 * 摘要 done → 已总结（绿）；need_asr（且无活动 LLM 任务）→ 无字幕·待确认（橙）；
 * 极短语音 → 内容不足；failed（且无活动任务）→ 解析失败（红）；其余 → 未生成（灰）。
 * 优先级：生成中 > 已总结 > 待确认 > 失败 > 未生成（done+新任务=重生成中，以任务为准）。
 */
/** 旧版降级行没有大纲与点评：只对这种记录检查误存的 JSON。 */
export function isCorruptStoredSummary(s?: SummaryInfo): boolean {
  return s?.status === 'done' && !s.outline?.length && !s.evaluation && looksLikeStructuredSummary(s.summary ?? '');
}

export function badgeFor(item: { summary?: SummaryInfo; job?: JobInfo }): BadgeKind {
  if (isJobActive(item.job) && item.job?.status !== 'need_confirm') return 'generating';
  if (item.summary?.status === 'done') return isCorruptStoredSummary(item.summary) ? 'failed' : 'summarized';
  if (['ASR_TOO_SHORT','ASR_NO_SPEECH','LOW_CONTENT'].includes(item.summary?.error?.code ?? '') && (item.summary?.status === 'need_asr' || item.summary?.status === 'failed')) return 'insufficient';
  if (item.summary?.status === 'need_asr' || item.job?.status === 'need_confirm') return 'nosub';
  if (item.summary?.status === 'failed') return 'failed';
  return 'ungenerated';
}

export const BADGE_HTML: Record<BadgeKind, string> = {
  summarized: '✓ 已总结',
  generating: '生成中',
  nosub: '⚠ 无字幕 · 待处理',
  insufficient: '语音内容不足',
  ungenerated: '未生成',
  failed: '✕ 解析失败',
};

export function toListItemVM(item: ListQueryItem): ListItemVM {
  const v = item.video;
  return {
    videoKey: item.visit.videoKey,
    title: v?.title ?? item.visit.videoKey,
    cover: v?.cover ?? '',
    owner: v?.owner ?? '',
    durationSec: v?.duration ?? 0,
    progressPct: Math.max(0, Math.min(100, Math.round(item.visit.progressPct))),
    lastSeenAt: item.visit.lastSeenAt,
    badge: badgeFor(item),
    source: item.summary?.status === 'done' ? item.summary.source : undefined,
  };
}

/** 列表按最近观看倒序（F4；DB 已按索引排序，此处兜底保证语义）。 */
export function sortListItems(items: ListItemVM[]): ListItemVM[] {
  return [...items].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

// ---- 文案与格式化 ----

export const SOURCE_LABEL: Record<SummaryInfo['source'], string> = {
  manual_sub: '人工字幕',
  ai_sub: 'AI字幕',
  asr: 'ASR转写',
};

export const STAGE_LABEL: Record<string, string> = {
  subtitle: '获取字幕中…',
  audio: '下载音频中…',
  asr: '语音转写中…',
  llm_map: '整理要点中…',
  llm_reduce: '撰写摘要中…',
};

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 秒 → mm:ss / h:mm:ss（时长与时间戳共用）。 */
export function fmtSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${pad2(m)}:${pad2(s % 60)}`;
}

export function asrConsentText(durationSec: number, automatic = false): string {
  const scope = Number.isFinite(durationSec) && durationSec > 0 ? `整段视频（约 ${fmtSec(durationSec)}）` : '整段视频（时长尚未确认）';
  return `${automatic ? '自动处理或确认重试时可能下载' : '确认后可能下载'}${scope}的音频并发送给你配置的语音服务（如豆包）。如果已有的转写可以复用，将使用已保存的文字；否则会下载并识别音频。语音识别和摘要可能消耗套餐额度或产生费用，重新识别可能再次计费。处理范围包含尚未观看的内容，可能提前透露剧情。豆包语音目前支持不超过 15 分钟、25 MiB 的音轨。`;
}

export function asrProgressView(progress: NonNullable<SummaryInfo['asrProgress']>): {label: string; parts: {range: string; text: string}[]; unconfirmed: string[]; warning?: string} {
  const state = progress.status === 'partial' ? '未完成' : progress.status === 'done' ? '所选范围已识别，正在汇总全片' : '进行中';
  const end = Number.isFinite(progress.processedUntil) ? Math.max(0, progress.processedUntil) : 0;
  const target = Number.isFinite(progress.targetDuration) ? Math.max(0, progress.targetDuration) : 0;
  return {label:`已解析至 ${fmtSec(end)} / ${fmtSec(target)} · ${state}`,
    parts: progress.parts.filter(p => Number.isFinite(p.from) && Number.isFinite(p.to) && p.from >= 0 && p.to > p.from && p.text.trim()).map(p => ({range:`${fmtSec(p.from)}–${fmtSec(p.to)}`,text:p.text})),
    unconfirmed: (progress.unconfirmed ?? []).map(part => part.text).filter(text => text.trim()),
    ...(progress.warning ? {warning:progress.warning} : {})};
}

// ---- P2.1 · 保留期倒计时（F10：GRACE 态「数据保留至 HH:MM」） --------------------

/** 剩余毫秒 → hh:mm:ss（原型 fmtCountdown 1:1；负值钳 0）。 */
export function fmtCountdown(ms: number): string {
  const t = Math.max(0, ms);
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** 时间戳 → 本机 HH:MM（「数据保留至 HH:MM」口径；原型 clockOf）。 */
export function clockOf(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 时间戳 → 「刚刚 / N 分钟前 / N 小时前 / 昨天」（列表副标题）。 */
export function relativeTimeLabel(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return '更早';
}

/** rating 1–5 → 🫘 星条（暗豆兜底）。 */
export function starsHtml(rating: number): string {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return '🫘'.repeat(r) + `<span class="dim">${'🫘'.repeat(5 - r)}</span>`;
}

/**
 * 流式摘要抽取：LLM 输出是结构化 JSON（`{"summary": "…` 逐 token 到达），
 * 面板打字机只展示 summary 字段当前值。取**最后一次出现**的 summary 键
 * （completeStructured 校验失败重发时会有第二轮 JSON，后写的赢）。
 * 未进入 summary 字段前返回 ''（UI 显示阶段文案+spinner）。
 * shortcut: 只解 \" \n \\ \\uXXXX 四种转义；字幕/摘要文本场景已够用，遇罕见转义原样展示
 */
export function extractStreamingSummary(acc: string): string {
  const key = acc.lastIndexOf('"summary"');
  if (key < 0) return '';
  const open = acc.indexOf('"', key + 9);
  if (open < 0) return '';
  let out = '';
  for (let i = open + 1; i < acc.length; i++) {
    const c = acc[i]!;
    if (c === '\\') {
      const n = acc[i + 1];
      if (n === undefined) break;
      if (n === 'n') {
        out += '\n';
        i += 1; // 消费转义符本身；循环 i++ 越过被转义字符
      } else if (n === 'u' && i + 5 < acc.length) {
        const hex = acc.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5; // 指向第 4 个 hex 位；循环 i++ 落在转义序列之后
        } else {
          out += n;
          i += 1;
        }
      } else {
        out += n; // \" \\ 等
        i += 1;
      }
      continue;
    }
    if (c === '"') break; // 字段闭合
    out += c;
  }
  return out;
}

/** 转写节选载荷（SUMMARY_OPEN 返回；节选上限与总条数标注见 F7）。 */
export interface TranscriptExcerpt {
  source: TranscriptRow['source'];
  total: number;
  cues: { from: number; to: number; text: string }[];
  page?: number;
  unconfirmedText?: string;
}

export const TRANSCRIPT_EXCERPT_LIMIT = 200;

export function excerptOf(t: TranscriptRow | undefined, limit = TRANSCRIPT_EXCERPT_LIMIT, requestedPage = 0, videoDuration?: number): TranscriptExcerpt | undefined {
  if (!t) return undefined;
  if (hasAsrSemanticMismatch(t)) {
    const result=t.asrParts!.find(p=>p.whole===true && p.start===0)!.result;
    return {source:t.source,total:1,cues:[],unconfirmedText:result.text.trim()?result.text:result.utterances.map(u=>u.text).join('')};
  }
  if(t.source==='asr' && t.asrComplete!==true && !t.asrParts?.some(p=>p.whole===true) && t.cues.length===1 && t.cues[0]?.from===0 && videoDuration!==undefined && t.cues[0]?.to===videoDuration) return {source:t.source,total:1,cues:[],unconfirmedText:t.cues[0].text};
  const sentences=verifiedAsrSentences(t);
  if(sentences) {
    const size=Math.max(1,Math.min(TRANSCRIPT_EXCERPT_LIMIT,Math.floor(limit)||TRANSCRIPT_EXCERPT_LIMIT));
    const page=Math.min(Math.max(0,Number.isFinite(requestedPage)?Math.floor(requestedPage):0),Math.ceil(sentences.length/size)-1);
    return {source:t.source,total:sentences.length,page,cues:sentences.slice(page*size,(page+1)*size)};
  }
  return { source: t.source, total: t.cues.length, cues: t.cues.slice(0, limit) };
}

/** SUMMARY_OPEN 应答：详情载荷 = 列表行形状 + 转写节选（background 组装）。 */
export interface SummaryOpenResponse {
  ok: boolean;
  item?: ListQueryItem;
  transcript?: TranscriptExcerpt;
  asrCached?: boolean;
  recovery?: { status: 'available' | 'pending' | 'candidate' | 'running'; warning?: string; progress?: SummaryRow['asrProgress'] };
}
