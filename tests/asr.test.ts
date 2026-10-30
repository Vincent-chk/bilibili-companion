// P2.3 · ASR 链单测：选源（bandwidth 最小+域优先级，07 报告 G-3）、转写归一化（verbose_json/json 退化）、
// 体量预估、错误映射、上传 wire（multipart/response_format）、runAsrJob 全链（fake-indexeddb + fake bili/asr/llm）。
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { startMockLlm, validSummaryJson, type MockLlmServer } from './helpers/mock-llm';
import {
  estimateAudioBytes,
  mapAsrError,
  normalizeTranscription,
  pickAudioStream,
  transcribeAudio,
  urlHostClass,
  type AsrConfig,
} from '../src/lib/asr';
import { runAsrJob, type AsrBiliApi } from '../src/lib/summarize/asr';
import { runSummarizeJob } from '../src/lib/summarize/chain';
import { AsrHttpError } from '../src/lib/asr';
import { CompanionDB, summaryKey } from '../src/lib/storage';
import type { JobStage } from '../src/lib/storage';
import type { DashAudioStream } from '../src/lib/bilibili/client';

const servers: MockLlmServer[] = [];
const asrServers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const s of asrServers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const freshDb = (): CompanionDB => new CompanionDB(`test-${Math.random()}`, { indexedDB, IDBKeyRange });
const VIDEO_KEY = 'BV1noSub:777';

const audio = (over: Partial<DashAudioStream> = {}): DashAudioStream => ({
  id: 30216,
  bandwidth: 65_704,
  baseUrl: 'https://upos-sz-mirror08c.bilivideo.com/audio.m4s',
  backupUrl: [],
  ...over,
});

describe('选源（urlHostClass / pickAudioStream，架构 §3.8）', () => {
  it('域分类：upos-sz-*.bilivideo.com=1 > mcdn.bilivideo.cn=2 > 其他 bilivideo=3 > 第三方边缘域=4（不选）', () => {
    expect(urlHostClass('https://upos-sz-mirror08c.bilivideo.com/a.m4s')).toBe(1);
    expect(urlHostClass('https://xy123.mcdn.bilivideo.cn:8082/a.m4s')).toBe(2);
    expect(urlHostClass('https://cn-sh-cc-01.bilivideo.com/a.m4s')).toBe(3);
    expect(urlHostClass('https://b-abc.edge.mountaintoys.cn:4483/a.m4s')).toBe(4);
    expect(urlHostClass('not-a-url')).toBe(4);
  });
  it('bandwidth 最小档优先（不硬编码 id；30232/30280 同带宽取先入者）', () => {
    const picked = pickAudioStream([
      audio({ id: 30280, bandwidth: 97_260 }),
      audio({ id: 30216, bandwidth: 65_704 }),
    ]);
    expect(picked?.stream.id).toBe(30216);
  });
  it('同档内 URL 按域优先级：baseUrl 是第三方边缘域而 backupUrl 是 upos → 选 backupUrl', () => {
    const picked = pickAudioStream([
      audio({
        baseUrl: 'https://b-xyz.edge.mountaintoys.cn:4483/a.m4s',
        backupUrl: ['https://upos-sz-mirror08c.bilivideo.com/a.m4s'],
      }),
    ]);
    expect(picked?.url).toContain('upos-sz-mirror08c.bilivideo.com');
  });
  it('最低带宽档全为第三方边缘域 → 跳过取下一可用档（白名单四域封闭枚举）', () => {
    const picked = pickAudioStream([
      audio({ id: 1, bandwidth: 1, baseUrl: 'https://b-xyz.edge.mountaintoys.cn:4483/a.m4s' }),
      audio({ id: 2, bandwidth: 100, baseUrl: 'https://cn-sh-cc-01.bilivideo.com/a.m4s' }),
    ]);
    expect(picked?.stream.id).toBe(2);
  });
  it('无任何可用档 → null', () => {
    expect(pickAudioStream([])).toBeNull();
    expect(pickAudioStream([audio({ baseUrl: '', backupUrl: [] })])).toBeNull();
  });
});

describe('转写归一化（verbose_json / json 退化）', () => {
  it('仅有英文分句时保留单词边界', () => {
    const r=normalizeTranscription({segments:[{start:0,end:1,text:'hello'},{start:1,end:2,text:'world'}]},2);
    expect(r.text).toBe('hello world');
  });
  it('verbose_json.segments → cues（trim 空段滤除）；text 取响应 text 或拼接', () => {
    const r = normalizeTranscription(
      { text: '全文', segments: [{ start: 0, end: 2, text: ' 你好 ' }, { start: 2, end: 4, text: '' }, { start: 4, end: 6, text: '世界' }] },
      100,
    );
    expect(r.cues).toEqual([
      { from: 0, to: 2, text: '你好' },
      { from: 4, to: 6, text: '世界' },
    ]);
    expect(r.text).toBe('全文');
  });
  it('json 退化（无 segments）→ 整段文本单条 cue，to=时长封底', () => {
    const r = normalizeTranscription({ text: '整段转写文本' }, 600);
    expect(r.cues).toEqual([{ from: 0, to: 600, text: '整段转写文本' }]);
  });
  it('空响应 → 空 cues/空 text（上游判 LOW_CONTENT）', () => {
    expect(normalizeTranscription({}, 100)).toEqual({ cues: [], text: '' });
  });
});

describe('体量预估与错误映射', () => {
  it('estimateAudioBytes：≈64kbps 折算（60min ≈ 29.57MB，07 报告 G-3 口径）', () => {
    expect(estimateAudioBytes(60 * 60)).toBeGreaterThan(29_000_000);
    expect(estimateAudioBytes(60 * 60)).toBeLessThan(30_000_000);
  });
  it('mapAsrError：区分 Key、音频超限、识别超时和网络错误', () => {
    expect(mapAsrError(new AsrHttpError(401, 'x')).code).toBe('KEY_INVALID');
    expect(mapAsrError(new AsrHttpError(413, 'x')).code).toBe('AUDIO_TOO_LARGE');
    expect(mapAsrError(new Error('ASR_TIMEOUT'))).toMatchObject({code:'ASR_TIMEOUT',msg:expect.stringContaining('超时')});
    expect(mapAsrError(new Error('ASR_NETWORK:boom')).code).toBe('ASR_NETWORK');
  });
});

describe('transcribeAudio（multipart wire 级）', () => {
  const cfg: AsrConfig = { baseUrl: 'http://127.0.0.1:1/v1', modelId: 'sense-small', apiKey: 'sk-asr-test' };
  it('开始前取消不会向兼容 ASR 发送音频', async () => {
    const controller = new AbortController(); controller.abort();
    let requests = 0;
    const send:typeof fetch = async () => { requests++; return new Response('{}'); };
    await expect(transcribeAudio(cfg,{bytes:new ArrayBuffer(2),filename:'audio.m4a'},2,{fetchImpl:send,signal:controller.signal}))
      .rejects.toThrow('ASR_CANCELLED');
    expect(requests).toBe(0);
  });
  it('识别中取消会中止兼容 ASR 请求', async () => {
    const controller = new AbortController();
    let notifyStarted!:()=>void;
    const started = new Promise<void>(resolve=>{notifyStarted=resolve;});
    const send:typeof fetch = async (_url,init) => new Promise<Response>((_resolve,reject)=>{
      notifyStarted();
      init?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
    });
    const work = transcribeAudio(cfg,{bytes:new ArrayBuffer(2),filename:'audio.m4a'},2,{fetchImpl:send,timeoutMs:50,signal:controller.signal});
    await started; controller.abort();
    await expect(work).rejects.toThrow('ASR_CANCELLED');
  });
  it('请求形状：POST /audio/transcriptions + Bearer + multipart（file/model/response_format=verbose_json）', async () => {
    let seen = { url: '', auth: '', ct: '', body: '' };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { url: req.url ?? '', auth: req.headers.authorization ?? '', ct: req.headers['content-type'] ?? '', body };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '你好世界', segments: [{ start: 0, end: 1, text: '你好世界' }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    asrServers.push(srv);
    const port = (srv.address() as AddressInfo).port;
    const r = await transcribeAudio(
      { ...cfg, baseUrl: `http://127.0.0.1:${port}/v1` },
      { bytes: new TextEncoder().encode('fake-audio').buffer as ArrayBuffer, filename: 'audio.m4a' },
      100,
    );
    expect(seen.url).toBe('/v1/audio/transcriptions');
    expect(seen.auth).toBe('Bearer sk-asr-test');
    expect(seen.ct).toContain('multipart/form-data');
    expect(seen.body).toContain('name="model"');
    expect(seen.body).toContain('sense-small');
    expect(seen.body).toContain('verbose_json');
    expect(seen.body).toContain('audio.m4a');
    expect(r.text).toBe('你好世界');
    expect(r.cues).toEqual([{ from: 0, to: 1, text: '你好世界' }]);
  });
});

describe('runAsrJob 全链（fake-indexeddb + fake bili/asr + mock LLM SSE）', () => {
  const mkBili = (streams: DashAudioStream[], log: string[] = []): AsrBiliApi => ({
    async fetchWbiKeys() {
      return 'k';
    },
    async getView() {
      return {
        aid: 1,
        cid: 777,
        title: '无字幕视频',
        cover: 'c',
        owner: 'up',
        duration: 120,
        pages: [{ cid: 777, page: 1, part: 'p1', duration: 120 }],
      };
    },
    async getPlayerSubtitles() {
      return { subtitles: [], needLoginSubtitle: null };
    },
    async fetchTranscript() {
      throw new Error('ASR 链不取字幕');
    },
    async getPlayUrlAudio() {
      log.push('playurl');
      return streams;
    },
  });
  const ctxLog = () => {
    const stages: JobStage[] = [];
    return {
      stages,
      ctx: {
        update: async (patch: { stage?: JobStage }) => {
          if (patch.stage) stages.push(patch.stage);
        },
      },
    };
  };
  const fetchAudioOk = async () =>
    new Response(new Uint8Array(1024).buffer, { status: 200 });

  it.each(['asr', 'llm'] as const)('兼容 ASR 在 %s 阶段清除会话后，迟到结果不能复活数据', async (phase) => {
    const db = freshDb();
    const now = Date.now();
    await db.sessions.put({id:'s',state:'ACTIVE',startedAt:now,lastActiveAt:now});
    await db.jobs.put({id:'j',sessionId:'s',runId:'r',videoKey:VIDEO_KEY,type:'ASR_SUMMARIZE',status:'running',progress:0,retries:0,createdAt:now,updatedAt:now});
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:now});
    let notifyStarted!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const text = '这是一段需要保留的完整语音内容';
    const valid = JSON.parse(validSummaryJson());
    valid.outline = valid.outline.map((item:{time:number}, i:number) => ({...item,time:i * 15}));
    const endpoint = async (url:string|URL|Request):Promise<Response> => {
      if (String(url).includes('/audio/transcriptions')) {
        if (phase === 'asr') { notifyStarted(); await gate; }
        return new Response(JSON.stringify({text,segments:[{start:0,end:10,text}]}));
      }
      if (phase === 'llm') { notifyStarted(); await gate; }
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(valid)}}]})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
    };
    const work = runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'k'},asr:{baseUrl:'https://asr.test/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchAudio:fetchAudioOk as typeof fetch,fetchImpl:endpoint as typeof fetch},
      {videoKey:VIDEO_KEY,id:'j',sessionId:'s',runId:'r'},{update:async()=>{}});
    await started;
    await db.transaction('rw',db.sessions,db.jobs,db.videos,db.transcripts,db.summaries,async()=>{
      await db.sessions.clear(); await db.jobs.clear(); await db.videos.clear(); await db.transcripts.clear(); await db.summaries.clear();
    });
    release();
    expect(await work).toMatchObject({result:'failed',error:{code:'ASR_JOB_STALE'}});
    expect(await db.transcripts.count()).toBe(0);
    expect(await db.summaries.count()).toBe(0);
    await db.delete();
  });

  it('happy path：音频→转写→摘要 done（source=asr）+ transcripts 落库 + 阶段三段有序', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: '无字幕视频', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'mock-model'), videoKey: VIDEO_KEY, source: 'asr', summary: '', outline: [],
      evaluation: '', rating: 0, modelId: 'mock-model', persona: 'spicy', status: 'need_asr', createdAt: 1,
    });
    const summary = JSON.parse(validSummaryJson());
    summary.outline = summary.outline.map((item:{time:number}, i:number) => ({...item,time:i * 15}));
    const llm = await startMockLlm(() => ({ chunks: [JSON.stringify(summary)] }));
    servers.push(llm);
    const asrFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/audio/transcriptions')) {
        const text = '这是一段足够长的语音转写内容，用于越过低内容判定阈值，确保进入摘要阶段。'.repeat(3);
        return new Response(
          JSON.stringify({ text, segments: [{ start: 0, end: 10, text }] }),
          { status: 200 },
        );
      }
      if (u.includes('bilivideo.com')) return fetchAudioOk();
      return fetch(url, init); // 其余（LLM SSE）透传真实 fetch
    };
    const { stages, ctx } = ctxLog();
    const out = await runAsrJob(
      {
        db,
        bili: mkBili([audio()]),
        llm: { baseUrl: llm.url, model: 'mock-model', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 'sense', apiKey: 'k' },
        asrMaxMB: 25,
        fetchImpl: asrFetch as typeof fetch,
        fetchAudio: asrFetch as typeof fetch,
      },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(out).toEqual({ result: 'done' });
    expect(stages).toEqual(['audio', 'asr', 'llm_map', 'llm_reduce']);
    const sum = await db.summaries.get(summaryKey(VIDEO_KEY, 'mock-model'));
    expect(sum?.status).toBe('done');
    expect(sum?.source).toBe('asr');
    expect(sum?.summary.length).toBeGreaterThan(100);
    const tr = await db.transcripts.get(VIDEO_KEY);
    expect(tr?.source).toBe('asr');
    expect(tr?.cues.length).toBeGreaterThan(0);
    await db.delete();
  });

  it('音频超上限（>asrMaxMB）→ failed AUDIO_TOO_LARGE，need_asr 行保留（可重试口径）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'm'), videoKey: VIDEO_KEY, source: 'asr', summary: '', outline: [],
      evaluation: '', rating: 0, modelId: 'm', persona: 'spicy', status: 'need_asr', createdAt: 1,
    });
    const big = async () => new Response(new Uint8Array(30 * 1024 * 1024).buffer, { status: 200 });
    const { ctx } = ctxLog();
    const out = await runAsrJob(
      {
        db,
        bili: mkBili([audio()]),
        llm: { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
        asrMaxMB: 25,
        fetchAudio: big as typeof fetch,
      },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.error.code).toBe('AUDIO_TOO_LARGE');
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm')))?.status).toBe('need_asr');
    await db.delete();
  });

  it('兼容 ASR 短讲话保留转写，不当作无语音', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'm'), videoKey: VIDEO_KEY, source: 'asr', summary: '', outline: [],
      evaluation: '', rating: 0, modelId: 'm', persona: 'spicy', status: 'need_asr', createdAt: 1,
    });
    const valid = JSON.parse(validSummaryJson());
    valid.outline = valid.outline.map((item:{time:number}, i:number) => ({...item,time:i * 15}));
    const llm = await startMockLlm(() => ({ chunks: [JSON.stringify(valid)] }));
    servers.push(llm);
    const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      if (u.includes('/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: '很短。', segments: [{ start: 0, end: 1, text: '很短' }] }), { status: 200 });
      }
      if (u.includes('bilivideo.com')) return fetchAudioOk();
      return fetch(url, init);
    };
    const { ctx } = ctxLog();
    const out = await runAsrJob(
      {
        db,
        bili: mkBili([audio()]),
        llm: { baseUrl: llm.url, model: 'm', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
        asrMaxMB: 25,
        fetchImpl: f as typeof fetch,
        fetchAudio: f as typeof fetch,
      },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(out).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});
    expect((await db.transcripts.get(VIDEO_KEY))?.cues).toEqual([{from:0,to:1,text:'很短'}]);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm')))?.status).toBe('failed');expect(llm.calls).toHaveLength(0);
    const again=await runSummarizeJob({db,bili:mkBili([audio()]),llm:{baseUrl:llm.url,model:'m',apiKey:'test-only'},fetchImpl:f as typeof fetch},{videoKey:VIDEO_KEY},ctx,{force:true});
    expect(again).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});expect(llm.calls).toHaveLength(0);
    await db.delete();
  });

  it.each([
    ['无时间戳', {text:'这段语音有内容'}],
    ['部分时间戳缺失', {text:'这段语音有内容',segments:[{start:1,end:2,text:'这段语音'},{start:3,text:'有内容'}]}],
    ['倒序时间戳', {text:'这段语音有内容',segments:[{start:4,end:5,text:'这段语音'},{start:1,end:2,text:'有内容'}]}],
    ['超出视频范围', {text:'这段语音有内容',segments:[{start:121,end:123,text:'这段语音有内容'}]}],
  ])('兼容 ASR %s 时保留原文且不生成全片摘要', async (_name, response) => {
    const db = freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const f = async (url: string | URL | Request): Promise<Response> => String(url).includes('/audio/transcriptions')
      ? new Response(JSON.stringify(response),{status:200}) : fetchAudioOk();
    const out = await runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    expect(out).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
    const summary=await db.summaries.get(summaryKey(VIDEO_KEY,'m'));
    expect(summary?.status).not.toBe('done');
    expect(summary?.asrProgress?.unconfirmed?.[0]?.text).toBe('这段语音有内容');
    expect(summary?.outline).toEqual([]);
    await runSummarizeJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},fetchImpl:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}},{force:true});
    await runSummarizeJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},fetchImpl:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}},{force:true});
    expect((await db.summaries.get(summaryKey(VIDEO_KEY,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe('这段语音有内容');
    await db.delete();
  });

  it('兼容 ASR 无时间信息时保留已有转写和本次原文', async () => {
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const old={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:2,to:4,text:'旧原文'}],charCount:3,cachedAt:1};
    await db.transcripts.put(old);
    const f=async (url:string|URL|Request)=>String(url).includes('/audio/transcriptions')?new Response(JSON.stringify({text:'本次原文'})):fetchAudioOk();
    await runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    expect(await db.transcripts.get(VIDEO_KEY)).toEqual(old);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe('本次原文');
    await db.delete();
  });

  it('新转写与旧转写不同时保留旧数据及新原文，不生成全片结果', async () => {
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const old={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:2,to:4,text:'旧原文'}],charCount:3,cachedAt:1};
    await db.transcripts.put(old);
    const f=async (url:string|URL|Request)=>String(url).includes('/audio/transcriptions')?new Response(JSON.stringify({text:'新原文',segments:[{start:1,end:3,text:'新原文'}]})):fetchAudioOk();
    const out=await runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    expect(out).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
    expect(await db.transcripts.get(VIDEO_KEY)).toEqual(old);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe('新原文');
    await db.delete();
  });

  it('兼容 ASR 空语音明确提示内容不足', async () => {
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const f=async (url:string|URL|Request)=>String(url).includes('/audio/transcriptions')?new Response(JSON.stringify({text:'  '})):fetchAudioOk();
    const out=await runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    expect(out).toMatchObject({result:'failed',error:{code:'LOW_CONTENT'}});
    expect((await db.summaries.get(summaryKey(VIDEO_KEY,'m')))?.error?.msg).toContain('未识别到可用语音');
    await db.delete();
  });

  it.each([
    ['温度+5度','温度5度'],
    ['增长5%','增长5'],
    ['a part','apart'],
    ['数值1.5','数值15'],
  ])('兼容 ASR 原文 %s 与分句 %s 含义冲突时不能生成完整结果',async(text,segment)=>{
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const f=async (url:string|URL|Request)=>String(url).includes('/audio/transcriptions')?new Response(JSON.stringify({text,segments:[{start:1,end:3,text:segment}]})):fetchAudioOk();
    const out=await runAsrJob({db,bili:mkBili([audio()]),llm:{baseUrl:'http://127.0.0.1:9',model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    expect(out).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
    const summary=await db.summaries.get(summaryKey(VIDEO_KEY,'m'));
    expect(summary?.asrProgress?.unconfirmed?.[0]?.text).toBe(text);
    expect(summary?.status).not.toBe('done');
    await db.delete();
  });

  it.each(['空语音','仍冲突','成功'] as const)('连续两次兼容 ASR：第二次%s不丢第一次未确认原文',async(second)=>{
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const valid=JSON.parse(validSummaryJson());valid.outline=valid.outline.map((item:{time:number},i:number)=>({...item,time:i*15}));
    const llm=await startMockLlm(()=>({chunks:[JSON.stringify(valid)]}));servers.push(llm);
    let asrRequests=0;
    const f=async (url:string|URL|Request,init?:RequestInit):Promise<Response>=>{
      const u=String(url);
      if(u.includes('/audio/transcriptions')){
        asrRequests++;
        const body=asrRequests===1?{text:'第一次未确认原文'}:second==='空语音'?{text:''}:second==='仍冲突'?{text:'第二次+5',segments:[{start:1,end:2,text:'第二次5'}]}:{text:'第二次成功结果',segments:[{start:1,end:2,text:'第二次成功结果'}]};
        return new Response(JSON.stringify(body));
      }
      if(u.includes('bilivideo.com'))return fetchAudioOk();
      return fetch(url,init);
    };
    const deps={db,bili:mkBili([audio()]),llm:{baseUrl:llm.url,model:'m',apiKey:'k'},asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch};
    await runAsrJob(deps,{videoKey:VIDEO_KEY},{update:async()=>{}});
    await runAsrJob(deps,{videoKey:VIDEO_KEY},{update:async()=>{}});
    const summary=await db.summaries.get(summaryKey(VIDEO_KEY,'m'));
    expect(summary?.asrProgress?.unconfirmed?.map(x=>x.text)).toContain('第一次未确认原文');
    if(second==='仍冲突')expect(summary?.asrProgress?.unconfirmed?.map(x=>x.text)).toContain('第二次+5');
    if(second==='成功')expect(summary?.status).toBe('done');
    expect(asrRequests).toBe(2);
    await db.delete();
  });

  it('有字幕后生成字幕摘要，仍保留先前未确认的语音原文',async()=>{
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1noSub',aid:1,cid:777,title:'t',cover:'c',owner:'up',duration:120,page:1,fetchedAt:Date.now()});
    const valid=JSON.parse(validSummaryJson());valid.outline=valid.outline.map((item:{time:number},i:number)=>({...item,time:i*15}));
    const llm=await startMockLlm(()=>({chunks:[JSON.stringify(valid)]}));servers.push(llm);
    const f=async (url:string|URL|Request)=>String(url).includes('/audio/transcriptions')?new Response(JSON.stringify({text:'第一次未确认原文'})):fetchAudioOk();
    const base={db,llm:{baseUrl:llm.url,model:'m',apiKey:'k'}};
    await runAsrJob({...base,bili:mkBili([audio()]),asr:{baseUrl:'http://127.0.0.1:9/v1',modelId:'s',apiKey:'k'},asrMaxMB:25,fetchImpl:f as typeof fetch,fetchAudio:f as typeof fetch},{videoKey:VIDEO_KEY},{update:async()=>{}});
    const bili={...mkBili([]),getPlayerSubtitles:async()=>({subtitles:[{lan:'ai-zh',subtitle_url:'https://example.test/subtitle'}],needLoginSubtitle:null}),fetchTranscript:async()=>[{from:0,to:10,content:'字幕内容'}]};
    const out=await runSummarizeJob({...base,bili},{videoKey:VIDEO_KEY},{update:async()=>{}},{force:true});
    expect(out.result).toBe('done');
    const summary=await db.summaries.get(summaryKey(VIDEO_KEY,'m'));
    expect(summary?.source).toBe('ai_sub');
    expect(summary?.asrProgress?.unconfirmed?.map(x=>x.text)).toContain('第一次未确认原文');
    await db.delete();
  });

  it('审查 P2-7：done 缓存守卫——陈旧卡片二次确认不整链重跑（零 playurl 请求）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'm'), videoKey: VIDEO_KEY, source: 'asr', summary: 'done 摘要', outline: [],
      evaluation: '', rating: 3, modelId: 'm', persona: 'spicy', status: 'done', createdAt: 2,
    });
    const calls: string[] = [];
    const bili = mkBili([], calls);
    const out = await runAsrJob(
      {
        db, bili,
        llm: { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
        asrMaxMB: 25,
      },
      { videoKey: VIDEO_KEY },
      { update: async () => {} },
    );
    expect(out).toEqual({ result: 'done' });
    expect(calls).not.toContain('playurl'); // 未发起任何音频链请求
    await db.delete();
  });

  it('审查 P1-2：LLM 阶段失败沿用字幕链映射（KEY_INVALID）并落 failed 行——不保留 need_asr 致重试重烧转写费', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'm'), videoKey: VIDEO_KEY, source: 'asr', summary: '', outline: [],
      evaluation: '', rating: 0, modelId: 'm', persona: 'spicy', status: 'need_asr', createdAt: 1,
    });
    // 转写成功；LLM 401
    const text = '这是一段足够长的语音转写内容，用于越过低内容判定阈值，确保进入摘要阶段。'.repeat(3);
    let asrRequests = 0;
    const f = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.includes('/audio/transcriptions')) {
        asrRequests++;
        return new Response(JSON.stringify({ text, segments: [{ start: 0, end: 10, text }] }), { status: 200 });
      }
      if (u.includes('bilivideo.com')) return fetchAudioOk();
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    };
    const out = await runAsrJob(
      {
        db,
        bili: mkBili([audio()]),
        llm: { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
        asrMaxMB: 25,
        fetchImpl: f as typeof fetch,
        fetchAudio: f as typeof fetch,
      },
      { videoKey: VIDEO_KEY },
      { update: async () => {} },
    );
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.error.code).toBe('KEY_INVALID');
    const sum = await db.summaries.get(summaryKey(VIDEO_KEY, 'm'));
    expect(sum?.status).toBe('failed'); // 不保留 need_asr：重试只重跑 LLM（transcripts 已缓存）
    expect((await db.transcripts.get(VIDEO_KEY))?.source).toBe('asr');
    const valid = JSON.parse(validSummaryJson());
    valid.outline = valid.outline.map((item:{time:number}, i:number) => ({...item,time:i * 15}));
    const llm = await startMockLlm(() => ({chunks:[JSON.stringify(valid)]}));
    servers.push(llm);
    const retry = await runSummarizeJob({db,bili:mkBili([audio()]),llm:{baseUrl:llm.url,model:'m',apiKey:'k'}},{videoKey:VIDEO_KEY},{update:async()=>{}},{force:true});
    expect(retry.result).toBe('done');
    expect(asrRequests).toBe(1);
    await db.delete();
  });

  it('审查 P2-6：Content-Length 前置拦截（超限不读 body）', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    let bodyRead = false;
    const big = async () =>
      new Response(new Uint8Array(4).buffer, {
        status: 200,
        headers: { 'content-length': String(30 * 1024 * 1024) },
      });
    const origArrayBuffer = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () {
      bodyRead = true;
      return origArrayBuffer.call(this);
    };
    try {
      const out = await runAsrJob(
        {
          db,
          bili: mkBili([audio()]),
          llm: { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
          asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
          asrMaxMB: 25,
          fetchAudio: big as typeof fetch,
        },
        { videoKey: VIDEO_KEY },
        { update: async () => {} },
      );
      expect(out.result).toBe('failed');
      if (out.result === 'failed') expect(out.error.code).toBe('AUDIO_TOO_LARGE');
      expect(bodyRead).toBe(false); // 前置拦截：未下载 body
    } finally {
      Response.prototype.arrayBuffer = origArrayBuffer;
    }
    await db.delete();
  });

  it('无可选音频源（全第三方边缘域）→ failed NO_AUDIO', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1noSub', aid: 1, cid: 777, title: 't', cover: 'c', owner: 'up',
      duration: 120, page: 1, fetchedAt: Date.now(),
    });
    const { ctx } = ctxLog();
    const out = await runAsrJob(
      {
        db,
        bili: mkBili([audio({ baseUrl: 'https://b-x.edge.mountaintoys.cn:4483/a.m4s' })]),
        llm: { baseUrl: 'http://127.0.0.1:9', model: 'm', apiKey: 'k' },
        asr: { baseUrl: 'http://127.0.0.1:9/v1', modelId: 's', apiKey: 'k' },
        asrMaxMB: 25,
      },
      { videoKey: VIDEO_KEY },
      ctx,
    );
    expect(out.result).toBe('failed');
    if (out.result === 'failed') expect(out.error.code).toBe('NO_AUDIO');
    await db.delete();
  });
});
