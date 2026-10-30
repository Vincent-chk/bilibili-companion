// 豆包 Agent Plan 语音二进制协议。所有时间戳均为服务返回的相对毫秒。
import type { StoredCue, TranscriptRow } from '../storage';

export const DOUBAO_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream';
export const DOUBAO_ASR_ORIGIN = 'wss://openspeech.bytedance.com/*';
export const DOUBAO_ASR_RESOURCE = 'volc.seedasr.sauc.duration';
export const DOUBAO_ASR_MODEL = 'doubao-seed-asr-2.0';

export interface DoubaoWord { text: string; startMs: number | null; endMs: number | null }
export interface DoubaoUtterance extends DoubaoWord { definite: boolean; words: DoubaoWord[] }
export interface DoubaoResult { text: string; utterances: DoubaoUtterance[] }
export interface DoubaoFrame { final: boolean; errorCode?: number; result?: DoubaoResult; audioDurationMs?: number }

/** 只忽略不改变语义的常见中文句读和排版空白。 */
export const normalizeAsrContent = (text: string): string => text.replace(/[，。！？、；“”‘’]/gu, '').replace(/\s+/gu, (space, offset, input: string) =>
  /[\p{Script=Latin}\p{N}]$/u.test(input.slice(0, offset)) && /^[\p{Script=Latin}\p{N}]/u.test(input.slice(offset + space.length)) ? ' ' : '');

/** 只处理可明确对照原始全片结果的旧豆包缓存，缺失证据的旧通用转写不在此判定。 */
export function hasAsrSemanticMismatch(t: TranscriptRow): boolean {
  if (t.source !== 'asr' || t.asrComplete !== true) return false;
  const result = t.asrParts?.find(p => p.whole === true && p.start === 0)?.result;
  if (!result || !Array.isArray(result.utterances) || typeof result.text!=='string') return false;
  const utterances = result.utterances.filter(u => u.text.trim());
  if(!result.text.trim()) return utterances.length>0;
  if(!utterances.length) return t.cues.length>0 && normalizeAsrContent(result.text)!==normalizeAsrContent(t.cues.map(c=>c.text).join(''));
  if (normalizeAsrContent(result.text) !== normalizeAsrContent(utterances.map(u => u.text).join(''))) return true;
  if (utterances.some(u => u.words.length > 0 && normalizeAsrContent(u.words.map(w => w.text).join('')) !== normalizeAsrContent(u.text))) return true;
  // 缺少词列表时旧句级缓存仍可用；只在完整词列表能逐项对照时检查持久化 cues。
  if (utterances.some(u => !u.words.length)) return false;
  const words = utterances.flatMap(u => u.words).filter(w => w.text.trim());
  if (words.length !== t.cues.length) return true;
  return words.some((word, i) => {
    const cue = t.cues[i]!;
    return (cue.text !== word.text && cue.text !== word.text.trim()) ||
      (word.startMs !== null && cue.from !== word.startMs / 1000) ||
      (word.endMs !== null && cue.to !== word.endMs / 1000);
  });
}

export function timedCues(result:DoubaoResult, offset:number, duration:number, onInvalid?:(reason:string)=>void):StoredCue[] | null {
  const invalid=(reason:string):null=>{onInvalid?.(reason);return null;};
  if (!result.text.trim()) return result.utterances.some(u=>u.text.trim()) ? invalid('顶层文字与句子不一致') : [];
  if (!result.utterances.length) return invalid('缺少句子');
  // 常见句读可由服务补全；保留运算符、百分号、冒号、小数点以及拉丁字母和数字间空格，避免误删语义。
  const normalize=normalizeAsrContent;
  if(normalize(result.utterances.map(u=>u.text).join(''))!==normalize(result.text)) return invalid('顶层文字与句子不一致');
  const out:StoredCue[]=[];
  let previousStart=-1,previousEnd=-1,previousSentenceStart=-1,previousSentenceEnd=-1;
  for (const utterance of result.utterances) {
    if (!utterance.text.trim()) continue;
    if(utterance.startMs===null||utterance.endMs===null||!Number.isFinite(utterance.startMs)||!Number.isFinite(utterance.endMs)||utterance.startMs<0) return invalid('句子缺少时间');
    if(utterance.endMs<=utterance.startMs) return invalid('句子时间倒序');
    if(utterance.endMs>duration*1000) return invalid('句子时间超出片段');
    // 与词重叠允许值一致，容许服务边界的少量抖动，显著倒序不能定位。
    if(utterance.startMs<previousSentenceStart-200 || utterance.endMs<previousSentenceEnd-200) return invalid('句子时间倒序');
    previousSentenceStart=utterance.startMs;previousSentenceEnd=utterance.endMs;
    if (utterance.words.length && normalize(utterance.words.map(w=>w.text).join(''))!==normalize(utterance.text)) return invalid('词语与句子不一致');
    const items = utterance.words.length ? utterance.words : [utterance];
    for (const word of items) {
      // 模型有时在词列表中插入空白占位；非空词（包括标点）仍完整保留并严格验时。
      if (!word.text.trim()) continue;
      if (word.startMs===null || word.endMs===null || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs<0) return invalid('词语缺少时间');
      if (word.endMs <= word.startMs || word.startMs<previousStart || word.endMs<previousEnd) return invalid('词语时间倒序');
      if (word.endMs>duration*1000) return invalid('词语时间超出片段');
      if (word.startMs<utterance.startMs-200 || word.endMs>utterance.endMs+200) return invalid('词语时间超出句子');
      if (word.startMs<previousEnd-200) return invalid('词语时间重叠');
      out.push({from:offset+word.startMs/1000,to:offset+word.endMs/1000,text:word.text});
      previousStart=word.startMs;previousEnd=word.endMs;
    }
  }
  return out.length ? out : invalid('缺少可用句子');
}


/** 恢复用候选必须带完整最终结果及服务确认时长，旧通用 ASR 不能冒充候选。 */
export function isRecoveryCandidate(t: TranscriptRow, videoKey: string, videoDuration: number | undefined): boolean {
  const whole=t.asrParts?.find(p=>p.whole===true && p.start===0);
  if (t.key!==videoKey || t.source!=='asr' || t.asrComplete!==true || !Number.isFinite(t.asrDuration) || t.asrDuration!<=0 ||
      !Number.isFinite(videoDuration) || videoDuration!<=0 || Math.abs(t.asrDuration!-videoDuration!)>1 || t.asrDuration!-videoDuration!>0.05 ||
      !whole || !Number.isFinite(whole.end) || Math.abs(whole.end-t.asrDuration!)>=0.05 ||
      !Number.isFinite(whole.serviceDurationMs) || whole.serviceDurationMs!<=0 || Math.abs(whole.serviceDurationMs!-t.asrDuration!*1000)>1000 ||
      !whole.result || typeof whole.result.text!=='string' || !Array.isArray(whole.result.utterances)) return false;
  try {
    if (whole.result.utterances.some(u=>u.text.trim()&&!u.definite)) return false;
    const cues=timedCues(whole.result,0,t.asrDuration!);
    return !!cues?.length && cues.length===t.cues.length && cues.every((c,i)=>c.from===t.cues[i]?.from && c.to===t.cues[i]?.to && (c.text===t.cues[i]?.text || c.text.trim()===t.cues[i]?.text));
  } catch { return false; }
}

/** 返回可与已存词级时间逐项对应的完整句子；失败时调用方保留原 cues。 */
export function verifiedAsrSentences(t: TranscriptRow, requireWords = false): StoredCue[] | null {
  const whole = t.source === 'asr' && t.asrComplete === true ? t.asrParts?.find(p => p.whole === true && p.start === 0) : undefined;
  const utterances = whole?.result.utterances.filter(u => u.text.trim());
  // 摘要路径不得抹去 +、%、小数点等可能改变含义的符号；普通中文句读可由服务补全。
  const normalize = (s: string) => requireWords ? normalizeAsrContent(s) : s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!whole || !utterances?.length || normalize(whole.result.text) !== normalize(utterances.map(u => u.text).join(''))) return null;
  if (requireWords && (!Number.isFinite(whole.end) || whole.end <= 0)) return null;
  let index = 0;
  let previousStart = -1, previousEnd = -1;
  const sentences: StoredCue[] = [];
  for (const u of utterances) {
    if (!u.definite || (requireWords && !u.words.length)) return null;
    const allWords = u.words.length ? u.words : [u];
    const words = allWords.filter(w => w.text.trim());
    if (normalize(allWords.map(w => w.text).join('')) !== normalize(u.text)) return null;
    const start = index;
    for (const word of words) {
      const cue = t.cues[index++];
      if (!cue || word.startMs === null || word.endMs === null || cue.from !== word.startMs / 1000 || cue.to !== word.endMs / 1000 || (cue.text !== word.text && cue.text !== word.text.trim())) return null;
      if (requireWords && (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0 || word.endMs <= word.startMs || word.endMs > whole.end * 1000 || word.startMs < previousStart || word.endMs < previousEnd || word.startMs < previousEnd - 200)) return null;
      previousStart = word.startMs;
      previousEnd = word.endMs;
    }
    if (index === start) return null;
    sentences.push({ from: t.cues[start]!.from, to: t.cues[index - 1]!.to, text: u.text.trim() });
  }
  return index === t.cues.length ? sentences : null;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

export async function encodeDoubaoFrame(type: 1 | 2, bytes: Uint8Array, last = false): Promise<ArrayBuffer> {
  const body = await gzip(bytes);
  const out = new Uint8Array(8 + body.length);
  out.set([0x11, (type << 4) | (last ? 2 : 0), type === 1 ? 0x11 : 0x01, 0]);
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out.buffer;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function word(value: unknown): DoubaoWord {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { text: typeof v.text === 'string' ? v.text : '', startMs: timestamp(v.start_time), endMs: timestamp(v.end_time) };
}

export async function decodeDoubaoFrame(buffer: ArrayBuffer): Promise<DoubaoFrame> {
  const b = new Uint8Array(buffer);
  if (b.length < 8 || b[0]! >> 4 !== 1) throw new Error('ASR_PROTOCOL');
  const type = b[1]! >> 4, flags = b[1]! & 15;
  let offset = (b[0]! & 15) * 4;
  const view = new DataView(buffer);
  if (offset < 4 || offset + 4 > b.length) throw new Error('ASR_PROTOCOL');
  if (type === 15) {
    const errorCode = view.getUint32(offset);
    return { errorCode, final: false };
  }
  if (type !== 9) throw new Error('ASR_PROTOCOL');
  if (flags & 1) offset += 4;
  if (offset + 4 > b.length) throw new Error('ASR_PROTOCOL');
  const size = view.getUint32(offset); offset += 4;
  if (size !== b.length - offset) throw new Error('ASR_PROTOCOL');
  let payload = b.slice(offset);
  if ((b[2]! & 15) === 1) {
    payload = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  } else if ((b[2]! & 15) !== 0) throw new Error('ASR_PROTOCOL');
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>; }
  catch { throw new Error('ASR_PROTOCOL'); }
  let result = parsed.result;
  if (Array.isArray(result)) result = result[0];
  if (!result || typeof result !== 'object') return { final: !!(flags & 2) };
  const value = result as Record<string, unknown>;
  const utterances = Array.isArray(value.utterances) ? value.utterances.map((u): DoubaoUtterance => {
    const v = u && typeof u === 'object' ? u as Record<string, unknown> : {};
    return { ...word(v), definite: v.definite === true, words: Array.isArray(v.words) ? v.words.map(word) : [] };
  }) : [];
  const audioInfo = parsed.audio_info && typeof parsed.audio_info === 'object' ? parsed.audio_info as Record<string, unknown> : undefined;
  const audioDurationMs = timestamp(audioInfo?.duration);
  return { final: !!(flags & 2), result: { text: typeof value.text === 'string' ? value.text : '', utterances }, ...(audioDurationMs !== null ? {audioDurationMs} : {}) };
}

export function doubaoResultToCues(result: DoubaoResult, offsetSec: number): StoredCue[] {
  if (!Number.isFinite(offsetSec) || offsetSec < 0) return [];
  return result.utterances.flatMap(u => u.text.trim() && u.startMs !== null && u.endMs !== null && u.endMs > u.startMs
    ? [{ from: offsetSec + u.startMs / 1000, to: offsetSec + u.endMs / 1000, text: u.text.trim() }] : []);
}

export const DOUBAO_RULE_ID = 78;
interface AuthRule {
  id: number; priority: number;
  action: { type: 'modifyHeaders'; requestHeaders: { header: string; operation: 'set'; value: string }[] };
  condition: { urlFilter: string; initiatorDomains: string[]; resourceTypes: string[] };
}
interface SessionDeps {
  runtimeId: string;
  updateRules: (rule: AuthRule | null) => Promise<void>;
  createSocket: (url: string) => WebSocket;
  signal?: AbortSignal;
}
let sessionTail: Promise<void> = Promise.resolve();

/** 最多一条 15 分钟 PCM 会话；不自动重试。未传 PCM 时仅验证鉴权初始帧。 */
export async function runDoubaoSession(apiKey: string, pcm: Uint8Array | undefined, deps: SessionDeps): Promise<DoubaoFrame> {
  if (!apiKey.trim()) throw new Error('ASR_KEY_MISSING');
  if (pcm && (pcm.length === 0 || pcm.length > 28_800_000 || pcm.length % 2 !== 0)) throw new Error('ASR_PCM_INVALID');
  let release!: () => void;
  const previous = sessionTail;
  sessionTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await sessionOnce(apiKey, pcm, deps); } finally { release(); }
}

async function sessionOnce(apiKey: string, pcm: Uint8Array | undefined, deps: SessionDeps): Promise<DoubaoFrame> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) controller.abort();
  const totalTimer = setTimeout(abort, 600_000);
  let socket: WebSocket | undefined;
  const queue: DoubaoFrame[] = [];
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  let parsing = Promise.resolve();
  let firstFrameReceived = false, terminalFrameReceived = false, acknowledgedAudioFrames = 0;
  const fail = (code: string) => { failure ??= new Error(code); wake?.(); };
  const onAbort = () => fail('ASR_CANCELLED_OR_TIMEOUT');
  controller.signal.addEventListener('abort', onAbort);
  const receive = async (): Promise<DoubaoFrame> => {
    while (!queue.length) {
      if (failure) {
        await parsing; // 断开可能紧跟最终帧，先处理已收到的数据。
        if (!queue.length) throw failure;
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { fail('ASR_READ_TIMEOUT'); resolve(); }, 180_000);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
    const frame = queue.shift()!;
    if (frame.errorCode !== undefined) throw new Error(`ASR_SERVICE_${frame.errorCode}`);
    return frame;
  };
  try {
    if (controller.signal.aborted) throw new Error('ASR_CANCELLED_OR_TIMEOUT');
    await deps.updateRules({
      id: DOUBAO_RULE_ID, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'X-Api-Key', operation: 'set', value: apiKey },
        { header: 'X-Api-Resource-Id', operation: 'set', value: DOUBAO_ASR_RESOURCE },
        { header: 'X-Api-Request-Id', operation: 'set', value: crypto.randomUUID() },
      ] },
      condition: { urlFilter: `|${DOUBAO_ASR_ENDPOINT}|`, initiatorDomains: [deps.runtimeId], resourceTypes: ['websocket'] },
    });
    if (controller.signal.aborted) throw new Error('ASR_CANCELLED_OR_TIMEOUT');
    socket = deps.createSocket(DOUBAO_ASR_ENDPOINT);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      if (terminalFrameReceived) return;
      const buffer = event.data as ArrayBuffer;
      // 收到首个响应后，非最终识别帧只验证协议头；不积压累计文字或异步解压任务。
      // 有效中间帧是服务活跃信号，唤醒接收循环重置无响应计时。
      if (firstFrameReceived) {
        try {
          if (!(buffer instanceof ArrayBuffer)) throw new Error('ASR_PROTOCOL');
          const b = new Uint8Array(buffer);
          if (b.length < 8 || b[0]! >> 4 !== 1) throw new Error('ASR_PROTOCOL');
          const type = b[1]! >> 4, flags = b[1]! & 15;
          if (type === 9 && !(flags & 2)) {
            let offset = (b[0]! & 15) * 4;
            if (offset < 4) throw new Error('ASR_PROTOCOL');
            if (flags & 1) offset += 4;
            if (offset + 4 > b.length || new DataView(buffer).getUint32(offset) !== b.length - offset - 4 || (b[2]! & 15) > 1) throw new Error('ASR_PROTOCOL');
            acknowledgedAudioFrames++;
            wake?.();
            return;
          }
          terminalFrameReceived = true;
        } catch {
          terminalFrameReceived = true;fail('ASR_PROTOCOL');return;
        }
      } else {
        firstFrameReceived = true;
        if (buffer instanceof ArrayBuffer && buffer.byteLength >= 2) {
          const b = new Uint8Array(buffer);
          if ((b[1]! >> 4) === 15 || (b[1]! & 2)) terminalFrameReceived = true;
        }
      }
      parsing = parsing.then(async () => {
        const frame = await decodeDoubaoFrame(buffer);
        queue.push(frame); wake?.();
      }).catch(() => fail('ASR_PROTOCOL'));
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('ASR_CONNECT_TIMEOUT')), 15_000);
      const onAbortOpen = () => done(new Error('ASR_CANCELLED_OR_TIMEOUT'));
      const done = (error?: Error) => {
        clearTimeout(timer); controller.signal.removeEventListener('abort', onAbortOpen);
        if (error) reject(error); else resolve();
      };
      controller.signal.addEventListener('abort', onAbortOpen, {once:true});
      socket!.onopen = () => done();
      socket!.onerror = () => done(new Error('ASR_CONNECTION_FAILED'));
      socket!.onclose = () => done(new Error('ASR_CONNECTION_FAILED'));
    });
    // 凭据只在握手前存在于临时规则；清理失败则禁止发送任何音频。
    await deps.updateRules(null);
    socket.onerror = () => fail('ASR_CONNECTION_FAILED');
    socket.onclose = () => fail('ASR_CONNECTION_CLOSED');
    const init = { user: { uid: 'bilibili-companion' }, audio: { format:'pcm', codec:'raw', rate:16000, bits:16, channel:1 }, request: { model_name:'bigmodel', enable_punc:true, show_utterances:true } };
    socket.send(await encodeDoubaoFrame(1, new TextEncoder().encode(JSON.stringify(init))));
    const acknowledgement = await receive();
    if (acknowledgement.final) throw new Error('ASR_EARLY_FINAL');
    if (!pcm) return { final:false };
    let sentLastFrame = false;
    const send = async () => {
      const maxBuffered = 2 * 1024 * 1024;
      // nostream 对每个音频包返回一个响应；限制服务尚未处理的积压，仍允许其按实际吞吐快于实时处理。
      const maxOutstanding = 1024;
      let sentAudioFrames = 0, lastAudioSent = Date.now();
      let lastBuffered = 0, lastDrain = Date.now();
      for (let offset = 0; offset < pcm.length; offset += 6400) {
        if (controller.signal.aborted || failure) throw failure ?? new Error('ASR_CANCELLED_OR_TIMEOUT');
        // 若服务暂时不返回响应，最多每 4 秒继续发送一个真实音频包，避免等待时触发服务端等包超时。
        while (socket!.bufferedAmount > maxBuffered || (sentAudioFrames - acknowledgedAudioFrames >= maxOutstanding && Date.now() - lastAudioSent < 4000)) {
          if (controller.signal.aborted || failure) throw failure ?? new Error('ASR_CANCELLED_OR_TIMEOUT');
          if (socket!.bufferedAmount < lastBuffered) lastDrain = Date.now();
          lastBuffered = socket!.bufferedAmount;
          if (socket!.bufferedAmount > maxBuffered && Date.now() - lastDrain > 15_000) throw new Error('ASR_SEND_TIMEOUT');
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 25);
            const stop = () => { clearTimeout(timer); reject(new Error('ASR_CANCELLED_OR_TIMEOUT')); };
            controller.signal.addEventListener('abort', stop, {once:true});
          });
        }
        lastDrain = Date.now();
        lastBuffered = socket!.bufferedAmount;
        const last = offset + 6400 >= pcm.length;
        const frame = await encodeDoubaoFrame(2, pcm.slice(offset, offset + 6400), last);
        if (controller.signal.aborted || failure) throw failure ?? new Error('ASR_CANCELLED_OR_TIMEOUT');
        socket!.send(frame);
        sentAudioFrames++;lastAudioSent=Date.now();
        if (last) sentLastFrame = true;
      }
    };
    const receiveFinal = async () => {
      while (true) {
        const frame = await receive();
        if (frame.final) {
          if (!sentLastFrame) throw new Error('ASR_EARLY_FINAL');
          return frame;
        }
      }
    };
    const [, final] = await Promise.all([send(), receiveFinal()]);
    return final;
  } catch (e) {
    // 切勿将 WebSocket、服务正文或认证字段传到日志和用户界面。
    if (e instanceof Error && /^ASR_[A-Z_0-9]+$/.test(e.message)) throw e;
    throw new Error('ASR_CONNECTION_FAILED');
  } finally {
    controller.abort(); clearTimeout(totalTimer);
    deps.signal?.removeEventListener('abort', abort);
    if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close(); }
    await deps.updateRules(null);
  }
}
