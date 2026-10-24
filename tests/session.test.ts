// P2.1 · lib/session 单测：evaluateRetention 状态机（±1min 边界，F10）、applyRetention 写回、retainUntil。
import { describe, expect, it } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import {
  CompanionDB,
  getSessionPointer,
  setSessionPointer,
  type KVStore,
  type SessionPointer,
} from '../src/lib/storage';
import {
  RETENTION_MS,
  applyRetention,
  evaluateRetention,
  retainUntilOf,
  sessionStartBlockedReason,
} from '../src/lib/session';

const freshDb = (): CompanionDB => new CompanionDB(`test-${Math.random()}`, { indexedDB, IDBKeyRange });

const memKv = (): KVStore & { snapshot: () => Record<string, unknown> } => {
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
    snapshot: () => Object.fromEntries(m),
  };
};

const base = { sessionId: 's_1_a', startedAt: 1, lastActiveAt: 1 };
const T0 = 1_700_000_000_000; // 固定基准，边界判定不依赖现实时钟

describe('sessionStartBlockedReason（SESSION_START 闸门，审查 P2-7）', () => {
  it('EXPIRED_PENDING_CONFIRM / CLOSED → 拦截（旧数据须先经 2.2 确认链路处置）', () => {
    expect(
      sessionStartBlockedReason({ ...base, state: 'EXPIRED_PENDING_CONFIRM', closedAt: T0, lastActiveAt: T0 }),
    ).toBe('EXPIRED_CONFIRM');
    expect(sessionStartBlockedReason({ ...base, state: 'CLOSED', closedAt: T0, lastActiveAt: T0 })).toBe('CLOSED');
  });
  it('无 pointer / ACTIVE / GRACE → 可开（新会话或恢复）', () => {
    expect(sessionStartBlockedReason(undefined)).toBeNull();
    expect(sessionStartBlockedReason({ ...base, state: 'ACTIVE', lastActiveAt: T0 })).toBeNull();
    expect(
      sessionStartBlockedReason({ ...base, state: 'GRACE', closedAt: T0 - 30 * 60_000, lastActiveAt: T0 }),
    ).toBeNull();
  });
});

describe('evaluateRetention（02-数据模型 §6）', () => {
  it('无 pointer / INACTIVE → FRESH', () => {
    expect(evaluateRetention(undefined, T0)).toEqual({ kind: 'FRESH' });
    expect(evaluateRetention({ ...base, state: 'INACTIVE', lastActiveAt: T0 }, T0)).toEqual({ kind: 'FRESH' });
  });

  it('ACTIVE → RESTORE（浏览器重开恢复会话，无 1h 约束）', () => {
    const p: SessionPointer = { ...base, state: 'ACTIVE', startedAt: T0 - 10 * 3600_000, lastActiveAt: T0 - 10 * 3600_000 };
    expect(evaluateRetention(p, T0)).toEqual({ kind: 'RESTORE' });
  });

  it('GRACE 59min / 恰满 1h → RESTORE（≤ 边界，F10「误差 ≤1min」）', () => {
    const closedAt = T0 - 59 * 60_000;
    expect(evaluateRetention({ ...base, state: 'GRACE', closedAt, lastActiveAt: closedAt }, T0)).toEqual({ kind: 'RESTORE' });
    const exact = T0 - RETENTION_MS; // now - closedAt === 1h
    expect(evaluateRetention({ ...base, state: 'GRACE', closedAt: exact, lastActiveAt: exact }, T0)).toEqual({ kind: 'RESTORE' });
  });

  it('GRACE 1h+1ms / 2h → EXPIRE（写回 EXPIRED_PENDING_CONFIRM）', () => {
    const closedAt = T0 - RETENTION_MS - 1;
    const v = evaluateRetention({ ...base, state: 'GRACE', closedAt, lastActiveAt: closedAt }, T0);
    expect(v.kind).toBe('EXPIRE');
    if (v.kind === 'EXPIRE') {
      expect(v.pointer.state).toBe('EXPIRED_PENDING_CONFIRM');
      expect(v.pointer.sessionId).toBe('s_1_a');
      expect(v.pointer.closedAt).toBe(closedAt); // 基准不变：重提醒/清除判定仍以原 closedAt 为准
      expect(v.pointer.lastActiveAt).toBe(T0);
    }
    const two = evaluateRetention({ ...base, state: 'GRACE', closedAt: T0 - 2 * 3600_000, lastActiveAt: T0 }, T0);
    expect(two.kind).toBe('EXPIRE');
  });

  it('GRACE 缺 closedAt（脏数据）→ RESTORE 不判超期', () => {
    expect(evaluateRetention({ ...base, state: 'GRACE', lastActiveAt: T0 }, T0)).toEqual({ kind: 'RESTORE' });
  });

  it('EXPIRED_PENDING_CONFIRM / CLOSED → HOLD（维持现状，重提醒属 2.2 面板）', () => {
    expect(evaluateRetention({ ...base, state: 'EXPIRED_PENDING_CONFIRM', closedAt: T0 - 2 * 3600_000, lastActiveAt: T0 }, T0)).toEqual({ kind: 'HOLD' });
    expect(evaluateRetention({ ...base, state: 'CLOSED', closedAt: T0, lastActiveAt: T0 }, T0)).toEqual({ kind: 'HOLD' });
  });
});

describe('retainUntilOf', () => {
  it('closedAt + 1h；无 closedAt → undefined', () => {
    expect(retainUntilOf({ ...base, state: 'GRACE', closedAt: 1000, lastActiveAt: 1000 })).toBe(1000 + RETENTION_MS);
    expect(retainUntilOf({ ...base, state: 'ACTIVE', lastActiveAt: 1 })).toBeUndefined();
  });
});

describe('applyRetention（SW 侧写回）', () => {
  it('超期 → pointer 与 sessions 行均置 EXPIRED_PENDING_CONFIRM（幂等）', async () => {
    const db = freshDb();
    const kv = memKv();
    const closedAt = T0 - 2 * 3600_000;
    await db.sessions.put({ id: 's_1_a', state: 'GRACE', startedAt: 1, closedAt, lastActiveAt: closedAt });
    await setSessionPointer(kv, { sessionId: 's_1_a', state: 'GRACE', closedAt, lastActiveAt: closedAt });

    const r1 = await applyRetention(db, kv, T0);
    expect(r1.verdict.kind).toBe('EXPIRE');
    expect(r1.pointer?.state).toBe('EXPIRED_PENDING_CONFIRM');
    expect((await getSessionPointer(kv))?.state).toBe('EXPIRED_PENDING_CONFIRM');
    const row = await db.sessions.get('s_1_a');
    expect(row?.state).toBe('EXPIRED_PENDING_CONFIRM');
    expect(row?.lastActiveAt).toBe(T0); // 审查 P2-4：审计行与 pointer.lastActiveAt 同步

    // 幂等：再判一次 → HOLD，无新写入
    const r2 = await applyRetention(db, kv, T0 + 1000);
    expect(r2.verdict.kind).toBe('HOLD');
    expect((await getSessionPointer(kv))?.lastActiveAt).toBe(T0); // 未被二次触碰

    // 数据未删：visits 行仍在（删除只经 2.2 确认链路）
    await db.visits.add({ sessionId: 's_1_a', videoKey: 'BV1x:1', firstSeenAt: 1, lastSeenAt: 1, watchedSeconds: 0, progressPct: 0, triggered: 0 });
    await applyRetention(db, kv, T0 + 2000);
    expect(await db.visits.count()).toBe(1);
    await db.delete();
  });

  it('未超期 → RESTORE，pointer 原样返回', async () => {
    const db = freshDb();
    const kv = memKv();
    const closedAt = T0 - 30 * 60_000;
    const p: SessionPointer = { sessionId: 's_1_b', state: 'GRACE', closedAt, lastActiveAt: closedAt };
    await setSessionPointer(kv, p);
    const r = await applyRetention(db, kv, T0);
    expect(r.verdict.kind).toBe('RESTORE');
    expect(await getSessionPointer(kv)).toEqual(p);
    await db.delete();
  });

  it('无 pointer → FRESH', async () => {
    const db = freshDb();
    const kv = memKv();
    const r = await applyRetention(db, kv, T0);
    expect(r.verdict.kind).toBe('FRESH');
    expect(r.pointer).toBeUndefined();
    await db.delete();
  });
});
