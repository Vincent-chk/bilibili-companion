// P1.4 · Map-Reduce 长字幕摘要（架构 §3.5）：按 60% 上下文预算分块、块间 30s 重叠、
// Map 并发 ≤3 → Reduce 合并为结构化 JSON（复用 completeStructured 的校验/修复/降级链）。
// 参数口径沿用 BiliNote：预算按保守 24k 字符估（≈32k token 上下文模型的 60% 进单块）。
import type { LlmConfig } from '../llm/types';
import { streamChatCompletion } from '../llm/client';
import {
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
export function compactCues(cues: StoredCue[]): string {
  return cues.map((c) => `[${mmss(c.from)}]${c.text}`).join('\n');
}

/**
 * 分块：按 cue 文本累计长度切（块内 cue 原子、不拆行）；下一块开头回带上一块尾部
 * overlapSec 秒内的 cues（跨块语境衔接）。
 */
export function chunkCues(
  cues: StoredCue[],
  opts: { chunkChars?: number; overlapSec?: number } = {},
): StoredCue[][] {
  const { chunkChars = CHUNK_CHARS, overlapSec = OVERLAP_SEC } = opts;
  if (cues.length === 0) return [];
  const chunks: StoredCue[][] = [];
  let cur: StoredCue[] = [];
  let size = 0;
  for (const c of cues) {
    const len = c.text.length + 1; // 换行符计入预算
    if (size > 0 && size + len > chunkChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  for (let i = 1; i < chunks.length; i++) {
    const boundary = chunks[i]![0]!.from;
    const overlap = chunks[i - 1]!.filter((c) => c.to > boundary - overlapSec);
    chunks[i] = [...overlap, ...chunks[i]!];
  }
  return chunks;
}

const MAP_SYSTEM_PROMPT = `你是视频字幕片段分析器。把给出的字幕片段整理成要点清单，每条一行，格式 "[mm:ss] 要点（不超过30字）"。
只输出清单本身（8-15 行），不要解释、不要 Markdown。时间戳必须来自所给字幕。`;

async function runMap(cfg: LlmConfig, title: string, chunk: StoredCue[], opts: SummarizeOptions): Promise<string> {
  const r = await streamChatCompletion(
    cfg,
    [
      { role: 'system', content: MAP_SYSTEM_PROMPT },
      { role: 'user', content: `视频标题：${title}\n\n字幕片段（[mm:ss]文本）：\n${compactCues(chunk)}` },
    ],
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs },
  );
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
  const chunks = chunkCues(cues, { chunkChars: opts.chunkChars });
  const notes: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      const note = await runMap(cfg, videoMeta.title, chunks[i]!, opts);
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
      bodyLabel: '各段要点（[mm:ss]文本，已按时间合并）',
    }),
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, onDelta: opts.onDelta },
  );
}
