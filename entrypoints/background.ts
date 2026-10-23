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
  updateVisitProgress,
  upsertVisit,
  type JobRow,
  type JobStage,
  type VideoRow,
} from '../src/lib/storage';
import { browserKv } from '../src/lib/storage/browserKv';

const db = new CompanionDB();

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
    const m = msg as { type?: string; jobId?: string; stage?: JobStage; progress?: number };
    if (m?.type === 'SUMMARY_PROGRESS' && m.jobId === job.id) {
      const patch: { stage?: JobStage; progress?: number } = {};
      if (m.stage !== undefined) patch.stage = m.stage;
      if (m.progress !== undefined) patch.progress = m.progress;
      if (patch.stage !== undefined || patch.progress !== undefined) void ctx.update(patch);
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
      sendToOffscreen({ type: 'OFFSCREEN_RUN_JOB', job: { id: job.id, videoKey: job.videoKey }, llm: config, persona }),
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
    // 进度写回也会触发本回调：只在状态真正变化时打日志
    if (j.status !== 'pending' && lastLoggedStatus.get(j.id) !== j.status) {
      lastLoggedStatus.set(j.id, j.status);
      console.log(`[doubao] job ${j.type} ${j.videoKey} → ${j.status}${j.retries ? ` (retry ${j.retries})` : ''}`);
    }
  },
});

interface InMsg {
  type?: string;
  bvid?: string | null;
  url?: string;
  videoKey?: string;
  watchedSeconds?: number;
  progressPct?: number;
}

export default defineBackground(() => {
  console.log('[doubao-poc] background ready');
  // SW 启动：恢复 stale running → 清空 pending（断网挂起/重启后续跑，F11）
  void pipeline.recover().then(async (n) => {
    if (n) console.log(`[doubao] recovered ${n} stale job(s)`);
    await pipeline.drain();
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
      default:
        return undefined; // 未识别消息交给其它 listener（SUMMARY_PROGRESS 由 executeViaOffscreen 处理）
    }
  });
});

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

/** WATCH_TICK（1Hz 节流后到达）：刷新 visit 进度。未激活（无 sessionPointer）不产生记录（F1）。 */
async function handleWatchTick(m: InMsg): Promise<Record<string, unknown>> {
  const { videoKey, watchedSeconds = 0, progressPct = 0 } = m;
  if (!videoKey) return { ok: false };
  const pointer = await getSessionPointer(browserKv);
  if (!pointer) return { ok: false, reason: 'inactive' };
  await updateVisitProgress(db, { sessionId: pointer.sessionId, videoKey }, { watchedSeconds, progressPct });
  return { ok: true };
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

