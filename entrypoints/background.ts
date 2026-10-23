// background service worker：轻量编排（架构 §8：长任务一律 offscreen，SW 不执行 LLM SSE）。
// - P1.2 watcher 服务端（VIDEO_ENTER/WATCH_TICK/TRIGGER_SUMMARY）
// - P1.4 pipeline 编排：job 派发给 offscreen 执行体，进度回流落库；SW 启动 recover+drain
// 触发链：watcher 20s → TRIGGER_SUMMARY → pipeline.enqueue → offscreen → lib/summarize/chain → 落库
// （Phase 0 的 VIDEO_SEEN 进页即跑链已随 1.4 移除：SW 内不留 LLM 路径，E2E 改走真实触发链）
import { BiliClient, pickPage } from '../src/lib/bilibili/client';
import { readStoredLlmConfig, resolveConfig } from '../src/lib/llm/summary';
import { Pipeline, type JobContext, type JobOutcome } from '../src/lib/pipeline';
import {
  CompanionDB,
  getSessionPointer,
  isCacheFresh,
  setSessionPointer,
  updateVisitProgress,
  upsertVisit,
  type JobRow,
  type JobStage,
  type SummaryRow,
  type VideoRow,
} from '../src/lib/storage';
import { browserKv } from '../src/lib/storage/browserKv';
import { excerptOf } from '../src/content/panel/view-models';
import { validateAsr, validateEndpointUrl, validateLlm } from '../src/content/onboarding/onboarding-logic';
import { buildVideoUrl, pickSeekTab, type SeekTabCandidate } from '../src/content/seek';
import { parseVideoKey } from '../src/lib/summarize/chain';

const db = new CompanionDB();

// ---- P1.5 · Port（doubao-port）与面板推送 ----------------------------------------
// runtime.sendMessage 到不了 content script（扩展内部专用），B→C 推送一律走 Port 广播。

interface UiPort {
  postMessage: (msg: unknown) => void;
}
const uiPorts = new Set<UiPort>();

function broadcastToUi(msg: Record<string, unknown>): void {
  for (const p of uiPorts) {
    try {
      p.postMessage(msg);
    } catch {
      /* 断口由 onDisconnect 清理 */
    }
  }
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
      reasons: ['DOM_PARSER' as never],
      justification: 'LLM SSE 长任务执行体：规避 service worker 30s 空闲休眠',
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

async function executeViaOffscreen(job: JobRow, ctx: JobContext): Promise<JobOutcome> {
  const onProgress = (msg: unknown) => {
    const m = msg as {
      type?: string;
      jobId?: string;
      stage?: JobStage;
      progress?: number;
      deltaText?: string;
    };
    if (m?.type === 'SUMMARY_PROGRESS' && m.jobId === job.id) {
      const patch: { stage?: JobStage; progress?: number } = {};
      if (m.stage !== undefined) patch.stage = m.stage;
      if (m.progress !== undefined) patch.progress = m.progress;
      if (patch.stage !== undefined || patch.progress !== undefined) void ctx.update(patch);
      // 面板推送：补 videoKey（offscreen 只知道 jobId），deltaText 驱动详情流式打字
      broadcastToUi({ ...m, type: 'SUMMARY_PROGRESS', videoKey: job.videoKey });
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
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await ensureOffscreen();
    // offscreen 文档读不了 storage（API 受限）：LLM 配置与 persona 在 SW 解析后随 job 传入
    const { config, error: cfgErr } = resolveConfig(await readStoredLlmConfig(browserKv));
    if (!config) return { result: 'failed', error: { code: 'NO_LLM_CONFIG', msg: cfgErr ?? '未配置 LLM' } };
    const persona = ((await browser.storage.local.get('settings'))['settings'] as { persona?: string } | undefined)
      ?.persona;
    const reply = (await Promise.race([
      sendToOffscreen({
        type: 'OFFSCREEN_RUN_JOB',
        job: { id: job.id, videoKey: job.videoKey, type: job.type, segIndex: job.segIndex },
        llm: config,
        persona,
      }),
      new Promise<never>((_, rej) => {
        watchdog = setTimeout(() => rej(new Error('offscreen 执行超时(600s)')), 600_000);
      }),
    ])) as JobOutcome | undefined;
    if (reply && reply.result === 'failed') {
      // offscreen 的 console 不易被 CDP 捕获，失败原因回灌 SW console 便于诊断
      console.log(`[doubao] offscreen job failed: ${reply.error?.code}: ${reply.error?.msg}`);
    }
    if (!reply) throw new Error('offscreen 无应答（文档可能未加载完成）');
    return reply;
  } catch (e) {
    console.log(`[doubao] offscreen executor error: ${String(e).slice(0, 200)}`);
    offscreenReady = false; // offscreen 文档可能已被系统回收：下次执行重建
    throw e;
  } finally {
    browser.runtime.onMessage.removeListener(onProgress);
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

const lastLoggedStatus = new Map<string, string>();
const pipeline = new Pipeline(db, { execute: executeViaOffscreen }, {
  onTransition: (j) => {
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
      broadcastToUi({ type: t, videoKey: j.videoKey });
    }
  },
});

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
      error: note?.error,
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
  videoKey?: string;
  watchedSeconds?: number;
  progressPct?: number;
  time?: number; // SEEK_TO 目标秒（P1.8）
  segIndex?: number; // SEGMENT_NOTE_OPEN 段下标（P1.11）
  force?: number; // LOGIN_CHECK 强制绕过 30s 缓存（P1.10：面板打开时机）
  retry?: number; // SUMMARY_OPEN 用户显式重试标记（1=点击进入，可对 failed 摘要重新入队）
  llm?: ModelConfigMsg;
  asr?: ModelConfigMsg;
}

export default defineBackground(() => {
  console.log('[doubao-poc] background ready');
  // SW 启动：恢复 stale running → 清空 pending（断网挂起/重启后续跑，F11）
  void pipeline.recover().then(async (n) => {
    if (n) console.log(`[doubao] recovered ${n} stale job(s)`);
    await pipeline.drain();
  });
  // P1.10 时机①：扩展启动即探登录态（架构 §3.9）
  void checkLoginState(true)
    .then((s) => applyLoginState(s))
    .catch(() => {});

  // P1.5：面板 Port。连接即回放当前会话状态（新标签页初始化；P1.6 豆包消费）
  browser.runtime.onConnect.addListener((port) => {
    if ((port as { name?: string }).name !== 'doubao-port') return;
    const p = port as unknown as UiPort;
    uiPorts.add(p);
    (port as unknown as { onDisconnect: { addListener: (cb: () => void) => void } }).onDisconnect.addListener(() =>
      uiPorts.delete(p),
    );
    void getSessionPointer(browserKv)
      .then((pointer) => {
        try {
          p.postMessage({ type: 'SESSION_STATE', state: pointer?.state ?? 'INACTIVE' });
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

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as InMsg;
    switch (m?.type) {
      case 'PING':
        return Promise.resolve({ pong: true });
      case 'VIDEO_ENTER':
        return handleVideoEnter(m);
      case 'WATCH_TICK':
        return handleWatchTick(m);
      case 'TRIGGER_SUMMARY':
        return handleTriggerSummary(m);
      case 'LIST_QUERY':
        return handleListQuery();
      case 'SUMMARY_OPEN':
        return handleSummaryOpen(m);
      case 'SEEK_TO':
        return handleSeekTo(m);
      case 'SEGMENT_NOTE_OPEN':
        return handleSegmentNoteOpen(m);
      case 'LOGIN_CHECK':
        return handleLoginCheck(m);
      case 'SESSION_START':
        return handleSessionStart();
      case 'SESSION_END':
        return handleSessionEnd();
      case 'TEST_CONNECTION':
        return handleTestConnection(m);
      case 'SETTINGS_SAVE':
        return handleSettingsSave(m);
      default:
        return undefined; // 未识别消息交给其它 listener（SUMMARY_PROGRESS 由 executeViaOffscreen 处理）
    }
  });
});

// ---- P1.6 · 会话最小切片（完整状态机/保留期判定是任务 2.1） ---------------------

const rand4 = () => Math.random().toString(36).slice(2, 6);

/**
 * SESSION_START（开始/恢复陪看）：未配置 LLM → NEED_ONBOARDING（F1/F9，content 弹 onboarding）。
 * GRACE 内重开 = 恢复同一会话（保留列表与进度）；无 pointer 才新建 session 行。
 */
async function handleSessionStart(): Promise<Record<string, unknown>> {
  const cfg = await readStoredLlmConfig(browserKv);
  if (!cfg) return { ok: false, reason: 'NEED_ONBOARDING' };
  const now = Date.now();
  const existing = await getSessionPointer(browserKv);
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
  await setSessionPointer(browserKv, {
    sessionId,
    state: 'ACTIVE',
    startedAt: existing && resumable ? existing.startedAt : now,
    lastActiveAt: now,
    ...(existing?.state === 'GRACE' ? { restoredAt: now } : {}),
  });
  console.log(`[doubao] session ${resumable ? 'resumed' : 'started'}: ${sessionId}`);
  broadcastToUi({ type: 'SESSION_STATE', state: 'ACTIVE' });
  return { ok: true, sessionState: 'ACTIVE', resumed: resumable };
}

/** SESSION_END（结束陪看）：ACTIVE → GRACE（closedAt=现在，1h 保留基准）。 */
async function handleSessionEnd(): Promise<Record<string, unknown>> {
  const pointer = await getSessionPointer(browserKv);
  if (!pointer || pointer.state !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  const now = Date.now();
  await db.sessions.update(pointer.sessionId, { state: 'GRACE', closedAt: now, lastActiveAt: now });
  await setSessionPointer(browserKv, { ...pointer, state: 'GRACE', closedAt: now, lastActiveAt: now });
  console.log(`[doubao] session ended (GRACE): ${pointer.sessionId}`);
  broadcastToUi({ type: 'SESSION_STATE', state: 'GRACE' });
  return { ok: true, sessionState: 'GRACE' };
}

// ---- P1.2 · watcher 服务端 ---------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** VIDEO_ENTER：view 元信息（videos 24h 缓存）+ 多 P 选 cid + 建/刷 visit，回 watcher 所需参数。 */
async function handleVideoEnter(m: InMsg): Promise<Record<string, unknown>> {
  const { bvid, url } = m;
  if (!bvid || !url) return { ok: false, error: 'VIDEO_ENTER 缺 bvid/url' };
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
      const client = new BiliClient(); // credentials:'include'：扩展宿主下自动带登录 Cookie
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
    if (pointer) await upsertVisit(db, { sessionId: pointer.sessionId, videoKey: row.key, now });
    const settings = (await browser.storage.local.get('settings'))['settings'] as
      | { triggerSeconds?: number }
      | undefined;
    return {
      ok: true,
      videoKey: row.key,
      duration: row.duration,
      triggerSeconds: clamp(settings?.triggerSeconds ?? 20, 5, 300),
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
  const { videoKey, watchedSeconds = 0, progressPct = 0 } = m;
  if (!videoKey) return { ok: false };
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: false, reason: 'inactive' };
  const sessionId = pointer.sessionId;
  const existing = await db.visits.where({ sessionId, videoKey }).first();
  if (!existing) {
    // videos 行可能也缺（VIDEO_ENTER 全程未激活）：job 链有兜底，列表标题退 videoKey
    await upsertVisit(db, { sessionId, videoKey, now: Date.now() });
  }
  await updateVisitProgress(db, { sessionId, videoKey }, { watchedSeconds, progressPct });
  const threshold = clamp((await readSettings()).triggerSeconds ?? 20, 5, 300);
  const row = await db.visits.where({ sessionId, videoKey }).first();
  if (row && !row.triggered && row.watchedSeconds >= threshold) {
    await db.transaction('rw', [db.visits, db.jobs], async () => {
      await db.visits.put({ ...row, triggered: 1, lastSeenAt: Date.now() });
      await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId });
    });
    console.log(`[doubao] summary job queued (tick sweep): ${videoKey}`);
    void pipeline.drain();
  }
  return { ok: true, ...(existing ? {} : { created: true }) };
}

/**
 * TRIGGER_SUMMARY（20s 阈值）：会话级幂等（visits.triggered）+ pipeline.enqueue 活动任务去重
 * （双标签页/触发与按需并发在此收口），入队后 kick drain。
 */
async function handleTriggerSummary(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false };
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: false, reason: 'inactive' };
  const visit = await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first();
  if (!visit) return { ok: false, reason: 'no-visit' };
  if (visit.triggered) return { ok: true, deduped: true };
  // 单事务：置位 triggered 与建 job 同生共死，jobs 写失败可重试触发而不永久丢失
  await db.transaction('rw', [db.visits, db.jobs], async () => {
    await db.visits.put({ ...visit, triggered: 1, lastSeenAt: Date.now() });
    await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId: pointer.sessionId });
  });
  console.log(`[doubao] summary job queued: ${videoKey}`);
  void pipeline.drain();
  return { ok: true };
}

// ---- P1.5 · 面板数据服务（LIST_QUERY / SUMMARY_OPEN） --------------------------

const ACTIVE_JOB_STATUSES: JobRow['status'][] = ['pending', 'running', 'need_confirm'];

/** videoKey 的最新 summary 行（换模型会产生多行，面板展示最新一次结果）。 */
async function latestSummary(videoKey: string): Promise<SummaryRow | undefined> {
  const rows = await db.summaries.where('videoKey').equals(videoKey).sortBy('createdAt');
  return rows.length ? rows[rows.length - 1] : undefined;
}

async function activeJob(videoKey: string): Promise<JobRow | undefined> {
  const rows = await db.jobs.where('videoKey').equals(videoKey).toArray();
  return rows.find((j) => ACTIVE_JOB_STATUSES.includes(j.status));
}

async function readSettings(): Promise<{ triggerSeconds?: number; persona?: string }> {
  return ((await browser.storage.local.get('settings'))['settings'] as { triggerSeconds?: number; persona?: string }) ?? {};
}

/** LIST_QUERY：visits+videos+summaries+jobs 联查快照（02-数据模型 §3，列表数据源）。 */
async function handleListQuery(): Promise<Record<string, unknown>> {
  const pointer = await getSessionPointer(browserKv);
  const settings = await readSettings();
  const base = {
    ok: true as const,
    sessionState: pointer?.state ?? 'INACTIVE',
    triggerSeconds: clamp(settings.triggerSeconds ?? 20, 5, 300),
    // P1.10：引导卡数据源（30s 缓存零网络；强制刷新走 LOGIN_CHECK force=1，面板打开时机）
    loggedIn: loginCache?.loggedIn ?? null,
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
      job: await activeJob(visit.videoKey),
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
 */
async function handleSummaryOpen(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey } = m;
  if (!videoKey) return { ok: false, error: 'SUMMARY_OPEN 缺 videoKey' };
  const pointer = await getSessionPointer(browserKv);
  const visit = pointer
    ? await db.visits.where({ sessionId: pointer.sessionId, videoKey }).first()
    : undefined;
  if (!visit || !pointer) return { ok: false, error: 'no-visit' };
  const video = await db.videos.get(videoKey);
  const summary = await latestSummary(videoKey);
  let job = await activeJob(videoKey);
  const lastJobRow = (await db.jobs.where('videoKey').equals(videoKey).sortBy('updatedAt')).pop();
  const untouched = !summary && !lastJobRow; // 从未生成过也从未排过队
  const failedBefore = summary?.status === 'failed' || lastJobRow?.status === 'failed';
  if (!job && (untouched || (failedBefore && m.retry === 1))) {
    await pipeline.enqueue({ type: 'SUMMARIZE', videoKey, sessionId: pointer.sessionId });
    job = await activeJob(videoKey);
    void pipeline.drain();
  }
  const transcript = excerptOf(await db.transcripts.get(videoKey));
  return { ok: true, item: { visit, video, summary, job }, transcript };
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
  const tab = pickSeekTab(tabs, bvid, page);
  if (tab?.id !== undefined) {
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    await browser.tabs.update(tab.id, { active: true });
    // 目标页自己收广播执行 seek（发起页 currentVideoKey 不匹配会忽略）；page 随广播带上——
    // 各标签页的 URL 兜底匹配须按 bvid+分P 判定（审查 P1-1：仅比 bvid 会让同 bvid 异 P 页误 seek）
    broadcastToUi({ type: 'SEEK_TO', videoKey, time: Math.max(0, Math.floor(time)), page });
    // shortcut: 扩展 reload 后旧标签 content 成孤儿（URL 仍匹配）→ 聚焦成功但广播进空端口、
    // 发起页按设计不 toast，用户见切页却无跳转；完整修需 port↔tab 映射+ack，PoC 阶段不值（审查 P2-1）
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

/**
 * SEGMENT_NOTE_OPEN（架构 §4.4）：命中 segmentNotes done 缓存 → 直接返回（零 LLM 请求）；
 * 未命中 → 建 SEGMENT_ANALYZE job（pipeline 串行）→ 流式经 SEGMENT_NOTE_STREAM/DONE/FAILED 回流。
 * 重试口径同 SUMMARY_OPEN（F11）：failed 注记仅 retry=1（用户显式点击）重排；
 * streaming 注记但无活动 job（SW 中途死亡残留）→ 点击即重建自愈。
 */
async function handleSegmentNoteOpen(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey, segIndex, retry } = m;
  if (!videoKey || typeof segIndex !== 'number' || !Number.isInteger(segIndex) || segIndex < 0) {
    return { ok: false, error: 'SEGMENT_NOTE_OPEN 缺 videoKey/segIndex' };
  }
  const summary = await latestSummary(videoKey);
  if (!summary || summary.status !== 'done' || !summary.outline?.length || segIndex >= summary.outline.length) {
    return { ok: false, error: 'NO_OUTLINE' }; // 无大纲（含无字幕未确认）→ 入口本不应出现
  }
  const cached = summary.segmentNotes?.[segIndex];
  const active = await activeSegmentJob(videoKey, segIndex);
  if (cached?.status === 'done' && !active) {
    console.log(`[doubao] segment note cache hit: ${videoKey}#${segIndex}`);
    return { ok: true, note: cached, cacheHit: true };
  }
  if (!active) {
    const allow =
      cached === undefined ||
      cached.status === 'streaming' || // 残留 streaming（SW 死亡）→ 点击重建
      (cached.status === 'failed' && retry === 1); // 用户显式重试
    if (allow) {
      const pointer = await getSessionPointer(browserKv);
      await pipeline.enqueue({
        type: 'SEGMENT_ANALYZE',
        videoKey,
        sessionId: pointer?.sessionId ?? 'no-session',
        segIndex,
      });
      void pipeline.drain();
      // 审查 P1-1：本次入了队就回合成 streaming 占位（started 标记让面板清空旧增量残留）——
      // 若回旧 failed 注记，面板会把重试的流式占位覆盖回失败卡并丢弃全部增量（「重试秒败」假象）
      return { ok: true, note: { text: '', status: 'streaming', createdAt: Date.now() }, started: true };
    }
  }
  return { ok: true, note: cached ?? { text: '', status: 'streaming', createdAt: Date.now() } };
}

// ---- P1.10 · 登录态检测与引导（架构 §3.9） ------------------------------------

// 登录探测专用实例：-412 熔断等待压到 1.5s（默认 60s 会让面板打开的 force 复核卡一分钟）；
// 探测失败返回 null（未知态）不写缓存，下次重探。
const loginClient = new BiliClient({ breakerWaitMs: 1500 });
const LOGIN_CACHE_MS = 30_000;
let loginCache: { at: number; loggedIn: boolean | null } | null = null;
/** 最近一次广播过的登录态（undefined=从未广播）；仅翻转时广播，防轰炸。 */
let loginBroadcasted: boolean | null | undefined = undefined;
/** 审查 P2-4：single-flight——启动探测/多标签重连 force/面板 open force 并发时共享在途 nav。 */
let loginInflight: Promise<boolean | null> | null = null;

async function checkLoginState(force = false): Promise<boolean | null> {
  if (!force && loginCache && Date.now() - loginCache.at < LOGIN_CACHE_MS) return loginCache.loggedIn;
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
      void pipeline.drain();
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
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
}

/** optional_host_permissions：已含则跳过，否则申请（F9：弹窗仅含所填端点 origin）。
 *  SW 消息上下文可能无用户手势 → 申请抛错按未授权处理，不阻塞保存（端点带 CORS 时链路仍可用）。 */
async function ensureOriginPermission(pattern: string): Promise<boolean> {
  try {
    if (await browser.permissions.contains({ origins: [pattern] })) return true;
    return await browser.permissions.request({ origins: [pattern] });
  } catch {
    return false;
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
 * TEST_CONNECTION：最小 chat/completions 探活（max_tokens=1、stream:false、15s 超时）。
 * 先按 origin 尽力申请权限（成功/失败均继续探测——CORS 端点无权限也能通）。
 */
async function handleTestConnection(m: InMsg): Promise<Record<string, unknown>> {
  const cfg = m.llm ?? {};
  const baseUrl = (cfg.baseUrl ?? '').trim();
  const model = (cfg.modelId ?? '').trim();
  const apiKey = (cfg.apiKey ?? '').trim();
  if (!baseUrl || !model || !apiKey) return { ok: false, msg: '请先填写完整配置再测试' };
  const v = validateEndpointUrl(baseUrl);
  if (!v.ok) return { ok: false, msg: v.error ?? 'Base URL 不合法' };
  await ensureOriginPermission(`${v.origin}/*`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), 15_000);
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
      msg: controller.signal.aborted ? '连接超时（>15s）' : `无法连接端点：${String(e).slice(0, 80)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SETTINGS_SAVE（onboarding 保存，02-数据模型 §2 settings 形状）：
 * 后台二次校验（信任边界）→ 写 settings + onboarded → 按 origin 申请权限 → 返回授权结果。
 * tts 预留位置灰保存；triggerSeconds/persona/bubbles 首次保存时落默认值。
 * llm/asr 的 `ok`（已验证）标记不在此写——语义属「测试连接通过」，由 2.5 设置页消费时再定义。
 * ASR 清空保存 = 清除旧配置（防旧 Key 残留，审查 P2）。
 */
async function handleSettingsSave(m: InMsg): Promise<Record<string, unknown>> {
  const llm = m.llm ?? {};
  const asr = m.asr;
  const v = validateLlm({ baseUrl: llm.baseUrl ?? '', modelId: llm.modelId ?? '', apiKey: llm.apiKey ?? '' });
  if (!v.ok) return { ok: false, error: v.error ?? `必填项缺失：${v.missing.join(' / ')}` };

  const prev =
    ((await browser.storage.local.get('settings'))['settings'] as Record<string, unknown> | undefined) ?? {};
  const next: Record<string, unknown> = {
    ...prev,
    llm: { baseUrl: llm.baseUrl!.trim(), modelId: llm.modelId!.trim(), apiKey: llm.apiKey!.trim() },
  };
  const patterns: string[] = [];
  const oL = validateEndpointUrl(llm.baseUrl!);
  if (oL.ok && oL.origin) patterns.push(`${oL.origin}/*`);

  const a = asr
    ? validateAsr({ baseUrl: asr.baseUrl ?? '', modelId: asr.modelId ?? '', apiKey: asr.apiKey ?? '' })
    : { kind: 'skip' as const };
  if (a.kind === 'error') return { ok: false, error: a.error };
  if (a.kind === 'ok') {
    next.asr = { baseUrl: asr!.baseUrl!.trim(), modelId: asr!.modelId!.trim(), apiKey: asr!.apiKey!.trim() };
    const oA = validateEndpointUrl(asr!.baseUrl!);
    if (oA.ok && oA.origin) patterns.push(`${oA.origin}/*`);
  } else {
    delete next.asr; // 清空保存 = 移除旧 ASR 配置（含旧 Key），与「部分填写报错」对称
  }
  if (typeof next['triggerSeconds'] !== 'number') next['triggerSeconds'] = 20;
  if (typeof next['persona'] !== 'string') next['persona'] = 'spicy';
  if (typeof next['bubbles'] !== 'boolean') next['bubbles'] = true;

  await browser.storage.local.set({ settings: next, onboarded: true });

  const granted: string[] = [];
  const denied: string[] = [];
  for (const p of patterns) {
    (await ensureOriginPermission(p) ? granted : denied).push(p);
  }
  console.log(
    `[doubao] settings saved (llm ok, asr ${a.kind === 'ok' ? 'provided' : 'cleared/skipped'}; origins granted=${granted.length} denied=${denied.length})`,
  );
  return { ok: true, granted, denied };
}

