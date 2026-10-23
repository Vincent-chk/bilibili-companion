// P1.4 · 摘要全链集成测试（fake-indexeddb + fake BiliApi + mock SSE LLM）：
// 缓存幂等（摘要命中零请求 / 字幕命中免抓取）、无轨→need_asr、LLM 错误映射、
// 长字幕走 Map-Reduce、videos 行兜底、进度 stage 顺序。
import { afterEach, describe, expect, it } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { startMockLlm, validSummaryJson, type MockLlmServer } from './helpers/mock-llm';
import { runSummarizeJob, parseVideoKey, mapLlmError, type BiliApi } from '../src/lib/summarize/chain';
import { LlmHttpError } from '../src/lib/llm/client';
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
    expect(bili.calls).toEqual(['player', 'subtitle']); // 有 videos 行，无需 view
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
    expect(bili.calls).toEqual(['player', 'subtitle']);
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
});
