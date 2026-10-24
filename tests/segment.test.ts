// P1.11 · F13 分段解读单测：段区间/切片/截断/Prompt 边界/注记写回/执行体（缓存零请求、失败落注记）。
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import {
  SEGMENT_CUES_CHAR_LIMIT,
  buildSegmentMessages,
  runSegmentJob,
  segmentRange,
  sliceCues,
  writeSegmentNote,
  type OutlineItem,
} from '../src/lib/summarize/segment';
import { CompanionDB, summaryKey, type StoredCue, type SummaryRow, type VideoRow } from '../src/lib/storage';
import type { BiliApi } from '../src/lib/summarize/chain';
import type { LlmConfig } from '../src/lib/llm/types';
import { Pipeline } from '../src/lib/pipeline';

const freshDb = (): CompanionDB => new CompanionDB(`seg-${Math.random()}`, { indexedDB, IDBKeyRange });
const VIDEO_KEY = 'BV1seg:424242';
const SKEY = summaryKey(VIDEO_KEY, 'mock-model');

const outline: OutlineItem[] = [
  { time: 0, text: '开场' },
  { time: 60, text: '中段' },
  { time: 150, text: '结尾段' },
];

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function writeSse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of text.match(/.{1,40}/gs) ?? []) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const cues: StoredCue[] = [
  { from: 0, to: 10, text: '开场白' },
  { from: 55, to: 70, text: '跨段起点 cue' },
  { from: 80, to: 90, text: '中段 cue' },
  { from: 140, to: 200, text: '结尾 cue' },
];

async function seedDoneSummary(db: CompanionDB, withOutline = true): Promise<void> {
  const row: SummaryRow = {
    key: SKEY,
    videoKey: VIDEO_KEY,
    source: 'ai_sub',
    summary: '摘要'.repeat(80),
    outline: withOutline ? outline : [],
    evaluation: '点评',
    rating: 4,
    modelId: 'mock-model',
    persona: 'spicy',
    status: 'done',
    createdAt: Date.now(),
  };
  await db.summaries.put(row);
  const video: VideoRow = {
    key: VIDEO_KEY,
    bvid: 'BV1seg',
    aid: 1,
    cid: 424242,
    title: '测试视频',
    cover: 'c',
    owner: 'up',
    duration: 200,
    page: 1,
    fetchedAt: Date.now(),
  };
  await db.videos.put(video);
  await db.transcripts.put({
    key: VIDEO_KEY,
    source: 'ai_sub',
    lan: 'ai-zh',
    cues,
    charCount: 100,
    cachedAt: Date.now(),
  });
}

const silentBili = (): BiliApi => ({
  async fetchWbiKeys() {
    throw new Error('不应取 WBI（字幕缓存命中）');
  },
  async getView() {
    throw new Error('不应取 view');
  },
  async getPlayerSubtitles() {
    throw new Error('不应取轨（字幕缓存命中）');
  },
  async fetchTranscript() {
    throw new Error('不应下载字幕（缓存命中）');
  },
});

describe('segmentRange（段定义：本条 time → 下条 time，末条以时长封底）', () => {
  it('中间段与末段', () => {
    expect(segmentRange(outline, 0, 200)).toEqual({ from: 0, to: 60 });
    expect(segmentRange(outline, 1, 200)).toEqual({ from: 60, to: 150 });
    expect(segmentRange(outline, 2, 200)).toEqual({ from: 150, to: 200 });
  });
  it('越界/空大纲 → null；负 time 钳 0；下条早于本条钳平', () => {
    expect(segmentRange(outline, 3, 200)).toBeNull();
    expect(segmentRange([], 0, 200)).toBeNull();
    expect(segmentRange([{ time: -5, text: 'x' }], 0, 100)).toEqual({ from: 0, to: 100 });
    expect(segmentRange([{ time: 90, text: 'a' }, { time: 30, text: 'b' }], 0, 100)).toEqual({ from: 90, to: 90 });
  });
});

describe('sliceCues（与段区间有重叠即入，不拆行）', () => {
  it('边界：起点前已结束的 cue 不入；跨边界整条入', () => {
    const s = sliceCues(cues, { from: 60, to: 150 });
    expect(s.map((c) => c.text)).toEqual(['跨段起点 cue', '中段 cue', '结尾 cue']); // 0–10 不重叠排除；140–200 重叠整条入
    expect(sliceCues(cues, { from: 0, to: 60 }).map((c) => c.text)).toEqual(['开场白', '跨段起点 cue']);
  });
});

describe('buildSegmentMessages', () => {
  it('全片大纲压缩 + <transcript> 边界 + 伪标签中和 + 截断标记', () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ from: i, to: i + 1, text: '字'.repeat(30) }));
    const { messages, truncated } = buildSegmentMessages({
      title: 'T',
      outline,
      segIndex: 1,
      range: { from: 60, to: 150 },
      cues: big,
    });
    expect(truncated).toBe(true);
    const user = messages[1]!.content;
    expect(user).toContain('<transcript>');
    expect(user).toContain('[0|0s] 开场');
    expect(user).toContain('大纲[1]');
    expect(messages[0]!.content).toContain('120–200 字');
    const inner = user.slice(user.indexOf('<transcript>'), user.lastIndexOf('</transcript>'));
    expect(inner).not.toContain('</transcript>');
    // 截断后正文不超过预算
    expect(inner.length).toBeLessThanOrEqual(SEGMENT_CUES_CHAR_LIMIT + 40);
  });
  it('未超预算不截断；system 无人设口吻指令（F15 信息质量护栏）', () => {
    const { truncated, messages } = buildSegmentMessages({ title: 'T', outline, segIndex: 0, range: { from: 0, to: 60 }, cues });
    expect(truncated).toBe(false);
    expect(messages[0]!.content).toContain('客观');
  });
});

describe('writeSegmentNote', () => {
  it('按 segIndex 合并、保留其他段；行被清除则不复活（F10）', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    await writeSegmentNote(db, SKEY, 0, { text: 'a', status: 'done', createdAt: 1 });
    await writeSegmentNote(db, SKEY, 2, { text: 'c', status: 'streaming', createdAt: 2 });
    const row = await db.summaries.get(SKEY);
    expect(row?.segmentNotes?.[0]?.text).toBe('a');
    expect(row?.segmentNotes?.[2]?.status).toBe('streaming');
    await db.summaries.delete(SKEY);
    await writeSegmentNote(db, SKEY, 1, { text: 'x', status: 'done', createdAt: 3 });
    expect(await db.summaries.get(SKEY)).toBeUndefined();
  });
});

describe('runSegmentJob', () => {
  const llm: LlmConfig = { baseUrl: 'http://127.0.0.1:1', model: 'mock-model', apiKey: 'k' };

  it('无大纲/摘要未 done → NO_OUTLINE，零网络', async () => {
    const db = freshDb();
    const r = await runSegmentJob({ db, bili: silentBili(), llm }, { videoKey: VIDEO_KEY, segIndex: 0 });
    expect(r.result).toBe('failed');
    if (r.result === 'failed') expect(r.error.code).toBe('NO_OUTLINE');
  });

  it('缓存命中 done → 直接完成，零 bili/LLM 请求', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    await writeSegmentNote(db, SKEY, 1, { text: '缓存解读', status: 'done', createdAt: 1 });
    let fetchCalled = false;
    const r = await runSegmentJob(
      { db, bili: silentBili(), llm, fetchImpl: (() => { fetchCalled = true; throw new Error('no'); }) as typeof fetch },
      { videoKey: VIDEO_KEY, segIndex: 1 },
    );
    expect(r.result).toBe('done');
    expect(fetchCalled).toBe(false);
  });

  it('段内无 cues → NO_CUES 失败注记', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    await db.transcripts.put({ key: VIDEO_KEY, source: 'ai_sub', lan: 'ai-zh', cues: [{ from: 500, to: 510, text: '远端' }], charCount: 10, cachedAt: Date.now() });
    const r = await runSegmentJob({ db, bili: silentBili(), llm }, { videoKey: VIDEO_KEY, segIndex: 0 });
    expect(r.result).toBe('failed');
    if (r.result === 'failed') expect(r.error.code).toBe('NO_CUES');
    const note = (await db.summaries.get(SKEY))?.segmentNotes?.[0];
    expect(note?.status).toBe('failed');
  });

  it('全链：流式 delta 回调 + done 注记落库（真实 SSE server）', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    const base = await start((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const j = JSON.parse(body) as { max_tokens?: number };
          expect(j.max_tokens).toBe(500); // 成本护栏随请求下发
          writeSse(res, '该段先给结论再给依据，值得一看。');
        });
        return;
      }
      res.writeHead(404).end();
    });
    const deltas: string[] = [];
    const r = await runSegmentJob(
      { db, bili: silentBili(), llm: { ...llm, baseUrl: base }, onDelta: (t) => deltas.push(t) },
      { videoKey: VIDEO_KEY, segIndex: 1 },
    );
    expect(r.result).toBe('done');
    expect(deltas.join('')).toBe('该段先给结论再给依据，值得一看。');
    const note = (await db.summaries.get(SKEY))?.segmentNotes?.[1];
    expect(note?.status).toBe('done');
    expect(note?.text).toBe('该段先给结论再给依据，值得一看。');
  });

  it('LLM 500 → failed 注记含错误码，摘要本体不受影响', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    const base = await start((_, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    const r = await runSegmentJob(
      { db, bili: silentBili(), llm: { ...llm, baseUrl: base } },
      { videoKey: VIDEO_KEY, segIndex: 0 },
    );
    expect(r.result).toBe('failed');
    const note = (await db.summaries.get(SKEY))?.segmentNotes?.[0];
    expect(note?.status).toBe('failed');
    expect(note?.error?.code).toBe('LLM_HTTP');
    const row = await db.summaries.get(SKEY);
    expect(row?.status).toBe('done'); // 摘要本体不变（F13）
    expect(row?.summary).toContain('摘要');
  });
});

describe('pipeline SEGMENT_ANALYZE 幂等键含 segIndex', () => {
  it('同段去重、异段独立、与 SUMMARIZE 互不去重', async () => {
    const db = freshDb();
    const p = new Pipeline(db, { execute: async () => ({ result: 'done' }) });
    const a = await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: VIDEO_KEY, sessionId: 's1', segIndex: 1 });
    const b = await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: VIDEO_KEY, sessionId: 's1', segIndex: 1 });
    const c = await p.enqueue({ type: 'SEGMENT_ANALYZE', videoKey: VIDEO_KEY, sessionId: 's1', segIndex: 2 });
    const d = await p.enqueue({ type: 'SUMMARIZE', videoKey: VIDEO_KEY, sessionId: 's1' });
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(d.id).not.toBe(a.id);
  });
});

describe('审查修复回归', () => {
  it('P2-4：取行=videoKey 下 createdAt 最新行（换模型后不 NO_OUTLINE 死循环），注记写回该行', async () => {
    const db = freshDb();
    const base: SummaryRow = {
      key: `${VIDEO_KEY}:model-old`,
      videoKey: VIDEO_KEY,
      source: 'ai_sub',
      summary: '旧',
      outline,
      evaluation: '',
      rating: 3,
      modelId: 'model-old',
      persona: 'spicy',
      status: 'done',
      createdAt: 1000,
    };
    await db.summaries.put(base);
    await db.summaries.put({ ...base, key: `${VIDEO_KEY}:model-new`, modelId: 'model-new', createdAt: 2000 });
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1seg', aid: 1, cid: 424242, title: 'T', cover: 'c', owner: 'u',
      duration: 200, page: 1, fetchedAt: Date.now(),
    });
    await db.transcripts.put({ key: VIDEO_KEY, source: 'ai_sub', lan: 'ai-zh', cues, charCount: 50, cachedAt: Date.now() });
    const base2 = await start((req, res) => {
      if (req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => writeSse(res, '新模型行的段解读。'));
        return;
      }
      res.writeHead(404).end();
    });
    // 当前 llm.model 与两行都不同 → 仍应取最新行（model-new）并把注记写进 model-new 行
    const r = await runSegmentJob(
      { db, bili: silentBili(), llm: { baseUrl: base2, model: 'model-other', apiKey: 'k' } },
      { videoKey: VIDEO_KEY, segIndex: 0 },
    );
    expect(r.result).toBe('done');
    const newRow = await db.summaries.get(`${VIDEO_KEY}:model-new`);
    expect(newRow?.segmentNotes?.[0]?.status).toBe('done');
    expect((await db.summaries.get(`${VIDEO_KEY}:model-old`))?.segmentNotes).toBeUndefined();
  });

  it('P1-2：字幕缓存过期后 B 站 -101 → NEED_LOGIN 失败注记（F11 文案，不穿透 CHAIN_ERROR）', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    await db.transcripts.put({
      key: VIDEO_KEY, source: 'ai_sub', lan: 'ai-zh', cues, charCount: 50, cachedAt: Date.now() - 25 * 3600_000,
    });
    const bili: BiliApi = {
      async fetchWbiKeys() {
        throw new (await import('../src/lib/bilibili/client')).BiliApiError(-101, '/x/web-interface/nav');
      },
      async getView() {
        throw new Error('no');
      },
      async getPlayerSubtitles() {
        throw new Error('no');
      },
      async fetchTranscript() {
        throw new Error('no');
      },
    };
    const r = await runSegmentJob({ db, bili, llm: { baseUrl: 'http://127.0.0.1:1', model: 'mock-model', apiKey: 'k' } }, { videoKey: VIDEO_KEY, segIndex: 0 });
    expect(r.result).toBe('failed');
    if (r.result === 'failed') expect(r.error.code).toBe('NEED_LOGIN');
    const note = (await db.summaries.get(SKEY))?.segmentNotes?.[0];
    expect(note?.status).toBe('failed');
    expect(note?.error?.code).toBe('NEED_LOGIN');
  });

  it('timeoutMs 透传：deps.timeoutMs=30 + 服务器不响应 → failed 注记 LLM_NETWORK(超时)', async () => {
    const db = freshDb();
    await seedDoneSummary(db);
    const base = await start(async () => {
      /* 收下请求但永不响应 */
    });
    const r = await runSegmentJob(
      { db, bili: silentBili(), llm: { baseUrl: base, model: 'mock-model', apiKey: 'k' }, timeoutMs: 30 },
      { videoKey: VIDEO_KEY, segIndex: 1 },
    );
    expect(r.result).toBe('failed');
    const note = (await db.summaries.get(SKEY))?.segmentNotes?.[1];
    expect(note?.status).toBe('failed');
    expect(note?.error?.code).toBe('LLM_NETWORK');
    expect(note?.error?.msg).toContain('超时');
  });
});
