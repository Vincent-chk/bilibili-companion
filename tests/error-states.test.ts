// P2.6 · 错误态单测：跨请求 -412 熔断门禁（F11）/ mapLlmError -412 映射 /
// 字幕结构变化降级归一化（F11）/ pipeline 网络挂起 wait（不烧重试不轰炸，恢复续跑）。
import { describe, expect, it } from 'vitest';
import { BiliClient, BiliApiError } from '../src/lib/bilibili/client';
import { normalizeCues } from '../src/lib/bilibili/track';
import { mapLlmError } from '../src/lib/summarize/chain';
import { LlmHttpError } from '../src/lib/llm/client';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { CompanionDB, type JobRow } from '../src/lib/storage';
import { Pipeline, type JobContext, type JobOutcome } from '../src/lib/pipeline';

const freshDb = (): CompanionDB => new CompanionDB(`test-err-${Math.random()}`, { indexedDB, IDBKeyRange });

function mkPipeline(execute: (job: JobRow, ctx: JobContext) => Promise<JobOutcome>) {
  const db = freshDb();
  const p = new Pipeline(db, { execute });
  return { db, p };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('P2.6 · -412 跨请求熔断门禁（F11：60s 内不再请求，恢复自动续）', () => {
  it('字幕 CDN 的 HTTP 412 同样报告共享风控并阻止后续请求', async () => {
    let riskHits = 0;
    let calls = 0;
    const client = new BiliClient({ intervalMs: 0, breakerWaitMs: 60_000, onRiskControl: async () => { riskHits++; }, fetchImpl: async () => { calls++; return new Response('', { status: 412 }); } });
    await expect(client.fetchTranscript('https://i0.hdslb.com/test.json')).rejects.toMatchObject({ code: -412 });
    expect(riskHits).toBe(1);
    await expect(client.getView('BV1x')).rejects.toBeInstanceOf(BiliApiError);
    expect(calls).toBe(1);
  });
  it('不同客户端通过共享请求门禁共同遵守风控冷却', async () => {
    let blocked = false;
    let secondCalls = 0;
    const shared = {
      beforeRequest: async () => { if (blocked) throw new BiliApiError(-412, 'shared', '风控熔断中'); },
      onRiskControl: async () => { blocked = true; },
    };
    const a = new BiliClient({ ...shared, intervalMs: 0, breakerWaitMs: 0, fetchImpl: async () => jsonResponse({ code: -412 }) });
    const b = new BiliClient({ ...shared, intervalMs: 0, breakerWaitMs: 0, fetchImpl: async () => { secondCalls++; return jsonResponse({ code: 0, data: { aid: 1, title: 'x', duration: 1 } }); } });
    await expect(a.getView('BV1x')).rejects.toBeInstanceOf(BiliApiError);
    await expect(b.getView('BV1y')).rejects.toThrow('风控熔断中');
    expect(secondCalls).toBe(0);
    blocked = false;
    await expect(b.getView('BV1y')).resolves.toMatchObject({ title: 'x' });
    expect(secondCalls).toBe(1);
  });
  // 真实 sleep=breakerWaitMs（保持小值快速）；熔断门禁时钟用注入的 fake now（冻结/步进可控）
  const makeClient = (fetchImpl: (url: string) => Promise<Response>, nowRef: { t: number }) =>
    new BiliClient({ fetchImpl, intervalMs: 0, breakerWaitMs: 30, now: () => nowRef.t });

  it('首个 -412 请求重试一次仍败 → 抛错；冷却窗内后续请求零网络即刻拒绝', async () => {
    let calls = 0;
    const nowRef = { t: 1000 };
    const client = makeClient(() => {
      calls += 1;
      return Promise.resolve(jsonResponse({ code: -412 }, 200));
    }, nowRef);
    await expect(client.getView('BV1xx')).rejects.toBeInstanceOf(BiliApiError); // 尝试1 -412→熔断等待→尝试2 -412→抛
    expect(calls).toBe(2);
    expect(nowRef.t).toBe(1000); // fake 时钟不动：真实 sleep 过了，但门禁看 fake now
    // 冷却窗内（1000 < blockedUntil=1030）：另一请求零网络、立即拒
    nowRef.t += 10;
    const callsBefore = calls;
    await expect(client.fetchWbiKeys()).rejects.toThrow('风控熔断中');
    expect(calls).toBe(callsBefore); // 门禁拒绝，无任何新网络请求
  });

  it('冷却期满（now ≥ blockedUntil）→ 自动放行恢复请求', async () => {
    let calls = 0;
    const nowRef = { t: 0 };
    const client = makeClient(() => {
      calls += 1;
      return Promise.resolve(calls <= 2 ? jsonResponse({ code: -412 }) : jsonResponse({ code: 0, data: { wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }));
    }, nowRef);
    await expect(client.fetchWbiKeys()).rejects.toBeInstanceOf(BiliApiError);
    nowRef.t += 100; // 冷却结束（>30ms 窗）
    await expect(client.fetchWbiKeys()).resolves.toBeTruthy();
    expect(calls).toBe(3);
  });

  it('loginClient 短熔断实例同受门禁保护（-412→null 未知态不误报未登录）', async () => {
    let calls = 0;
    const nowRef = { t: 0 };
    const client = new BiliClient({
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ code: -412 }));
      },
      intervalMs: 0,
      breakerWaitMs: 1500,
      now: () => nowRef.t,
    });
    expect(await client.checkLogin()).toBeNull();
    nowRef.t += 100; // 仍在 1.5s 冷却内
    const before = calls;
    expect(await client.checkLogin()).toBeNull();
    expect(calls).toBe(before); // 门禁拒绝=零请求
  });
});

describe('P2.6 · mapLlmError：-412 → RISK_CONTROL（可读文案，不再落 UNKNOWN）', () => {
  it('BiliApiError(-412) 映射 RISK_CONTROL，说明冷却后自动恢复', () => {
    const r = mapLlmError(new BiliApiError(-412, '/x/player/wbi/v2'));
    expect(r.code).toBe('RISK_CONTROL');
    expect(r.msg).toContain('风控');
    expect(r.msg).toContain('自动恢复');
  });
  it('401 → KEY_INVALID 不受影响（回归）', () => {
    const r = mapLlmError(new LlmHttpError(401, 'denied'));
    expect(r.code).toBe('KEY_INVALID');
  });
});

describe('P2.6 · 字幕结构变化降级（normalizeCues，F11）', () => {
  it('空白字幕不作为有效文字，备用文本有效时仍应保留', () => {
    expect(normalizeCues([
      { from: 0, to: 1, content: ' \n\t' },
      { from: 1, to: 2, content: '　', text: '备用文字' },
      { from: 2, to: 3, content: ' 正文 ' },
    ])).toEqual([
      { from: 1, to: 2, content: '备用文字' },
      { from: 2, to: 3, content: ' 正文 ' },
    ]);
  });
  it('规范形状 {from,to,content} 原样通过', () => {
    expect(normalizeCues([{ from: 0, to: 2, content: '你好' }])).toEqual([{ from: 0, to: 2, content: '你好' }]);
  });
  it('变体字段 {start,end,text} 与数值字符串容错', () => {
    expect(normalizeCues([{ start: '1.5', end: '3', text: '变体' }])).toEqual([{ from: 1.5, to: 3, content: '变体' }]);
  });
  it('缺失 to 回退 from；缺文本行剔除；非对象行剔除', () => {
    expect(normalizeCues([{ from: 5, content: '无to' }, { from: 1, to: 2 }, '噪声', null])).toEqual([{ from: 5, to: 5, content: '无to' }]);
  });
  it('body 非数组 / 空数组 → []（走 chain 既有 empty→NO_CONTENT 明确失败，不炸 UNKNOWN）', () => {
    expect(normalizeCues(undefined)).toEqual([]);
    expect(normalizeCues({ body: [] })).toEqual([]);
    expect(normalizeCues('oops')).toEqual([]);
  });
});

describe('P2.6 · pipeline wait（断网挂起续跑，F11）', () => {
  it('wait → 回 pending 不烧重试不落 failed 且静默（无 onTransition 广播=审查 P1-1 热循环回归锚）', async () => {
    const transitions: string[] = [];
    const db = freshDb();
    const p = new Pipeline(db, { execute: async () => ({ result: 'wait', error: { code: 'LLM_NETWORK', msg: 'x' } }) }, { onTransition: (j) => transitions.push(j.status) });
    await p.enqueue({ type: 'SUMMARIZE', videoKey: 'BV1:1', sessionId: 's' });
    await p.drain();
    const job = (await db.jobs.toArray())[0]!;
    expect(job.status).toBe('pending');
    expect(job.retries).toBe(0);
    expect(job.error).toBeUndefined(); // 非 failed 不带错误（#set 收口）
    expect(transitions).toEqual(['pending', 'running']); // 无第二次 pending——SUMMARY_UPDATED 不外溢
  });

  it('恢复后同一 pending 可正常执行到 done（wait 不损坏队列语义）', async () => {
    let n = 0;
    const { db, p } = mkPipeline(async () => {
      n += 1;
      return n === 1 ? ({ result: 'wait', error: { code: 'LLM_NETWORK', msg: 'x' } } as const) : ({ result: 'done' } as const);
    });
    await p.enqueue({ type: 'SUMMARIZE', videoKey: 'BV1:1', sessionId: 's' });
    await p.drain(); // 第一轮 wait 挂起
    await p.drain(); // 网络恢复后续跑
    expect((await db.jobs.toArray())[0]!.status).toBe('done');
    expect(n).toBe(2);
  });
});
