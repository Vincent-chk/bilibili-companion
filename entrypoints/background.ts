// background service worker：轻量编排（架构 §8：长任务一律 offscreen，SW 不执行 LLM SSE）。
// - P1.2 watcher 服务端（VIDEO_ENTER/WATCH_TICK/TRIGGER_SUMMARY）
// - P1.4 pipeline 编排：job 派发给 offscreen 执行体，进度回流落库；SW 启动 recover+drain
// 触发链：watcher 20s → TRIGGER_SUMMARY → pipeline.enqueue → offscreen → lib/summarize/chain → 落库
// （Phase 0 的 VIDEO_SEEN 进页即跑链已随 1.4 移除：SW 内不留 LLM 路径，E2E 改走真实触发链）
import { BiliApiError, BiliClient, pickPage } from '../src/lib/bilibili/client';
import { readStoredLlmConfig, resolveConfig } from '../src/lib/llm/summary';
import { Pipeline, type JobContext, type JobOutcome } from '../src/lib/pipeline';
import {
  CompanionDB,
  getSessionPointer,
  interruptSessionAsr,
  isCacheFresh,
  setSessionPointer,
  updateVisitProgress,
  upsertVisit,
  wipeAllData,
  type JobRow,
  type JobStage,
  type SummaryRow,
  type VideoRow,
} from '../src/lib/storage';
import { browserKv } from '../src/lib/storage/browserKv';
import { applyRetention, retainUntilOf, sessionStartBlockedReason, type RetentionResult } from '../src/lib/session';
import type { SessionPointer } from '../src/lib/storage';
import { excerptOf } from '../src/content/panel/view-models';
import { originPattern, validateAsr, validateEndpointUrl, validateLlm } from '../src/content/onboarding/onboarding-logic';
import { clampThreshold, maskApiKey, resolveApiKey, sanitizePersona } from '../src/content/panel/settings-logic';
import { buildVideoUrl, pickSeekTab, type SeekTabCandidate } from '../src/content/seek';
import { parseVideoKey } from '../src/lib/summarize/chain';
import { segmentsToPrefetch } from '../src/lib/summarize/segment';
import { buildRefererRules, DNR_RULE_IDS } from '../src/lib/dnr';
import { DOUBAO_ASR_ENDPOINT, DOUBAO_ASR_MODEL, DOUBAO_ASR_ORIGIN, DOUBAO_ASR_RESOURCE, DOUBAO_RULE_ID, hasAsrSemanticMismatch, isRecoveryCandidate } from '../src/lib/asr/doubao';
import { checkForUpdate, isNewerVersion, type UpdateRecord } from '../src/lib/update';

const db = new CompanionDB();
let settingsSaveTail: Promise<void> = Promise.resolve();
let browserSessionReady: Promise<void> = Promise.resolve();
let recoveryReady: Promise<number> = Promise.resolve(0);
let doubaoRuleTail: Promise<void> = Promise.resolve();
let wipesInProgress = 0;

// 所有 B 站 API 请求（含 offscreen）在 SW 排队，跨实例共享限速与 60 秒风控冷却。
let biliRiskUntil = 0;
let biliNextRequestAt = 0;
let biliGateTail: Promise<void> = Promise.resolve();
function beforeBiliRequest(runningJob = false): Promise<void> {
  const run = async (): Promise<void> => {
    biliRiskUntil = Math.max(biliRiskUntil, (await browserKv.get<number>('biliRiskUntil')) ?? 0);
    if (Date.now() < biliRiskUntil) throw new BiliApiError(-412, 'request-gate', 'B 站风控冷却中，稍后自动恢复');
    if (!runningJob && await isPaused()) throw new BiliApiError(-499, 'request-gate', '陪看已暂停');
    const delay = biliNextRequestAt - Date.now();
    if (delay > 0) await sleep(delay);
    if (Date.now() < biliRiskUntil) throw new BiliApiError(-412, 'request-gate', 'B 站风控冷却中，稍后自动恢复');
    if (!runningJob && await isPaused()) throw new BiliApiError(-499, 'request-gate', '陪看已暂停');
    biliNextRequestAt = Date.now() + 500;
  };
  const pending = biliGateTail.then(run, run);
  biliGateTail = pending.catch(() => {});
  return pending;
}
async function markBiliRisk(): Promise<void> {
  biliRiskUntil = Math.max(biliRiskUntil, Date.now() + 60_000);
  await browserKv.set('biliRiskUntil', biliRiskUntil).catch(() => {});
  await browser.alarms.create('doubao-bili-risk', { when: biliRiskUntil + 50 });
}
const biliRequestHooks = { beforeRequest: beforeBiliRequest, onRiskControl: markBiliRisk };

const updateStore = {
  get: () => browserKv.get<UpdateRecord>('updateCheck'),
  set: (value: UpdateRecord) => browserKv.set('updateCheck', value),
};
let updateCheckInFlight: Promise<void> | null = null;
let updateAbort: AbortController | null = null;
function checkUpdate(): void {
  if (updateCheckInFlight) return;
  const controller = new AbortController();
  updateAbort = controller;
  updateCheckInFlight = (async () => {
    const latest = await checkForUpdate(updateStore, browser.runtime.getManifest().version, { paused: await isPaused(), signal: controller.signal });
    const revision = (await updateStore.get())?.revision ?? 0;
    if (!controller.signal.aborted && !(await isPaused())) broadcastToUi({ type: 'UPDATE_AVAILABLE', updateVersion: latest, updateRevision: revision });
  })().catch(() => {}).finally(() => { updateCheckInFlight = null; updateAbort = null; });
}

// ---- P1.5 · Port（doubao-port）与面板推送 ----------------------------------------
// runtime.sendMessage 到不了 content script（扩展内部专用），B→C 推送一律走 Port 广播。

interface UiPort {
  postMessage: (msg: unknown) => void;
  /** 连接方标签页 id（onConnect 记录）：seek focus-tab 的活端口过滤，孤儿标签落 new-tab 兜底。 */
  tabId?: number;
}
const uiPorts = new Set<UiPort>();
let sessionBroadcastRevision = 0;
let settingsBroadcastRevision = 0;

function broadcastToUi(msg: Record<string, unknown>): void {
  if (msg.type === 'SESSION_STATE') sessionBroadcastRevision++;
  if (msg.type === 'WATCH_SETTINGS') settingsBroadcastRevision++;
  for (const p of uiPorts) {
    try {
      p.postMessage(msg);
    } catch {
      /* 断口由 onDisconnect 清理 */
    }
  }
}

// ---- P2.1 · 会话保留期判定（架构 §3.7 / 02-数据模型 §6） ------------------------
// 三时机判定：①SW 启动 ②面板打开（LIST_QUERY 静默判定）③content 首连（Port 回放）；
// chrome.alarms(30min) 兜底唤醒补判。判定只更新状态（EXPIRED_PENDING_CONFIRM），
// 绝不静默删数据——删除仅经 2.2 的 WIPE_CONFIRM/WIPE_NOW 清除链路。

/** SESSION_STATE 消息形状（02-数据模型 §3：{state, closedAt, retainUntil}，面板倒计时数据源）。 */
function sessionStateMsg(pointer?: SessionPointer): Record<string, unknown> {
  const retainUntil = pointer ? retainUntilOf(pointer) : undefined;
  return {
    type: 'SESSION_STATE',
    state: pointer?.state ?? 'INACTIVE',
    ...(pointer?.closedAt !== undefined ? { closedAt: pointer.closedAt } : {}),
    ...(retainUntil !== undefined ? { retainUntil } : {}),
  };
}

/** 最近一次经广播下发的会话态：SESSION_STATE 只在变化时广播——LIST_QUERY 高频触发
 *  的静默判定若每次都广播，会被面板的 refresh→LIST_QUERY→广播 循环放大成广播风暴。 */
let lastBroadcastSession: { sessionId: string; state: string } | null = null;

/** 判定保留期；broadcast=true 时仅在会话态变化时广播（审查 P2-3：无第三种语义）。 */
async function runRetention(broadcast = false): Promise<RetentionResult> {
  await browserSessionReady;
  const r = await applyRetention(db, browserKv);
  if (!r.pointer) return r;
  if (broadcast) {
    const memo = { sessionId: r.pointer.sessionId, state: r.pointer.state };
    const changed =
      lastBroadcastSession === null ||
      lastBroadcastSession.sessionId !== memo.sessionId ||
      lastBroadcastSession.state !== memo.state;
    if (changed) {
      lastBroadcastSession = memo;
      broadcastToUi(sessionStateMsg(r.pointer));
    }
  }
  return r;
}

// ---- P1.4 · pipeline：执行体=offscreen（LLM SSE 长任务不在 SW 跑） -----------------

let offscreenReady = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return;
  try {
    const existing = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as never],
    });
    if (existing.length > 0) {
      offscreenReady = true;
      return;
    }
    await browser.offscreen.createDocument({
      url: 'offscreen.html', // WXT 构建产物路径（entrypoints/offscreen/index.html → 根 offscreen.html）
      reasons: ['DOM_PARSER' as never, 'BLOBS' as never, 'WORKERS' as never],
      justification: '执行摘要与用户确认的音频分段处理',
    });
    offscreenReady = true;
  } catch (e) {
    // 并发创建时"已存在"类报错按就绪处理；其余抛给 pipeline 记失败重试
    if (String(e).includes('Only a single offscreen')) offscreenReady = true;
    else {
      console.log(`[doubao] ensureOffscreen error: ${String(e).slice(0, 200)}`);
      throw e;
    }
  }
}

/**
 * job 执行器：发 offscreen 跑全链路，SUMMARY_PROGRESS 消息转 pipeline ctx 落库。
 * shortcut: 600s 看门狗兜 offscreen 挂死（不回包）阻塞队列；SW 中途死亡由 recover() 重排幂等重跑。
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** offscreen 文档刚创建时监听器可能尚未注册（Receiving end does not exist）——短重试等它就绪。 */
async function sendToOffscreen(payload: Record<string, unknown>): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      return await browser.runtime.sendMessage(payload);
    } catch (e) {
      lastErr = e;
      if (!String(e).includes('Receiving end does not exist')) throw e;
      await sleep(300);
    }
  }
  throw lastErr;
}

export async function executeViaOffscreen(job: JobRow, ctx: JobContext): Promise<JobOutcome> {
  if (await isPaused()) return { result: 'wait', error: { code: 'PAUSED', msg: '陪看已暂停' } };
  const asrSnapshot = job.type === 'ASR_SUMMARIZE' ? (await readSettings()).asr : undefined;
  if (job.type === 'ASR_SUMMARIZE' && !job.recovery?.candidate?.asrComplete) {
    const cfg = asrSnapshot;
    const blocked = async (code:'NEED_ASR_CONFIG'|'ASR_PERMISSION_DENIED'):Promise<JobOutcome> => {
      const msg = code === 'NEED_ASR_CONFIG' ? '请先配置语音识别服务' : '语音服务未获授权，请到设置中授权后重试';
      await db.transaction('rw',db.jobs,db.summaries,async()=>{
        const current=await db.jobs.get(job.id);
        if(current?.status!=='running'||current.runId!==job.runId)return;
        const rows=await db.summaries.where('videoKey').equals(job.videoKey).toArray();
        const summary=rows.sort((a,b)=>b.createdAt-a.createdAt)[0];
        if(summary?.status==='need_asr')await db.summaries.put({...summary,error:{code,msg}});
      });
      return {result:'failed',error:{code:code==='NEED_ASR_CONFIG'?'ASR_NOT_SENT_CONFIG':'ASR_NOT_SENT_PERMISSION',msg}};
    };
    if (!cfg || validateAsr(cfg).kind !== 'ok') return blocked('NEED_ASR_CONFIG');
    const origin = cfg.provider === 'doubao-agent-plan' ? DOUBAO_ASR_ORIGIN : originPattern(cfg.baseUrl);
    if (!origin || !(await browser.permissions.contains({origins:[origin]}))) return blocked('ASR_PERMISSION_DENIED');
  }
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogReject: ((error: Error) => void) | undefined;
  const watchdogError = new Error('offscreen 执行超时');
  let timedOut = false;
  const refreshWatchdog = () => {
    if (!watchdogReject || timedOut) return;
    if (watchdog !== undefined) clearTimeout(watchdog);
    // 语音协议自身最多 600 秒，留出 60 秒供任务状态收口；后续摘要进度同样重置。
    watchdog = setTimeout(() => { timedOut = true; watchdogReject?.(watchdogError); }, job.type === 'ASR_SUMMARIZE' ? 660_000 : 600_000);
  };
  const onProgress = (msg: unknown) => {
    const m = msg as {
      type?: string;
      jobId?: string;
      stage?: JobStage;
      progress?: number;
      deltaText?: string;
    };
    if (!timedOut && m?.type === 'SUMMARY_PROGRESS' && m.jobId === job.id) {
      if (job.type === 'ASR_SUMMARIZE') refreshWatchdog();
      const patch: { stage?: JobStage; progress?: number } = {};
      if (m.stage !== undefined) patch.stage = m.stage;
      if (m.progress !== undefined) patch.progress = m.progress;
      if (patch.stage !== undefined || patch.progress !== undefined) void ctx.update(patch);
      // 面板推送：补 videoKey（offscreen 只知道 jobId），deltaText 驱动详情流式打字
      broadcastToUi({ ...m, type: 'SUMMARY_PROGRESS', videoKey: job.videoKey, runId: job.runId });
    }
    // P1.11：分段解读流式增量 → SEGMENT_NOTE_STREAM（补 videoKey/segIndex，面板内联卡片打字机）
    if (m?.type === 'SEGMENT_PROGRESS' && m.jobId === job.id && m.deltaText) {
      broadcastToUi({
        type: 'SEGMENT_NOTE_STREAM',
        videoKey: job.videoKey,
        segIndex: job.segIndex,
        deltaText: m.deltaText,
      });
    }
  };
  browser.runtime.onMessage.addListener(onProgress);
  try {
    await ensureOffscreen();
    // offscreen 文档读不了 storage（API 受限）：LLM/ASR 配置与 persona 在 SW 解析后随 job 传入
    const { config, error: cfgErr, timeoutMs } = resolveConfig(await readStoredLlmConfig(browserKv));
    if (!config) return { result: 'failed', error: { code: 'NO_LLM_CONFIG', msg: cfgErr ?? '未配置 LLM' } };
    const settings = await readSettings();
    if (settings.paused) return { result: 'wait', error: { code: 'PAUSED', msg: '陪看已暂停' } };
    const reply = (await Promise.race([
      sendToOffscreen({
        type: 'OFFSCREEN_RUN_JOB',
        job: { id: job.id, videoKey: job.videoKey, type: job.type, segIndex: job.segIndex, sessionId: job.sessionId, runId: job.runId, ...(job.recovery ? {recovery:job.recovery} : {}) },
        llm: config,
        persona: settings.persona,
        // P2.3：ASR 配置仅 ASR_SUMMARIZE 需要（Key 只进 SW/offscreen 内存，消息为扩展内部通道）
        ...(job.type === 'ASR_SUMMARIZE' && asrSnapshot
          ? { asr: asrSnapshot, asrMaxMB: clamp(settings.asrMaxMB ?? 25, 1, 100) }
          : {}),
        timeoutMs,
      }),
      new Promise<never>((_, rej) => {
        watchdogReject = rej;
        refreshWatchdog();
      }),
    ])) as JobOutcome | undefined;
    if (reply && reply.result === 'failed') {
      // offscreen 的 console 不易被 CDP 捕获，失败原因回灌 SW console 便于诊断
      console.log(`[doubao] offscreen job failed: ${reply.error?.code}: ${reply.error?.msg}`);
    }
    if (!reply) throw new Error('offscreen 无应答（文档可能未加载完成）');
    // P2.6 F11 断网挂起续跑：网络级失败（LLM 传输层/离线期任何 UNKNOWN）回 wait——
    // pipeline 落 pending 不烧重试不 failed 轰炸；恢复时机=SW online 事件/面板 LIST_QUERY/alarms
    if (reply.result === 'failed' && (reply.error?.code === 'LLM_NETWORK' || reply.error?.code === 'RISK_CONTROL' || reply.error?.code === 'PAUSED' || (navigator.onLine === false && reply.error?.code === 'UNKNOWN'))) {
      console.log(`[doubao] job waits for network: ${job.videoKey} (${reply.error?.code})`);
      return { result: 'wait', error: reply.error };
    }
    return reply;
  } catch (e) {
    if (e === watchdogError && job.type === 'ASR_SUMMARIZE') {
      const row = await db.transaction('rw', db.jobs, db.summaries, async () => {
        const current = await db.jobs.get(job.id);
        if (!current || current.status !== 'running' || current.runId !== job.runId) return undefined;
        const { runId: _runId, ...rest } = current;
        const failed: JobRow = { ...rest, status:'failed', error:{code:'ASR_INTERRUPTED',msg:'语音处理超时，已发送部分可能产生费用，请确认后再重试'}, updatedAt:Date.now() };
        await db.jobs.put(failed);
        const summaries = await db.summaries.where('videoKey').equals(job.videoKey).toArray();
        for (const summary of summaries) {
          const progress = summary.asrProgress;
          if (summary.status !== 'done' && progress?.sessionId === job.sessionId && progress.status === 'running') {
            await db.summaries.put({...summary,status:'need_asr',asrProgress:{...progress,status:'partial',warning:'语音处理超时，在途语音费用状态不明，重新识别前请确认'}});
          }
        }
        return failed;
      }).catch(error => {
        // 即使数据库出错，也要尽力停止可能仍在计费的离屏任务。
        void browser.runtime.sendMessage({type:'OFFSCREEN_CANCEL_ASR',sessionId:job.sessionId}).catch(() => {});
        throw error;
      });
      if (row) {
        // 仅通知已存在的离屏文档，不能为了取消创建新文档或等待不响应的通道。
        void browser.runtime.sendMessage({type:'OFFSCREEN_CANCEL_ASR',sessionId:job.sessionId}).catch(() => {});
        onJobTransition(row);
      }
      return {result:'failed',error:{code:'ASR_INTERRUPTED',msg:'语音处理超时，已发送部分可能产生费用，请确认后再重试'}};
    }
    if (await isPaused()) return { result: 'wait', error: { code: 'PAUSED', msg: '陪看已暂停' } };
    console.log(`[doubao] offscreen executor error: ${String(e).slice(0, 200)}`);
    offscreenReady = false; // offscreen 文档可能已被系统回收：下次执行重建
    throw e;
  } finally {
    browser.runtime.onMessage.removeListener(onProgress);
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

const lastLoggedStatus = new Map<string, string>();
export const onJobTransition = (j: JobRow): void => {
  if (j.status === 'done' || j.status === 'failed' || j.status === 'need_confirm') {
    void browser.storage.session.remove(`manualJob:${j.id}`).catch(() => {});
  }
  // 进度写回也会触发本回调：状态变化才打日志（pending 不打，保持原行为）
  if (j.status !== 'pending' && lastLoggedStatus.get(j.id) !== j.status) {
    console.log(`[doubao] job ${j.type} ${j.videoKey} → ${j.status}${j.retries ? ` (retry ${j.retries})` : ''}`);
  }
  // P1.5：状态变化即广播（含 pending 入队——其他标签页/未开面板的列表要看到「生成中」）；
  // 纯进度写回状态不变不广播（进度走 SUMMARY_PROGRESS 通道）
  if (lastLoggedStatus.get(j.id) !== j.status) {
    lastLoggedStatus.set(j.id, j.status);
    // P1.11：分段解读任务走独立终态通道（不得触发 SUMMARY_DONE 的 happy 气泡/列表刷新语义）
    if (j.type === 'SEGMENT_ANALYZE') {
      if (j.status === 'done' || j.status === 'failed') void broadcastSegmentTerminal(j);
      return;
    }
    const t =
      j.status === 'done' ? 'SUMMARY_DONE'
      : j.status === 'failed' ? 'SUMMARY_FAILED'
      : j.status === 'need_confirm' ? 'SUMMARY_NEED_ASR'
      : 'SUMMARY_UPDATED';
    // P2.6：失败终态随带错误码/文案（F9 Key 无效→气泡「去设置」；其余码仅随行不消费）
    broadcastToUi(
      t === 'SUMMARY_FAILED' && j.error
        ? { type: t, videoKey: j.videoKey, jobId: j.id, runId: j.runId, errorCode: j.error.code, errorMsg: j.error.msg }
        : { type: t, videoKey: j.videoKey, jobId: j.id, runId: j.runId },
    );
    // F13 预取提速：摘要落库（大纲+转写已就绪）→ 静默入队未解读段（交互链 prio=1 后台消化，
    // 用户点【AI 解读】时大概率缓存命中秒开）
    if (j.status === 'done') void prefetchSegments(j);
    if (j.status === 'need_confirm' && j.type === 'SUMMARIZE') {
      // 迁移回调发生在 IndexedDB 事务内；提交后再判定，避免并发确认和事务失效。
      setTimeout(() => { void tryAutoAsr(j.id,true).catch(() => {}); }, 0);
    }
  }
};
// 用户在保留期内主动发起的任务仅在本次浏览器运行期间可执行；SW 休眠不会丢失标记。
async function allowManualJob(job: JobRow): Promise<void> {
  await browser.storage.session.set({ [`manualJob:${job.id}`]: true });
}
async function canRunJob(job: JobRow): Promise<boolean | {allowInGrace:boolean}> {
  if (await isPaused()) return false;
  const pointer = await getSessionPointer(browserKv);
  if (!pointer || pointer.sessionId !== job.sessionId) return false;
  if (pointer.state !== 'ACTIVE' && pointer.state !== 'GRACE') return false;
  const key = `manualJob:${job.id}`;
  const manual = (await browser.storage.session.get(key))[key] === true;
  return pointer.state === 'ACTIVE' || manual ? {allowInGrace:manual} : false;
}
// F13 提速：双通道并行——主链（摘要/重生成/ASR，B 站侧串行）+ 交互链（分段解读）。
// 用户点击分段解读不再排在数分钟的摘要任务之后；每链并发=1（总 LLM 并发≤2）。
const pipeline = new Pipeline(db, { execute: executeViaOffscreen }, {
  lane: ['SUMMARIZE', 'ASR_SUMMARIZE', 'REGENERATE'],
  onTransition: onJobTransition,
  canRun: canRunJob,
  enforceSession: true,
});
const segPipeline = new Pipeline(db, { execute: executeViaOffscreen }, {
  lane: ['SEGMENT_ANALYZE'],
  onTransition: onJobTransition,
  canRun: canRunJob,
  enforceSession: true,
});

async function finishOffscreenAsr(id?:string, runId?:string, outcome?:JobOutcome):Promise<{ok:boolean}> {
  if (!id || !runId || !outcome || !['done','failed','wait','need_confirm'].includes(outcome.result)) return {ok:false};
  // 离屏返回内容不可直接回显：仅允许已知错误码对应的固定、脱敏提示。
  const messages:Record<string,string> = {
    ASR_DURATION_LIMIT:'当前豆包语音最多支持 15 分钟的视频，暂不能处理更长的音轨。',
    ASR_AUDIO_TOO_LONG:'当前豆包语音最多支持 15 分钟的音轨。',
    ASR_AUDIO_CHANNEL_UNSUPPORTED:'该音轨声道格式暂不支持。',
    ASR_AUDIO_INCOMPLETE:'音频解码不完整，暂不能识别，请稍后重试。',
    ASR_TIMEOUT:'语音识别请求超时，可能已产生费用，请确认后重试。',
    ASR_SEND_TIMEOUT:'音频发送超时，请检查网络后重新确认。',
    ASR_SERVICE_45000081:'语音服务等待音频包超时，识别未完成。',
    ASR_SERVICE_DURATION_UNKNOWN:'语音服务未返回已处理时长，无法确认全片结果。',
    ASR_SERVICE_DURATION_MISMATCH:'语音服务处理时长与音轨不一致，无法确认全片结果。',
    ASR_AUDIO_TOO_LARGE:'音频超过当前 25 MiB 大小上限，暂不支持处理。',
    AUDIO_TOO_LARGE:'音频超过设置的大小上限（默认 25 MiB），暂不支持处理。',
    ASR_AUDIO_MISSING:'无法获取该视频的音频。', NO_AUDIO:'无法获取该视频的音频。',
    ASR_AUDIO_HTTP:'音频下载失败，请检查网络或登录状态。', AUDIO_HTTP:'音频下载失败，请检查网络或登录状态。',
    ASR_AUDIO_FAILED:'音频获取失败，请稍后重试。',
    ASR_DURATION_MISMATCH:'音轨和视频时长不一致，暂不能确认处理范围。',
    ASR_TIMESTAMP_MISSING:'部分语音缺少可靠时间信息，已保留内容，无法确认完整结果。',
    ASR_CONTENT_UNCONFIRMED:'已有转写内容或时间不一致，原文和旧摘要已保留。',
    ASR_RECOVERY_CHANGED:'已保存的新转写不可用，请重新确认处理方式。',
    ASR_UNCONFIRMED:'部分识别结果尚未确认，已保留内容，不能标记完整。',
    ASR_ALIGNMENT_UNCERTAIN:'片段衔接无法可靠确认，已保留内容，请勿将其视为完整结果。',
    ASR_NO_SPEECH:'该音频未识别到可用语音。', LOW_CONTENT:'该视频几乎没有可解析的语音内容。',
    ASR_TOO_SHORT:'识别到了少量语音，但内容不足以生成可靠摘要。',
    ASR_SUMMARY_FAILED:'摘要生成未完成，可重试并复用已识别的文字。',
    NEED_LOGIN:'需要登录 B 站才能获取视频，请先在本浏览器登录。',
    RISK_CONTROL:'B 站风控拦截，请稍后重试。',
    KEY_INVALID:'模型 Key 无效或无权限，请到设置检查。',
    NO_BALANCE:'模型余额不足，请检查账户。',
    ASR_NETWORK:'语音服务无法连接，请检查网络和配置。',
    ASR_CONNECTION_FAILED:'语音服务无法连接，请检查网络和配置。',
    ASR_AUDIO_DECODE_FAILED:'音频无法解码，暂不支持处理。',
  };
  const code = outcome.result === 'failed' && typeof outcome.error?.code === 'string' && Object.hasOwn(messages,outcome.error.code) ? outcome.error.code : 'ASR_FAILED';
  const row = await db.transaction('rw',db.jobs,async () => {
    const current = await db.jobs.get(id);
    if (!current || current.type !== 'ASR_SUMMARIZE' || current.status !== 'running' || current.runId !== runId) return undefined;
    const next:JobRow = outcome.result === 'done'
      ? {...current,status:'done',progress:100,error:undefined,updatedAt:Date.now()}
      : outcome.result === 'need_confirm'
        ? {...current,status:'need_confirm',error:undefined,updatedAt:Date.now()}
        : {...current,status:'failed',error:outcome.result === 'failed'
          ? {code,msg:messages[code] ?? '语音处理未完成，请检查设置后重新确认。'}
          : {code:'ASR_INTERRUPTED',msg:'语音识别中断，已发送部分可能产生费用，请确认后再重试'},updatedAt:Date.now()};
    await db.jobs.put(next);return next;
  });
  if (!row) return {ok:false};
  onJobTransition(row);drainUnlessPaused(true);return {ok:true};
}

/**
 * F13 分段预取（静默提前解读）：当前视频摘要 done 后，把未解读段以 prio=1 入交互链。
 * 护栏：暂停中零请求；仅当前 ACTIVE 会话（GRACE/换会话不烧）；done 注记跳过；
 * enqueue 幂等收口并发重复。成本上界：每视频 ≤12 次小额调用（≤500 token、Ark 关思考）。
 */
async function prefetchSegments(j: JobRow): Promise<void> {
  try {
    if (await isPaused()) return;
    const pointer = await getSessionPointer(browserKv);
    if (pointer?.state !== 'ACTIVE' || pointer.sessionId !== j.sessionId) return;
    const row = await latestSummary(j.videoKey);
    if (!row || row.status !== 'done' || row.asrOutdated || !row.outline?.length) return;
    const transcript=await db.transcripts.get(j.videoKey);
    if (row.source==='asr' && transcript && hasAsrSemanticMismatch(transcript)) return;
    const todo = segmentsToPrefetch(row.outline, row.segmentNotes);
    for (const i of todo) {
      await segPipeline.enqueue({
        type: 'SEGMENT_ANALYZE',
        videoKey: j.videoKey,
        sessionId: j.sessionId,
        segIndex: i,
        prio: 1,
      });
    }
    if (todo.length) {
      console.log(`[doubao] segment prefetch queued: ${j.videoKey} ×${todo.length}`);
      drainUnlessPaused();
    }
  } catch {
    /* 预取尽力而为：失败不影响按需解读链路（用户点击仍走 OPEN 入队） */
  }
}

/** SEGMENT_NOTE_DONE/FAILED：终态注记文本/错误从 summaries.segmentNotes 读回随广播下发（面板免再请求）。 */
async function broadcastSegmentTerminal(j: JobRow): Promise<void> {
  try {
    const row = await latestSummary(j.videoKey);
    const note = j.segIndex !== undefined ? row?.segmentNotes?.[j.segIndex] : undefined;
    broadcastToUi({
      type: j.status === 'done' ? 'SEGMENT_NOTE_DONE' : 'SEGMENT_NOTE_FAILED',
      videoKey: j.videoKey,
      segIndex: j.segIndex,
      text: note?.text ?? '',
      error: j.error ?? note?.error, // j.error 与 failed 终态同 tick 落行、永远最新（审查 P2-1：重试走早退不写注记时不得带出旧注记错误码）；note 兜底历史行
      truncated: note?.truncated,
    });
  } catch {
    /* 广播失败不影响队列 */
  }
}

interface InMsg {
  type?: string;
  bvid?: string | null;
  url?: string;
  page?: number;
  videoKey?: string;
  watchedSeconds?: number;
  watchId?: string;
  progressPct?: number;
  time?: number; // SEEK_TO 目标秒（P1.8）
  segIndex?: number; // SEGMENT_NOTE_OPEN 段下标（P1.11）
  force?: number; // LOGIN_CHECK 强制绕过 30s 缓存（P1.10：面板打开时机）
  retry?: number; // SUMMARY_OPEN 用户显式重试标记（1=点击进入，可对 failed 摘要重新入队）
  transcriptPage?: number;
  recovery?: boolean;
  recoveryAction?: 'continue' | 'recognize';
  llm?: ModelConfigMsg;
  asr?: ModelConfigMsg;
  kind?: 'llm' | 'asr'; // TEST_CONNECTION：探活对象（P2.3 起 asr 走 /models 探活）
  pcm?: number[];
  authRule?: { key: string; requestId: string } | null;
  jobId?: string;
  runId?: string;
  outcome?: JobOutcome;
  // P2.5 设置页：偏好部分保存 + LLM 配置显式清除（F9「清空 Key 保存→回到未激活态」）
  triggerSeconds?: number;
  persona?: string;
  bubbles?: boolean;
  paused?: boolean;
  runningJob?: boolean;
  llmClear?: boolean;
}

// ---- P2.3 · DNR 音频防盗链（架构 §3.8） -------------------------------------------
// bilivideo CDN 是否校验 Referer 取决于调度命中的节点类型（不可预测，07 报告 G-2）——
// 对扩展自身发起的音频请求无条件补 Referer: https://www.bilibili.com/（.com+.cn 双域）。
// 规则形状在 lib/dnr（任务 2.4 抽出可单测）；用动态规则而非静态 JSON：initiator 域=
// chrome.runtime.id 只有运行时可知（静态文件写不了）且无 initiator 限定会波及页面自身请求。
async function ensureDnrRules(): Promise<void> {
  const rules = buildRefererRules(browser.runtime.id);
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [...DNR_RULE_IDS],
      addRules: rules as never,
    });
    console.log('[doubao] dnr rules ensured: 2 (bilivideo.com/.cn Referer for extension requests)');
  } catch (e) {
    console.log(`[doubao] dnr ensure error: ${String(e).slice(0, 500)}`);
  }
}

export default defineBackground(() => {
  console.log('[doubao-poc] background ready');
  // storage.session 在 SW 休眠时保留，浏览器资料重启时清空；扩展重载和更新也会清空。
  browserSessionReady = (async () => {
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DOUBAO_RULE_ID] });
    const marker = await browser.storage.session.get('browserSessionReady');
    if (!marker.browserSessionReady) {
      const pointer = await getSessionPointer(browserKv);
      if (pointer?.state === 'ACTIVE') {
        const heartbeat = await browserKv.get<{ sessionId: string; at: number }>('browserHeartbeat');
        const now = Date.now();
        const closedAt = heartbeat?.sessionId === pointer.sessionId && Number.isFinite(heartbeat.at) && heartbeat.at >= pointer.lastActiveAt && heartbeat.at <= now
          ? heartbeat.at : now;
        await handleSessionEnd(closedAt);
        const result = await applyRetention(db, browserKv, now);
        if (result.verdict.kind === 'EXPIRE' && result.pointer) {
          lastBroadcastSession = { sessionId: result.pointer.sessionId, state: result.pointer.state };
          broadcastToUi(sessionStateMsg(result.pointer));
        }
      }
      await browser.storage.session.set({ browserSessionReady: true });
    }
    // 不重建已有闹钟：每次 SW 唤醒都重设会把下一次心跳不断推迟。
    try {
      if (!(await browser.alarms.get('doubao-browser-heartbeat'))) {
        await browser.alarms.create('doubao-browser-heartbeat', { periodInMinutes: 1 });
      }
    } catch {
      // 心跳不可用时，启动判定使用可得时间；不阻塞扩展使用。
    }
  })();
  // SW 启动：恢复 stale running → 清空 pending（断网挂起/重启后续跑，F11；P2.5 暂停中则挂起）
  recoveryReady = browserSessionReady.then(async () => {
    let live: {id:string;runId:string;outcome?:JobOutcome}[] = [];
    try {
      const contexts = await browser.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT' as never]});
      if (contexts.length) {
        const reply = await sendToOffscreen({type:'OFFSCREEN_ACTIVE_JOBS'});
        if (Array.isArray(reply)) live = reply.filter(x => typeof x?.id === 'string' && typeof x?.runId === 'string');
      }
    } catch { /* 离屏文档不存在时按中断处理 */ }
    for (const run of live) if (run.outcome) await finishOffscreenAsr(run.id,run.runId,run.outcome);
    return pipeline.recover(live);
  });
  void recoveryReady.then(async (n) => {
    if (n) console.log(`[doubao] recovered ${n} stale job(s)`);
    await resumeAutoAsrWaiting();
    drainUnlessPaused(n > 0); // 恢复了任务时，忙碌中的两条队列都须在当前轮后补查
  });
  // P1.10 时机①：扩展启动即探登录态（架构 §3.9）
  void browserSessionReady.then(() => checkLoginState(true))
    .then((s) => applyLoginState(s))
    .catch(() => {});
  // P2.1 时机①：扩展启动即判保留期（GRACE 超期 → EXPIRED_PENDING_CONFIRM；仅状态，不删数据）
  void runRetention(true).catch(() => {});
  void browserSessionReady.then(() => checkUpdate());
  // P2.1 兜底：30min 周期闹钟在 SW 被唤醒时补一次判定（MV3 定时器不可靠，判定以时间戳比较为准）
  void browser.alarms.create('doubao-retention', { periodInMinutes: 30 });
  browser.alarms.onAlarm.addListener((a) => {
    if ((a as { name?: string }).name === 'doubao-browser-heartbeat') {
      void browserSessionReady.then(async () => {
        const pointer = await getSessionPointer(browserKv);
        if (pointer?.state === 'ACTIVE') await browserKv.set('browserHeartbeat', { sessionId: pointer.sessionId, at: Date.now() });
      });
    }
    if ((a as { name?: string }).name === 'doubao-bili-risk') {
      drainUnlessPaused(true);
      void readSettings().then(settings => broadcastToUi({ type: 'WATCH_SETTINGS', paused: settings.paused === true, restartWatcher: true }));
    }
    if ((a as { name?: string }).name === 'doubao-retention') {
      void runRetention(true);
      drainUnlessPaused(); // P2.6：断网挂起的 pending 在 30min 兜底唤醒时也试续跑
      void browserSessionReady.then(() => checkUpdate()); // 存储时间戳保证最多每天检查一次
    }
  });
  // P2.6 F11：网络恢复事件 → 立即续跑挂起队列（MV3 SW 全局作用域可收 online/offline）
  addEventListener('online', () => {
    console.log('[doubao] network online: resuming suspended jobs');
    drainUnlessPaused(true);
  });
  // P2.3：DNR 音频 Referer 规则（幂等重建；启动/重启均确保在位）
  void ensureDnrRules();

  // P1.5：面板 Port。连接即回放当前会话状态（新标签页初始化；P1.6 豆包消费）
  // P2.1 时机③：content 首连即判保留期（浏览器重开后的第一个连接点），回放判定后的最新态
  browser.runtime.onConnect.addListener((port) => {
    if ((port as { name?: string }).name !== 'doubao-port') return;
    const p = port as unknown as UiPort;
    p.tabId = (port as unknown as { sender?: { tab?: { id?: number } } }).sender?.tab?.id;
    uiPorts.add(p);
    (port as unknown as { onDisconnect: { addListener: (cb: () => void) => void } }).onDisconnect.addListener(() => {
      try { void browser.runtime.lastError; } catch { /* 扩展上下文可能已失效 */ }
      uiPorts.delete(p);
    });
    const replayRevision = sessionBroadcastRevision;
    const settingsRevision = settingsBroadcastRevision;
    void runRetention()
      .then(async (r) => {
        try {
          const settings = await readSettings();
          if (settingsRevision === settingsBroadcastRevision) p.postMessage({ type: 'WATCH_SETTINGS', paused: settings.paused === true, bubbles: settings.bubbles !== false });
          // 连接期间已经收到更新广播时，不再回放较旧的会话快照。
          if (replayRevision === sessionBroadcastRevision) p.postMessage(sessionStateMsg(r.pointer));
        } catch {
          /* 端口即断 */
        }
      })
      .catch(() => {});
  });

  // P1.9 · SPA 路由探测主路（架构 §3.1）：B 站真 SPA 切换走主世界 pushState，content 孤立世界的
  // history 补丁拦不到（E2E 实测 follow 失效揪出）→ webNavigation.onHistoryStateUpdated 由 SW 侧
  // 感知并经 tabs.sendMessage 通知该标签页 content 重新识别（popstate/补丁仅作兜底）。
  // 不按 /video/ 过滤 URL（审查 P1-1）：「离开视频页」的路由同样必须送达——content 的
  // startWatcher(null) 负责 dispose 旧会话并作废在途 VIDEO_ENTER 应答，否则代数令牌不失效、
  // 首页 feed 预览 <video> 会被绑进旧视频的观看计时（真实 LLM 费用+脏数据）。
  browser.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    const url = (d as { url?: string }).url ?? '';
    void browser.tabs
      .sendMessage(d.tabId, { type: 'ROUTE_CHANGED', url })
      .catch(() => {}); // 标签页无 content（非匹配页/未注入）静默
  });

  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = msg as InMsg;
    switch (m?.type) {
      case 'BILI_REQUEST_GATE':
        return browserSessionReady.then(() => beforeBiliRequest(m.runningJob === true)).then(() => ({ ok: true })).catch((e: unknown) => ({ ok: false, code: e instanceof BiliApiError ? e.code : -412, msg: e instanceof Error ? e.message : '请求暂缓' }));
      case 'BILI_RISK_HIT':
        return browserSessionReady.then(() => markBiliRisk()).then(() => ({ ok: true }));
      case 'PING':
        return browserSessionReady.then(() => ({ pong: true }));
      case 'VIDEO_ENTER':
        return browserSessionReady.then(() => handleVideoEnter(m));
      case 'WATCH_TICK':
        return browserSessionReady.then(() => handleWatchTick(m));
      case 'TRIGGER_SUMMARY':
        return browserSessionReady.then(() => handleTriggerSummary(m));
      case 'LIST_QUERY':
        return browserSessionReady.then(() => handleListQuery());
      case 'CURRENT_VIDEO_STATUS':
        return browserSessionReady.then(() => handleCurrentVideoStatus(m));
      case 'SUMMARY_OPEN':
        return browserSessionReady.then(() => handleSummaryOpen(m));
      case 'REGENERATE':
        return browserSessionReady.then(() => handleRegenerate(m));
      case 'ASR_CONFIRM':
        return browserSessionReady.then(() => handleAsrConfirm(m)); // P2.3 F6：用户确认调用 ASR
      case 'ASR_DECLINE':
        return browserSessionReady.then(() => handleAsrDecline(m)); // P2.3 F6：暂不（保持橙色标注，无状态迁移）
      case 'DOUBAO_TRANSCRIBE_PCM':
        if (sender?.url !== browser.runtime.getURL('/offscreen.html')) return Promise.resolve({ ok: false, error: 'ASR_UNAUTHORIZED' });
        return browserSessionReady.then(() => handleDoubaoPcm(m));
      case 'DOUBAO_AUTH_RULE':
        if (sender?.url !== browser.runtime.getURL('/offscreen.html')) return Promise.resolve({ ok: false, error: 'ASR_UNAUTHORIZED' });
        if (m.authRule && wipesInProgress) return Promise.resolve({ ok: false, error: 'ASR_CANCELLED' });
        return browserSessionReady.then(() => scheduleDoubaoRule(m.authRule));
      case 'ASR_PARTIAL_UPDATED':
        if (sender?.url !== browser.runtime.getURL('/offscreen.html')) return Promise.resolve({ok:false});
        return browserSessionReady.then(async () => {
          const job = m.jobId ? await db.jobs.get(m.jobId) : undefined;
          if (!job || job.type !== 'ASR_SUMMARIZE' || job.status !== 'running' || job.runId !== m.runId) return {ok:false};
          broadcastToUi({type:'SUMMARY_UPDATED',videoKey:job.videoKey});
          return {ok:true};
        });
      case 'OFFSCREEN_ASR_DONE':
        if (sender?.url !== browser.runtime.getURL('/offscreen.html')) return Promise.resolve({ok:false});
        return browserSessionReady.then(() => finishOffscreenAsr(m.jobId,m.runId,m.outcome));
      case 'SEEK_TO':
        return browserSessionReady.then(() => handleSeekTo(m));
      case 'SEGMENT_NOTE_OPEN':
        return browserSessionReady.then(() => handleSegmentNoteOpen(m));
      case 'LOGIN_CHECK':
        return browserSessionReady.then(() => handleLoginCheck(m));
      case 'SESSION_START':
        return browserSessionReady.then(() => handleSessionStart());
      case 'SESSION_END':
        return browserSessionReady.then(() => handleSessionEnd());
      case 'WIPE_CONFIRM':
      case 'WIPE_NOW':
        return browserSessionReady.then(() => handleWipe()); // P2.2 F10 清除链路（超期确认【立即清除】/ 手动清除）
      case 'TEST_CONNECTION': {
        const endpoint = validateEndpointUrl(m.llm?.baseUrl ?? '');
        // 必须在消息同步阶段调用，不能先 await 存储或进入 Promise 队列，否则手势丢失。
        const origins = m.kind === 'asr' && m.llm?.provider === 'doubao-agent-plan' ? [DOUBAO_ASR_ORIGIN] : m.llm?.modelId?.trim() && endpoint.ok && endpoint.origin ? [`${endpoint.origin}/*`] : [];
        const access = ensureOriginPermission(origins);
        return Promise.all([access, browserSessionReady]).then(async ([granted]) => {
          const result = m.llm?.provider === 'doubao-agent-plan' && !granted ? { ok: false, msg: '未授权豆包语音服务，请重新授权后测试' } : await handleTestConnection(m);
          if (m.kind === 'asr' && result.ok === true) void resumeAutoAsrWaiting();
          return result;
        });
      }
      case 'SETTINGS_SAVE': {
        const origins = [m.llm, m.asr].flatMap(cfg => {
          if (cfg === m.asr && cfg?.provider === 'doubao-agent-plan') return [DOUBAO_ASR_ORIGIN];
          const endpoint = validateEndpointUrl(cfg?.baseUrl ?? '');
          return cfg?.modelId?.trim() && endpoint.ok && endpoint.origin ? [`${endpoint.origin}/*`] : [];
        });
        const access = ensureOriginPermission([...new Set(origins)]);
        // 配置写入仍按点击顺序串行；原生授权对话框不占用保存队列，其他标签页可立即暂停。
        const saved = settingsSaveTail.then(() => browserSessionReady).then(() => handleSettingsSave(m));
        settingsSaveTail = saved.then(() => {}, () => {});
        return Promise.all([saved, access]).then(async ([result]) => {
          if (result.ok !== true) return result;
          const granted: string[] = [];
          const denied: string[] = [];
          for (const origin of origins) (await browser.permissions.contains({ origins: [origin] }) ? granted : denied).push(origin);
          if (m.asr && denied.length === 0) void resumeAutoAsrWaiting();
          return { ...result, granted, denied };
        });
      }
      case 'SETTINGS_GET':
        return browserSessionReady.then(() => handleSettingsGet()); // P2.5：设置页数据源（Key 打码，F9）
      default:
        return undefined; // 未识别消息交给其它 listener（SUMMARY_PROGRESS 由 executeViaOffscreen 处理）
    }
  });
});

// ---- P1.6 · 会话最小切片 + P2.1 保留期状态机 ------------------------------------

const rand4 = () => Math.random().toString(36).slice(2, 6);

/**
 * SESSION_START（开始/恢复陪看）：未配置 LLM → NEED_ONBOARDING（F1/F9，content 弹 onboarding）。
 * GRACE 内重开 = 恢复同一会话（保留列表与进度）；无 pointer 才新建 session 行。
 * P2.1：EXPIRED_PENDING_CONFIRM 期禁止直接开新会话——旧数据还躺在库里未被处置，
 * 静默换 pointer 会把整段旧陪看数据变成永远不可见的死数据（F10：处置必须经确认链路）。
 */
async function handleSessionStart(): Promise<Record<string, unknown>> {
  const cfg = await readStoredLlmConfig(browserKv);
  if (!cfg) return { ok: false, reason: 'NEED_ONBOARDING' };
  const now = Date.now();
  // 审查 P2-1：读 pointer 前先判保留期（判定收口到唯一入口）——SW 冷启动被 SESSION_START
  // 唤醒时，若直接读 pointer 会与 unawaited 的启动判定竞态：过期 GRACE 可在写回前被静默恢复
  const { pointer: existing } = await runRetention();
  const blocked = sessionStartBlockedReason(existing);
  if (blocked) return { ok: false, reason: blocked };
  const resumable = existing?.state === 'ACTIVE' || existing?.state === 'GRACE';
  // shortcut: 双标签页无 pointer 并发点开始会各建一会话行（输家成孤儿行，2.1 保留期清理时收口）
  let sessionId: string;
  if (existing && resumable) {
    // 恢复（GRACE）或幂等重入（ACTIVE）
    sessionId = existing.sessionId;
    await db.sessions.update(sessionId, {
      state: 'ACTIVE',
      lastActiveAt: now,
      ...(existing.state === 'GRACE' ? { restoredAt: now } : {}),
    });
  } else {
    sessionId = `s_${now}_${rand4()}`;
    await db.sessions.put({ id: sessionId, state: 'ACTIVE', startedAt: now, lastActiveAt: now });
  }
  const pointer: SessionPointer = {
    sessionId,
    state: 'ACTIVE',
    startedAt: existing && resumable ? existing.startedAt : now,
    lastActiveAt: now,
    ...(existing?.state === 'GRACE' ? { restoredAt: now } : {}),
  };
  await setSessionPointer(browserKv, pointer);
  await browserKv.set('browserHeartbeat', { sessionId, at: now });
  console.log(`[doubao] session ${resumable ? 'resumed' : 'started'}: ${sessionId}`);
  lastBroadcastSession = { sessionId, state: 'ACTIVE' };
  broadcastToUi(sessionStateMsg(pointer));
  drainUnlessPaused(true);
  return { ok: true, sessionState: 'ACTIVE', resumed: resumable };
}

/** SESSION_END（结束陪看）：ACTIVE → GRACE（closedAt=现在，1h 保留基准；响应带倒计时数据）。 */
async function handleSessionEnd(closedAt = Date.now()): Promise<Record<string, unknown>> {
  const pointer = await getSessionPointer(browserKv);
  if (!pointer || pointer.state !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  const now = closedAt;
  const next: SessionPointer = { ...pointer, state: 'GRACE', closedAt: now, lastActiveAt: now };
  await db.transaction('rw', db.sessions, db.jobs, db.summaries, async () => {
    await db.sessions.update(pointer.sessionId, { state: 'GRACE', closedAt: now, lastActiveAt: now });
    await interruptSessionAsr(db, pointer.sessionId, now);
  });
  // 消息只发往现有离屏文档；不创建新文档。任务租约已先失效。
  try { await browser.runtime.sendMessage({type:'OFFSCREEN_CANCEL_ASR',sessionId:pointer.sessionId}); } catch { /* 文档可能不存在 */ }
  await setSessionPointer(browserKv, next);
  console.log(`[doubao] session ended (GRACE): ${pointer.sessionId}`);
  lastBroadcastSession = { sessionId: pointer.sessionId, state: 'GRACE' };
  broadcastToUi(sessionStateMsg(next));
  return { ok: true, sessionState: 'GRACE', closedAt: now, retainUntil: retainUntilOf(next) };
}

/**
 * P2.2 · WIPE_CONFIRM / WIPE_NOW（F10 清除链路）：事务清空六表 + 移除 sessionPointer
 * （settings/mascotPos/onboarded 保留）→ 广播 INACTIVE（面板清空、豆包回未激活+开始气泡）。
 * 「稍后提醒」是面板本地行为（保持 EXPIRED_PENDING_CONFIRM，不删数据），不产生消息。
 * 审查 P1-1：清除前先掐死在途执行体（offscreen）——否则生成中的 job 会在 wipe 后落一行
 * 孤儿 summary，且 latestSummary 按 videoKey 取行，重看同视频会「复活」已清数据（F10-③ 违背）；
 * 执行体死后 sendToOffscreen 拒绝 → tick 落 failed 但 job 行已删（pipeline 双守卫）不复活。
 * 残余窗口：掐死前最后 ms 级已提交的 put——极窄，记账接受。
 */
async function handleWipe(): Promise<Record<string, unknown>> {
  wipesInProgress++;
  try {
    try {
      await browser.offscreen.closeDocument();
      console.log('[doubao] wipe: offscreen executor killed (in-flight job aborted)');
    } catch {
      /* offscreen 未开或关闭失败时仍清理规则并清除数据。 */
    }
    offscreenReady = false;
    let ruleCleanupFailed = false;
    try { await scheduleDoubaoRule(null); } catch { ruleCleanupFailed = true; }
    await wipeAllData(db, browserKv);
    lastBroadcastSession = null;
    broadcastToUi(sessionStateMsg(undefined)); // {type:'SESSION_STATE', state:'INACTIVE'}
    console.log('[doubao] wipe all data done (six tables + pointer cleared; settings kept)');
    return ruleCleanupFailed ? { ok: false, error: '数据已清除，但语音认证规则清理失败；请重启扩展后重试' } : { ok: true, sessionState: 'INACTIVE' };
  } finally {
    wipesInProgress--;
  }
}

// ---- P1.2 · watcher 服务端 ---------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** VIDEO_ENTER：view 元信息（videos 24h 缓存）+ 多 P 选 cid + 建/刷 visit，回 watcher 所需参数。
 *  P2.5「暂停陪看」：直接拒绝（不取 view=零网络请求、不建 visit=零采集，F12）。 */
async function handleVideoEnter(m: InMsg): Promise<Record<string, unknown>> {
  const { bvid, url } = m;
  if (!bvid || !url) return { ok: false, error: 'VIDEO_ENTER 缺 bvid/url' };
  if (await isPaused()) return { ok: false, reason: 'paused' };
  const initialPointer = await getSessionPointer(browserKv);
  if (initialPointer?.state !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  try {
    let wantedPage = 1;
    try {
      wantedPage = Number(new URL(url).searchParams.get('p')) || 1;
    } catch {
      /* 相对/畸形 url 按第 1P 处理 */
    }
    const now = Date.now();
    // 缓存键 bvid:cid 依赖 cid，未取 view 前未知 → 按 bvid 索引取候选再按页码过滤 24h 内的行
    let row = (await db.videos.where('bvid').equals(bvid).toArray()).find(
      (r) => r.page === wantedPage && isCacheFresh(r.fetchedAt, now),
    );
    if (!row) {
      const client = new BiliClient(biliRequestHooks);
      const v = await client.getView(bvid); // view 免 WBI 签名，无需先取 keys
      const pg = pickPage(v.pages, wantedPage);
      row = {
        key: `${bvid}:${pg?.cid ?? 0}`,
        bvid,
        aid: v.aid,
        cid: pg?.cid ?? 0,
        title: v.title,
        cover: v.cover,
        owner: v.owner,
        duration: pg?.duration ?? v.duration, // 多 P：顶层 duration 是各 P 之和，必须用单 P 值
        page: pg?.page ?? 1,
        fetchedAt: now,
      } satisfies VideoRow;
      await db.videos.put(row);
    }
    const pointer = await getSessionPointer(browserKv);
    if (pointer?.state !== 'ACTIVE' || pointer.sessionId !== initialPointer.sessionId || await isPaused()) return { ok: false, reason: 'inactive' };
    const visit = await upsertVisit(db, { sessionId: pointer.sessionId, videoKey: row.key, now });
    const settings = (await browser.storage.local.get('settings'))['settings'] as
      | { triggerSeconds?: number }
      | undefined;
    if (visit.triggered && visit.watchedSeconds >= clamp(settings?.triggerSeconds ?? 10,5,300)) await resumeLegacyVideo(row.key,pointer.sessionId);
    return {
      ok: true,
      videoKey: row.key,
      duration: row.duration,
      triggerSeconds: clamp(settings?.triggerSeconds ?? 10, 5, 300),
    };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** WATCH_TICK（1Hz 节流后到达）：刷新 visit 进度。未激活（无 sessionPointer）不产生记录（F1）。
 *  行缺失时惰性补建（P1.6）：「先开视频后点开始陪看」时序下 VIDEO_ENTER 早于激活、
 *  当时无 pointer 不建行——首个 tick 自愈，保证「会话内看过的视频一个不漏」（F4）。
 *  P1.7 补：阈值扫描兜底——content 侧 tracker 是一次性触发，若阈值在激活前已跨过
 *  （先看后激活的 autoplay 时序，E2E 实测），触发请求在 INACTIVE 期被吞后不再重发；
 *  这里以 DB 的 watchedSeconds 为权威做幂等补偿，F2 语义（累计≥阈值→触发）在任何时序下成立。 */
async function handleWatchTick(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey, watchedSeconds = 0, progressPct = 0, watchId } = m;
  if (!videoKey) return { ok: false };
  if (await isPaused()) return { ok: false, reason: 'paused' }; // P2.5：暂停=零采集（不建行不记进度）
  const pointer = await getSessionPointer(browserKv);
  if (pointer?.state !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  const sessionId = pointer.sessionId;
  const existing = await db.visits.where({ sessionId, videoKey }).first();
  if (!existing) {
    // videos 行可能也缺（VIDEO_ENTER 全程未激活）：job 链有兜底，列表标题退 videoKey
    await upsertVisit(db, { sessionId, videoKey, now: Date.now() });
  }
  await updateVisitProgress(db, { sessionId, videoKey }, { watchedSeconds, progressPct, watchId });
  const threshold = clamp((await readSettings()).triggerSeconds ?? 10, 5, 300);
  const row = await db.visits.where({ sessionId, videoKey }).first();
  if (row && !row.triggered && row.watchedSeconds >= threshold) {
    // 审查 P2-1（2.2 轮）：读 pointer（:507）到入队之间可能插入手动清除——复验仍属同会话
    // 才入队，否则 wipe 后的迟到 tick 会重建 visit+烧一次 LLM（visit 行刚被随表清空，
    // where 查无行本会跳过；此复验收口 pointer 被清除/换新的窗口）
    const live = await getSessionPointer(browserKv);
    if (live?.sessionId !== sessionId || live.state !== 'ACTIVE' || await isPaused()) return { ok: true, staleSession: true };
    const queued = await db.transaction('rw', [db.visits, db.jobs], async () => {
      // 在事务内读取，避免覆盖另一标签页刚提交的观看增量；重复触发也在此收口。
      const latest = await db.visits.where({ sessionId, videoKey }).first();
      if (!latest || latest.triggered || latest.watchedSeconds < threshold) return false;
      await db.visits.update(latest.id!, { triggered: 1, lastSeenAt: Date.now() });
      await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId });
      return true;
    });
    if (!queued) return { ok: true, deduped: true };
    console.log(`[doubao] summary job queued (tick sweep): ${videoKey}`);
    drainUnlessPaused();
    return { ok: true, summaryTriggered: true };
  }
  return { ok: true, ...(existing ? {} : { created: true }) };
}

/**
 * TRIGGER_SUMMARY（可配置阈值）：会话级幂等（visits.triggered）+ pipeline.enqueue 活动任务去重
 * （双标签页/触发与按需并发在此收口），入队后 kick drain。
 */
async function handleTriggerSummary(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false };
  if (await isPaused()) return { ok: false, reason: 'paused' }; // P2.5：暂停不触发不置位（恢复后照常）
  const pointer = await getSessionPointer(browserKv);
  if (pointer?.state !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  const visit = await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first();
  if (!visit) return { ok: false, reason: 'no-visit' };
  const threshold = clamp((await readSettings()).triggerSeconds ?? 10, 5, 300);
  if (visit.watchedSeconds < threshold) return { ok: false, reason: 'below-threshold' };
  if (visit.triggered) return { ok: true, deduped: true };
  const live = await getSessionPointer(browserKv);
  if (live?.sessionId !== pointer.sessionId || live.state !== 'ACTIVE' || await isPaused()) return { ok: false, reason: 'inactive' };
  // 单事务：置位 triggered 与建 job 同生共死，不用事务外旧记录覆盖并发进度。
  const queued = await db.transaction('rw', [db.visits, db.jobs], async () => {
    const latest = await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first();
    if (!latest || latest.triggered || latest.watchedSeconds < threshold) return false;
    await db.visits.update(latest.id!, { triggered: 1, lastSeenAt: Date.now() });
    await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId: pointer.sessionId });
    return true;
  });
  if (!queued) return { ok: true, deduped: true };
  console.log(`[doubao] summary job queued: ${videoKey}`);
  drainUnlessPaused();
  return { ok: true };
}

// ---- P1.5 · 面板数据服务（LIST_QUERY / SUMMARY_OPEN） --------------------------

const ACTIVE_JOB_STATUSES: JobRow['status'][] = ['pending', 'running', 'need_confirm'];

/** videoKey 的最新 summary 行（换模型会产生多行，面板展示最新一次结果）。 */
async function latestSummary(videoKey: string): Promise<SummaryRow | undefined> {
  const rows = await db.summaries.where('videoKey').equals(videoKey).sortBy('createdAt');
  return rows.length ? rows[rows.length - 1] : undefined;
}

/** 摘要类活动任务（驱动列表「生成中」徽章与详情流式态判定）。
 *  F13：排除 SEGMENT_ANALYZE——分段预取在后台跑，不得污染列表徽章/详情流式态（分段态另有 activeSegmentJob）。 */
async function activeJob(videoKey: string, sessionId: string): Promise<JobRow | undefined> {
  const rows = await db.jobs.where('videoKey').equals(videoKey).toArray();
  return rows.find((j) => j.sessionId === sessionId && j.type !== 'SEGMENT_ANALYZE' && ACTIVE_JOB_STATUSES.includes(j.status));
}

/** 只读状态快照：不执行保留期判断、队列唤醒或摘要生成，也不返回字幕和摘要正文。 */
async function handleCurrentVideoStatus(m: InMsg): Promise<Record<string, unknown>> {
  let { videoKey } = m;
  if (!videoKey && (!m.bvid || !Number.isInteger(m.page) || m.page! < 1)) return { ok: false };
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: true, videoKey };
  if (!videoKey) {
    // 暂停后刷新时没有 watcher，只从本机会话已有的视频元信息定位分 P。
    const rows = (await db.videos.where('bvid').equals(m.bvid!).toArray())
      .filter(row => row.page === m.page)
      .sort((a, b) => b.fetchedAt - a.fetchedAt);
    const candidate = rows[0];
    if (candidate && await db.visits.where({ sessionId: pointer.sessionId, videoKey: candidate.key }).first()) videoKey = candidate.key;
    if ((await getSessionPointer(browserKv))?.sessionId !== pointer.sessionId) return { ok: false };
    if (!videoKey) return { ok: true, videoKey: undefined };
  }
  const visit = await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first();
  if (!visit) return { ok: true, videoKey };
  const [summary, job, jobs] = await Promise.all([
    latestSummary(videoKey),
    activeJob(videoKey, pointer.sessionId),
    db.jobs.where('videoKey').equals(videoKey).toArray(),
  ]);
  if ((await getSessionPointer(browserKv))?.sessionId !== pointer.sessionId) return { ok: false };
  const lastJob = jobs.filter(j => j.sessionId === pointer.sessionId && j.type !== 'SEGMENT_ANALYZE')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    ok: true,
    videoKey,
    ...(job ? { job: { id: job.id, type: job.type, status: job.status, stage: job.stage, runId: job.runId } } : {}),
    ...(summary ? { summary: { status: summary.status, source: summary.source, errorCode: summary.error?.code, asrOutdated: summary.asrOutdated } } : {}),
    ...(lastJob ? { lastJob: { type: lastJob.type, status: lastJob.status, errorCode: lastJob.error?.code } } : {}),
  };
}

interface StoredSettings {
  triggerSeconds?: number;
  persona?: string;
  asrMaxMB?: number;
  bubbles?: boolean;
  paused?: boolean; // P2.5：「暂停陪看」总开关（F12：开启后不再有任何采集与请求）
  llm?: { baseUrl: string; modelId: string; apiKey: string };
  asr?: { baseUrl: string; modelId: string; apiKey: string; provider?: 'openai-compatible' | 'doubao-agent-plan' };
}

async function readSettings(): Promise<StoredSettings> {
  return ((await browser.storage.local.get('settings'))['settings'] as StoredSettings) ?? {};
}

/** 仅首次明确无字幕时自动排一个独立 ASR 任务；旧记录和计费不明均保留人工处理。 */
export async function tryAutoAsr(jobId: string, requireWaitingMarker = false): Promise<void> {
  const job = await db.jobs.get(jobId);
  if (!job || job.type !== 'SUMMARIZE' || job.status !== 'need_confirm') return;
  const settings = await readSettings();
  const pointer = await getSessionPointer(browserKv);
  if (settings.paused || !pointer || pointer.state !== 'ACTIVE' || pointer.sessionId !== job.sessionId) return;
  const cfg = settings.asr;
  const configured = !!cfg?.baseUrl?.trim() && !!cfg.modelId?.trim() && !!cfg.apiKey?.trim() && validateAsr(cfg).kind === 'ok';
  const origin = configured && cfg ? (cfg.provider === 'doubao-agent-plan' ? DOUBAO_ASR_ORIGIN : originPattern(cfg.baseUrl)) : null;
  const authorized = !!origin && await browser.permissions.contains({origins:[origin]});
  const reason = !configured ? 'NEED_ASR_CONFIG' : !authorized ? 'ASR_PERMISSION_DENIED' : undefined;
  let queued = false;
  let statusChanged = false;
  await db.transaction('rw', db.jobs, db.transcripts, db.summaries, async () => {
    const current = await db.jobs.get(jobId);
    if (!current || current.status !== 'need_confirm' || current.type !== 'SUMMARIZE' || current.sessionId !== pointer.sessionId) return;
    const jobs = await db.jobs.where('videoKey').equals(current.videoKey).toArray();
    const summaries = await db.summaries.where('videoKey').equals(current.videoKey).toArray();
    const summary = summaries.sort((a,b) => b.createdAt-a.createdAt)[0];
    if (!summary || summary.status !== 'need_asr' || summary.source !== 'asr' || (requireWaitingMarker && summary.error?.code !== 'AUTO_ASR_PENDING' && summary.error?.code !== 'NEED_ASR_CONFIG' && summary.error?.code !== 'ASR_PERMISSION_DENIED') || summary.error?.code === 'ASR_DECLINED' || summaries.some(s=>s.status==='done'||s.asrProgress?.unconfirmed?.length) || jobs.some(j=>j.type==='ASR_SUMMARIZE')) return;
    const transcript = await db.transcripts.get(current.videoKey);
    if (transcript) {
      if (transcript.source !== 'asr') { await db.summaries.put({...summary,error:{code:'ASR_EXISTING_SUBTITLE',msg:'旧字幕已保留，当前无法安全启动语音识别'}}); statusChanged = true; }
      return;
    }
    if (reason) {
      await db.summaries.put({...summary,error:{code:reason,msg:reason==='NEED_ASR_CONFIG'?'请先配置语音识别服务':'语音服务未获授权，请到设置中授权'}});
      return;
    }
    await db.jobs.put({...current,status:'done',updatedAt:Date.now()});
    await pipeline.enqueue({type:'ASR_SUMMARIZE',videoKey:current.videoKey,sessionId:current.sessionId});
    queued = true;
  });
  if (queued) drainUnlessPaused();
  else if (reason || statusChanged) broadcastToUi({type:'SUMMARY_UPDATED',videoKey:job.videoKey});
}

async function resumeAutoAsrWaiting(): Promise<void> {
  const jobs = await db.jobs.where('status').equals('need_confirm').toArray();
  for (const job of jobs) {
    if (job.type !== 'SUMMARIZE') continue;
    const summary = await latestSummary(job.videoKey);
    if (summary?.status === 'need_asr' && (summary.error?.code === 'AUTO_ASR_PENDING' || summary.error?.code === 'NEED_ASR_CONFIG' || summary.error?.code === 'ASR_PERMISSION_DENIED')) await tryAutoAsr(job.id,true);
  }
  // 只有执行前明确未发送音频的失败可以在配置恢复后自动排回，其他失败绝不自动重发。
  const settings = await readSettings();
  const pointer = await getSessionPointer(browserKv);
  const cfg = settings.asr;
  if (settings.paused || pointer?.state !== 'ACTIVE' || !cfg || validateAsr(cfg).kind !== 'ok') return;
  const origin = cfg.provider === 'doubao-agent-plan' ? DOUBAO_ASR_ORIGIN : originPattern(cfg.baseUrl);
  if (!origin || !(await browser.permissions.contains({origins:[origin]}))) return;
  const failed = await db.jobs.where('status').equals('failed').toArray();
  let resumed = false;
  for (const old of failed) {
    if (old.type !== 'ASR_SUMMARIZE' || old.sessionId !== pointer.sessionId || !['ASR_NOT_SENT_CONFIG','ASR_NOT_SENT_PERMISSION'].includes(old.error?.code ?? '')) continue;
    await db.transaction('rw',db.jobs,db.summaries,db.transcripts,async()=>{
      const job=await db.jobs.get(old.id);
      const jobs=await db.jobs.where('videoKey').equals(old.videoKey).toArray();
      const summaries=await db.summaries.where('videoKey').equals(old.videoKey).toArray();
      const summary=summaries.sort((a,b)=>b.createdAt-a.createdAt)[0];
      if (!job || job.status!=='failed' || !['ASR_NOT_SENT_CONFIG','ASR_NOT_SENT_PERMISSION'].includes(job.error?.code??'') || jobs.filter(j=>j.type==='ASR_SUMMARIZE').length!==1 || !summary || summary.status!=='need_asr' || !['NEED_ASR_CONFIG','ASR_PERMISSION_DENIED'].includes(summary.error?.code??'') || summaries.some(s=>s.asrProgress?.unconfirmed?.length) || await db.transcripts.get(old.videoKey)) return;
      await db.jobs.put({...job,status:'pending',error:undefined,retries:0,updatedAt:Date.now()});
      await db.summaries.put({...summary,error:{code:'AUTO_ASR_PENDING',msg:'字幕不可用，等待语音识别'}});
      resumed=true;
    });
  }
  if (resumed) drainUnlessPaused(true);
}

/** P2.5：暂停中？（各采集/生成入口的门禁；F12「不再有任何采集与请求」）。 */
async function isPaused(): Promise<boolean> {
  return (await readSettings()).paused === true;
}

/** P2.5：暂停时不清空 pending 队列（挂起待恢复）；解除暂停的保存路径自行 drain。
 *  F13 提速：双链同 kick——交互链独立于主链，摘要挂起/长跑不拖分段解读。 */
function drainUnlessPaused(resume = false): void {
  void recoveryReady.then(() => isPaused()).then((paused) => {
    if (paused) return;
    void pipeline.drain(resume);
    void segPipeline.drain(resume);
  });
}

/** LIST_QUERY：visits+videos+summaries+jobs 联查快照（02-数据模型 §3，列表数据源）。
 *  P2.1 时机②：面板打开触发本查询——先静默判定保留期（不广播：LIST_QUERY 高频，
 *  广播会与面板 refresh 互触发成风暴；倒计时数据随本应答下发，状态变化经应答自然到达）。 */
async function handleListQuery(): Promise<Record<string, unknown>> {
  const { pointer } = await runRetention();
  drainUnlessPaused(); // P2.6：面板在看=续跑挂起队列的好时机（断网恢复后首个用户触点）
  const settings = await readSettings();
  const update = await updateStore.get();
  const latest = update?.latest;
  const retainUntil = pointer ? retainUntilOf(pointer) : undefined;
  const base = {
    ok: true as const,
    sessionState: pointer?.state ?? 'INACTIVE',
    ...(pointer?.closedAt !== undefined ? { closedAt: pointer.closedAt } : {}),
    ...(retainUntil !== undefined ? { retainUntil } : {}),
    triggerSeconds: clamp(settings.triggerSeconds ?? 10, 5, 300),
    // P2.5：「暂停陪看」总开关随列表应答下发（面板状态行与设置开关的数据源）
    paused: settings.paused === true,
    // P1.10：引导卡数据源（30s 缓存零网络；强制刷新走 LOGIN_CHECK force=1，面板打开时机）
    loggedIn: loginCache?.loggedIn ?? null,
    updateVersion: latest && isNewerVersion(latest, browser.runtime.getManifest().version) ? latest : null,
    updateRevision: update?.revision ?? 0,
  };
  if (!pointer) return { ...base, items: [] };
  const visits = (await db.visits.where('sessionId').equals(pointer.sessionId).toArray()).sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt,
  );
  const items = await Promise.all(
    visits.map(async (visit) => ({
      visit,
      video: await db.videos.get(visit.videoKey),
      summary: await latestSummary(visit.videoKey),
      job: await activeJob(visit.videoKey, pointer.sessionId),
    })),
  );
  return { ...base, items };
}

/**
 * SUMMARY_OPEN：按需生成/取缓存（F4 点击未生成条目、失败重试）。
 * 入队条件（缺一不可）：
 *  ① 无活动 job；② 从未跑过（无 summary 且无历史 job）；或 上次失败（summary.failed **或**
 *  最近一次 job 终态 failed——执行体级失败不写 summary 行，审查 P1 旁路）且 **retry=1（用户显式点击）**。
 * 广播刷新（面板事件驱动的重开）不带 retry：失败后不自动重新入队——
 * 否则失败+详情打开 = 「失败→刷新→入队→失败」无限自动重试环（2026-10-23 E2E 实测），
 * 重试必须由用户发起（F11）。
 * P2.5「暂停陪看」：缓存/详情照常可见（零网络），但**不入队**（F12 无任何生成请求）。
 */
async function resumeLegacyVideo(videoKey:string, sessionId:string):Promise<void> {
  const migrated = await db.transaction('rw',db.jobs,db.summaries,db.transcripts,async()=>{
    const rows=await db.jobs.where('videoKey').equals(videoKey).toArray();
    const summaries=await db.summaries.where('videoKey').equals(videoKey).toArray();
    const latest=summaries.sort((a,b)=>b.createdAt-a.createdAt)[0];
    const legacy=rows.find(j=>j.sessionId===sessionId&&j.type==='SUMMARIZE'&&j.status==='need_confirm');
    if (!latest || latest.status!=='need_asr' || latest.source!=='asr' || (latest.error && latest.error.code!=='EMPTY_SUBTITLE') || summaries.some(s=>s.status==='done'||s.asrProgress?.unconfirmed?.length) || rows.some(j=>j.type==='ASR_SUMMARIZE'||j.status==='failed'||j.status==='running'||j.status==='pending') || await db.transcripts.get(videoKey)) return false;
    if (legacy) await db.jobs.put({...legacy,status:'pending',retries:0,updatedAt:Date.now()});
    else await pipeline.enqueue({type:'SUMMARIZE',videoKey,sessionId,prio:-1});
    await db.summaries.put({...latest,error:{code:'AUTO_ASR_PENDING',msg:'正在重新检查字幕'}});
    return true;
  });
  if (migrated) drainUnlessPaused(true);
}

async function handleSummaryOpen(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false, error: 'SUMMARY_OPEN 缺 videoKey' };
  const pointer = await getSessionPointer(browserKv);
  const visit = pointer
    ? await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first()
    : undefined;
  if (!visit || !pointer) return { ok: false, error: 'no-visit' };
  // 旧版无确认记录的待处理项只在用户主动打开该视频时重新检查字幕；不批量启动其他旧视频。
  if (m.retry === 1 && pointer.state === 'ACTIVE' && !(await isPaused()) && visit.triggered && visit.watchedSeconds >= clamp((await readSettings()).triggerSeconds??10,5,300)) await resumeLegacyVideo(videoKey,pointer.sessionId);
  const video = await db.videos.get(videoKey);
  const summary = await latestSummary(videoKey);
  const storedTranscript = await db.transcripts.get(videoKey);
  const conflict = !!storedTranscript && hasAsrSemanticMismatch(storedTranscript);
  const showRecovery = conflict && (!summary || summary.source === 'asr');
  let job = await activeJob(videoKey, pointer.sessionId);
  const lastJobRow = (await db.jobs.where('videoKey').equals(videoKey).filter(j=>j.sessionId===pointer.sessionId).sortBy('updatedAt')).pop();
  const untouched = !summary && !lastJobRow; // 从未生成过也从未排过队
  // 少量或无语音是已处理的内容结果；打开详情不应重新排队并将它改回等待自动识别。
  const insufficientSpeech = summary?.source === 'asr' && summary.status === 'failed' && ['LOW_CONTENT','ASR_NO_SPEECH','ASR_TOO_SHORT'].includes(summary.error?.code ?? '');
  const failedBefore = !insufficientSpeech && summary?.status !== 'need_asr' && (summary?.status === 'failed' || lastJobRow?.status === 'failed');
  if (!conflict && !job && (untouched || (failedBefore && m.retry === 1)) && !(await isPaused())) {
    await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId: pointer.sessionId, ...(m.retry === 1 ? { prio: -1 } : {}) });
    job = await activeJob(videoKey, pointer.sessionId);
    drainUnlessPaused();
  }
  // 用户主动点击时允许保留期内执行，包括提升已存在的自动摘要；广播刷新不能触发。
  if (m.retry === 1 && job && (job.type === 'SUMMARIZE' || job.type === 'REGENERATE') && job.status === 'pending' && !(await isPaused())) {
    if (job.type === 'SUMMARIZE') await db.jobs.update(job.id, { prio: -1, updatedAt: Date.now() });
    if (summary?.error?.code !== 'AUTO_ASR_PENDING') await allowManualJob(job);
    job = await db.jobs.get(job.id);
    drainUnlessPaused(true);
  }
  const transcript = excerptOf(storedTranscript, undefined, m.transcriptPage, video?.duration);
  const asrCached = !conflict && storedTranscript?.source === 'asr' && storedTranscript.asrComplete === true && isCacheFresh(storedTranscript.cachedAt);
  const recoveryJob = showRecovery ? (await db.jobs.where('videoKey').equals(videoKey).filter(j=>j.sessionId===pointer.sessionId && !!j.recovery && !j.recovery.committed).sortBy('updatedAt')).pop() : undefined;
  const recoveryData=recoveryJob?.recovery;
  const recovery = showRecovery ? { status: recoveryJob && ACTIVE_JOB_STATUSES.includes(recoveryJob.status) ? 'running' : recoveryData?.candidate && isRecoveryCandidate(recoveryData.candidate,videoKey,video?.duration) && isCacheFresh(recoveryData.candidate.cachedAt) ? 'candidate' : recoveryData?.pending ? 'pending' : 'available', ...(recoveryData?.pending?{warning:'上次请求的计费状态不明，重新识别可能再次消耗额度。'}:{}), ...(recoveryData?.progress?{progress:recoveryData.progress}:{}) } : undefined;
  // P2.3 审查 P1-1：need_asr 卡片要能显示上次 ASR 尝试的失败原因——音频链失败保留 need_asr 行、
  // 错误只在 job 行，activeJob（仅活动态）永远带不出；lastJobRow 上面已查，随详情下发
  return { ok: true, item: { visit, video, summary, job, lastJob: lastJobRow }, transcript, asrCached, ...(recovery?{recovery}:{}) };
}

/**
 * 2.7a REGENERATE（F7/F8【重新生成】）：用户从详情页发起强制重跑。
 * 成功整行覆盖旧摘要（segmentNotes 随之清空=分段缓存失效策略，chain force 语义）；
 * 失败不覆盖旧 done 行（旧摘要保留，错误只落 job 行）。同视频任何任务在途 → busy 拒绝。
 * 人设切换后的联动询问属 2.5 设置页（2.7b，P2.5 已接入：personaChanged 随保存应答）。
 */
async function handleRegenerate(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false, error: 'REGENERATE 缺 videoKey' };
  if (await isPaused()) return { ok: false, error: 'paused' }; // P2.5：暂停期间不烧 LLM
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: false, error: 'no-session' };
  if (await activeJob(videoKey, pointer.sessionId)) return { ok: false, error: 'busy' };
  const job = await pipeline.enqueue({ type: 'REGENERATE', videoKey, sessionId: pointer.sessionId });
  await allowManualJob(job);
  drainUnlessPaused();
  return { ok: true, started: true };
}

// ---- P2.3 · ASR 确认流（F6，架构 §4.2） -------------------------------------------

/**
 * ASR_CONFIRM：未配置 ASR → NEED_ASR_CONFIG（面板跳 onboarding 的 ASR 补配模式）。
 * 确认后：need_confirm 的 SUMMARIZE job 收口为 done（其结论=需 ASR，用户已确认），
 * 同事务入队 ASR_SUMMARIZE——不退役旧活动行会让 busy 守卫（activeJob 含 need_confirm）
 * 永久卡死【重新生成】/二次确认。幂等：ASR_SUMMARIZE 已在途时 enqueue 去重复用。
 */
async function handleAsrConfirm(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false, error: 'ASR_CONFIRM 缺 videoKey' };
  if (await isPaused()) return { ok: false, error: 'paused' }; // P2.5：暂停期间不下载音频不转写
  const existingTranscript = await db.transcripts.get(videoKey);
  if (existingTranscript && existingTranscript.source !== 'asr') return {ok:false,reason:'ASR_EXISTING_SUBTITLE'};
  const settings = await readSettings();
  const asr = settings.asr;
  const continueRecovery=m.recovery===true && m.recoveryAction==='continue';
  if (!continueRecovery && (!asr?.baseUrl || !asr.modelId || !asr.apiKey)) return { ok: false, reason: 'NEED_ASR_CONFIG' };
  if (m.recovery && !continueRecovery && asr?.provider !== 'doubao-agent-plan') return {ok:false,reason:'ASR_RECOVERY_UNSUPPORTED'};
  if (!continueRecovery && asr?.provider === 'doubao-agent-plan' && !(await browser.permissions.contains({origins:[DOUBAO_ASR_ORIGIN]}))) return {ok:false,reason:'ASR_PERMISSION_DENIED'};
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: false, error: 'no-session' };
  if (m.recovery) {
    const result=await db.transaction('rw',db.jobs,db.transcripts,db.videos,async()=>{
      const original=await db.transcripts.get(videoKey);
      if(!original || !hasAsrSemanticMismatch(original)) return {error:'ASR_RECOVERY_CHANGED'} as const;
      const rows=await db.jobs.where('videoKey').equals(videoKey).toArray();
      // 其他会话未运行的旧队列不会再被 canRunJob 执行，正在运行的仍须等待。
      const active=rows.find(j=>j.status==='running'||(j.sessionId===pointer.sessionId&&j.status==='pending'));
      if(active){if(active.type==='ASR_SUMMARIZE'&&active.sessionId===pointer.sessionId&&active.recovery)return {job:active} as const;return {error:'busy'} as const;}
      const last=rows.filter(j=>j.sessionId===pointer.sessionId&&j.recovery&&!j.recovery.committed).sort((a,b)=>b.updatedAt-a.updatedAt)[0]?.recovery;
      if(last && JSON.stringify(last.original)!==JSON.stringify(original))return {error:'ASR_RECOVERY_CHANGED'} as const;
      const candidate=!!last?.candidate && isRecoveryCandidate(last.candidate,videoKey,(await db.videos.get(videoKey))?.duration) && isCacheFresh(last.candidate.cachedAt);
      if((candidate && m.recoveryAction!=='continue') || (!candidate && m.recoveryAction!=='recognize'))return {error:'ASR_RECOVERY_CHANGED'} as const;
      // 同会话旧确认卡按普通 ASR 确认流收口。
      for(const row of rows)if(row.sessionId===pointer.sessionId&&row.status==='need_confirm')await db.jobs.put({...row,status:'done',updatedAt:Date.now()});
      const recovery=candidate?last!:{original,...(last?.pending?{pending:true}:{})};
      const job=await pipeline.enqueue({type:'ASR_SUMMARIZE',videoKey,sessionId:pointer.sessionId,recovery});
      return {job} as const;
    });
    if('error' in result)return {ok:false,reason:result.error,error:result.error};
    await allowManualJob(result.job);drainUnlessPaused();return {ok:true,started:true};
  }
  const job = await db.transaction('rw', db.jobs, async () => {
    const rows = await db.jobs.where('videoKey').equals(videoKey).toArray();
    for (const j of rows) {
      // 审查 P2-3：need_confirm 语义唯一（等 ASR 确认），不按 type 过滤——REGENERATE 落
      // need_confirm（旧 failed 行重跑无轨）同样必须收口，否则 busy 守卫永久卡死
      if (j.sessionId === pointer.sessionId && j.status === 'need_confirm') {
        await db.jobs.put({ ...j, status: 'done', updatedAt: Date.now() });
      }
    }
    return pipeline.enqueue({ type: 'ASR_SUMMARIZE', videoKey, sessionId: pointer.sessionId });
  });
  await allowManualJob(job);
  console.log(`[doubao] asr job queued (user confirmed): ${videoKey}`);
  drainUnlessPaused();
  return { ok: true, started: true };
}

/** ASR_DECLINE：暂不——保持 need_asr 橙色标注（F6-⑥ 不再自动追问，下次打开面板仍可见）。 */
async function handleAsrDecline(m: InMsg): Promise<Record<string, unknown>> {
  if (m.videoKey) {
    const result = await db.transaction('rw',db.summaries,db.jobs,async()=>{
      const jobs=await db.jobs.where('videoKey').equals(m.videoKey!).toArray();
      if(jobs.some(j=>j.type==='ASR_SUMMARIZE' && j.status==='running'))return false;
      for(const job of jobs)if(job.type==='ASR_SUMMARIZE' && job.status==='pending')await db.jobs.put({...job,status:'failed',error:{code:'ASR_DECLINED',msg:'已选择暂不处理'},updatedAt:Date.now()});
      const summary = await latestSummary(m.videoKey!);
      if (summary?.status === 'need_asr') await db.summaries.put({...summary,error:{code:'ASR_DECLINED',msg:'已选择暂不处理'}});
      return true;
    });
    if (!result) return {ok:false,reason:'ASR_ALREADY_STARTED'};
  }
  console.log(`[doubao] asr declined (keep need_asr): ${m.videoKey ?? ''}`);
  return { ok: true };
}

// ---- P1.8 · 大纲 seek（SEEK_TO） ------------------------------------------------

/**
 * SEEK_TO：面板点在别的视频上（当前标签页不是目标视频）时的跨标签页路由。
 * 同页 seek 由 content 本地完成，不会到这里。两分支：
 *  ① 已有目标视频页标签 → 聚焦该窗口+标签，Port 广播 SEEK_TO（目标页 content 对自己的 <video> 落 seek）；
 *  ② 没有 → 新开标签页，URL 带 B 站原生 t= 秒参数直接起播到时间点（多 P 带 p=）。
 * tabs.query 不加 'tabs' 权限：host_permissions 已覆盖 bilibili.com，其标签页 url 可见（架构 §5 权限最小化）。
 */
async function handleSeekTo(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey, time } = m;
  if (!videoKey || typeof time !== 'number' || !Number.isFinite(time)) {
    return { ok: false, error: 'SEEK_TO 缺 videoKey/time' };
  }
  let bvid: string;
  try {
    bvid = parseVideoKey(videoKey).bvid;
  } catch {
    return { ok: false, error: `videoKey 格式非法：${videoKey}` };
  }
  const page = (await db.videos.get(videoKey))?.page ?? 1;
  const tabs = (await browser.tabs.query({})) as SeekTabCandidate[];
  // 活端口过滤：扩展 reload 后旧标签 content 成孤儿（URL 仍匹配但广播进空端口、聚焦成功却不跳转，
  // 原审查 P2-1 记账项）——过滤后落 new-tab 分支 t= 直达，不再静默失败。
  // 边界：目标页刚加载完尚未连 Port / SW 刚重启端口未回连时同样落 new-tab（多开一页但功能正确）。
  const liveTabIds = new Set<number>();
  for (const p of uiPorts) if (p.tabId !== undefined) liveTabIds.add(p.tabId);
  const tab = pickSeekTab(tabs, bvid, page, liveTabIds);
  if (tab?.id !== undefined) {
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tab.id, { active: true });
    // 目标页自己收广播执行 seek（发起页 currentVideoKey 不匹配会忽略）；page 随广播带上——
    // 各标签页的 URL 兜底匹配须按 bvid+分P 判定（审查 P1-1：仅比 bvid 会让同 bvid 异 P 页误 seek）
    broadcastToUi({ type: 'SEEK_TO', videoKey, time: Math.max(0, Math.floor(time)), page });
    console.log(`[doubao] seek focus-tab: ${videoKey} → t=${Math.floor(time)}s`);
    return { ok: true, mode: 'focus-tab' };
  }
  const url = buildVideoUrl(bvid, page, time);
  await browser.tabs.create({ url });
  console.log(`[doubao] seek new-tab: ${videoKey} → ${url}`);
  return { ok: true, mode: 'new-tab', url };
}

// ---- P1.11 · F13 分段解读（SEGMENT_NOTE_OPEN） ---------------------------------

/** 活动中的分段解读任务（同 videoKey+segIndex）。 */
async function activeSegmentJob(videoKey: string, segIndex: number): Promise<JobRow | undefined> {
  const rows = await db.jobs.where('videoKey').equals(videoKey).toArray();
  return rows.find(
    (j) => j.type === 'SEGMENT_ANALYZE' && j.segIndex === segIndex && ACTIVE_JOB_STATUSES.includes(j.status),
  );
}

/** 交互链排队位次：pending 的 SEGMENT_ANALYZE 中按 (prio, createdAt) 排在 self 之前的条数
 *  （面板「排队中 · 前面还有 N 个」数据源；running 不可抢占，不计入）。 */
async function segmentQueueAhead(self: { id: string; prio?: number; createdAt: number }): Promise<number> {
  const rows = await db.jobs.where('status').equals('pending').toArray();
  return rows.filter(
    (j) =>
      j.id !== self.id &&
      j.type === 'SEGMENT_ANALYZE' &&
      ((j.prio ?? 0) < (self.prio ?? 0) ||
        ((j.prio ?? 0) === (self.prio ?? 0) && j.createdAt < self.createdAt)),
  ).length;
}

/**
 * SEGMENT_NOTE_OPEN（架构 §4.4）：命中 segmentNotes done 缓存 → 直接返回（零 LLM 请求）；
 * 未命中 → 建 SEGMENT_ANALYZE job（交互链，与摘要主链并行）→ 流式经 SEGMENT_NOTE_STREAM/DONE/FAILED 回流。
 * 重试口径同 SUMMARY_OPEN（F11）：failed 注记仅 retry=1（用户显式点击）重排；
 * streaming 注记但无活动 job（SW 中途死亡残留）→ 点击即重建自愈。
 * F13 提速：pending 的预取任务（prio=1）被用户点击就地提升为 prio=0（不被后台队列压尾）；
 * 应答随带 queued（前面还有几个），面板占位文案追加排队位次。
 */
async function handleSegmentNoteOpen(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey, segIndex, retry } = m;
  if (!videoKey || typeof segIndex !== 'number' || !Number.isInteger(segIndex) || segIndex < 0) {
    return { ok: false, error: 'SEGMENT_NOTE_OPEN 缺 videoKey/segIndex' };
  }
  const summary = await latestSummary(videoKey);
  if (summary?.asrOutdated) return {ok:false,error:'ASR_CONTENT_UNCONFIRMED'};
  const segmentTranscript=await db.transcripts.get(videoKey);
  if (summary?.source==='asr' && segmentTranscript && hasAsrSemanticMismatch(segmentTranscript)) return {ok:false,error:'ASR_CONTENT_UNCONFIRMED'};
  if (!summary || summary.status !== 'done' || !summary.outline?.length || segIndex >= summary.outline.length) {
    return { ok: false, error: 'NO_OUTLINE' }; // 无大纲（含无字幕未确认）→ 入口本不应出现
  }
  const cached = summary.segmentNotes?.[segIndex];
  const active = await activeSegmentJob(videoKey, segIndex);
  if (cached?.status === 'done' && !cached.truncated && !active) {
    console.log(`[doubao] segment note cache hit: ${videoKey}#${segIndex}`);
    return { ok: true, note: cached, cacheHit: true };
  }
  if (!active) {
    const allow =
      (cached === undefined || cached.truncated === true ||
        cached.status === 'streaming' || // 残留 streaming（SW 死亡）→ 点击重建
        (cached.status === 'failed' && retry === 1)) && // 用户显式重试
      !(await isPaused()); // P2.5：暂停期间分段解读只读缓存，不发 LLM 请求
    if (allow) {
      const pointer = await getSessionPointer(browserKv);
      const row = await segPipeline.enqueue({
        type: 'SEGMENT_ANALYZE',
        videoKey,
        sessionId: pointer?.sessionId ?? 'no-session',
        segIndex,
      });
      await allowManualJob(row);
      drainUnlessPaused();
      const queued = row.status === 'pending' ? await segmentQueueAhead(row) : 0;
      // 审查 P1-1：本次入了队就回合成 streaming 占位（started 标记让面板清空旧增量残留）——
      // 若回旧 failed 注记，面板会把重试的流式占位覆盖回失败卡并丢弃全部增量（「重试秒败」假象）
      return {
        ok: true,
        note: { text: '', status: 'streaming', createdAt: Date.now() },
        started: true,
        ...(queued > 0 ? { queued } : {}),
      };
    }
  }
  // 已有活动任务（预取/在跑）：pending 预取提升为用户优先级，应答带位次
  // update（非 put）：只改 prio/updatedAt，避免用早先读到的陈旧整行覆盖在途 tick 写入的 stage/progress
  if (active?.status === 'pending' && !(await isPaused())) {
    if ((active.prio ?? 0) > 0) await db.jobs.update(active.id, { prio: 0, updatedAt: Date.now() });
    await allowManualJob(active);
    drainUnlessPaused(true);
  }
  const queued = active?.status === 'pending' ? await segmentQueueAhead(active) : 0;
  return {
    ok: true,
    note: cached ?? { text: '', status: 'streaming', createdAt: Date.now() },
    ...(queued > 0 ? { queued } : {}),
  };
}

// ---- P1.10 · 登录态检测与引导（架构 §3.9） ------------------------------------

// 登录探测专用实例：-412 熔断等待压到 1.5s（默认 60s 会让面板打开的 force 复核卡一分钟）；
// 探测失败返回 null（未知态）不写缓存，下次重探。
const loginClient = new BiliClient({ ...biliRequestHooks, breakerWaitMs: 1500 });
const LOGIN_CACHE_MS = 30_000;
let loginCache: { at: number; loggedIn: boolean | null } | null = null;
/** 最近一次广播过的登录态（undefined=从未广播）；仅翻转时广播，防轰炸。 */
let loginBroadcasted: boolean | null | undefined = undefined;
/** 审查 P2-4：single-flight——启动探测/多标签重连 force/面板 open force 并发时共享在途 nav。 */
let loginInflight: Promise<boolean | null> | null = null;

async function checkLoginState(force = false): Promise<boolean | null> {
  if (!force && loginCache && Date.now() - loginCache.at < LOGIN_CACHE_MS) return loginCache.loggedIn;
  // P2.5「暂停陪看」：暂停期间连登录探测也不发（F12「不再有任何采集与请求」）——
  // 回缓存值（无缓存=未知 null），解除暂停后下次探测自愈
  if (await isPaused()) return loginCache?.loggedIn ?? null;
  if (!loginInflight) {
    loginInflight = loginClient.checkLogin().finally(() => {
      loginInflight = null;
    });
  }
  const loggedIn = await loginInflight;
  if (loggedIn !== null) loginCache = { at: Date.now(), loggedIn }; // 未知态不写缓存，下次重探
  return loggedIn;
}

/**
 * 翻转时广播 LOGIN_STATE；翻正自动恢复：NEED_LOGIN 失败的 job 重排
 * （架构 §3.9「登录成功后自动恢复陪看流程，无需用户额外操作」）。
 * 审查 P0-1：条件用 prev !== true 而非 prev === false——SW 30s 空闲重启后 loginBroadcasted
 * 归 undefined，若只认 false→true，用户扫码期间 SW 死亡将永久丢失自动重排（红徽章滞留）。
 * undefined→true 首探同样扫描；无 NEED_LOGIN 失败行时天然 no-op，自愈收敛。
 */
async function applyLoginState(loggedIn: boolean | null): Promise<void> {
  if (loggedIn === null || loggedIn === loginBroadcasted) return;
  const prev = loginBroadcasted;
  loginBroadcasted = loggedIn;
  broadcastToUi({ type: 'LOGIN_STATE', loggedIn });
  if (loggedIn && prev !== true) {
    // 审查 P2-3：只重排当前会话的失败 job（历史会话的 NEED_LOGIN 不再烧 LLM 费用）
    const pointer = await getSessionPointer(browserKv);
    const failedSummaries = (await db.summaries.where('status').equals('failed').toArray()).filter(
      (s) => s.error?.code === 'NEED_LOGIN',
    );
    let n = 0;
    for (const s of failedSummaries) {
      const job = (await db.jobs.where('videoKey').equals(s.videoKey).sortBy('updatedAt')).reverse().find(
        (j) => j.status === 'failed',
      );
      if (job && pointer && job.sessionId === pointer.sessionId) {
        await pipeline.retry(job.id);
        n += 1;
      }
    }
    if (n) {
      console.log(`[doubao] login restored: requeued ${n} NEED_LOGIN job(s)`);
      drainUnlessPaused();
    }
  }
}

/** LOGIN_CHECK：content 首连/面板打开（force）/激活后复核。应答直给 + 翻转广播副作用。 */
async function handleLoginCheck(m: InMsg): Promise<Record<string, unknown>> {
  const loggedIn = await checkLoginState(m.force === 1);
  void applyLoginState(loggedIn).catch(() => {});
  return { ok: true, loggedIn };
}

// ---- P1.7 · onboarding 服务（TEST_CONNECTION / SETTINGS_SAVE） ------------------

interface ModelConfigMsg {
  provider?: 'openai-compatible' | 'doubao-agent-plan';
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

/** F9：同步发起请求以保留点击手势；已授权时 Chrome 自行省略弹窗。拒绝不阻塞 CORS 端点。 */
function ensureOriginPermission(origins: string[]): Promise<boolean> {
  if (!origins.length) return Promise.resolve(true);
  try {
    return browser.permissions.request({ origins }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** 服务端错误 body 打码（Key 剔除 + Bearer/sk- 形态 + 截断），与 llm/client 同口径。 */
const maskBody = (raw: string, apiKey: string): string =>
  raw
    .split(apiKey)
    .join('***')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/\b(?:sk|ark)-[A-Za-z0-9][A-Za-z0-9-]{8,}/g, '***')
    .slice(0, 120);

/**
 * TEST_CONNECTION：最小 chat/completions 探活（max_tokens=1、stream:false、35s 超时——
 * 思考型模型对 ping 也会先长时间 reasoning，实测 ~14s，15s 必边际超时；35s 仍供应商中立）。
 * 先按 origin 尽力申请权限（成功/失败均继续探测——CORS 端点无权限也能通）。
 */
async function handleTestConnection(m: InMsg): Promise<Record<string, unknown>> {
  const cfg = m.llm ?? {};
  const baseUrl = (cfg.baseUrl ?? '').trim();
  const model = (cfg.modelId ?? '').trim();
  // P2.5：设置页 Key 打码——空/打码哨兵沿用已存 Key（面板永不见明文，探活仍用真 Key）
  const prevCfg = (m.kind === 'asr' ? (await readSettings()).asr : (await readSettings()).llm) ?? undefined;
  const sameProvider = m.kind !== 'asr' || (cfg.provider ?? 'openai-compatible') === ((prevCfg as StoredSettings['asr'])?.provider ?? 'openai-compatible');
  const apiKey = resolveApiKey(sameProvider ? prevCfg?.apiKey : undefined, cfg.apiKey ?? '').trim();
  if (m.kind === 'asr' && cfg.provider === 'doubao-agent-plan') {
    if (!apiKey) return { ok: false, msg: '请先填写 Agent Plan Key' };
    try {
      await ensureOffscreen();
      const result = await sendToOffscreen({type:'OFFSCREEN_DOUBAO_SESSION', apiKey}) as {ok?:boolean};
      if (!result?.ok) throw new Error('ASR_AUTH_FAILED');
      return { ok: true, msg: '鉴权通过，尚未验证语音识别' };
    } catch (error) {
      console.log(`[doubao] asr authentication failed: ${error instanceof Error && /^ASR_[A-Z_0-9]+$/.test(error.message) ? error.message : 'ASR_CONNECTION_FAILED'}`);
      return { ok: false, msg: '豆包语音鉴权未通过，请检查 Key、授权和网络' };
    }
  }
  if (!baseUrl || !model || !apiKey) return { ok: false, msg: '请先填写完整配置再测试' };
  const v = validateEndpointUrl(baseUrl);
  if (!v.ok) return { ok: false, msg: v.error ?? 'Base URL 不合法' };
  // P2.3：ASR 探活走 GET /models（OpenAI-compatible 惯例；/audio/transcriptions 探活需真音频不划算）
  if (m.kind === 'asr') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), 15_000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, msg: '连接成功（HTTP ' + res.status + '）' };
      if (res.status === 401 || res.status === 403) return { ok: false, msg: 'Key 无效或无权限（HTTP ' + res.status + '）' };
      if (res.status === 404) return { ok: true, msg: '端点可达（不支持模型列表接口，保存后可直接使用；若失败请检查 Base URL 是否含 /v1）' };
      const body = await res.text().catch(() => '');
      return { ok: false, msg: `HTTP ${res.status}: ${maskBody(body, apiKey)}` };
    } catch (e) {
      return {
        ok: false,
        msg: controller.signal.aborted ? '连接超时（>15s）' : `无法连接端点：${String(e).slice(0, 80)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 35_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, msg: `连接成功（HTTP ${res.status}）` };
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) return { ok: false, msg: 'Key 无效或无权限（HTTP ' + res.status + '）' };
    if (res.status === 402) return { ok: false, msg: '余额不足（HTTP 402）' };
    if (res.status === 404) return { ok: false, msg: '端点 404：请检查 Base URL（通常需含 /v1 这样的基础路径）' };
    return { ok: false, msg: `HTTP ${res.status}: ${maskBody(body, apiKey)}` };
  } catch (e) {
    return {
      ok: false,
      msg: controller.signal.aborted ? '连接超时（>35s）' : `无法连接端点：${String(e).slice(0, 80)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function scheduleDoubaoRule(auth: InMsg['authRule']): Promise<Record<string, unknown>> {
  const pending = doubaoRuleTail.then(() => auth && wipesInProgress ? {ok:false, error:'ASR_CANCELLED'} : updateDoubaoRule(auth));
  doubaoRuleTail = pending.then(() => {}, () => {});
  return pending;
}

async function updateDoubaoRule(auth: InMsg['authRule']): Promise<Record<string, unknown>> {
  if (auth && (!auth.key || /[\r\n]/.test(auth.key) || !/^[a-f0-9-]{36}$/i.test(auth.requestId))) return {ok:false, error:'ASR_INVALID_AUTH'};
  const rule = auth ? {
    id: DOUBAO_RULE_ID, priority: 1,
    action: {type:'modifyHeaders', requestHeaders:[
      {header:'X-Api-Key',operation:'set',value:auth.key},
      {header:'X-Api-Resource-Id',operation:'set',value:DOUBAO_ASR_RESOURCE},
      {header:'X-Api-Request-Id',operation:'set',value:auth.requestId},
    ]},
    condition:{urlFilter:`|${DOUBAO_ASR_ENDPOINT}|`,initiatorDomains:[browser.runtime.id],resourceTypes:['websocket']},
  } : null;
  await browser.declarativeNetRequest.updateSessionRules({removeRuleIds:[DOUBAO_RULE_ID], ...(rule ? {addRules:[rule as never]} : {})});
  return {ok:true};
}

async function handleDoubaoPcm(m: InMsg): Promise<Record<string, unknown>> {
  const bytes = m.pcm;
  if (!Array.isArray(bytes) || !bytes.length || bytes.length > 960000 || bytes.length % 2 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return {ok:false, error:'ASR_PCM_INVALID'};
  const cfg = (await readSettings()).asr;
  if (cfg?.provider !== 'doubao-agent-plan' || !cfg.apiKey) return {ok:false, error:'NEED_ASR_CONFIG'};
  if (!(await browser.permissions.contains({origins:[DOUBAO_ASR_ORIGIN]}))) return {ok:false, error:'ASR_PERMISSION_DENIED'};
  try {
    await ensureOffscreen();
    return (await sendToOffscreen({type:'OFFSCREEN_DOUBAO_SESSION', apiKey:cfg.apiKey, pcm:bytes})) as Record<string, unknown>;
  } catch (e) {
    const message = e instanceof Error && /^ASR_[A-Z_0-9]+$/.test(e.message) ? e.message : 'ASR_CONNECTION_FAILED';
    return {ok:false, error:message};
  }
}

/**
 * P2.5 · SETTINGS_GET：设置页数据源。Key 打码（F9「仅尾 4 位」）——明文永不出 SW。
 * prefs 全量随发；llm/asr 未配置时不带键（面板按 undefined 渲染「未配置」）。
 */
async function handleSettingsGet(): Promise<Record<string, unknown>> {
  const s = await readSettings();
  const mask = (c?: { baseUrl: string; modelId: string; apiKey: string; provider?: 'openai-compatible' | 'doubao-agent-plan' }) =>
    c && c.baseUrl && c.modelId && c.apiKey
      ? { baseUrl: c.baseUrl, modelId: c.modelId, apiKeyMasked: maskApiKey(c.apiKey), ...(c.provider ? { provider: c.provider } : {}) }
      : undefined;
  return {
    ok: true,
    ...(s.llm ? { llm: mask(s.llm) } : {}),
    ...(s.asr ? { asr: mask(s.asr) } : {}),
    triggerSeconds: clampThreshold(s.triggerSeconds),
    persona: sanitizePersona(s.persona),
    bubbles: s.bubbles !== false,
    paused: s.paused === true,
    asrMaxMB: s.asrMaxMB ?? 25,
  };
}

/**
 * SETTINGS_SAVE（onboarding + P2.5 设置页，02-数据模型 §2 settings 形状）：
 * 后台二次校验（信任边界）→ 写 settings → 按 origin 申请权限 → 返回授权结果。
 * P2.5 语义（部分保存，各键缺省=保持原值）：
 *  - llm 缺省=沿用（P2.3 asr-only 补配模式）；带 llm 时 apiKey 空或为旧 Key 打码形态=沿用旧 Key
 *    （设置页打码占位不改配置），三件套齐才落库并补 onboarded=true；
 *  - llmClear=true：显式清除 LLM 配置（F9「清空 Key 保存→回到未激活态」）——onboarded=false
 *    + 活动会话 ACTIVE→GRACE（数据按保留规则走 F10 确认链路，不产生不可见死数据）；
 *  - asr 缺省=沿用（不再隐式删除）；全空保存=显式清除旧 ASR 配置（含旧 Key）；
 *  - prefs（triggerSeconds/persona/bubbles/paused）随带随存。
 */
async function handleSettingsSave(m: InMsg): Promise<Record<string, unknown>> {
  const llm = m.llm;
  const asr = m.asr;
  const prev = (await readSettings()) as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev };
  let llmCleared = false;

  // F9 清空 LLM Key 保存：显式清除 + 会话收口（ACTIVE→GRACE，走 F10 保留/确认链路）
  if (m.llmClear === true) {
    delete next['llm'];
    llmCleared = true;
    const pointer = await getSessionPointer(browserKv);
    if (pointer?.state === 'ACTIVE') {
      const now = Date.now();
      const grace: SessionPointer = { ...pointer, state: 'GRACE', closedAt: now, lastActiveAt: now };
      await db.sessions.update(pointer.sessionId, { state: 'GRACE', closedAt: now, lastActiveAt: now });
      await setSessionPointer(browserKv, grace);
      lastBroadcastSession = { sessionId: grace.sessionId, state: 'GRACE' };
      broadcastToUi(sessionStateMsg(grace));
    }
    console.log('[doubao] llm config cleared (session gated, data kept per retention rules)');
  } else if (llm !== undefined) {
    const prevLlm = prev['llm'] as { baseUrl?: string; modelId?: string; apiKey?: string } | undefined;
    // 打码哨兵：空/旧 Key 打码形态 = 沿用旧 Key（设置页不改 Key 只改 baseUrl/model 的场景）
    const apiKey = resolveApiKey(prevLlm?.apiKey, llm.apiKey ?? '');
    const v = validateLlm({ baseUrl: llm.baseUrl ?? '', modelId: llm.modelId ?? '', apiKey });
    if (!v.ok) return { ok: false, error: v.error ?? `必填项缺失：${v.missing.join(' / ')}` };
    next['llm'] = { baseUrl: llm.baseUrl!.trim(), modelId: llm.modelId!.trim(), apiKey };
  } else if (
    llm === undefined &&
    asr !== undefined &&
    !((prev['llm'] as { baseUrl?: string; modelId?: string; apiKey?: string } | undefined)?.apiKey)
  ) {
    // P2.3 asr-only 补配模式：不带 llm 存 ASR 须已有 LLM（否则摘要链无配置）；
    // 纯 prefs 保存（滑杆/开关）不要求已配置 LLM——onboarding 前也可调偏好
    return { ok: false, error: 'LLM 尚未配置，请完整填写 LLM 三项' };
  }

  if (asr !== undefined) {
    // P1-1（审查）：全空判定必须看原始输入——哨兵解析会把空 Key 还原成旧 Key，
    // validateAsr 随即报「部分填写」，用户按提示全空保存却永远清不掉 ASR Key
    const rawAllEmpty = !(asr.baseUrl ?? '').trim() && !(asr.modelId ?? '').trim() && !(asr.apiKey ?? '').trim();
    if (rawAllEmpty) {
      delete next.asr; // 显式带 asr 全空保存 = 清除旧 ASR 配置（含旧 Key）
    } else {
      const prevAsr = prev['asr'] as { apiKey?: string; provider?: 'openai-compatible' | 'doubao-agent-plan' } | undefined;
      const previousKey = (asr.provider ?? 'openai-compatible') === (prevAsr?.provider ?? 'openai-compatible') ? prevAsr?.apiKey : undefined;
      const resolvedKey = resolveApiKey(previousKey, asr.apiKey ?? '');
      const a = validateAsr({
        provider: asr.provider,
        baseUrl: asr.baseUrl ?? '',
        modelId: asr.modelId ?? '',
        apiKey: resolvedKey,
      });
      if (a.kind === 'error') return { ok: false, error: a.error };
      next.asr = asr.provider === 'doubao-agent-plan'
        ? { provider: asr.provider, baseUrl: 'https://openspeech.bytedance.com', modelId: DOUBAO_ASR_MODEL, apiKey: resolvedKey }
        : { baseUrl: asr.baseUrl!.trim(), modelId: asr.modelId!.trim(), apiKey: resolvedKey, ...(asr.provider ? { provider: asr.provider } : {}) };
    }
  } // asr 缺省 = 沿用（P2.5 起不再隐式删除）

  // P2.5 prefs：随带随存（滑杆/人设/气泡/暂停）
  if (m.triggerSeconds !== undefined) next['triggerSeconds'] = clampThreshold(m.triggerSeconds);
  if (m.persona !== undefined) next['persona'] = sanitizePersona(m.persona);
  if (m.bubbles !== undefined) next['bubbles'] = m.bubbles === true;
  if (m.paused !== undefined) {
    next['paused'] = m.paused === true;
  }
  if (typeof next['triggerSeconds'] !== 'number') next['triggerSeconds'] = 10;
  if (typeof next['persona'] !== 'string') next['persona'] = 'spicy';
  if (typeof next['bubbles'] !== 'boolean') next['bubbles'] = true;
  if (typeof next['asrMaxMB'] !== 'number') next['asrMaxMB'] = 25; // P2.3：音频上限默认 25MB（≈50 分钟）

  const personaChanged = typeof m.persona === 'string' && sanitizePersona(m.persona) !== String(prev['persona'] ?? 'spicy');
  const setOnboarded = llmCleared ? false : llm !== undefined ? true : undefined;
  await browser.storage.local.set({
    settings: next,
    ...(setOnboarded === undefined ? {} : { onboarded: setOnboarded }),
  });
  if (m.paused === true) {
    updateAbort?.abort();
  }
  if (m.paused !== undefined || m.bubbles !== undefined) broadcastToUi({ type: 'WATCH_SETTINGS', paused: next['paused'] === true, bubbles: next['bubbles'] !== false });
  if (m.paused === false) {
    void resumeAutoAsrWaiting();
    drainUnlessPaused(true);
    const pending = updateCheckInFlight;
    if (pending) void pending.then(() => checkUpdate());
    else checkUpdate();
  }

  console.log(
    `[doubao] settings saved (${llmCleared ? 'llm cleared' : llm !== undefined ? 'llm ok' : 'llm kept'}, asr ${asr === undefined ? 'kept' : 'provided'}, paused=${String(next['paused'] === true)})`,
  );
  return { ok: true, ...(llmCleared ? { llmCleared: true } : {}), personaChanged };
}

