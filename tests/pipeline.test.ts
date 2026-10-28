// P1.3 · lib/pipeline 单测：入队幂等、SW 重启恢复（stale running 重排）、自动重试 ≤1、
// need_confirm 状态与 resume/retry、并发=1、stage/progress 落库、执行中被清除不复活。
import { describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { CompanionDB, type JobRow } from '../src/lib/storage';
import { Pipeline, type JobContext, type JobOutcome } from '../src/lib/pipeline';

const freshDb = (): CompanionDB => new CompanionDB(`test-${Math.random()}`, { indexedDB, IDBKeyRange });

const mkJob = (over: Partial<JobRow> = {}): JobRow => ({
  id: `j_${over.createdAt ?? 1}_xxxx`,
  type: 'SUMMARIZE',
  videoKey: 'BV1x:111',
  sessionId: 's',
  status: 'pending',
  progress: 0,
  retries: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function mkPipeline(execute: (job: JobRow, ctx: JobContext) => Promise<JobOutcome>) {
  const db = freshDb();
  const transitions: JobRow[] = [];
  const p = new Pipeline(db, { execute }, { onTransition: (j) => transitions.push(j) });
  return { db, p, transitions };
}

describe('enqueue 幂等', () => {
  it('同 videoKey+type 活动任务（pending/running/need_confirm）不重复建行', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    const a = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    const b = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    expect(b.id).toBe(a.id);
    expect(await db.jobs.count()).toBe(1);
    // need_confirm 也算活动：不重复
    await db.jobs.put({ ...a, status: 'need_confirm' });
    const c = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    expect(c.id).toBe(a.id);
    expect(await db.jobs.count()).toBe(1);
    // 不同 type / 不同 video 互不干扰
    await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: 'v', sessionId: 's' });
    await p.enqueue({ type: 'SUMMARIZE', videoKey: 'w', sessionId: 's' });
    expect(await db.jobs.count()).toBe(3);
    await db.delete();
  });

  it('done/failed 后可再入队（重新生成/手动重试走 retry()，按需再触发建新行）', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    const a = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    await db.jobs.put({ ...a, status: 'done' });
    const b = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    expect(b.id).not.toBe(a.id);
    await db.delete();
  });
});

describe('执行与终态', () => {
  it('空队列查询进行中入队，新任务仍会在本轮结束前执行', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    let release!: () => void;
    let markSnapshot!: () => void;
    const snapshotTaken = new Promise<void>(resolve => { markSnapshot = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(p, 'tick').mockImplementationOnce(async () => {
      const snapshot = await db.jobs.where('status').equals('pending').toArray();
      expect(snapshot).toHaveLength(0);
      markSnapshot();
      await gate;
      return false;
    });
    const draining = p.drain();
    await snapshotTaken;
    const job = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    await p.drain(); // 与后台入队后的普通启动请求相同
    release();
    await draining;
    expect((await db.jobs.get(job.id))?.status).toBe('done');
    await db.delete();
  });

  it('空队列查询进行中手动重试失败任务，重试不会被遗漏', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    await db.jobs.put(mkJob({ id: 'failed', status: 'failed', retries: 1 }));
    let release!: () => void;
    let markSnapshot!: () => void;
    const snapshotTaken = new Promise<void>(resolve => { markSnapshot = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(p, 'tick').mockImplementationOnce(async () => {
      const snapshot = await db.jobs.where('status').equals('pending').toArray();
      expect(snapshot).toHaveLength(0);
      markSnapshot();
      await gate;
      return false;
    });
    const draining = p.drain();
    await snapshotTaken;
    await p.retry('failed');
    await p.drain();
    release();
    await draining;
    expect((await db.jobs.get('failed'))?.status).toBe('done');
    await db.delete();
  });

  it('网络等待期间有新任务入队，也不立即重试等待中的任务', async () => {
    const db = freshDb();
    let online = false;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const p = new Pipeline(db, { execute: async job => {
      seen.push(job.videoKey);
      if (!online) { markStarted(); await gate; return { result: 'wait', error: { code: 'OFFLINE', msg: '离线' } }; }
      return { result: 'done' };
    } });
    const first = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'first', sessionId: 's' });
    const draining = p.drain();
    await started;
    const second = await p.enqueue({ type: 'SUMMARIZE', videoKey: 'second', sessionId: 's' });
    await p.drain();
    release();
    await draining;
    expect(seen).toEqual(['first']);
    expect((await db.jobs.get(first.id))?.status).toBe('pending');
    expect((await db.jobs.get(second.id))?.status).toBe('pending');
    online = true;
    await p.drain(true);
    expect(seen).toEqual(['first', 'first', 'second']);
    await db.delete();
  });

  it('恢复请求发生在旧执行尚未结束时，结束后仍会补跑', async () => {
    const db = freshDb();
    let calls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const p = new Pipeline(db, { execute: async () => {
      calls++;
      if (calls === 1) { markStarted(); await gate; return { result: 'wait', error: { code: 'PAUSED', msg: '暂停' } }; }
      return { result: 'done' };
    } });
    await db.jobs.put(mkJob({ id: 'a' }));
    const draining = p.drain();
    await started;
    await p.drain(true);
    release();
    await draining;
    expect(calls).toBe(2);
    expect((await db.jobs.get('a'))?.status).toBe('done');
    await db.delete();
  });

  it('普通列表刷新在执行中重入，不会让挂起任务立即多跑一轮', async () => {
    const db = freshDb();
    let calls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const p = new Pipeline(db, { execute: async () => { calls++; markStarted(); await gate; return { result: 'wait', error: { code: 'OFFLINE', msg: '离线' } }; } });
    await db.jobs.put(mkJob({ id: 'a' }));
    const draining = p.drain();
    await started;
    await p.drain();
    release();
    await draining;
    expect(calls).toBe(1);
    expect((await db.jobs.get('a'))?.status).toBe('pending');
    await db.delete();
  });
  it('暂停后不继续执行已排队任务，恢复后可继续', async () => {
    const db = freshDb();
    let allowed = true;
    const calls: string[] = [];
    const p = new Pipeline(db, { execute: async job => { calls.push(job.videoKey); allowed = false; return { result: 'done' }; } }, { canRun: async () => allowed });
    await db.jobs.put(mkJob({ id: 'a', videoKey: 'a', createdAt: 1 }));
    await db.jobs.put(mkJob({ id: 'b', videoKey: 'b', createdAt: 2 }));
    await p.drain();
    expect(calls).toEqual(['a']);
    expect((await db.jobs.get('b'))?.status).toBe('pending');
    allowed = true;
    await p.drain();
    expect(calls).toEqual(['a', 'b']);
    await db.delete();
  });
  it('done：progress 落到 100；stage/progress 更新持久化', async () => {
    const { db, p } = mkPipeline(async (job, ctx) => {
      await ctx.update({ stage: 'subtitle', progress: 30 });
      await ctx.update({ stage: 'llm_map', progress: 60 });
      return { result: 'done' };
    });
    await p.enqueue({ type: 'SUMMARIZE', videoKey: 'v', sessionId: 's' });
    await p.drain();
    const row = (await db.jobs.toArray())[0]!;
    expect(row.status).toBe('done');
    expect(row.progress).toBe(100);
    expect(row.stage).toBe('llm_map');
    await db.delete();
  });

  it('并发=1：两个任务串行执行（第二个等第一个 settle 后才开始）', async () => {
    const order: string[] = [];
    let release1!: () => void;
    const gate = new Promise<void>((r) => (release1 = r));
    const { db, p } = mkPipeline(async (job) => {
      order.push(`start:${job.videoKey}`);
      if (job.videoKey === 'v1') await gate; // v1 手动放行前不得开始 v2
      order.push(`end:${job.videoKey}`);
      return { result: 'done' };
    });
    await db.jobs.put(mkJob({ id: 'a', videoKey: 'v1', createdAt: 1 }));
    await db.jobs.put(mkJob({ id: 'b', videoKey: 'v2', createdAt: 2 }));
    const draining = p.drain();
    await new Promise((r) => setTimeout(r, 20)); // v1 已 start、被 gate 挡住
    expect(order).toEqual(['start:v1']);
    release1();
    await draining;
    expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2']);
    await db.delete();
  });
});

describe('自动重试 ≤1', () => {
  it('首败重排 pending（retries=1），次败终态 failed；不再第三次执行', async () => {
    let calls = 0;
    const { db, p } = mkPipeline(async () => {
      calls += 1;
      return { result: 'failed', error: { code: 'X', msg: '失败' } };
    });
    await db.jobs.put(mkJob({}));
    await p.drain();
    expect(calls).toBe(2);
    const row = (await db.jobs.toArray())[0]!;
    expect(row.status).toBe('failed');
    expect(row.retries).toBe(1);
    expect(row.error).toEqual({ code: 'X', msg: '失败' }); // 终态 error 落行：分段早退等不写注记路径的广播兜底数据源
    await db.delete();
  });

  it('executor 抛异常等同失败；首败重试后成功 → done', async () => {
    let calls = 0;
    const { db, p } = mkPipeline(async (job, ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('网络炸了');
      await ctx.update({ stage: 'llm_reduce', progress: 80 });
      return { result: 'done' };
    });
    await db.jobs.put(mkJob({}));
    await p.drain();
    expect(calls).toBe(2);
    const row = (await db.jobs.toArray())[0]!;
    expect(row).toMatchObject({ status: 'done', retries: 1, stage: 'llm_reduce' });
    await db.delete();
  });

  it('retry()：failed → pending 且 retries 归零（F11 手动重试）', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'failed', error: { code: 'X', msg: '' } }));
    await db.jobs.put(mkJob({ id: 'jx', retries: 1, status: 'failed' }));
    await p.retry('jx');
    let row = (await db.jobs.get('jx'))!;
    expect(row).toMatchObject({ status: 'pending', retries: 0 });
    await p.drain(); // 再次自动重试一次后终态 failed
    row = (await db.jobs.get('jx'))!;
    expect(row.status).toBe('failed');
    await db.delete();
  });

  it('error 只在 failed 终态随行：重排与 done 迁移清除旧 error（审查 P2-3）', async () => {
    let fail = true;
    const { db, p } = mkPipeline(async () =>
      fail ? { result: 'failed', error: { code: 'X', msg: 'x' } } : { result: 'done' },
    );
    await db.jobs.put(mkJob({ id: 'je', retries: 1, status: 'failed', error: { code: 'X', msg: 'x' } }));
    await p.retry('je');
    expect((await db.jobs.get('je'))!.error).toBeUndefined(); // 重排即清
    fail = false;
    await p.drain();
    const row = (await db.jobs.get('je'))!;
    expect(row.status).toBe('done');
    expect(row.error).toBeUndefined(); // done 行不带旧 error
    await db.delete();
  });
});

describe('need_confirm（need_asr，F6）', () => {
  it('无字幕轨 → need_confirm；resume() → pending 重跑', async () => {
    let sawConfirm = false;
    const { db, p } = mkPipeline(async (job) => {
      if (job.status === 'running' && !sawConfirm) {
        sawConfirm = true;
        return { result: 'need_confirm' };
      }
      return { result: 'done' };
    });
    await db.jobs.put(mkJob({ id: 'jc' }));
    await p.drain();
    expect((await db.jobs.get('jc'))!.status).toBe('need_confirm');
    // need_confirm 是终态之一：drain 不会继续消费它
    await p.drain();
    expect((await db.jobs.get('jc'))!.status).toBe('need_confirm');
    await p.resume('jc');
    expect((await db.jobs.get('jc'))!.status).toBe('pending');
    await p.drain();
    expect((await db.jobs.get('jc'))!.status).toBe('done');
    await db.delete();
  });
});

describe('SW 重启恢复', () => {
  it('两条队列忙于空查询时，恢复的摘要和分段任务均能继续执行', async () => {
    const db = freshDb();
    await db.jobs.put(mkJob({ id: 'main', type: 'SUMMARIZE', status: 'running' }));
    await db.jobs.put(mkJob({ id: 'segment', type: 'SEGMENT_ANALYZE', status: 'running', segIndex: 0 }));
    const main = new Pipeline(db, { execute: async () => ({ result: 'done' }) }, { lane: ['SUMMARIZE'] });
    const segment = new Pipeline(db, { execute: async () => ({ result: 'done' }) }, { lane: ['SEGMENT_ANALYZE'] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let markMain!: () => void;
    let markSegment!: () => void;
    const snapshots = [new Promise<void>(resolve => { markMain = resolve; }), new Promise<void>(resolve => { markSegment = resolve; })];
    for (const [queue, mark] of [[main, markMain], [segment, markSegment]] as const) {
      vi.spyOn(queue, 'tick').mockImplementationOnce(async () => {
        expect(await db.jobs.where('status').equals('pending').count()).toBe(0);
        mark();
        await gate;
        return false;
      });
    }
    const draining = [main.drain(), segment.drain()];
    await Promise.all(snapshots);
    expect(await main.recover()).toBe(2); // recover 恢复全部 lane
    await Promise.all([main.drain(true), segment.drain(true)]);
    release();
    await Promise.all(draining);
    expect((await db.jobs.get('main'))?.status).toBe('done');
    expect((await db.jobs.get('segment'))?.status).toBe('done');
    await db.delete();
  });

  it('显式恢复后仍离线时只补跑一次，不会热循环', async () => {
    const db = freshDb();
    let calls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const p = new Pipeline(db, { execute: async () => {
      calls++;
      if (calls === 1) { markStarted(); await gate; }
      return { result: 'wait', error: { code: 'OFFLINE', msg: '离线' } };
    } });
    await db.jobs.put(mkJob({ id: 'waiting' }));
    const draining = p.drain();
    await started;
    await p.drain(true);
    release();
    await draining;
    expect(calls).toBe(2);
    expect((await db.jobs.get('waiting'))?.status).toBe('pending');
    await db.delete();
  });

  it('stale running 重排 pending，新 Pipeline 实例（模拟 SW 重启）可继续消费', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    await db.jobs.put(mkJob({ id: 'r1', status: 'running' }));
    await db.jobs.put(mkJob({ id: 'r2', status: 'pending', createdAt: 2 }));
    await db.jobs.put(mkJob({ id: 'r3', status: 'done', createdAt: 3 }));

    // 模拟重启：全新 Pipeline（新 handlers/内存），只做 recover + drain
    const p2 = new Pipeline(db, { execute: async () => ({ result: 'done' }) });
    expect(await p2.recover()).toBe(1);
    expect((await db.jobs.get('r1'))!.status).toBe('pending');
    await p2.drain();
    for (const id of ['r1', 'r2']) expect((await db.jobs.get(id))!.status, id).toBe('done');
    expect((await db.jobs.get('r3'))!.status).toBe('done'); // done 不动
    void p;
    await db.delete();
  });
});

describe('执行中被清除（F10 wipe）不复活', () => {
  it('executor 运行中行被删：终态不写回、无垃圾行', async () => {
    const { db, p } = mkPipeline(async (_job, ctx) => {
      await db.jobs.clear(); // 模拟清除事务
      await ctx.update({ progress: 50 }); // 应静默 no-op
      return { result: 'done' };
    });
    await db.jobs.put(mkJob({ id: 'w1' }));
    await p.drain();
    expect(await db.jobs.count()).toBe(0);
    await db.delete();
  });
});

describe('P2.3 审查 P2-4：ASR_SUMMARIZE 失败不自动重排', () => {
  it('failed 的 ASR job 直落终态（重试=重新下载+转写计费，须用户显式发起）', async () => {
    const db = freshDb();
    const q = new Pipeline(db, {
      execute: async () => ({ result: 'failed', error: { code: 'ASR_HTTP', msg: 'x' } }),
    });
    const j = await q.enqueue({ type: 'ASR_SUMMARIZE', videoKey: 'BV1x:1', sessionId: 's' });
    await q.drain();
    const row = await db.jobs.get(j.id);
    expect(row?.status).toBe('failed'); // 不回 pending
    expect(row?.retries).toBe(0);
    await db.delete();
  });
  it('SUMMARIZE 失败仍自动重试一次（对照组，行为不变）', async () => {
    const db = freshDb();
    let n = 0;
    const q = new Pipeline(db, {
      execute: async () => {
        n += 1;
        return n === 1 ? { result: 'failed', error: { code: 'X', msg: 'x' } } : { result: 'done' };
      },
    });
    const j = await q.enqueue({ type: 'SUMMARIZE', videoKey: 'BV1x:1', sessionId: 's' });
    await q.drain();
    expect(n).toBe(2);
    expect((await db.jobs.get(j.id))?.status).toBe('done');
    await db.delete();
  });
});

describe('F13 双通道 lane + prio 优先级', () => {
  it('保留等待中的自动摘要时，后面的手动重生成仍可执行', async () => {
    const db = freshDb();
    const p = new Pipeline(db, { execute: async () => ({ result: 'done' }) }, {
      lane: ['SUMMARIZE', 'REGENERATE'], canRun: async job => job.type !== 'SUMMARIZE',
    });
    await db.jobs.put(mkJob({ id: 'automatic', type: 'SUMMARIZE', videoKey: 'a', createdAt: 1 }));
    await db.jobs.put(mkJob({ id: 'manual', type: 'REGENERATE', videoKey: 'b', createdAt: 2 }));
    await p.drain();
    expect((await db.jobs.get('automatic'))?.status).toBe('pending');
    expect((await db.jobs.get('manual'))?.status).toBe('done');
    await db.delete();
  });
  it('lane 过滤：主链只取摘要类，交互链只取 SEGMENT_ANALYZE（互不越界）', async () => {
    const db = freshDb();
    const mainSeen: string[] = [];
    const segSeen: string[] = [];
    const main = new Pipeline(
      db,
      {
        execute: async (job) => {
          mainSeen.push(job.type);
          return { result: 'done' };
        },
      },
      { lane: ['SUMMARIZE', 'ASR_SUMMARIZE', 'REGENERATE'] },
    );
    const seg = new Pipeline(
      db,
      {
        execute: async (job) => {
          segSeen.push(job.type);
          return { result: 'done' };
        },
      },
      { lane: ['SEGMENT_ANALYZE'] },
    );
    await db.jobs.put(mkJob({ id: 'm', type: 'SUMMARIZE', videoKey: 'a', createdAt: 1 }));
    await db.jobs.put(mkJob({ id: 's', type: 'SEGMENT_ANALYZE', videoKey: 'a', segIndex: 0, createdAt: 2 }));
    await main.drain();
    await seg.drain();
    expect(mainSeen).toEqual(['SUMMARIZE']); // 主链没碰分段
    expect(segSeen).toEqual(['SEGMENT_ANALYZE']); // 交互链只跑分段
    expect((await db.jobs.get('m'))?.status).toBe('done');
    expect((await db.jobs.get('s'))?.status).toBe('done');
    await db.delete();
  });

  it('同通道内 prio 压 createdAt：用户任务(0)先于更早的预取任务(1)', async () => {
    const db = freshDb();
    const order: string[] = [];
    const p = new Pipeline(
      db,
      {
        execute: async (job) => {
          order.push(job.id);
          return { result: 'done' };
        },
      },
      { lane: ['SEGMENT_ANALYZE'] },
    );
    // 预取任务 prio=1 先入队（createdAt 更小）；用户点击 prio=0 后入队 → 应插队先跑
    await db.jobs.put(mkJob({ id: 'prefetch', type: 'SEGMENT_ANALYZE', videoKey: 'a', segIndex: 1, prio: 1, createdAt: 1 }));
    await db.jobs.put(mkJob({ id: 'user', type: 'SEGMENT_ANALYZE', videoKey: 'a', segIndex: 2, prio: 0, createdAt: 5 }));
    await p.drain();
    expect(order).toEqual(['user', 'prefetch']);
    await db.delete();
  });

  it('enqueue 落 prio：仅非零写列（0/缺省不落，省存储）', async () => {
    const { db, p } = mkPipeline(async () => ({ result: 'done' }));
    const a = await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: 'a', sessionId: 's', segIndex: 0, prio: 1 });
    const b = await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: 'b', sessionId: 's', segIndex: 0, prio: 0 });
    expect(a.prio).toBe(1);
    expect(b.prio).toBeUndefined();
    await db.delete();
  });

  it('recover 跨通道：stale running 一律重排 pending（不分 lane）', async () => {
    const db = freshDb();
    await db.jobs.put(mkJob({ id: 'r1', type: 'SUMMARIZE', status: 'running' }));
    await db.jobs.put(mkJob({ id: 'r2', type: 'SEGMENT_ANALYZE', segIndex: 0, status: 'running' }));
    const p = new Pipeline(db, { execute: async () => ({ result: 'done' }) }, { lane: ['SUMMARIZE'] });
    const n = await p.recover();
    expect(n).toBe(2); // 两条 stale running 都回 pending（recover 不按 lane 过滤，重启自愈全量）
    expect((await db.jobs.get('r2'))?.status).toBe('pending');
    await db.delete();
  });
});
