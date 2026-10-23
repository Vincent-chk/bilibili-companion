// P1.1 · 存储助手：sessionPointer（chrome.storage.local）、24h 缓存判定、visit upsert、清除事务。
// lib 层不直接触碰 browser API：KV 存储由调用方注入（browserKv.ts 提供扩展实现，测试注入内存版）。
import type { CompanionDB, TranscriptRow, VisitRow } from './db';

export * from './db';

/** chrome.storage.local 的最小抽象（仅本模块需要的三个操作）。 */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

// ---- sessionPointer（02-数据模型 §2：保留期判定的唯一事实源，SW 休眠安全） ----

export const SESSION_POINTER_KEY = 'sessionPointer';

export interface SessionPointer {
  sessionId: string;
  state: 'ACTIVE' | 'GRACE' | 'EXPIRED_PENDING_CONFIRM' | 'CLOSED' | 'INACTIVE';
  startedAt?: number;
  closedAt?: number;
  lastActiveAt: number;
}

export const getSessionPointer = (kv: KVStore): Promise<SessionPointer | undefined> =>
  kv.get<SessionPointer>(SESSION_POINTER_KEY);

export const setSessionPointer = (kv: KVStore, p: SessionPointer): Promise<void> =>
  kv.set(SESSION_POINTER_KEY, p);

export const clearSessionPointer = (kv: KVStore): Promise<void> =>
  kv.remove(SESSION_POINTER_KEY);

// ---- 缓存判定（02-数据模型 §1.2/§1.4：元信息与字幕均缓存 24h） -----------------

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const isCacheFresh = (cachedAt: number, now = Date.now(), ttl = CACHE_TTL_MS): boolean =>
  now - cachedAt <= ttl;

// videos 表的缓存命中按 bvid 索引查（键含 cid，取 view 前未知），见 background.handleVideoEnter。

export async function getFreshTranscript(
  db: CompanionDB,
  key: string,
  now = Date.now(),
): Promise<TranscriptRow | undefined> {
  const row = await db.transcripts.get(key);
  return row && isCacheFresh(row.cachedAt, now) ? row : undefined;
}

// ---- visits（列表数据源；WATCH_TICK 高频写，节流由 watcher 侧负责） ----------

/** 首次观看建行，之后只刷 lastSeenAt（firstSeenAt 不可变）。'rw' 事务防并发同键重复建行。 */
export async function upsertVisit(
  db: CompanionDB,
  input: { sessionId: string; videoKey: string; now: number },
): Promise<VisitRow> {
  return db.transaction('rw', db.visits, async () => {
    const existing = await db.visits
      .where({ sessionId: input.sessionId, videoKey: input.videoKey })
      .first();
    if (existing) {
      const row: VisitRow = { ...existing, lastSeenAt: input.now };
      await db.visits.put(row);
      return row;
    }
    const row: VisitRow = {
      sessionId: input.sessionId,
      videoKey: input.videoKey,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      watchedSeconds: 0,
      progressPct: 0,
      triggered: 0,
    };
    const id = await db.visits.add(row);
    return { ...row, id };
  });
}

export async function updateVisitProgress(
  db: CompanionDB,
  where: { sessionId: string; videoKey: string },
  patch: Pick<VisitRow, 'watchedSeconds' | 'progressPct'> &
    Partial<Pick<VisitRow, 'triggered' | 'lastSeenAt'>>,
): Promise<void> {
  await db.transaction('rw', db.visits, async () => {
    const existing = await db.visits.where(where).first();
    if (!existing) return; // 无行可更（会话未建/已清除）——静默，watcher 下个 tick 重建
    await db.visits.put({
      ...existing,
      ...patch,
      // 刷新页面后 tracker 从 0 重新累计：取 max 保住会话累计口径，避免 watchedSeconds 回退
      watchedSeconds: Math.max(existing.watchedSeconds, patch.watchedSeconds),
      lastSeenAt: patch.lastSeenAt ?? Date.now(),
    });
  });
}

export const summaryKey = (videoKey: string, modelId: string): string => `${videoKey}:${modelId}`;

// ---- 清除事务（F10 · 02-数据模型 §5） ----------------------------------------
// broadcast(SESSION_STATE) 属会话层（任务 2.1），由调用方在 wipe 后自行触发。

export async function wipeAllData(db: CompanionDB, kv: KVStore): Promise<void> {
  await db.transaction(
    'rw',
    [db.sessions, db.videos, db.visits, db.transcripts, db.summaries, db.jobs],
    async () => {
      await Promise.all([
        db.sessions.clear(),
        db.videos.clear(),
        db.visits.clear(),
        db.transcripts.clear(),
        db.summaries.clear(),
        db.jobs.clear(),
      ]);
    },
  );
  await clearSessionPointer(kv); // settings / mascotPos / onboarded 保留
}
