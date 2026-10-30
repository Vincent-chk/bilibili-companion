// P1.4 · Map-Reduce 长字幕摘要（架构 §3.5）：按 60% 上下文预算分块、块间 30s 重叠、
// Map 并发 ≤3 → Reduce 合并为结构化 JSON（复用 completeStructured 的校验/修复/降级链）。
// 参数口径沿用 BiliNote：预算按保守 24k 字符估（≈32k token 上下文模型的 60% 进单块）。
import type { LlmConfig } from '../llm/types';
import { LlmNetworkError, streamChatCompletion } from '../llm/client';
import {
  ASR_SCOPE_INSTRUCTION,
  buildSummaryMessages,
  completeStructured,
  type SummarizeOptions,
  type SummarizeOutcome,
  type SummaryVideoMeta,
} from '../llm/summary';
import type { StoredCue } from '../storage';

export const CONTEXT_BUDGET_CHARS = 24_000;
export const CHUNK_CHARS = Math.floor(CONTEXT_BUDGET_CHARS * 0.6); // 14400
export const OVERLAP_SEC = 30;
export const MAP_CONCURRENCY = 3;

/** 单趟阈值：字幕总字符 ≤ 此值不走 Map-Reduce（chain 判定用）。 */
export const SINGLE_PASS_THRESHOLD_CHARS = CHUNK_CHARS;

const mmss = (sec: number): string => {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** cues → "[mm:ss]text" 行（LLM 输入的紧凑格式，单趟与 Map 共用）。 */
export function compactCues(cues: StoredCue[], seconds = false): string {
  return cues.map((c) => `[${seconds ? `${Math.floor(c.from)}秒` : mmss(c.from)}]${c.text}`).join('\n');
}

/**
 * 分块：按 cue 文本累计长度切（块内 cue 原子、不拆行）；下一块开头回带上一块尾部
 * overlapSec 秒内的 cues（跨块语境衔接）。
 */
export function chunkCues(
  cues: StoredCue[],
  opts: { chunkChars?: number; overlapSec?: number; seconds?: boolean } = {},
): StoredCue[][] {
  const { chunkChars = CHUNK_CHARS, overlapSec = OVERLAP_SEC, seconds = false } = opts;
  if (cues.length === 0) return [];
  const chunks: StoredCue[][] = [];
  let cur: StoredCue[] = [];
  let size = 0;
  for (const c of cues) {
    const len = compactCues([c],seconds).length + 1; // 时间戳和换行也占上下文
    if (size > 0 && size + len > chunkChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
      // 重叠必须和新内容一起落入预算；从最近的 cue 向前回带。
      const previous=chunks.at(-1)!;
      for(let i=previous.length-1;i>=0;i--){
        const old=previous[i]!;
        if(old.to<=c.from-overlapSec)break;
        const oldLen=compactCues([old],seconds).length+1;
        if(size+oldLen+len>chunkChars)break;
        cur.unshift(old);size+=oldLen;
      }
    }
    cur.push(c);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const MAP_SYSTEM_PROMPT = `你是视频字幕片段分析器。把给出的字幕片段整理成要点清单，每条一行，格式 "[mm:ss] 要点（不超过30字）"。
只输出清单本身（8-15 行），不要解释、不要 Markdown。时间戳必须来自所给字幕。`;

export async function runMap(cfg: LlmConfig, title: string, chunk: StoredCue[], opts: SummarizeOptions): Promise<string> {
  const seconds=opts.outlineTimeLimit !== undefined;
  const system=seconds ? '你是视频字幕片段分析器。把给出的字幕片段整理成要点清单，每条一行，格式 "[N秒] 要点（不超过30字）"。N 是字幕标签中出现的整数总秒数，直接照抄，例如 [612秒] 表示视频的第 612 秒。不要使用分:秒格式，不要虚构时间。只输出清单本身（8-15 行），不要解释、不要 Markdown。' : MAP_SYSTEM_PROMPT;
  const r = await streamChatCompletion(
    cfg,
    [
      { role: 'system', content: system + (opts.anchorAsrTopics ? ' 每条要点找到其主题首次明确出现的原文，使用对应句子开头的时间标签，不要以之后的演示、结果或总结时间代替。' : '') + (opts.asrTranscript ? `\n${ASR_SCOPE_INSTRUCTION}` : '') },
      { role: 'user', content: `视频标题：${title}\n本片段时间范围 ${Math.floor(chunk[0]?.from ?? 0)}–${Math.ceil(chunk.at(-1)?.to ?? 0)}秒。请覆盖整段到结尾的关键内容，不要只整理开头。\n\n字幕片段（${seconds?'[N秒]':'[mm:ss]'}文本）：\n${compactCues(chunk,seconds)}` },
    ],
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, signal: opts.signal, disableThinking: true },
  );
  if (!r.text.trim()) throw new Error('字幕分块要点为空，请重试');
  return r.text;
}

export interface MapReduceOptions extends SummarizeOptions {
  chunkChars?: number;
  mapConcurrency?: number;
  persona?: string;
  /** 观察 Map 阶段（单测用）。 */
  onMapComplete?: (chunkIndex: number, note: string) => void;
}

/** Map（并发 ≤3，任一块传输失败整体抛出）→ Reduce（结构化 + 校验失败重发 + 降级）。 */
export async function mapReduceSummarize(
  cfg: LlmConfig,
  videoMeta: SummaryVideoMeta,
  cues: StoredCue[],
  opts: MapReduceOptions = {},
): Promise<SummarizeOutcome> {
  const seconds=opts.outlineTimeLimit !== undefined;
  const chunks = chunkCues(cues, { chunkChars: opts.chunkChars,seconds });
  // 审查 P1-2：Map(N 块并发≤3)+Reduce 共享 timeoutMs 总预算——否则最坏 (N+1)×timeoutMs 击穿 SW 600s 看门狗
  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
  const remaining = (): number | undefined =>
    deadline === undefined ? undefined : Math.max(1_000, deadline - Date.now());
  const notes: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
      const i = next++;
      if (i >= chunks.length) return;
      const note = await runMap(cfg, videoMeta.title, chunks[i]!, { ...opts, timeoutMs: remaining() });
      if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
      notes[i] = note;
      opts.onMapComplete?.(i, note);
    }
  };
  const workers = Array.from(
    { length: Math.min(opts.mapConcurrency ?? MAP_CONCURRENCY, chunks.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return completeStructured(
    cfg,
    buildSummaryMessages(videoMeta, notes.join('\n'), {
      persona: opts.persona,
      outlineCoverage: opts.outlineCoverage,
      anchorAsrTopics: opts.anchorAsrTopics,
      anchorAsrReduce: opts.anchorAsrTopics,
      asrTranscript: opts.asrTranscript,
      bodyLabel: seconds ? '各段要点（[N秒]文本，N 为总秒数，已按时间合并）' : '各段要点（[mm:ss]文本，已按时间合并）',
    }),
    { fetchImpl: opts.fetchImpl, timeoutMs: remaining(), onDelta: opts.onDelta, signal: opts.signal, outlineCoverage: opts.outlineCoverage, outlineTimeLimit:opts.outlineTimeLimit },
  );
}
