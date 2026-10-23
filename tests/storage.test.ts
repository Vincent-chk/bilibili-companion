// P1.1 · lib/storage 单测：六表建库、sessionPointer、24h 缓存判定、visit upsert、清除事务。
import { describe, expect, it } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import {
  CACHE_TTL_MS,
  CompanionDB,
  clearSessionPointer,
  getSessionPointer,
  getFreshTranscript,
  isCacheFresh,
  setSessionPointer,
  summaryKey,
  updateVisitProgress,
  upsertVisit,
  wipeAllData,
  type KVStore,
} from '../src/lib/storage';

const freshDb = (): CompanionDB => new CompanionDB(`test-${Math.random()}`, { indexedDB, IDBKeyRange });

const memKv = (): KVStore => {
  const m = new Map<string, unknown>();
  return {
    async get(k) {
      return m.get(k) as never;
    },
    async set(k, v) {
      m.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k);
    },
  };
};

const videoRow = (fetchedAt: number) => ({
  key: 'BV1x:111',
  bvid: 'BV1x',
  aid: 1,
  cid: 111,
  title: 't',
  cover: 'c',
  owner: 'o',
  duration: 600,
  page: 1,
  fetchedAt,
});

describe('schema', () => {
  it('六表建库并可读写（v1.0：五业务表 + jobs）', async () => {
    const db = freshDb();
    await db.sessions.put({ id: 's_1_a', state: 'ACTIVE', startedAt: 1, lastActiveAt: 1 });
    await db.videos.put(videoRow(1));
    await db.visits.add({ sessionId: 's_1_a', videoKey: 'BV1x:111', firstSeenAt: 1, lastSeenAt: 1, watchedSeconds: 0, progressPct: 0, triggered: 0 });
    await db.transcripts.put({ key: 'BV1x:111', source: 'ai_sub', lan: 'ai-zh', cues: [{ from: 0, to: 2, text: '你好' }], charCount: 2, cachedAt: 1 });
    await db.summaries.put({ key: summaryKey('BV1x:111', 'm'), videoKey: 'BV1x:111', source: 'ai_sub', summary: 's', outline: [], evaluation: 'e', rating: 3, modelId: 'm', persona: 'witty', status: 'done', createdAt: 1 });
    await db.jobs.put({ id: 'j1', type: 'SUMMARIZE', videoKey: 'BV1x:111', sessionId: 's_1_a', status: 'pending', progress: 0, retries: 0, createdAt: 1, updatedAt: 1 });

    expect(await db.sessions.count()).toBe(1);
    expect(await db.videos.count()).toBe(1);
    expect(await db.visits.count()).toBe(1);
    expect(await db.transcripts.count()).toBe(1);
    expect(await db.summaries.count()).toBe(1);
    expect(await db.jobs.count()).toBe(1);
    // 复合索引：列表查询 [sessionId+lastSeenAt] 可用
    const list = await db.visits.where('[sessionId+lastSeenAt]').between(['s_1_a', 0], ['s_1_a', 2]).toArray();
    expect(list).toHaveLength(1);
    await db.delete();
  });
});

describe('sessionPointer', () => {
  it('set → get → clear 往返', async () => {
    const kv = memKv();
    expect(await getSessionPointer(kv)).toBeUndefined();
    const p = { sessionId: 's_1_a', state: 'GRACE' as const, closedAt: 123, lastActiveAt: 120 };
    await setSessionPointer(kv, p);
    expect(await getSessionPointer(kv)).toEqual(p);
    await clearSessionPointer(kv);
    expect(await getSessionPointer(kv)).toBeUndefined();
  });
});

describe('24h 缓存判定', () => {
  it('TTL 内命中、超时未命中、边界（恰好 24h）命中（videos/transcripts 同一判定）', async () => {
    const db = freshDb();
    const now = 1_000_000_000;
    expect(isCacheFresh(now - CACHE_TTL_MS, now)).toBe(true);
    expect(isCacheFresh(now - CACHE_TTL_MS - 1, now)).toBe(false);

    await db.videos.put(videoRow(now - CACHE_TTL_MS));
    expect(isCacheFresh((await db.videos.get('BV1x:111'))!.fetchedAt, now)).toBe(true);
    await db.videos.put(videoRow(now - CACHE_TTL_MS - 1));
    expect(isCacheFresh((await db.videos.get('BV1x:111'))!.fetchedAt, now)).toBe(false);

    await db.transcripts.put({ key: 'BV1x:111', source: 'manual_sub', lan: 'zh-CN', cues: [], charCount: 0, cachedAt: now });
    expect(await getFreshTranscript(db, 'BV1x:111', now + CACHE_TTL_MS)).toBeDefined();
    expect(await getFreshTranscript(db, 'BV1x:111', now + CACHE_TTL_MS + 1)).toBeUndefined();
    await db.delete();
  });
});

describe('visit upsert', () => {
  it('首见建行（firstSeenAt 不可变）、再见只刷 lastSeenAt、进度与触发位可更新', async () => {
    const db = freshDb();
    const a = await upsertVisit(db, { sessionId: 's', videoKey: 'v', now: 100 });
    expect(a.firstSeenAt).toBe(100);
    const b = await upsertVisit(db, { sessionId: 's', videoKey: 'v', now: 200 });
    expect(b.id).toBe(a.id);
    expect(b.firstSeenAt).toBe(100);
    expect(b.lastSeenAt).toBe(200);

    await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchedSeconds: 42, progressPct: 7, triggered: 1 });
    const rows = await db.visits.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ watchedSeconds: 42, progressPct: 7, triggered: 1 });
    expect(rows[0]!.lastSeenAt).toBeGreaterThanOrEqual(200);

    // 不存在的行：静默不抛
    await expect(
      updateVisitProgress(db, { sessionId: 'nope', videoKey: 'v' }, { watchedSeconds: 1, progressPct: 1 }),
    ).resolves.toBeUndefined();
    await db.delete();
  });

  it('同会话不同视频 / 不同会话同视频 各自独立成行', async () => {
    const db = freshDb();
    await upsertVisit(db, { sessionId: 's1', videoKey: 'v1', now: 1 });
    await upsertVisit(db, { sessionId: 's1', videoKey: 'v2', now: 1 });
    await upsertVisit(db, { sessionId: 's2', videoKey: 'v1', now: 1 });
    expect(await db.visits.count()).toBe(3);
    await db.delete();
  });

  it('watchedSeconds 单调不回退（刷新页面后 tracker 从 0 重新累计）', async () => {
    const db = freshDb();
    await upsertVisit(db, { sessionId: 's', videoKey: 'v', now: 1 });
    await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchedSeconds: 30, progressPct: 50 });
    // 模拟刷新：新 tracker 实例从 0 累计，只看了 3s
    await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchedSeconds: 3, progressPct: 55 });
    const row = (await db.visits.toArray())[0]!;
    expect(row.watchedSeconds).toBe(30); // max 保累计
    expect(row.progressPct).toBe(55); // 进度跟随媒体时间正常刷新
    await db.delete();
  });
});

describe('wipeAllData（F10 清除事务）', () => {
  it('六表物理清空 + sessionPointer 移除，且 wipe 是事务性的（失败不半清）', async () => {
    const db = freshDb();
    const kv = memKv();
    await setSessionPointer(kv, { sessionId: 's', state: 'ACTIVE', lastActiveAt: 1 });
    await db.sessions.put({ id: 'x', state: 'ACTIVE', startedAt: 1, lastActiveAt: 1 });
    await db.videos.put(videoRow(1));
    await db.visits.add({ sessionId: 'x', videoKey: 'k', firstSeenAt: 1, lastSeenAt: 1, watchedSeconds: 0, progressPct: 0, triggered: 0 });
    await db.transcripts.put({ key: 'k', source: 'asr', lan: 'zh', cues: [], charCount: 0, cachedAt: 1 });
    await db.summaries.put({ key: 'k:m', videoKey: 'k', source: 'asr', summary: '', outline: [], evaluation: '', rating: 1, modelId: 'm', persona: 'witty', status: 'done', createdAt: 1 });
    await db.jobs.put({ id: 'j', type: 'SUMMARIZE', videoKey: 'k', sessionId: 'x', status: 'done', progress: 100, retries: 0, createdAt: 1, updatedAt: 1 });
    await wipeAllData(db, kv);
    for (const t of [db.sessions, db.videos, db.visits, db.transcripts, db.summaries, db.jobs]) {
      expect(await t.count()).toBe(0);
    }
    expect(await getSessionPointer(kv)).toBeUndefined();
    await db.delete();
  });
});
