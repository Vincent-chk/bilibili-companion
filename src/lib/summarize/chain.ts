// P1.4 · 摘要生成完整链路（架构 §3.5 / 02-数据模型 §4.2）：
// 摘要缓存命中(零请求) → 字幕缓存(24h) → 选轨(无轨→need_asr) → 字幕归一落库
// → 单趟/Map-Reduce LLM → 结构化校验(修复1次/降级) → summaries 落库。
// 执行体为 Offscreen Document（见 entrypoints/offscreen）；本模块不碰 chrome API，依赖全注入可测。
import type { BiliClient, PlayerSubtitles, TranscriptCue } from '../bilibili/client';
import { selectTrack } from '../bilibili/track';
import { BiliApiError, pickPage } from '../bilibili/client';
import { LlmHttpError, LlmNetworkError } from '../llm/client';
import { summarize, type SummarizeOutcome } from '../llm/summary';
import type { LlmConfig, StreamEvent } from '../llm/types';
import { mapReduceSummarize, compactCues, SINGLE_PASS_THRESHOLD_CHARS, CHUNK_CHARS } from './mapReduce';
import { hasAsrSemanticMismatch, verifiedAsrSentences } from '../asr/doubao';
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
  signal?: AbortSignal;
  /** 流式增量（offscreen 转发面板打字机；P1.5 接线）。 */
  onDelta?: (text: string) => void;
  /** ASR 分段任务使用事务校验租约，避免结束或清除后迟到写回。 */
  persistSummary?: (row: SummaryRow) => Promise<void>;
  requireStructured?: boolean;
}

export interface ChainCtx {
  update: (patch: { stage?: JobStage; progress?: number }) => Promise<void>;
}

/** LLM 传输/HTTP 错误 → 可读错误码（F9/F11：401→Key 无效+去设置；429→限流重试；断网→挂起续跑）。
 *  P1.10：B 站 -101/-352 → NEED_LOGIN（F11 失败原因「需要登录」；登录后自动恢复按此码重排）。 */
export function mapLlmError(e: unknown): { code: string; msg: string } {
  if (e instanceof Error && e.message === 'ASR_CONTENT_UNCONFIRMED') return {code:'ASR_CONTENT_UNCONFIRMED',msg:'已有转写内容不一致，原文和旧摘要已保留；请检查后再处理'};
  if (e instanceof Error && e.message === 'SUBTITLE_UNAVAILABLE') return {code:'SUBTITLE_UNAVAILABLE',msg:'中文字幕轨暂不可访问，请检查登录状态或稍后重试'};
  if (e instanceof BiliApiError && (e.code === -101 || e.code === -352)) {
    return { code: 'NEED_LOGIN', msg: '需要登录 B 站才能取字幕，请先在本浏览器登录' };
  }
  // P2.6 F11：-412 → RISK_CONTROL（此前落 UNKNOWN 文案含技术细节不可读；熔断 60s 后自动恢复）
  if (e instanceof BiliApiError && e.code === -412) {
    return { code: 'RISK_CONTROL', msg: 'B 站风控拦截，冷却约 1 分钟后自动恢复' };
  }
  if (e instanceof BiliApiError && e.code === -499) return { code: 'PAUSED', msg: '陪看已暂停，恢复后继续' };
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
  const existing = await db.transcripts.get(videoKey);
  const mismatched = !!existing && hasAsrSemanticMismatch(existing);
  const cached = await getFreshTranscript(db, videoKey);
  const emptySubtitle = !!existing && existing.source !== 'asr' && !existing.asrParts?.length && !existing.asrPending && existing.cues.every(c => !c.text.trim());
  const discardEmptySubtitle = async () => {
    if (!emptySubtitle) return;
    await db.transaction('rw', db.transcripts, async () => {
      const current = await db.transcripts.get(videoKey);
      if (current && current.source !== 'asr' && !current.asrParts?.length && !current.asrPending && current.cues.every(c => !c.text.trim())) await db.transcripts.delete(videoKey);
    });
  };
  const legacyUntimed=cached?.source==='asr' && cached.asrComplete===undefined && !cached.asrParts?.some(p=>p.whole===true) && cached.cues.length===1 && cached.cues[0]?.from===0 && cached.cues[0]?.to===video.duration;
  if (cached && !legacyUntimed && !mismatched && !emptySubtitle) return { kind: 'ok', transcript: cached };
  const { bvid } = parseVideoKey(videoKey);
  await bili.fetchWbiKeys(); // player/wbi/v2 需 WBI 签名（nav 取 img/sub key，实例内缓存；T-5）
  const { subtitles, needLoginSubtitle }: PlayerSubtitles = await bili.getPlayerSubtitles(bvid, video.cid);
  const track = selectTrack(subtitles.filter(t=>!!t.subtitle_url));
  if (!track) {
    if (needLoginSubtitle === true) throw new BiliApiError(-101, 'subtitle');
    if (selectTrack(subtitles)) throw new Error('SUBTITLE_UNAVAILABLE');
    if (mismatched) throw new Error('ASR_CONTENT_UNCONFIRMED');
    await discardEmptySubtitle();
    return { kind: 'no-track' };
  }
  if (!track.subtitle_url) throw new Error('SUBTITLE_UNAVAILABLE');
  const raw: TranscriptCue[] = await bili.fetchTranscript(track.subtitle_url);
  const cues: StoredCue[] = raw.map((c) => ({ from: c.from, to: c.to, text: c.content }));
  if (cues.length === 0) {
    if (mismatched) throw new Error('ASR_CONTENT_UNCONFIRMED');
    await discardEmptySubtitle();
    return { kind: 'empty' };
  }
  const source: TranscriptSource = track.lan?.startsWith('ai') ? 'ai_sub' : 'manual_sub';
  const transcript: TranscriptRow = {
    key: videoKey,
    source,
    lan: track.lan ?? '',
    cues,
    charCount: cues.reduce((n, c) => n + c.text.length + 1, 0),
    cachedAt: Date.now(),
  };
  // 已有冲突 ASR 原文必须保留；真实字幕可临时参与摘要，不能覆盖未确认原始数据。
  if (!mismatched) await db.transcripts.put(transcript);
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
  const previous = await db.summaries.get(skey);

  // F5 幂等：done 摘要直接完成，零 LLM/字幕请求（换模型=换 key 自然重跑）；force=2.7a 重新生成绕过
  if (!opts.force && (await db.summaries.get(skey))?.status === 'done') return { result: 'done' };

  // 2.7a 审查 P0-1/P1-1/P2-4：force 时锁定「旧 done 行是否须保留」——口径 = videoKey 下 createdAt
  // 最新行（与 latestSummary/broadcastSegmentTerminal/runSegmentJob 取行一致；按当前模型 skey 会在
  // 多模型场景误顶掉展示中的旧模型 done 行）。所有非成功出口（need_asr/NO_CONTENT/degraded/异常）
  // 一律保留旧行：旧摘要与分段注记是不可逆数据；错误只落 job 行，busy 守卫随终态解除、可重试。
  let keepDone = false;
  if (opts.force) {
    const prev = (await db.summaries.where('videoKey').equals(job.videoKey).sortBy('createdAt')).pop();
    keepDone = prev?.status === 'done';
  }

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
    ...(previous?.asrProgress?.unconfirmed?.length ? {asrProgress: previous.asrProgress} : {}),
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
      // 审查 P0-1：force+旧 done → 不得整行覆盖成 need_asr（旧摘要+注记不可逆丢失，且 need_confirm
      // 属活动态会卡死 busy 守卫）——返回 failed 保留旧行
      if (keepDone) {
        return { result: 'failed', error: { code: 'NO_SUBTITLE', msg: '字幕轨当前不可用，未能重新生成（旧摘要已保留）' } };
      }
      // F6：无字幕轨 → 橙色待确认。source 暂记 'asr'（用户确认后实际来源即 asr）
      await db.summaries.put({ ...baseSummary, source: 'asr', status: 'need_asr', ...(!opts.force ? {error: previous?.error?.code === 'ASR_DECLINED' ? previous.error : {code:'AUTO_ASR_PENDING',msg:'字幕不可用，等待语音识别'}} : {}) });
      return { result: 'need_confirm' };
    }
    if (tr.kind === 'empty') {
      if (keepDone) return { result: 'failed', error: { code: 'NO_CONTENT', msg: '字幕轨内容为空，未能重新生成（旧摘要已保留）' } };
      await db.summaries.put({ ...baseSummary, source: 'asr', status: 'need_asr', error: !opts.force ? (previous?.error?.code === 'ASR_DECLINED' ? previous.error : {code:'AUTO_ASR_PENDING',msg:'字幕内容为空，等待语音识别'}) : {code:'EMPTY_SUBTITLE',msg:'字幕内容为空，可选择语音识别'} });
      return { result: 'need_confirm' };
    }
    const transcript = tr.transcript;
    // P2.3 起本段与 ASR 链共用（runLlmAndPersist）：转写→LLM→校验→落库的单一实现
    return await runLlmAndPersist(deps, ctx, { video, transcript, baseSummary, keepDone });
  } catch (e) {
    const error = mapLlmError(e);
    // 2.7a：force 重生成失败不覆盖旧 done 摘要（keepDone 在 try 前锁定，审查 P0-1/P1-1：
    // 口径=videoKey 最新行，多模型安全）；成功路径的 put 为整行替换——segmentNotes 不在
    // baseSummary 中，分段缓存随重生成自然失效清空
    if (!keepDone) {
      await db.summaries.put({ ...baseSummary, status: 'failed', error });
    }
    return { result: 'failed', error };
  }
}

/**
 * P2.3 抽取（SUMMARIZE 与 ASR_SUMMARIZE 共用）：已有 transcript → LLM（单趟/Map-Reduce）
 * → 结构化校验/降级 → summaries 落库。keepDone=失败不覆盖旧 done 行（2.7a 审查 P0-1 语义）。
 */
export async function runLlmAndPersist(
  deps: SummarizeChainDeps,
  ctx: ChainCtx,
  input: {
    video: VideoRow;
    transcript: TranscriptRow;
    baseSummary: Omit<SummaryRow, 'status'>;
    keepDone: boolean;
  },
): Promise<JobOutcome> {
  const { db, llm } = deps;
  const persist = deps.persistSummary ?? (async (row: SummaryRow) => { await db.summaries.put(row); });
  const { video, transcript, baseSummary, keepDone } = input;
  if (hasAsrSemanticMismatch(transcript)) return {result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED',msg:'已有转写内容不一致，原文和旧摘要已保留；请检查后再处理'}};
  if (transcript.source === 'asr') {
    const chars=transcript.cues.reduce((n,c)=>n+Array.from(c.text.replace(/[\s\p{P}\p{S}]/gu,'')).length,0);
    if(chars<=5){
      const error=chars===0?{code:'ASR_NO_SPEECH',msg:'该音频未识别到可用语音'}:{code:'ASR_TOO_SHORT',msg:'识别到了少量语音，但内容不足以生成可靠摘要'};
      if(!keepDone&&!deps.requireStructured)await persist({...baseSummary,source:'asr',status:'failed',error});
      return {result:'failed',error};
    }
  }
  const persona = deps.persona ?? 'spicy';
  if (deps.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
  await ctx.update({ stage: 'llm_map', progress: 45 });

  const sentences = verifiedAsrSentences(transcript, true);
  const usableSentences = sentences && sentences.every(c => compactCues([c], true).length + 1 <= CHUNK_CHARS) ? sentences : null;
  const summaryCues = usableSentences ?? transcript.cues;
  const meta = { title: video.title, duration: video.duration, cueCount: summaryCues.length };
  const timed = summaryCues.filter(c => c.text.trim() && Number.isFinite(c.from) && Number.isFinite(c.to) && c.from >= 0 && c.to >= c.from);
  const bounds = timed.reduce((r,c) => ({from:Math.min(r.from,c.from),to:Math.max(r.to,c.to)}), {from:Infinity,to:-Infinity});
  const span = bounds.to - bounds.from;
  const outlineCoverage = timed.length > 1 && span > 0 ? {
    ...bounds,
    includeMiddle:timed.some(c=>c.from>=bounds.from+span*.25 && c.from<=bounds.from+span*.75),
    includeEnd:timed.some(c=>c.from>=bounds.from+span*.75),
  } : undefined;
  const llmOpts = {
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
    persona,
    ...(usableSentences ? { anchorAsrTopics: true } : {}),
    ...(transcript.source === 'asr' ? { outlineTimeLimit: video.duration, asrTranscript: true } : {}),
    ...(outlineCoverage ? { outlineCoverage } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.onDelta
      ? { onDelta: (ev: StreamEvent) => { if (ev.type === 'delta') deps.onDelta?.(ev.text); } }
      : {}),
  };
  let outcome: SummarizeOutcome;
  const seconds = transcript.source === 'asr';
  const text = compactCues(summaryCues,seconds);
  if (text.length <= SINGLE_PASS_THRESHOLD_CHARS) {
    outcome = await summarize(llm, meta, text, {...llmOpts,...(seconds?{bodyLabel:'紧凑字幕（[N秒]文本，N 为总秒数）'}:{})});
  } else {
    outcome = await mapReduceSummarize(llm, meta, summaryCues, llmOpts);
  }
  if (deps.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
  // 真实 LLM 补验指标（offscreen console → E2E console.json 采集；ttft=首 content token，不含 reasoning）
  console.log(
    `[doubao] llm summarize ttft=${outcome.ttftMs ?? -1}ms attempts=${outcome.attempts} degraded=${outcome.degraded} usage=${JSON.stringify(outcome.usage ?? null)}`,
  );
  await ctx.update({ stage: 'llm_reduce', progress: 90 });
  if (deps.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');

  if (outcome.degraded || !outcome.summaryResult) {
    if (deps.requireStructured) return {result:'failed',error:{code:'DEGRADED',msg:'全片摘要、大纲或点评未完整生成'}};
    // 审查 P2-4：force+旧 done → 不以降级纯文本（outline=[]）换掉旧结构化摘要+注记
    if (keepDone) {
      return { result: 'failed', error: { code: 'DEGRADED', msg: '重生成输出未通过校验，旧摘要已保留，可稍后重试' } };
    }
    // 结构化内容截断或损坏时，不能把 JSON 当正文，也不能伪装成成功。
    if (!outcome.plainText?.trim()) {
      const error = { code: 'DEGRADED', msg: '摘要生成不完整，请点击重新生成' };
      await persist({ ...baseSummary, source: transcript.source, status: 'failed', error });
      return { result: 'failed', error };
    }
    // 降级纯文本（F5：不白屏）：summary=前600字、outline 置空
    await persist({
      ...baseSummary,
      source: transcript.source,
      summary: outcome.plainText ?? '',
      status: 'done',
    });
    return { result: 'done' };
  }
  const r = outcome.summaryResult;
  // 重生成仅得到少于建议数量且比旧版更少的要点时，不丢弃旧大纲与分段解读。
  if (keepDone && r.outline.length < 6) {
    const previous = (await db.summaries.where('videoKey').equals(video.key).sortBy('createdAt')).pop();
    if (deps.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
    if (previous?.status === 'done' && r.outline.length < previous.outline.length) {
      return { result: 'failed', error: { code: 'DEGRADED', msg: '新大纲不完整，旧摘要已保留，可重新生成' } };
    }
  }
  await persist({
    ...baseSummary,
    source: transcript.source,
    summary: r.summary,
    outline: r.outline,
    evaluation: r.evaluation,
    rating: r.rating,
    status: 'done',
  });
  return { result: 'done' };
}
