// P1.4 · 摘要生成完整链路（架构 §3.5 / 02-数据模型 §4.2）：
// 摘要缓存命中(零请求) → 字幕缓存(24h) → 选轨(无轨→need_asr) → 字幕归一落库
// → 单趟/Map-Reduce LLM → 结构化校验(修复1次/降级) → summaries 落库。
// 执行体为 Offscreen Document（见 entrypoints/offscreen）；本模块不碰 chrome API，依赖全注入可测。
import type { BiliClient, PlayerSubtitles, TranscriptCue, VideoView } from '../bilibili/client';
import { selectTrack } from '../bilibili/track';
import { BiliApiError, pickPage } from '../bilibili/client';
import { LlmHttpError, LlmNetworkError } from '../llm/client';
import { summarize, type SummarizeOutcome } from '../llm/summary';
import type { LlmConfig, StreamEvent } from '../llm/types';
import { mapReduceSummarize, compactCues, SINGLE_PASS_THRESHOLD_CHARS } from './mapReduce';
import {
  CompanionDB,
  getFreshTranscript,
  summaryKey,
  type JobStage,
  type StoredCue,
  type SummaryRow,
  type TranscriptRow,
  type TranscriptSource,
  type VideoRow,
} from '../storage';
import type { JobOutcome } from '../pipeline';

/** Bili 接口的最小面（BiliClient 天然满足；测试注入 fake）。 */
export type BiliApi = Pick<BiliClient, 'fetchWbiKeys' | 'getView' | 'getPlayerSubtitles' | 'fetchTranscript'>;

export interface SummarizeChainDeps {
  db: CompanionDB;
  bili: BiliApi;
  llm: LlmConfig;
  persona?: string;
  fetchImpl?: typeof fetch;
  /** 整流超时（SW resolveConfig → offscreen 透传；思考型真实模型需 > 默认 60s）。 */
  timeoutMs?: number;
  /** 流式增量（offscreen 转发面板打字机；P1.5 接线）。 */
  onDelta?: (text: string) => void;
}

export interface ChainCtx {
  update: (patch: { stage?: JobStage; progress?: number }) => Promise<void>;
}

/** LLM 传输/HTTP 错误 → 可读错误码（F9/F11：401→Key 无效+去设置；429→限流重试；断网→挂起续跑）。
 *  P1.10：B 站 -101/-352 → NEED_LOGIN（F11 失败原因「需要登录」；登录后自动恢复按此码重排）。 */
export function mapLlmError(e: unknown): { code: string; msg: string } {
  if (e instanceof BiliApiError && (e.code === -101 || e.code === -352)) {
    return { code: 'NEED_LOGIN', msg: '需要登录 B 站才能取字幕，请先在本浏览器登录' };
  }
  if (e instanceof LlmHttpError) {
    if (e.status === 401 || e.status === 403) return { code: 'KEY_INVALID', msg: 'LLM Key 无效或无权限，请到设置检查' };
    if (e.status === 402) return { code: 'NO_BALANCE', msg: 'LLM 余额不足' };
    if (e.status === 429) return { code: 'RATE_LIMITED', msg: 'LLM 限流，稍后自动重试' };
    return { code: 'LLM_HTTP', msg: `LLM HTTP ${e.status}: ${e.body}` };
  }
  if (e instanceof LlmNetworkError) return { code: 'LLM_NETWORK', msg: e.message.slice(0, 150) };
  return { code: 'UNKNOWN', msg: String(e).slice(0, 150) };
}

/** videoKey `${bvid}:${cid}` 拆解（bvid 不含冒号）。 */
export function parseVideoKey(videoKey: string): { bvid: string; cid: number } {
  const i = videoKey.lastIndexOf(':');
  if (i <= 0) throw new Error(`videoKey 格式非法：${videoKey}`);
  const bvid = videoKey.slice(0, i);
  const cid = Number(videoKey.slice(i + 1));
  if (!bvid || !Number.isFinite(cid)) throw new Error(`videoKey 格式非法：${videoKey}`);
  return { bvid, cid };
}

export type EnsureTranscriptResult =
  | { kind: 'ok'; transcript: TranscriptRow }
  | { kind: 'no-track' } // 无字幕轨（F6 待确认 / 分段解读不可用）
  | { kind: 'empty' }; // 有轨但内容为空

/**
 * 字幕缓存 24h；未命中 → WBI keys → 选轨 → 抓取 → 归一落库（P1.11 起 SUMMARIZE 与
 * SEGMENT_ANALYZE 共用，根因单点）。不写 summaries 行——调用方按 kind 自行定语义。
 */
export async function ensureTranscript(
  db: CompanionDB,
  bili: BiliApi,
  videoKey: string,
  video: VideoRow,
): Promise<EnsureTranscriptResult> {
  const cached = await getFreshTranscript(db, videoKey);
  if (cached) return { kind: 'ok', transcript: cached };
  const { bvid } = parseVideoKey(videoKey);
  await bili.fetchWbiKeys(); // player/wbi/v2 需 WBI 签名（nav 取 img/sub key，实例内缓存；T-5）
  const { subtitles }: PlayerSubtitles = await bili.getPlayerSubtitles(bvid, video.cid);
  const track = selectTrack(subtitles);
  if (!track?.subtitle_url) return { kind: 'no-track' };
  const raw: TranscriptCue[] = await bili.fetchTranscript(track.subtitle_url);
  const cues: StoredCue[] = raw.map((c) => ({ from: c.from, to: c.to, text: c.content }));
  if (cues.length === 0) return { kind: 'empty' };
  const source: TranscriptSource = track.lan?.startsWith('ai') ? 'ai_sub' : 'manual_sub';
  const transcript: TranscriptRow = {
    key: videoKey,
    source,
    lan: track.lan ?? '',
    cues,
    charCount: cues.reduce((n, c) => n + c.text.length + 1, 0),
    cachedAt: Date.now(),
  };
  await db.transcripts.put(transcript);
  return { kind: 'ok', transcript };
}

export async function runSummarizeJob(
  deps: SummarizeChainDeps,
  job: { videoKey: string },
  ctx: ChainCtx,
  opts: { force?: boolean } = {},
): Promise<JobOutcome> {
  const { db, bili, llm } = deps;
  const { bvid, cid } = parseVideoKey(job.videoKey);
  const skey = summaryKey(job.videoKey, llm.model);
  const now = Date.now();
  const persona = deps.persona ?? 'spicy';

  // F5 幂等：done 摘要直接完成，零 LLM/字幕请求（换模型=换 key 自然重跑）；force=2.7a 重新生成绕过
  if (!opts.force && (await db.summaries.get(skey))?.status === 'done') return { result: 'done' };

  const baseSummary: Omit<SummaryRow, 'status'> = {
    key: skey,
    videoKey: job.videoKey,
    source: 'ai_sub',
    summary: '',
    outline: [],
    evaluation: '',
    rating: 0,
    modelId: llm.model,
    persona,
    createdAt: now,
  };

  try {
    await ctx.update({ stage: 'subtitle', progress: 10 });

    // videos 行兜底（正常路径 VIDEO_ENTER 已写入；24h 过期也在此刷新）。按 job 的 cid 选页，
    // 多 P 时不能默认 P1（否则会用 P1 的 cid 取字幕、内容却存进该 P 的键下）
    let video = await db.videos.get(job.videoKey);
    if (!video) {
      const v = await bili.getView(bvid);
      const pg = v.pages.find((p) => p.cid === cid) ?? pickPage(v.pages, 1);
      video = {
        key: job.videoKey,
        bvid,
        aid: v.aid,
        cid: pg?.cid ?? cid,
        title: v.title,
        cover: v.cover,
        owner: v.owner,
        duration: pg?.duration ?? v.duration,
        page: pg?.page ?? 1,
        fetchedAt: now,
      } satisfies VideoRow;
      await db.videos.put(video);
    }

    // 字幕缓存 24h；未命中→选轨→抓取→归一落库（P1.11 起与分段解读共用 ensureTranscript）
    const tr = await ensureTranscript(db, bili, job.videoKey, video);
    if (tr.kind === 'no-track') {
      // F6：无字幕轨 → 橙色待确认。source 暂记 'asr'（用户确认后实际来源即 asr）
      await db.summaries.put({ ...baseSummary, source: 'asr', status: 'need_asr' });
      return { result: 'need_confirm' };
    }
    if (tr.kind === 'empty') {
      const err = { code: 'NO_CONTENT', msg: '字幕轨内容为空' };
      await db.summaries.put({ ...baseSummary, status: 'failed', error: err });
      return { result: 'failed', error: err };
    }
    const transcript = tr.transcript;
    await ctx.update({ stage: 'llm_map', progress: 45 });

    const meta = { title: video.title, duration: video.duration, cueCount: transcript.cues.length };
    const llmOpts = {
      fetchImpl: deps.fetchImpl,
      persona,
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.onDelta
        ? { onDelta: (ev: StreamEvent) => { if (ev.type === 'delta') deps.onDelta?.(ev.text); } }
        : {}),
    };
    let outcome: SummarizeOutcome;
    if (transcript.charCount <= SINGLE_PASS_THRESHOLD_CHARS) {
      outcome = await summarize(llm, meta, compactCues(transcript.cues), llmOpts);
    } else {
      outcome = await mapReduceSummarize(llm, meta, transcript.cues, llmOpts);
    }
    // 真实 LLM 补验指标（offscreen console → E2E console.json 采集；ttft=首 content token，不含 reasoning）
    console.log(
      `[doubao] llm summarize ttft=${outcome.ttftMs ?? -1}ms attempts=${outcome.attempts} degraded=${outcome.degraded} usage=${JSON.stringify(outcome.usage ?? null)}`,
    );
    await ctx.update({ stage: 'llm_reduce', progress: 90 });

    if (outcome.degraded || !outcome.summaryResult) {
      // 降级纯文本（F5：不白屏）：summary=前600字、outline 置空
      await db.summaries.put({
        ...baseSummary,
        source: transcript.source,
        summary: outcome.plainText ?? '',
        status: 'done',
      });
      return { result: 'done' };
    }
    const r = outcome.summaryResult;
    await db.summaries.put({
      ...baseSummary,
      source: transcript.source,
      summary: r.summary,
      outline: r.outline,
      evaluation: r.evaluation,
      rating: r.rating,
      status: 'done',
    });
    return { result: 'done' };
  } catch (e) {
    const error = mapLlmError(e);
    // 2.7a：force 重生成失败不覆盖旧 done 摘要（F11 友好：面板保留旧内容，错误只落 job 行/徽章）；
    // 成功路径的 put 为整行替换——segmentNotes 不在 baseSummary 中，分段缓存随重生成自然失效清空
    if (!(opts.force && (await db.summaries.get(skey))?.status === 'done')) {
      await db.summaries.put({ ...baseSummary, status: 'failed', error });
    }
    return { result: 'failed', error };
  }
}
