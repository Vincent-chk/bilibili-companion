// P1.4 · Offscreen 执行体：接收 background 的 OFFSCREEN_RUN_JOB（含 LLM 配置与人设），
// 跑摘要全链路（lib/summarize/chain），进度经 SUMMARY_PROGRESS 消息回流 SW。
// 同源扩展页：可直接开 CompanionDB（IndexedDB）；fetch 带 host_permissions。
// 注意：offscreen 文档 API 受限（实测 chrome.storage/browser.storage 均不可用），
// 因此 LLM 配置与 persona 由 SW 解析后随消息传入，offscreen 不读 storage。
import { browser } from 'wxt/browser';
import { BiliApiError, BiliClient } from '../../src/lib/bilibili/client';
import { runSummarizeJob } from '../../src/lib/summarize/chain';
import { runAsrJob } from '../../src/lib/summarize/asr';
import { runSegmentJob } from '../../src/lib/summarize/segment';
import { CompanionDB, type AsrRecovery } from '../../src/lib/storage';
import type { LlmConfig } from '../../src/lib/llm/types';
import { runDoubaoSession } from '../../src/lib/asr/doubao';
import type { AsrConfig } from '../../src/lib/asr';

const db = new CompanionDB();
const bili = new BiliClient({
  beforeRequest: async () => {
    const reply = await browser.runtime.sendMessage({ type: 'BILI_REQUEST_GATE', runningJob: true }) as { ok?: boolean; code?: number; msg?: string } | undefined;
    if (!reply?.ok) throw new BiliApiError(reply?.code ?? -412, 'request-gate', reply?.msg ?? '请求暂缓');
  },
  onRiskControl: async () => { await browser.runtime.sendMessage({ type: 'BILI_RISK_HIT' }); },
});

interface RunJobMsg {
  type?: 'OFFSCREEN_RUN_JOB';
  job?: { id: string; videoKey: string; type?: string; segIndex?: number; sessionId?: string; runId?: string; recovery?: AsrRecovery };
  llm?: LlmConfig;
  persona?: string;
  /** 整流超时（SW resolveConfig 解析，思考型真实模型 > 默认 60s）。 */
  timeoutMs?: number;
  /** P2.3：ASR 配置随 job 下发（offscreen 读不了 storage，SW 解析后传入）。 */
  asr?: AsrConfig;
  asrMaxMB?: number;
}

/** 进度回传节流：token 级 delta 高频，200ms 合并一次防消息风暴（stage/progress/deltaText 共用）。
 *  P1.11：segIndex 非空时消息类型改 SEGMENT_PROGRESS（分段解读流式通道）。 */
function makeCtx(jobId: string, segIndex?: number) {
  const msgType = segIndex !== undefined ? 'SEGMENT_PROGRESS' : 'SUMMARY_PROGRESS';
  let lastSentAt = 0;
  let pending: { stage?: string; progress?: number; deltaText?: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const payload = { jobId, ...(segIndex !== undefined ? { segIndex } : {}), ...pending };
    pending = null;
    void browser.runtime.sendMessage({ type: msgType, ...payload }).catch(() => {});
  };
  const schedule = () => {
    const now = Date.now();
    if (now - lastSentAt >= 200) {
      lastSentAt = now;
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 200);
    }
  };
  return {
    update: async (patch: { stage?: string; progress?: number }) => {
      pending = { ...(pending ?? {}), ...patch };
      schedule();
    },
    /** P1.5：LLM 流式增量缓冲（deltaText 累计到下次 flush 一并发出）。 */
    pushDelta: (text: string) => {
      pending = { ...(pending ?? {}), deltaText: (pending?.deltaText ?? '') + text };
      schedule();
    },
  };
}

const activeAsrRuns = new Map<string, {id:string;runId:string;outcome?: unknown}>();
const asrControllers = new Map<string, {sessionId:string; controller:AbortController}>();
browser.runtime.onMessage.addListener((msg: unknown, sender) => {
  const m = msg as RunJobMsg;
  if ((msg as {type?:string})?.type === 'OFFSCREEN_CANCEL_ASR') {
    if (sender.url !== browser.runtime.getURL('/background.js')) return Promise.resolve({ok:false});
    const sessionId=(msg as {sessionId?:unknown}).sessionId;
    if(typeof sessionId!=='string')return Promise.resolve({ok:false});
    for(const active of asrControllers.values())if(active.sessionId===sessionId)active.controller.abort();
    return Promise.resolve({ok:true});
  }
  if ((msg as {type?:string})?.type === 'OFFSCREEN_ACTIVE_JOBS') {
    if (sender.url !== browser.runtime.getURL('/background.js')) return Promise.resolve([]);
    return Promise.resolve([...activeAsrRuns.values()]);
  }
  if (m?.type !== 'OFFSCREEN_RUN_JOB' || !m.job?.videoKey || !m.llm) return undefined; // 非本品消息交给其它 listener
  if (sender.url !== browser.runtime.getURL('/background.js')) return Promise.resolve({result:'failed' as const,error:{code:'ASR_UNAUTHORIZED',msg:'任务来源无效'}});
  const job = m.job;
  const active = job.type === 'ASR_SUMMARIZE' && job.runId ? {id:job.id,runId:job.runId} : undefined;
  const controller=active && job.sessionId ? new AbortController() : undefined;
  if(controller)asrControllers.set(job.id,{sessionId:job.sessionId!,controller});
  if (active) activeAsrRuns.set(job.id, active);
  return handleRun(job, m.llm, m.persona, m.timeoutMs, m.asr, m.asrMaxMB,controller?.signal).catch((e: unknown) => ({
    result: 'failed' as const,
    error: { code: 'CHAIN_ERROR', msg: String(e).slice(0, 200) },
  })).then(async outcome => {
    if(controller && asrControllers.get(job.id)?.controller===controller)asrControllers.delete(job.id);
    if (active) {
      activeAsrRuns.set(job.id, {...active,outcome});
      try {
        const ack = await browser.runtime.sendMessage({type:'OFFSCREEN_ASR_DONE',jobId:job.id,runId:active.runId,outcome}) as {ok?:boolean};
        if (ack?.ok !== undefined) activeAsrRuns.delete(job.id);
      } catch { /* 后台重启后可查询已完成结果并收口 */ }
    }
    return outcome;
  });
});

// 语音连接运行在扩展离屏页面：Chrome 的 DNR 发起者限定在此上下文才匹配。
function doubaoSession(apiKey: string, pcm?: Uint8Array, signal?:AbortSignal) {
  return runDoubaoSession(apiKey, pcm, {
    runtimeId: browser.runtime.id,
    createSocket: url => new WebSocket(url),
    signal,
    updateRules: async rule => {
      const headers = rule?.action.requestHeaders;
      const result = await browser.runtime.sendMessage({type:'DOUBAO_AUTH_RULE', authRule: rule ? {key:headers![0]!.value, requestId:headers![2]!.value} : null}) as {ok?:boolean};
      if (!result?.ok) throw new Error('ASR_RULE_FAILED');
    },
  });
}
browser.runtime.onMessage.addListener((msg: unknown, sender) => {
  const m = msg as { type?: string; apiKey?: string; pcm?: number[] };
  if (m.type !== 'OFFSCREEN_DOUBAO_SESSION') return undefined;
  if (sender.url !== browser.runtime.getURL('/background.js') || typeof m.apiKey !== 'string') return Promise.resolve({ok:false, error:'ASR_UNAUTHORIZED'});
  return doubaoSession(m.apiKey, m.pcm ? Uint8Array.from(m.pcm) : undefined).then(frame => ({ok:true, frame})).catch((e: unknown) => ({ok:false, error:e instanceof Error && /^ASR_[A-Z_0-9]+$/.test(e.message) ? e.message : 'ASR_CONNECTION_FAILED'}));
});

async function handleRun(
  job: { id: string; videoKey: string; type?: string; segIndex?: number; sessionId?: string; runId?: string; recovery?: AsrRecovery },
  llm: LlmConfig,
  persona?: string,
  timeoutMs?: number,
  asr?: AsrConfig,
  asrMaxMB?: number,
  signal?:AbortSignal,
) {
  // 继续已完成的候选只用摘要模型；ASR 配置或权限撤销后仍可继续，且此路径禁止发送音频。
  const resumeCandidate=job.type==='ASR_SUMMARIZE' && job.recovery?.candidate?.asrComplete===true;
  const effectiveAsr=resumeCandidate ? {provider:'doubao-agent-plan' as const,baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:''} : asr;
  console.log(
    `[doubao] offscreen run job=${job.id} videoKey=${job.videoKey}${job.type === 'SEGMENT_ANALYZE' ? ` seg=${job.segIndex}` : ''}`,
  );
  const ctx = makeCtx(job.id, job.segIndex);
  const outcome =
    job.type === 'SEGMENT_ANALYZE'
      ? job.segIndex === undefined
        ? {
            result: 'failed' as const,
            error: { code: 'BAD_JOB', msg: 'SEGMENT_ANALYZE 缺 segIndex（审查 P2-9：不得静默解读第 0 段写脏缓存）' },
          }
        : await runSegmentJob(
            { db, bili, llm, timeoutMs, onDelta: (t) => ctx.pushDelta(t) },
            { videoKey: job.videoKey, segIndex: job.segIndex },
            ctx,
          )
      : job.type === 'ASR_SUMMARIZE'
        ? effectiveAsr
          ? await runAsrJob(
              {
                db,
                bili,
                llm,
                persona,
                timeoutMs,
                asr:effectiveAsr,
                signal,
                asrMaxMB: asrMaxMB ?? 25,
                ...(effectiveAsr.provider === 'doubao-agent-plan' ? {
                  transcribePcm: (pcm: Uint8Array) => resumeCandidate ? Promise.reject(new Error('ASR_RECOVERY_CHANGED')) : doubaoSession(effectiveAsr.apiKey, pcm,signal),
                  onAsrPartial: async () => { await browser.runtime.sendMessage({type:'ASR_PARTIAL_UPDATED',jobId:job.id,runId:job.runId}); },
                } : {}),
                onDelta: (t) => ctx.pushDelta(t),
              },
              job,
              ctx,
            )
          : {
              // SW 侧已拦未配置；此为防御（offscreen 读不了 storage，配置必须由 SW 随 job 传入）
              result: 'failed' as const,
              error: { code: 'NEED_ASR_CONFIG', msg: 'ASR 未配置（配置未随任务下发）' },
            }
        : await runSummarizeJob(
            { db, bili, llm, persona, timeoutMs, onDelta: (t) => ctx.pushDelta(t) },
            job,
            ctx,
            { force: job.type === 'REGENERATE' }, // 2.7a：重新生成绕过 done 缓存，成功整行覆盖
          );
  console.log(`[doubao] offscreen job=${job.id} type=${job.type ?? 'SUMMARIZE'} → ${outcome.result}`);
  return outcome;
}
