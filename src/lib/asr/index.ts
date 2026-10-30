// P2.3 · ASR 模块（架构 §3.6 / 02-数据模型 §4.3）：
// 音频选源（bandwidth 最小档 + 域优先级，07 报告 G-3）→ 转写归一化（verbose_json 优先，
// 退化 json 整段文本）→ 错误映射（Key 无效/过长/超时）。纯逻辑无 chrome API，依赖注入可测。
// 音频本体只经调用方内存在传（ArrayBuffer），本模块不落任何存储（F12 音频零落盘红线）。
import type { DashAudioStream } from '../bilibili/client';
import type { StoredCue } from '../storage';

// ---- 选源（架构 §3.8：域可枚举优先，第三方边缘域默认不选） ------------------------

/** URL 域优先级：1 upos-sz-*（传统 CDN 首选）2 *.mcdn.bilivideo.cn（MCDN）3 其余 bilivideo.com/.cn；
 *  第三方边缘域（*.edge.mountaintoys.cn 等，一次性随机子域无法枚举）= 4 默认不选。
 *  白名单四域封闭枚举的约束下只能规避不能通配（风险合规 §数据流白名单）。 */
export function urlHostClass(url: string): number {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return 4;
  }
  if (/^upos-sz-[a-z0-9-]*\.bilivideo\.com$/.test(host)) return 1;
  if (/(^|\.)mcdn\.bilivideo\.cn$/.test(host)) return 2;
  if (/(^|\.)bilivideo\.(com|cn)$/.test(host)) return 3;
  return 4;
}

export interface PickedAudio {
  stream: DashAudioStream;
  url: string;
}

/** 选档=bandwidth 最小（07 报告 G-3：30232/30280 带宽相同证明不可硬编码 id）；
 *  选源=该档候选 URL（baseUrl+backupUrl）中域优先级最高者；第三方边缘域独占的档跳过。 */
export function pickAudioStream(streams: DashAudioStream[]): PickedAudio | null {
  const usable = streams
    .filter((s) => s.baseUrl || s.backupUrl.length)
    .sort((a, b) => a.bandwidth - b.bandwidth);
  for (const stream of usable) {
    const urls = [stream.baseUrl, ...stream.backupUrl].filter(Boolean);
    let best: { url: string; cls: number } | null = null;
    for (const u of urls) {
      const cls = urlHostClass(u);
      if (cls < 4 && (!best || cls < best.cls)) best = { url: u, cls };
    }
    if (best) return { stream, url: best.url };
  }
  return null;
}

/** 音频体量预估（最低档 ≈64kbps≈65704bps，07 报告 G-3）：确认卡片「视频过长」预告的数据源。 */
export const AUDIO_BITS_PER_SEC = 65_704;
export const estimateAudioBytes = (durationSec: number): number => Math.round((durationSec * AUDIO_BITS_PER_SEC) / 8);

// ---- 转写归一化（02-数据模型 §4.3：verbose_json 优先，退化 json+整段文本） ----------

interface VerboseSegment {
  start?: number;
  end?: number;
  text?: string;
}

/** verbose_json.segments → cues；退化 json（无 segments）→ 整段文本作单条 cue（0→时长封底）。 */
export function normalizeTranscription(
  body: unknown,
  fallbackDurationSec: number,
): { cues: StoredCue[]; text: string } {
  const j = (body ?? {}) as { text?: string; segments?: VerboseSegment[] };
  const text = (j.text ?? '').trim();
  const segs = Array.isArray(j.segments) ? j.segments : [];
  if (segs.length > 0) {
    const cues: StoredCue[] = segs
      .map((s) => ({
        from: Number(s.start ?? 0),
        to: Number(s.end ?? 0),
        text: (s.text ?? '').trim(),
      }))
      .filter((c) => c.text);
    return { cues, text: text || cues.map((c) => c.text).join(' ') };
  }
  if (!text) return { cues: [], text: '' };
  return { cues: [{ from: 0, to: Math.max(1, fallbackDurationSec), text }], text };
}

// ---- 上传（OpenAI-compatible /audio/transcriptions，multipart） --------------------

export interface AsrConfig {
  provider?: 'openai-compatible' | 'doubao-agent-plan';
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export class AsrHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`ASR HTTP ${status}: ${body.slice(0, 120)}`);
    this.name = 'AsrHttpError';
  }
}

export interface TranscribeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** multipart 上传（offscreen DOM 环境有 FormData/Blob）；响应归一化为 cues。
 *  错误：401/403→Key 无效；413→音频超限；超时和网络错误分别提示。 */
export async function transcribeAudio(
  cfg: AsrConfig,
  audio: { bytes: ArrayBuffer; filename: string },
  durationSec: number,
  deps: TranscribeDeps = {},
): Promise<{ cues: StoredCue[]; text: string; timestampsValid: boolean }> {
  if (cfg.provider === 'doubao-agent-plan') throw new Error('ASR_DOUBAO_REQUIRES_PCM');
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const form = new FormData();
  form.append('file', new Blob([audio.bytes]), audio.filename);
  form.append('model', cfg.modelId);
  form.append('response_format', 'verbose_json');
  const controller = new AbortController();
  const cancel = () => controller.abort('cancelled');
  deps.signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => controller.abort('timeout'), deps.timeoutMs ?? 120_000);
  try {
    if (deps.signal?.aborted) throw new Error('ASR_CANCELLED');
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      // Key 剔除 + 截断，与 llm/client 同口径
      throw new AsrHttpError(res.status, bodyText.split(cfg.apiKey).join('***').slice(0, 120));
    }
    const body = await res.json();
    const result = normalizeTranscription(body, durationSec);
    const segments = Array.isArray(body?.segments) ? body.segments.filter((s: VerboseSegment) => typeof s?.text === 'string' && s.text.trim()) : [];
    let previousStart = -1;
    const timestampsValid = segments.length > 0 && Number.isFinite(durationSec) && durationSec > 0 && segments.every((s: VerboseSegment) => {
      if (typeof s.start !== 'number' || typeof s.end !== 'number' || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start || s.end > durationSec || s.start < previousStart) return false;
      previousStart = s.start;
      return true;
    });
    return { ...result, timestampsValid };
  } catch (e) {
    if (deps.signal?.aborted) throw new Error('ASR_CANCELLED');
    if (e instanceof AsrHttpError) throw e;
    const aborted = controller.signal.aborted;
    throw new Error(aborted ? 'ASR_TIMEOUT' : `ASR_NETWORK:${String(e).slice(0, 100)}`);
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', cancel);
  }
}

/** ASR 侧错误 → 可读码（02-数据模型 §4.3；面板/徽章消费）。 */
export function mapAsrError(e: unknown): { code: string; msg: string } {
  if (e instanceof AsrHttpError) {
    if (e.status === 401 || e.status === 403) return { code: 'KEY_INVALID', msg: 'ASR Key 无效或无权限，请到设置检查' };
    if (e.status === 413) return { code: 'AUDIO_TOO_LARGE', msg: '视频过长暂不支持（音频超出上传上限）' };
    return { code: 'ASR_HTTP', msg: `ASR HTTP ${e.status}: ${e.body.slice(0, 80)}` };
  }
  const s = String(e);
  if (s.includes('ASR_DOUBAO_REQUIRES_PCM')) return { code: 'ASR_NOT_READY', msg: '豆包视频语音处理尚未接入，请等待后续版本' };
  if (s.includes('ASR_TIMEOUT')) return { code: 'ASR_TIMEOUT', msg: '语音识别请求超时，可能已产生费用，请确认后重试' };
  if (s.includes('ASR_NETWORK')) return { code: 'ASR_NETWORK', msg: 'ASR 端点无法连接，请检查配置' };
  return { code: 'UNKNOWN', msg: s.slice(0, 150) };
}
