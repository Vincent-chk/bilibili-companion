// P2.3 · ASR 确认流执行体（架构 §4.2 / 02-数据模型 §4.3）：
// playurl 取音轨（bandwidth 最小档+域优先级）→ background/offscreen fetch 音频（DNR 已补 Referer）
// → **仅内存 ArrayBuffer**（零落盘红线）→ 上传 /audio/transcriptions → 归一 cues（transcripts 落库
// source=asr）→ 复用 runLlmAndPersist 出摘要。执行体=offscreen（音频 fetch+上传均为长任务）。
import { mapAsrError, pickAudioStream, transcribeAudio, type AsrConfig } from '../asr';
import { LlmHttpError, LlmNetworkError } from '../llm/client';
import type { BiliApi } from './chain';
import { mapLlmError, parseVideoKey, runLlmAndPersist, type ChainCtx, type SummarizeChainDeps } from './chain';
import { summaryKey, type SummaryRow, type TranscriptRow, type VideoRow } from '../storage';
import type { JobOutcome } from '../pipeline';
import { pickPage } from '../bilibili/client';

export type AsrBiliApi = BiliApi & Pick<import('../bilibili/client').BiliClient, 'getPlayUrlAudio'>;

export interface AsrJobDeps extends SummarizeChainDeps {
  bili: AsrBiliApi;
  asr: AsrConfig;
  /** 音频上限 MB（settings.asrMaxMB，默认 25 ≈ 50 分钟最低档，02-数据模型 §4.3）。 */
  asrMaxMB: number;
  /** 音频下载实现（offscreen fetch 带 host_permissions；测试注入 fake）。 */
  fetchAudio?: typeof fetch;
}

export const LOW_CONTENT_CHARS = 50; // 转写 <50 字 → 几乎无语音内容（F6-⑧）

/**
 * ASR_SUMMARIZE job：need_asr 行 → ASR 摘要（source=asr）。
 * 失败口径：音频链失败保留 need_asr 行（用户可重试）；LOW_CONTENT 落 failed 行（终态、文案明确）。
 */
export async function runAsrJob(deps: AsrJobDeps, job: { videoKey: string }, ctx: ChainCtx): Promise<JobOutcome> {
  const { db, bili, asr } = deps;
  const { bvid, cid } = parseVideoKey(job.videoKey);
  const now = Date.now();
  const persona = deps.persona ?? 'spicy';
  const maxBytes = deps.asrMaxMB * 1024 * 1024;
  const baseSummary: Omit<SummaryRow, 'status'> = {
    key: summaryKey(job.videoKey, deps.llm.model),
    videoKey: job.videoKey,
    source: 'asr',
    summary: '',
    outline: [],
    evaluation: '',
    rating: 0,
    modelId: deps.llm.model,
    persona,
    createdAt: now,
  };

  // 审查 P2-7：done 缓存守卫——陈旧确认卡二次点击/广播竞态下不整链重跑（下载+转写=真实计费）
  const latest = (await db.summaries.where('videoKey').equals(job.videoKey).sortBy('createdAt')).pop();
  if (latest?.status === 'done') return { result: 'done' };

  try {
    await ctx.update({ stage: 'audio', progress: 10 });

    // videos 行兜底（与 SUMMARIZE 链同口径：按 job 的 cid 选页）
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

    // playurl 需 WBI 签名（T-5 同款坑：ASR 链不经 ensureTranscript，须先取 keys）
    await bili.fetchWbiKeys();
    const streams = await bili.getPlayUrlAudio(bvid, video.cid);
    const picked = pickAudioStream(streams);
    if (!picked) return { result: 'failed', error: { code: 'NO_AUDIO', msg: '该视频无法获取可用音频流' } };

    // 音频仅内存中转（F6-⑤ 零落盘）；DNR 静态域规则已为 bilivideo.com/.cn 补 Referer（架构 §3.8）
    const fetchAudio = deps.fetchAudio ?? fetch.bind(globalThis);
    const res = await fetchAudio(picked.url, { credentials: 'omit' });
    if (!res.ok) return { result: 'failed', error: { code: 'AUDIO_HTTP', msg: `音频下载失败（HTTP ${res.status}）` } };
    // 审查 P2-6：Content-Length 前置拦截（超长视频不整段进内存再丢弃）；下载后仍有兜底校验
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      return {
        result: 'failed',
        error: { code: 'AUDIO_TOO_LARGE', msg: `视频过长暂不支持（音频约 ${(declared / 1048576).toFixed(0)}MB，超过 ${deps.asrMaxMB}MB 上限）` },
      };
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      return {
        result: 'failed',
        error: { code: 'AUDIO_TOO_LARGE', msg: `视频过长暂不支持（音频约 ${(bytes.byteLength / 1048576).toFixed(0)}MB，超过 ${deps.asrMaxMB}MB 上限）` },
      };
    }

    await ctx.update({ stage: 'asr', progress: 40 });
    const { cues, text } = await transcribeAudio(
      asr,
      { bytes, filename: audioFilename(picked.url) },
      video.duration,
      { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs },
    );

    if (text.length < LOW_CONTENT_CHARS) {
      // F6-⑧：摘要行 failed 明确提示。审查 P2-5：不写 transcripts——若写，<50 字缓存会让
      // SUMMARIZE 重试命中并把「很短」直接喂 LLM 生成幻觉摘要，覆盖本终态；重试语义=重新确认 ASR
      await db.summaries.put({
        ...baseSummary,
        status: 'failed',
        error: { code: 'LOW_CONTENT', msg: '该视频几乎没有可解析的语音内容' },
      });
      return { result: 'failed', error: { code: 'LOW_CONTENT', msg: '该视频几乎没有可解析的语音内容' } };
    }

    const transcript = await putAsrTranscript(db, job.videoKey, cues);
    // 复用字幕链的 LLM→校验→落库（keepDone=false：need_asr 行本非 done，成功即整行覆盖）
    return await runLlmAndPersist(deps, ctx, { video, transcript, baseSummary, keepDone: false });
  } catch (e) {
    // 审查 P1-2：LLM 阶段失败沿用字幕链映射（KEY_INVALID 等）并落 failed 行——
    // 转 mapAsrError 会得 UNKNOWN 且保留 need_asr，用户重试=重新下载+重新转写（再次计费）
    if (e instanceof LlmHttpError || e instanceof LlmNetworkError) {
      const error = mapLlmError(e);
      await db.summaries.put({ ...baseSummary, status: 'failed', error });
      return { result: 'failed', error };
    }
    const error = mapAsrError(e);
    // 音频/转写链失败：保留 need_asr 行（用户可再点确认重试）；错误只落 job 行
    console.log(`[doubao] asr chain failed: ${error.code}: ${error.msg}`);
    return { result: 'failed', error };
  }
}

async function putAsrTranscript(
  db: AsrJobDeps['db'],
  videoKey: string,
  cues: TranscriptRow['cues'],
): Promise<TranscriptRow> {
  const row: TranscriptRow = {
    key: videoKey,
    source: 'asr',
    lan: 'asr',
    cues,
    charCount: cues.reduce((n, c) => n + c.text.length + 1, 0),
    cachedAt: Date.now(),
  };
  await db.transcripts.put(row);
  return row;
}

/** URL → 上传文件名（保留容器扩展名，服务端按扩展识别格式；默认 m4a——B 站 DASH 音轨为 mp4 容器）。 */
function audioFilename(url: string): string {
  const m = url.split('?')[0]?.match(/\.(\w+)$/);
  return `audio.${m?.[1] === 'm4s' ? 'm4a' : (m?.[1] ?? 'm4a')}`;
}
