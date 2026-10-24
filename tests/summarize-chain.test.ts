// P1.4 · 摘要全链集成测试（fake-indexeddb + fake BiliApi + mock SSE LLM）：
// 缓存幂等（摘要命中零请求 / 字幕命中免抓取）、无轨→need_asr、LLM 错误映射、
// 长字幕走 Map-Reduce、videos 行兜底、进度 stage 顺序。
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { startMockLlm, validSummaryJson, type MockLlmServer } from './helpers/mock-llm';
import { runSummarizeJob, parseVideoKey, mapLlmError, type BiliApi } from '../src/lib/summarize/chain';
import { LlmHttpError } from '../src/lib/llm/client';
import { BiliApiError } from '../src/lib/bilibili/client';
import { CompanionDB, summaryKey } from '../src/lib/storage';
import type { JobStage } from '../src/lib/storage';

const servers: MockLlmServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const freshDb = (): CompanionDB => new CompanionDB(`test-${Math.random()}`, { indexedDB, IDBKeyRange });

const VIDEO_KEY = 'BV1XynB6EEiM:123456';

interface FakeBiliOpts {
  subtitles?: { lan: string; subtitle_url?: string }[];
  cues?: { from: number; to: number; content: string }[];
}

function fakeBili(opts: FakeBiliOpts) {
  const calls: string[] = [];
  const api: BiliApi & { calls: string[] } = {
    calls,
    async fetchWbiKeys() {
      calls.push('wbi');
      return 'mock-mixin-key';
    },
    async getView() {
      calls.push('view');
      return {
        aid: 1,
        cid: 123456,
        title: '测试视频',
        cover: 'c',
        owner: 'up',
        duration: 600,
        pages: [{ cid: 123456, page: 1, part: 'p1', duration: 600 }],
      };
    },
    async getPlayerSubtitles() {
      calls.push('player');
      return { subtitles: opts.subtitles ?? [{ lan: 'ai-zh', subtitle_url: '//aisubtitle.hdslb.com/x.json' }], needLoginSubtitle: null };
    },
    async fetchTranscript() {
      calls.push('subtitle');
      return opts.cues ?? Array.from({ length: 40 }, (_, i) => ({ from: i * 15, to: i * 15 + 14, content: `第${i}句解说词内容示例` }));
    },
  };
  return api;
}

const ctxLog = () => {
  const stages: JobStage[] = [];
  const progress: number[] = [];
  return {
    stages,
    progress,
    ctx: {
      update: async (patch: { stage?: JobStage; progress?: number }) => {
        if (patch.stage) stages.push(patch.stage);
        if (patch.progress !== undefined) progress.push(patch.progress);
      },
    },
  };
};

describe('parseVideoKey / mapLlmError', () => {
  it('拆 bvid:cid；非法格式抛错', () => {
    expect(parseVideoKey('BV1x:42')).toEqual({ bvid: 'BV1x', cid: 42 });
    expect(() => parseVideoKey('nodash')).toThrow();
    expect(() => parseVideoKey(':123')).toThrow();
  });
  it('LLM 错误映射：401→KEY_INVALID、429→RATE_LIMITED、网络→LLM_NETWORK', () => {
    expect(mapLlmError(new LlmHttpError(401, 'Unauthorized')).code).toBe('KEY_INVALID');
    expect(mapLlmError(new LlmHttpError(429, 'rate')).code).toBe('RATE_LIMITED');
    expect(mapLlmError(new Error('x')).code).toBe('UNKNOWN');
  });
  it('P1.10：B 站 -101/-352 → NEED_LOGIN（F11 失败原因「需要登录」，自动恢复按此码重排）', () => {
    const a = mapLlmError(new BiliApiError(-101, '/x/player/wbi/v2'));
    expect(a.code).toBe('NEED_LOGIN');
    expect(a.msg).toContain('登录');
    expect(mapLlmError(new BiliApiError(-352, '/x/web-interface/nav')).code).toBe('NEED_LOGIN');
    expect(mapLlmError(new BiliApiError(-412, '/x/player/wbi/v2')).code).not.toBe('NEED_LOGIN');
  });
});

describe('runSummarizeJob 全链', () => {
  it('字幕链路：选轨→字幕归一落库→单趟 LLM→summaries done；进度 stage 有序', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '测试视频',
      cover: 'c', owner: 'up', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const bili = fakeBili({});
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const { ctx, stages } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' }, persona: 'gentle' },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(outcome).toEqual({ result: 'done' });
    expect(bili.calls).toEqual(['wbi', 'player', 'subtitle']); // 有 videos 行，无需 view
    expect(stages).toEqual(['subtitle', 'llm_map', 'llm_reduce']);
    const srow = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(srow?.status).toBe('done');
    expect(srow?.source).toBe('ai_sub'); // ai-zh 轨
    expect(srow?.persona).toBe('gentle');
    expect(srow?.rating).toBe(4);
    expect(srow?.outline).toHaveLength(8);
    const trow = await db.transcripts.get(VIDEO_KEY);
    expect(trow?.cues[0]).toEqual({ from: 0, to: 14, text: '第0句解说词内容示例' }); // content→text 归一
    expect(trow?.charCount).toBeGreaterThan(0);
    await db.delete();
  });

  it('字幕缓存 24h 命中：不调 player/subtitle；重复跑摘要缓存命中：零 LLM 请求（F5）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({});
    const deps = { db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } } as const;
    const { ctx } = ctxLog();
    expect(await runSummarizeJob(deps, { videoKey: VIDEO_KEY }, ctx)).toEqual({ result: 'done' });
    expect(server.calls).toHaveLength(1);
    expect(bili.calls).toEqual(['wbi', 'player', 'subtitle']);
    // 第二跑：字幕已缓存（无 player/subtitle）+ 摘要已 done（无 LLM）
    bili.calls.length = 0;
    expect(await runSummarizeJob(deps, { videoKey: VIDEO_KEY }, ctx)).toEqual({ result: 'done' });
    expect(server.calls).toHaveLength(1); // 未新增
    expect(bili.calls).toEqual([]);
    await db.delete();
  });

  it('人工中文字幕优先（manual_sub 徽章）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({ subtitles: [{ lan: 'ai-zh', subtitle_url: '//x/ai.json' }, { lan: 'zh-CN', subtitle_url: '//x/manual.json' }] });
    const { ctx } = ctxLog();
    await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    const srow = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(srow?.source).toBe('manual_sub');
    expect((await db.transcripts.get(VIDEO_KEY))?.lan).toBe('zh-CN');
    await db.delete();
  });

  it('无字幕轨 → need_confirm + summaries.status=need_asr，零 LLM 请求', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({ subtitles: [{ lan: 'ai-zh' }] }); // 有轨无 url=不可用
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome).toEqual({ result: 'need_confirm' });
    expect(server.calls).toHaveLength(0);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.status).toBe('need_asr');
    await db.delete();
  });

  it('LLM 401 → failed + KEY_INVALID 落 summaries.error（脱敏可读）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ status: 401 }));
    servers.push(server);
    const bili = fakeBili({});
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome.result).toBe('failed');
    if (outcome.result === 'failed') expect(outcome.error.code).toBe('KEY_INVALID');
    const srow = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(srow?.status).toBe('failed');
    expect(srow?.error?.code).toBe('KEY_INVALID');
    await db.delete();
  });

  it('videos 行缺失 → 兜底 view 拉取落库（pickPage P1）', async () => {
    const db = freshDb();
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({});
    const { ctx } = ctxLog();
    await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(bili.calls[0]).toBe('view');
    const vrow = await db.videos.get(VIDEO_KEY);
    expect(vrow?.title).toBe('测试视频');
    expect(vrow?.duration).toBe(600); // 单 P duration（非顶层和）
    await db.delete();
  });

  it('长字幕（>14400 字）走 Map-Reduce：map 请求 ≥2、reduce 1，摘要仍过校验', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 7200, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm((call) => {
      if (call.body.messages?.[0]?.content.includes('字幕片段分析器')) {
        return { chunks: ['[00:00] 要点甲\n[30:00] 要点乙\n[60:00] 要点丙'] };
      }
      return { chunks: [validSummaryJson()] };
    });
    servers.push(server);
    const longCues = Array.from({ length: 40 }, (_, i) => ({ from: i * 180, to: i * 180 + 179, content: `第${i}段：` + '超长解说内容'.repeat(60) }));
    const bili = fakeBili({ cues: longCues });
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome).toEqual({ result: 'done' });
    const mapCalls = server.calls.filter((c) => c.body.messages?.[0]?.content.includes('字幕片段分析器')).length;
    expect(mapCalls).toBeGreaterThanOrEqual(2);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.status).toBe('done');
    await db.delete();
  });

  it('换 model 重生成：key 不同→重新跑 LLM（F7 前置）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({});
    const { ctx } = ctxLog();
    await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(server.calls).toHaveLength(1);
    await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm2', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(server.calls).toHaveLength(2); // m2 是新 key → 重跑（字幕已缓存，无 player/subtitle）
    expect(await db.summaries.get(summaryKey(VIDEO_KEY, 'm2'))).toBeDefined();
    expect(bili.calls).toEqual(['wbi', 'player', 'subtitle']); // 字幕仅首跑抓取
    await db.delete();
  });

  it('LLM 两轮非法 JSON → 降级纯文本落库（status=done、outline 空、summary≤600字，F5）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: ['这是一段纯文本回复，不是 JSON，也没有花括号。'] }));
    servers.push(server);
    const bili = fakeBili({});
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome).toEqual({ result: 'done' });
    const srow = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(srow?.status).toBe('done'); // 降级是兜底成功路径，不白屏
    expect(srow?.outline).toEqual([]);
    expect(srow?.summary).toContain('纯文本回复');
    expect(srow!.summary.length).toBeLessThanOrEqual(600);
    expect(server.calls).toHaveLength(2); // 修复重发 1 次
    await db.delete();
  });

  it('字幕轨存在但 cues 为空 → failed + NO_CONTENT', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const bili = fakeBili({ cues: [] });
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome.result).toBe('failed');
    if (outcome.result === 'failed') expect(outcome.error.code).toBe('NO_CONTENT');
    expect(server.calls).toHaveLength(0); // 零 LLM
    await db.delete();
  });
});

describe('timeoutMs 透传（POC_LLM_TIMEOUT_MS → resolveConfig → offscreen → chain）', () => {
  it('deps.timeoutMs=30 + 服务器不响应 → failed(LLM_NETWORK 超时)，不再吃 60s 缺省', async () => {
    const srv = http.createServer(() => {
      /* 收下请求但永不响应 */
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const db = freshDb();
      await db.videos.put({
        key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '测试视频',
        cover: 'c', owner: 'up', duration: 600, page: 1, fetchedAt: Date.now(),
      });
      const { ctx } = ctxLog();
      const outcome = await runSummarizeJob(
        { db, bili: fakeBili({}), llm: { baseUrl: url, model: 'm1', apiKey: 'k' }, timeoutMs: 30 },
        { videoKey: VIDEO_KEY },
        ctx,
      );
      expect(outcome.result).toBe('failed');
      if (outcome.result === 'failed') {
        expect(outcome.error.code).toBe('LLM_NETWORK');
        expect(outcome.error.msg).toContain('超时');
      }
      await db.delete();
    } finally {
      srv.close();
    }
  });
});

describe('2.7a force 重新生成（REGENERATE 执行体语义）', () => {
  const seedDone = async (db: CompanionDB) => {
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '测试视频',
      cover: 'c', owner: 'up', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'm1'), videoKey: VIDEO_KEY, source: 'ai_sub',
      summary: '旧摘要', outline: [{ time: 0, text: '旧大纲' }], evaluation: '旧点评', rating: 3,
      modelId: 'm1', persona: 'spicy', status: 'done', createdAt: 1,
      segmentNotes: { 0: { text: '旧注记', status: 'done', createdAt: 1 } },
    });
  };

  it('force 绕过 done 缓存：整行覆盖（createdAt 更新、summary 换新、segmentNotes 随之清空）', async () => {
    const db = freshDb();
    await seedDone(db);
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili: fakeBili({}), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } },
      { videoKey: VIDEO_KEY },
      ctx,
      { force: true },
    );
    expect(outcome.result).toBe('done');
    const row = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(row?.status).toBe('done');
    expect(row?.summary).not.toBe('旧摘要');
    expect(row?.createdAt).toBeGreaterThan(1);
    expect(row?.segmentNotes).toBeUndefined(); // 分段缓存随重生成失效（2.7a 策略）
    expect(server.calls).toHaveLength(1);
    await db.delete();
  });

  it('无 force 时 done 缓存命中零请求（F5 幂等回归）', async () => {
    const db = freshDb();
    await seedDone(db);
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili: fakeBili({}), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(outcome.result).toBe('done');
    expect(server.calls).toHaveLength(0);
    await db.delete();
  });

  it('force 失败不覆盖旧 done 行：旧摘要/分段注记完好，错误只在 outcome（F11 友好）', async () => {
    const db = freshDb();
    await seedDone(db);
    const srv = http.createServer(() => {
      /* 收下请求但永不响应 */
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const { ctx } = ctxLog();
      const outcome = await runSummarizeJob(
        { db, bili: fakeBili({}), llm: { baseUrl: url, model: 'm1', apiKey: 'k' }, timeoutMs: 30 },
        { videoKey: VIDEO_KEY },
        ctx,
        { force: true },
      );
      expect(outcome.result).toBe('failed');
      const row = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
      expect(row?.status).toBe('done');
      expect(row?.summary).toBe('旧摘要');
      expect(row?.segmentNotes?.[0]?.text).toBe('旧注记');
      await db.delete();
    } finally {
      srv.close();
    }
  });
});
