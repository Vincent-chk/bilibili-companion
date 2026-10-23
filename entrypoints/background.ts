// background service worker：轻量编排（架构 §8：长任务一律 offscreen，SW 不执行 LLM SSE）。
// - P1.2 watcher 服务端（VIDEO_ENTER/WATCH_TICK/TRIGGER_SUMMARY）
// - P1.4 pipeline 编排：job 派发给 offscreen 执行体，进度回流落库；SW 启动 recover+drain
// - Phase 0 PoC 链保留为 E2E 载波（VIDEO_SEEN → console 标记，scripts/e2e-poc.mjs 依赖；
//   真实触发链为 TRIGGER_SUMMARY → pipeline → offscreen → chain）
import { BiliClient, pickPage } from '../src/lib/bilibili/client';
import { selectTrack } from '../src/lib/bilibili/track';
import { resolveConfig, summarize } from '../src/lib/llm/summary';
import type { StoredLlmConfig } from '../src/lib/llm/summary';
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

const seen = new Set<string>();
const db = new CompanionDB();

// ---- P1.4 · pipeline：执行体=offscreen（LLM SSE 长任务不在 SW 跑） -----------------

let offscreenReady = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenReady) return;
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as never],
  });
  if (existing.length > 0) {
    offscreenReady = true;
    return;
  }
  try {
    await browser.offscreen.createDocument({
      url: 'offscreen.html', // WXT 构建产物路径（entrypoints/offscreen/index.html → 根 offscreen.html）
      reasons: ['DOM_PARSER' as never],
      justification: 'LLM SSE 长任务执行体：规避 service worker 30s 空闲休眠',
    });
    offscreenReady = true;
  } catch (e) {
    // 并发创建时"已存在"类报错按就绪处理；其余抛给 pipeline 记失败重试
    if (String(e).includes('Only a single offscreen')) offscreenReady = true;
    else throw e;
  }
}

/**
 * job 执行器：发 offscreen 跑全链路，SUMMARY_PROGRESS 消息转 pipeline ctx 落库。
 * shortcut: 600s 看门狗兜 offscreen 挂死（不回包）阻塞队列；SW 中途死亡由 recover() 重排幂等重跑。
 */
async function executeViaOffscreen(job: JobRow, ctx: JobContext): Promise<JobOutcome> {
  await ensureOffscreen();
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
    const reply = await Promise.race([
      browser.runtime.sendMessage({ type: 'OFFSCREEN_RUN_JOB', job: { id: job.id, videoKey: job.videoKey } }),
      new Promise<never>((_, rej) => {
        watchdog = setTimeout(() => rej(new Error('offscreen 执行超时(600s)')), 600_000);
      }),
    ]);
    return reply as JobOutcome;
  } finally {
    browser.runtime.onMessage.removeListener(onProgress);
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

const pipeline = new Pipeline(db, { execute: executeViaOffscreen }, {
  onTransition: (j) => {
    if (j.status !== 'pending') console.log(`[doubao] job ${j.type} ${j.videoKey} → ${j.status}${j.retries ? ` (retry ${j.retries})` : ''}`);
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
      case 'VIDEO_SEEN':
        if (m.bvid) void runChain(m.bvid);
        return undefined; // 单向通知，无应答
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

/** PoC 触发=进页面即跑（幂等：每视频每会话一次）；Phase 1 换 watcher 的 20s 有效观看触发。 */
async function runChain(bvid: string): Promise<void> {
  if (seen.has(bvid)) return;
  seen.add(bvid);
  const t0 = Date.now();
  try {
    const client = new BiliClient(); // credentials:'include' 内置：扩展宿主下自动带登录 Cookie
    await client.fetchWbiKeys();
    const view = await client.getView(bvid);
    console.log(`[doubao-poc] E2E view ok: "${view.title.slice(0, 30)}" dur=${view.duration}s cid=${view.cid}`);

    const { subtitles } = await client.getPlayerSubtitles(bvid, view.cid);
    const track = selectTrack(subtitles);
    if (!track?.subtitle_url) {
      console.log(
        `[doubao-poc] E2E FAIL subtitle: 无可用轨（tracks=${subtitles.length}；有轨样本出现此错误=登录态未带上）`,
      );
      return;
    }
    const cues = await client.fetchTranscript(track.subtitle_url);
    console.log(`[doubao-poc] E2E subtitle ok: cues=${cues.length} lan=${track.lan}`);

    const stored = ((await browser.storage.local.get('llm'))['llm'] ?? undefined) as
      | StoredLlmConfig
      | undefined;
    const { config } = resolveConfig(stored);
    if (!config) {
      console.log('[doubao-poc] E2E FAIL llm: 未配置（storage.local.llm 三件套或构建期 POC_LLM_* 环境变量）');
      return;
    }
    const transcript = cues.map((c) => `[${mmss(c.from)}]${c.content}`).join('\n');
    const out = await summarize(
      config,
      { title: view.title, duration: view.duration, cueCount: cues.length },
      transcript,
    );
    if (out.summaryResult) {
      const r = out.summaryResult;
      console.log(
        `[doubao-poc] E2E llm ok: degraded=false rating=${r.rating} summaryChars=${r.summary.length}` +
          ` attempts=${out.attempts} ttft=${out.ttftMs}ms outline=${r.outline.length}条`,
      );
      console.log(`[doubao-poc] 摘要：${r.summary}`);
      console.log(`[doubao-poc] 豆包说：${r.evaluation}（${r.rating}🫘）`);
    } else {
      console.log(
        `[doubao-poc] E2E llm ok: degraded=true chars=${out.plainText?.length ?? 0} attempts=${out.attempts}`,
      );
    }
    console.log(`[doubao-poc] E2E CHAIN DONE bvid=${bvid} in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`[doubao-poc] E2E FAIL ${String(e).slice(0, 300)}`);
  }
}

function mmss(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
