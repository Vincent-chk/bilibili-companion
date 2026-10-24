// P1.3 · lib/pipeline 单测：入队幂等、SW 重启恢复（stale running 重排）、自动重试 ≤1、
// need_confirm 状态与 resume/retry、并发=1、stage/progress 落库、执行中被清除不复活。
import { describe, expect, it } from 'vitest';
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
