// P1.4 · 摘要全链集成测试（fake-indexeddb + fake BiliApi + mock SSE LLM）：
// 缓存幂等（摘要命中零请求 / 字幕命中免抓取）、无轨→need_asr、LLM 错误映射、
// 长字幕走 Map-Reduce、videos 行兜底、进度 stage 顺序。
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { startMockLlm, validSummaryJson, type MockLlmServer } from './helpers/mock-llm';
import { runSummarizeJob, runLlmAndPersist, ensureTranscript, parseVideoKey, mapLlmError, type BiliApi } from '../src/lib/summarize/chain';
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

it('ASR 摘要提醒模型不能从语音缺失推断画面，原字幕路径不增加此限定', async () => {
  const db = freshDb();
  const requests: {messages:{role:string;content:string}[]}[] = [];
  const output=JSON.parse(validSummaryJson());
  output.outline=[1,1,1,28,28,28].map(time=>({time,text:'要点'}));
  const fetchImpl = async (_input:unknown, init?:RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)}}]})}\n\ndata: [DONE]\n\n`,{status:200});
  };
  const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'实验',cover:'',owner:'',duration:32,page:1,fetchedAt:Date.now()};
  const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:1,to:3,text:'提到实验'},{from:28,to:30,text:'邀请互动'}],charCount:8,cachedAt:Date.now()};
  const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
  const run=(source:'asr'|'ai_sub')=>runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript:{...transcript,source},baseSummary,keepDone:false});
  expect((await run('asr')).result).toBe('done');
  expect((await run('ai_sub')).result).toBe('done');
  expect(requests[0]!.messages[0]!.content).toContain('不包含视频画面');
  expect(requests[0]!.messages[0]!.content).toContain('不能因为语音没有提到');
  expect(requests[1]!.messages[0]!.content).not.toContain('不包含视频画面');
  await db.delete();
});

it('极短语音缓存重新生成时保留旧摘要且不调用模型',async()=>{
 const db=freshDb();const key=summaryKey(VIDEO_KEY,'m');
 const old={key,videoKey:VIDEO_KEY,source:'asr' as const,summary:'已有摘要',outline:[{time:0,text:'已有要点'}],evaluation:'已有点评',rating:4,modelId:'m',persona:'spicy',createdAt:1,status:'done' as const};
 await db.summaries.put(old);
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:0,to:1,text:'今天下雨了。'}],charCount:6,cachedAt:Date.now()};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'短语音',cover:'',owner:'',duration:2,page:1,fetchedAt:Date.now()};
 const fetchImpl=vi.fn(async()=>new Response('',{status:500}));
 const outcome=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl},ctxLog().ctx,{video,transcript,baseSummary:old,keepDone:true});
 expect(outcome).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});expect(fetchImpl).not.toHaveBeenCalled();expect(await db.summaries.get(key)).toEqual(old);await db.delete();
});

it('严格结构化摘要模式下极短语音失败不写入摘要',async()=>{
 const db=freshDb();const key=summaryKey(VIDEO_KEY,'m');
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:0,to:1,text:'今天下雨了。'}],charCount:6,cachedAt:Date.now()};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'短语音',cover:'',owner:'',duration:2,page:1,fetchedAt:Date.now()};
 const baseSummary={key,videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 const fetchImpl=vi.fn(async()=>new Response('',{status:500}));
 const outcome=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
 expect(outcome).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});expect(fetchImpl).not.toHaveBeenCalled();expect(await db.summaries.get(key)).toBeUndefined();await db.delete();
});

it('长 ASR 的分块及汇总都告知模型只有语音文字', async () => {
  const db = freshDb();
  const systems:string[]=[];
  const fetchImpl = async (_input:unknown, init?:RequestInit) => {
    const body=JSON.parse(String(init?.body));
    const system=String(body.messages[0].content);systems.push(system);
    const output=system.includes('字幕片段分析器')?'[0秒] 实验旁白':validSummaryJson();
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:output}}]})}\n\ndata: [DONE]\n\n`,{status:200});
  };
  const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'实验',cover:'',owner:'',duration:776,page:1,fetchedAt:Date.now()};
  const cues=Array.from({length:20},(_,i)=>({from:i*30,to:i*30+2,text:'实验旁白'.repeat(200)}));
  const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues,charCount:16000,cachedAt:Date.now()};
  const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
  expect((await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false})).result).toBe('done');
  expect(systems.some(s=>s.includes('字幕片段分析器'))).toBe(true);
  expect(systems.some(s=>!s.includes('字幕片段分析器'))).toBe(true);
  expect(systems.every(s=>s.includes('不包含视频画面')&&s.includes('不能因为语音没有提到'))).toBe(true);
  await db.delete();
});

it.each(['no-track', 'empty'] as const)('空白旧字幕缓存不能阻断重新检查并进入 %s', async (kind) => {
  const db = freshDb();
  const video = {key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
  await db.transcripts.put({key:VIDEO_KEY,source:'ai_sub',lan:'ai-zh',cues:[{from:0,to:1,text:'  \n'}],charCount:3,cachedAt:Date.now()});
  const bili = kind === 'no-track' ? fakeBili({subtitles:[]}) : fakeBili({cues:[]});
  expect(await ensureTranscript(db,bili,VIDEO_KEY,video)).toEqual({kind});
  expect(bili.calls).toContain('player');
  expect(await db.transcripts.get(VIDEO_KEY)).toBeUndefined();
  await db.delete();
});

it('空白旧字幕的重新检查失败时保留缓存，不触发无字幕流程', async () => {
  const db = freshDb();
  const video = {key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
  const old = {key:VIDEO_KEY,source:'ai_sub' as const,lan:'ai-zh',cues:[{from:0,to:1,text:' '}],charCount:1,cachedAt:Date.now()};
  await db.transcripts.put(old);
  const bili = fakeBili({});
  bili.getPlayerSubtitles = async () => { throw new Error('网络失败'); };
  await expect(ensureTranscript(db,bili,VIDEO_KEY,video)).rejects.toThrow('网络失败');
  expect(await db.transcripts.get(VIDEO_KEY)).toEqual(old);
  await db.delete();
});

it('重新检查期间新写入的有效字幕不能被空白缓存清理掉', async () => {
  const db = freshDb();
  const video = {key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
  await db.transcripts.put({key:VIDEO_KEY,source:'ai_sub',lan:'ai-zh',cues:[{from:0,to:1,text:' '}],charCount:1,cachedAt:Date.now()});
  const valid = {key:VIDEO_KEY,source:'manual_sub' as const,lan:'zh-CN',cues:[{from:0,to:1,text:'有效内容'}],charCount:4,cachedAt:Date.now()};
  const bili = fakeBili({subtitles:[]});
  bili.getPlayerSubtitles = async () => { await db.transcripts.put(valid); return {subtitles:[],needLoginSubtitle:null}; };
  expect(await ensureTranscript(db,bili,VIDEO_KEY,video)).toEqual({kind:'no-track'});
  expect(await db.transcripts.get(VIDEO_KEY)).toEqual(valid);
  await db.delete();
});

it('已完成的旧豆包缓存若词句含义不一致，重生成保留旧摘要且零模型请求',async()=>{
 const db=freshDb(),bili=fakeBili({subtitles:[]}),fetchImpl=vi.fn(async()=>new Response(''));
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
 const words=[{text:'温度5度',startMs:1000,endMs:2000}];const cues=[{from:1,to:2,text:'温度5度'}];
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words}]},cues}]};
 const old={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'原有摘要',outline:[{time:1,text:'原有大纲'}],evaluation:'旧点评',rating:4,modelId:'m',persona:'spicy',createdAt:1,status:'done' as const};
 await db.videos.put(video);await db.transcripts.put(transcript);await db.summaries.put(old);
 const result=await runSummarizeJob({db,bili,llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl},{videoKey:VIDEO_KEY},ctxLog().ctx,{force:true});
 expect(result).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});expect(fetchImpl).not.toHaveBeenCalled();expect(bili.calls).toEqual(['wbi','player']);
 expect(await db.summaries.get(old.key)).toEqual(old);expect(await db.transcripts.get(VIDEO_KEY)).toEqual(transcript);await db.delete();
});

it('损坏的旧豆包缓存不阻断真实字幕，字幕使用后原始 ASR 仍被保留',async()=>{
 const db=freshDb(),bili=fakeBili({}),video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
 const cues=[{from:1,to:2,text:'温度5度'}];const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now()-25*60*60*1000,asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};
 await db.transcripts.put(transcript);const result=await ensureTranscript(db,bili,VIDEO_KEY,video);
 expect(result.kind).toBe('ok');if(result.kind==='ok')expect(result.transcript.source).toBe('ai_sub');
 expect(bili.calls).toEqual(['wbi','player','subtitle']);expect(await db.transcripts.get(VIDEO_KEY)).toEqual(transcript);await db.delete();
});

it.each(['text','time'])('旧豆包缓存的持久化词内容或时间与原结果不一致时禁止发送：%s',async(kind)=>{
 const db=freshDb(),bili=fakeBili({}),fetchImpl=vi.fn(async()=>new Response(''));
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
 const words=[{text:'温度+5度',startMs:1000,endMs:2000}];const cues=[{from:kind==='time'?5:1,to:kind==='time'?6:2,text:kind==='text'?'温度5度':'温度+5度'}];
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues,charCount:5,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words}]},cues}]};
 const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 expect(await runLlmAndPersist({db,bili,llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false})).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 expect(fetchImpl).not.toHaveBeenCalled();expect(await db.summaries.count()).toBe(0);await db.delete();
});

it('旧 ASR 全段占位时间不可直接复用，优先查询真实字幕并在无轨时等待确认',async()=>{
 const db=freshDb();const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
 const legacy={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:0,to:600,text:'旧原文'}],charCount:3,cachedAt:Date.now()};await db.transcripts.put(legacy);
 const bili=fakeBili({subtitles:[]});expect(await ensureTranscript(db,bili,VIDEO_KEY,video)).toEqual({kind:'no-track'});expect(bili.calls).toContain('player');expect(await db.transcripts.get(VIDEO_KEY)).toEqual(legacy);
 const withSubtitle=fakeBili({});expect((await ensureTranscript(db,withSubtitle,VIDEO_KEY,video)).kind).toBe('ok');expect(withSubtitle.calls).toContain('subtitle');await db.delete();
});

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

it('词级转写正文较短但带时间戳后超预算时分块摘要',async()=>{
  const db=freshDb();const requests:string[]=[];
  const fetchImpl=vi.fn(async(_input:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));const system=String(body.messages[0].content);requests.push(system);const content=system.includes('字幕片段分析器')?'[00:00] 片段要点':validSummaryJson();return new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`,{status:200});});
  const cues=Array.from({length:2000},(_,i)=>({from:i*.3,to:i*.3+.1,text:'词'}));
  const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:700,page:1,fetchedAt:Date.now()};
  const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues,charCount:2000,cachedAt:Date.now()};
  const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
  await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
  expect(requests.some(s=>s.includes('字幕片段分析器'))).toBe(true);await db.delete();
});

it('ASR 单趟摘要的时间输入使用整数总秒，不改变字幕的格式',async()=>{
 const db=freshDb();const bodies:any[]=[];
 const fetchImpl=async(_input:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(`data: ${JSON.stringify({choices:[{delta:{content:validSummaryJson()}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:776,page:1,fetchedAt:Date.now()};
 const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 for(const source of ['asr','ai_sub'] as const){const transcript={key:VIDEO_KEY,source,lan:'zh',cues:[{from:612,to:613,text:'讲话内容足够'}],charCount:6,cachedAt:Date.now()};await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});}
 expect(bodies[0].messages[1].content).toContain('[612秒]讲话内容足够');expect(bodies[1].messages[1].content).toContain('[10:12]讲话内容足够');
 expect(bodies[0].messages[0].content).toContain('612');await db.delete();
});

for (const [duration, times] of [
  [30, [-1, 2, 3, 4, 5, 6]],
  [30, [0, 2, 3, 4, 5, 31]],
  [776, [0, 15, 90, 200, 400, 777]],
  [776, [0, 15, 90, 200, 180, 700]],
] as [number, number[]][]) {
  it(`ASR ${duration} 秒的大纲越界或倒序不能标记为成功：${times.join(',')}`, async () => {
    const db=freshDb();const data=JSON.parse(validSummaryJson());data.outline=times.map(time=>({time,text:'要点'}));
    const fetchImpl=vi.fn(async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(data)}}]})}\n\ndata: [DONE]\n\n`,{status:200}));
    const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration,page:1,fetchedAt:Date.now()};
    const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues:[{from:0,to:duration,text:'讲话内容足够'}],charCount:6,cachedAt:Date.now()};
    const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
    const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
    expect(result.result).toBe('failed');expect(fetchImpl).toHaveBeenCalledTimes(2);expect(await db.summaries.count()).toBe(0);await db.delete();
  });
}

it('原有字幕路径不因 ASR 专属时间检查改变行为',async()=>{
  const db=freshDb();const data=JSON.parse(validSummaryJson());data.outline=data.outline.map((o:{text:string},i:number)=>({...o,time:i===0?-1:i}));
  const fetchImpl=vi.fn(async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(data)}}]})}\n\ndata: [DONE]\n\n`,{status:200}));
  const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:30,page:1,fetchedAt:Date.now()};
  const transcript={key:VIDEO_KEY,source:'ai_sub' as const,lan:'zh',cues:[{from:0,to:30,text:'讲话内容'}],charCount:4,cachedAt:Date.now()};
  const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'ai_sub' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
  const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
  expect(result.result).toBe('done');expect(fetchImpl).toHaveBeenCalledTimes(1);await db.delete();
});

it('长 ASR 转写的 Map-Reduce 最终大纲同样拒绝越界',async()=>{
  const db=freshDb();const data=JSON.parse(validSummaryJson());data.outline=[0,100,200,300,400,777].map(time=>({time,text:'要点'}));
  const fetchImpl=vi.fn(async(_input:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));const map=String(body.messages[0].content).includes('视频字幕片段分析器');const content=map?'[00:00] 局部要点':JSON.stringify(data);return new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`,{status:200});});
  const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:776,page:1,fetchedAt:Date.now()};
  const cues=Array.from({length:20},(_,i)=>({from:i*35,to:i*35+30,text:'讲话内容'.repeat(200)}));
  const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues,charCount:16000,cachedAt:Date.now()};
  const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
  const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
  expect(result.result).toBe('failed');expect(fetchImpl).toHaveBeenCalledTimes(4);await db.delete();
});

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
  it('旧字幕缓存末尾的空白行不应要求大纲覆盖无文字的时间', async () => {
    const db = freshDb();
    await db.videos.put({ key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '旧字幕缓存', cover: '', owner: '', duration: 520, page: 1, fetchedAt: Date.now() });
    const transcript = { key: VIDEO_KEY, source: 'ai_sub' as const, lan: 'ai-zh', cues: [
      { from: 2, to: 4, text: '开头讲话' },
      { from: 9, to: 11, text: '中间讲话' },
      { from: 15, to: 17, text: '结束讲话' },
      { from: 500, to: 501, text: '   ' },
    ], charCount: 15, cachedAt: Date.now() };
    await db.transcripts.put(transcript);
    const base = JSON.parse(validSummaryJson());
    base.outline = [2, 4, 6, 9, 12, 15].map(time => ({ time, text: '讲话要点' }));
    const server = await startMockLlm(() => ({ chunks: [JSON.stringify(base)] }));
    servers.push(server);
    const result = await runSummarizeJob({ db, bili: fakeBili({}), llm: { baseUrl: server.url, model: 'm', apiKey: 'test-only' } }, { videoKey: VIDEO_KEY }, ctxLog().ctx);
    expect(result.result).toBe('done');
    expect((await db.summaries.toArray())[0]!.outline.at(-1)!.time).toBe(15);
    expect(await db.transcripts.get(VIDEO_KEY)).toEqual(transcript);
    expect(server.calls).toHaveLength(1);
    await db.delete();
  });

  it('8 分钟视频的完整字幕送入模型，前段大纲必须重试并覆盖后段', async () => {
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'8 分钟视频',cover:'',owner:'',duration:520,page:1,fetchedAt:Date.now()});
    const cues=Array.from({length:243},(_,i)=>{const from=5.86+i*(508/242);return {from,to:from+2.84,content:i===242?'末尾独有讲话':'本段讲话'};});
    const base=JSON.parse(validSummaryJson());
    const server=await startMockLlm((_call,n)=>({chunks:[JSON.stringify({...base,outline:(n===1?[5,8,12,17,25,35,43,55,72,102]:[5,65,150,260,390,510]).map(time=>({time,text:`要点 ${time}`}))})]}));
    servers.push(server);
    const result=await runSummarizeJob({db,bili:fakeBili({cues}),llm:{baseUrl:server.url,model:'m',apiKey:'test-only'}},{videoKey:VIDEO_KEY},ctxLog().ctx);
    expect(server.calls[0]!.body.messages![1]!.content).toContain('末尾独有讲话');
    expect(server.calls).toHaveLength(2);
    expect(result.result).toBe('done');
    expect((await db.summaries.toArray())[0]!.outline.at(-1)!.time).toBe(510);
    await db.delete();
  });

  it('8 分钟视频两次都只生成开头大纲时保留旧摘要和解读', async () => {
    const db=freshDb();
    await db.videos.put({key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'8 分钟视频',cover:'',owner:'',duration:520,page:1,fetchedAt:Date.now()});
    const cues=Array.from({length:243},(_,i)=>{const from=5.86+i*(508/242);return {from,to:from+2.84,content:'本段讲话'};});
    const old={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'ai_sub' as const,summary:'旧摘要',outline:[{time:5,text:'旧要点'}],evaluation:'旧点评',rating:4,modelId:'m',persona:'spicy',createdAt:1,status:'done' as const,segmentNotes:{0:{text:'旧解读',status:'done' as const,createdAt:1}}};
    await db.summaries.put(old);
    const base=JSON.parse(validSummaryJson());base.outline=[5,8,12,17,25,35,43,55,72,102].map(time=>({time,text:'前段要点'}));
    const server=await startMockLlm(()=>({chunks:[JSON.stringify(base)]}));servers.push(server);
    const result=await runSummarizeJob({db,bili:fakeBili({cues}),llm:{baseUrl:server.url,model:'m',apiKey:'test-only'}},{videoKey:VIDEO_KEY},ctxLog().ctx,{force:true});
    expect(result.result).toBe('failed');expect(server.calls).toHaveLength(2);
    expect(await db.summaries.get(old.key)).toEqual(old);
    await db.delete();
  });

  it('语音只在片头和片尾出现时覆盖两端，不强制虚构中段', async () => {
    const db=freshDb();const requests:any[]=[];
    const output=JSON.parse(validSummaryJson());output.outline=[1,1,1,28,28,28].map(time=>({time,text:'讲话要点'}));
    const fetchImpl=async(_input:unknown,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
    const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'少量语音',cover:'',owner:'',duration:32,page:1,fetchedAt:Date.now()};
    const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:1,to:3,text:'开头讲话'},{from:28,to:30,text:'结尾讲话'}],charCount:8,cachedAt:Date.now()};
    const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
    const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
    expect(result.result).toBe('done');expect(requests).toHaveLength(1);
    expect(requests[0].messages[1].content).toContain('不得虚构没有文字的时段');
    await db.delete();
  });

  it('最后一条长语音横跨后段时，不把没有句首时间的区间当成必须章节', async () => {
    const db=freshDb();const requests:any[]=[];
    const output=JSON.parse(validSummaryJson());output.outline=[0,0,90,90,90,90].map(time=>({time,text:'讲话要点'}));
    const fetchImpl=async(_input:unknown,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
    const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'长句',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
    const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:0,to:1,text:'开头讲话'},{from:90,to:600,text:'较长句子'}],charCount:8,cachedAt:Date.now()};
    const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
    const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
    expect(result.result).toBe('done');expect(requests).toHaveLength(1);
    expect(requests[0].messages[1].content).toContain('不得虚构没有文字的时段');
    await db.delete();
  });

  it('分数秒的末句时间向下取整后仍可满足后段覆盖', async () => {
    const db=freshDb();const requests:any[]=[];
    const output=JSON.parse(validSummaryJson());output.outline=[0,0,0,2,2,2].map(time=>({time,text:'讲话要点'}));
    const fetchImpl=async(_input:unknown,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
    const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'短语音',cover:'',owner:'',duration:4,page:1,fetchedAt:Date.now()};
    const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'asr',cues:[{from:0,to:1,text:'开头讲话'},{from:2.9,to:3,text:'结尾讲话'}],charCount:8,cachedAt:Date.now()};
    const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
    const result=await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch,requireStructured:true},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
    expect(result.result).toBe('done');expect(requests).toHaveLength(1);
    await db.delete();
  });

  it('21 分钟视频使用全部字幕，发现大纲只覆盖前段时重试并保留后半段要点', async () => {
    const db = freshDb();
    await db.videos.put({ key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '21 分钟长视频', cover: 'c', owner: 'up', duration: 1272, page: 1, fetchedAt: Date.now() });
    const longCues = Array.from({ length: 587 }, (_, i) => ({ from: i * 1270 / 587, to: (i + 1) * 1270 / 587, content: i === 586 ? '后半结论与片尾独有内容' : `内容${i}` }));
    const base = JSON.parse(validSummaryJson());
    const server = await startMockLlm((_call, n) => ({ chunks: [JSON.stringify({ ...base, outline: (n === 1 ? [0, 10, 11, 50, 70, 76, 150, 200, 408, 467] : [0, 250, 500, 750, 1000, 1200]).map(time => ({ time, text: `要点 ${time}` })) })] }));
    servers.push(server);
    const result = await runSummarizeJob({ db, bili: fakeBili({ cues: longCues }), llm: { baseUrl: server.url, model: 'm', apiKey: 'test-only' } }, { videoKey: VIDEO_KEY }, ctxLog().ctx);
    expect(server.calls[0]!.body.messages![1]!.content).toContain('后半结论与片尾独有内容');
    expect(server.calls).toHaveLength(2);
    expect(result.result).toBe('done');
    expect((await db.summaries.toArray())[0]!.outline.at(-1)!.time).toBe(1200);
    await db.delete();
  });

  it('长视频旧 ASR 无分段时间时等待用户确认，不生成伪时间摘要', async () => {
    const db = freshDb();
    await db.videos.put({ key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 'ASR 长视频', cover: 'c', owner: 'up', duration: 2400, page: 1, fetchedAt: Date.now() });
    await db.transcripts.put({ key: VIDEO_KEY, source: 'asr', lan: 'zh', cues: [{ from: 0, to: 2400, text: 'ASR 完整全文' }], charCount: 10, cachedAt: Date.now() });
    const base = JSON.parse(validSummaryJson());
    const server = await startMockLlm(() => ({ chunks: [JSON.stringify({ ...base, outline: base.outline.map((o: {text: string}) => ({ ...o, time: 0 })) })] }));
    servers.push(server);
    const result = await runSummarizeJob({ db, bili: fakeBili({subtitles:[]}), llm: { baseUrl: server.url, model: 'm', apiKey: 'test-only' } }, { videoKey: VIDEO_KEY }, ctxLog().ctx);
    expect(result.result).toBe('need_confirm');
    expect(server.calls).toHaveLength(0);
    await db.delete();
  });

  it('长视频两次都只给前段大纲时明确失败，不把不完整大纲保存成成功', async () => {
    const db = freshDb();
    await db.videos.put({ key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '长视频', cover: 'c', owner: 'up', duration: 2400, page: 1, fetchedAt: Date.now() });
    const base = JSON.parse(validSummaryJson());
    const server = await startMockLlm(() => ({ chunks: [JSON.stringify(base)] }));
    servers.push(server);
    const result = await runSummarizeJob({ db, bili: fakeBili({ cues: [{ from: 0, to: 30, content: '开始内容' }, { from: 2350, to: 2390, content: '后半结论' }] }), llm: { baseUrl: server.url, model: 'm', apiKey: 'test-only' } }, { videoKey: VIDEO_KEY }, ctxLog().ctx);
    expect(result.result).toBe('failed');
    expect((await db.summaries.toArray())[0]!.status).toBe('failed');
    await db.delete();
  });
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
    const bili = fakeBili({ subtitles: [] }); // 无轨；有轨但地址不可用另行提示
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili, llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome).toEqual({ result: 'need_confirm' });
    expect(server.calls).toHaveLength(0);
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.status).toBe('need_asr');
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.error?.code).toBe('AUTO_ASR_PENDING');
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
        return { chunks: ['[00:00] 要点甲\n[30:00] 要点乙\n[60:00] 要点丙\n[90:00] 要点丁\n[105:00] 结尾要点'] };
      }
      return { chunks: [JSON.stringify({ ...JSON.parse(validSummaryJson()), outline: [0, 900, 1800, 2700, 3600, 4500, 5400, 6300].map(time => ({ time, text: '章节要点' })) })] };
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

  it('截断的结构化输出不得写成已完成摘要，而应提示用户重新生成', async () => {
    const db = freshDb();
    await db.videos.put({ key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: 't',
      cover: '', owner: '', duration: 600, page: 1, fetchedAt: Date.now() });
    const server = await startMockLlm(() => ({ chunks: ['{"summary":"摘要", "outline":[{"time":9,'] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob({ db, bili: fakeBili({}), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } }, { videoKey: VIDEO_KEY }, ctx);
    expect(outcome.result).toBe('failed');
    const row = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(row?.status).toBe('failed');
    expect(row?.summary).not.toContain('{');
    expect(row?.error?.msg).toContain('重新生成');
    await db.delete();
  });

  it('字幕轨存在但内容为空时提供 ASR 手动确认，不自动调用模型', async () => {
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
    expect(outcome.result).toBe('need_confirm');
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.status).toBe('need_asr');
    expect((await db.summaries.get(summaryKey(VIDEO_KEY, 'm1')))?.error?.code).toBe('AUTO_ASR_PENDING');
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

  it('重生成只得到更少且不完整的大纲时保留旧摘要和已生成解读', async () => {
    const db = freshDb();
    await seedDone(db);
    const oldKey = summaryKey(VIDEO_KEY, 'm1');
    const oldOutline = Array.from({ length: 6 }, (_, i) => ({ time: i * 60, text: `旧要点${i}` }));
    await db.summaries.update(oldKey, { outline: oldOutline });
    const candidate = JSON.stringify({ summary: '新摘要', outline: [{ time: 0, text: '仅一个要点' }], evaluation: '新点评', rating: 4 });
    const server = await startMockLlm(() => ({ chunks: [candidate] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili: fakeBili({}), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } },
      { videoKey: VIDEO_KEY }, ctx, { force: true },
    );
    expect(outcome.result).toBe('failed');
    const row = await db.summaries.get(oldKey);
    expect(row?.summary).toBe('旧摘要');
    expect(row?.outline).toEqual(oldOutline);
    expect(row?.segmentNotes?.[0]?.text).toBe('旧注记');
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

  it('force + 字幕轨消失(no-track)：不覆盖旧 done 行为 need_asr，返回 failed 保留旧内容（审查 P0-1）', async () => {
    const db = freshDb();
    await seedDone(db);
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili: fakeBili({ subtitles: [] }), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } },
      { videoKey: VIDEO_KEY },
      ctx,
      { force: true },
    );
    expect(outcome.result).toBe('failed');
    if (outcome.result === 'failed') expect(outcome.error.code).toBe('NO_SUBTITLE');
    const row = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(row?.status).toBe('done');
    expect(row?.summary).toBe('旧摘要');
    expect(row?.segmentNotes?.[0]?.text).toBe('旧注记');
    expect(server.calls).toHaveLength(0); // 零 LLM
    await db.delete();
  });

  it('force + 字幕为空(NO_CONTENT)：不覆盖旧 done 行（审查 P0-1）', async () => {
    const db = freshDb();
    await seedDone(db);
    const server = await startMockLlm(() => ({ chunks: [validSummaryJson()] }));
    servers.push(server);
    const { ctx } = ctxLog();
    const outcome = await runSummarizeJob(
      { db, bili: fakeBili({ cues: [] }), llm: { baseUrl: server.url, model: 'm1', apiKey: 'k' } },
      { videoKey: VIDEO_KEY },
      ctx,
      { force: true },
    );
    expect(outcome.result).toBe('failed');
    if (outcome.result === 'failed') expect(outcome.error.code).toBe('NO_CONTENT');
    const row = await db.summaries.get(summaryKey(VIDEO_KEY, 'm1'));
    expect(row?.status).toBe('done');
    expect(row?.summary).toBe('旧摘要');
    await db.delete();
  });

  it('多模型口径（审查 P1-1）：B 模型 force 失败不顶掉展示中的 A 模型 done 行', async () => {
    const db = freshDb();
    await db.videos.put({
      key: VIDEO_KEY, bvid: 'BV1XynB6EEiM', aid: 1, cid: 123456, title: '测试视频',
      cover: 'c', owner: 'up', duration: 600, page: 1, fetchedAt: Date.now(),
    });
    await db.summaries.put({
      key: summaryKey(VIDEO_KEY, 'mA'), videoKey: VIDEO_KEY, source: 'ai_sub',
      summary: 'A摘要', outline: [{ time: 0, text: 'A大纲' }], evaluation: 'A点评', rating: 4,
      modelId: 'mA', persona: 'spicy', status: 'done', createdAt: 1,
    });
    const srv = http.createServer(() => {
      /* 收下请求但永不响应 */
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const { ctx } = ctxLog();
      const outcome = await runSummarizeJob(
        { db, bili: fakeBili({}), llm: { baseUrl: url, model: 'mB', apiKey: 'k' }, timeoutMs: 30 },
        { videoKey: VIDEO_KEY },
        ctx,
        { force: true },
      );
      expect(outcome.result).toBe('failed');
      expect(await db.summaries.get(summaryKey(VIDEO_KEY, 'mB'))).toBeUndefined(); // 不写 failed 行
      const latest = (await db.summaries.where('videoKey').equals(VIDEO_KEY).sortBy('createdAt')).pop();
      expect(latest?.modelId).toBe('mA'); // latestSummary 口径仍指向 A 的 done
      expect(latest?.status).toBe('done');
      await db.delete();
    } finally {
      srv.close();
    }
  });
});

it('存在中文字幕轨但地址不可用时提示字幕权限问题，不转成 ASR 确认',async()=>{
 const db=freshDb();await db.videos.put({key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'t',cover:'',owner:'',duration:60,page:1,fetchedAt:Date.now()});
 const outcome=await runSummarizeJob({db,bili:fakeBili({subtitles:[{lan:'zh-CN'}]}),llm:{baseUrl:'https://example.test',model:'m',apiKey:'k'}},{videoKey:VIDEO_KEY},ctxLog().ctx);
 expect(outcome).toMatchObject({result:'failed',error:{code:'SUBTITLE_UNAVAILABLE'}});expect((await db.summaries.get(summaryKey(VIDEO_KEY,'m')))?.status).toBe('failed');await db.delete();
});

it('字幕服务明确要求登录时，不得误报无字幕而进入付费 ASR',async()=>{
 const db=freshDb();await db.videos.put({key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'t',cover:'',owner:'',duration:60,page:1,fetchedAt:Date.now()});
 const bili=fakeBili({subtitles:[]});bili.getPlayerSubtitles=async()=>({subtitles:[],needLoginSubtitle:true});
 const outcome=await runSummarizeJob({db,bili,llm:{baseUrl:'https://example.test',model:'m',apiKey:'k'}},{videoKey:VIDEO_KEY},ctxLog().ctx);
 expect(outcome).toMatchObject({result:'failed',error:{code:'NEED_LOGIN'}});await db.delete();
});

it('人工中文字幕地址不可用但中文 AI 字幕可用时继续选择 AI 字幕',async()=>{
 const db=freshDb();await db.videos.put({key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'t',cover:'',owner:'',duration:60,page:1,fetchedAt:Date.now()});
 const server=await startMockLlm(()=>({chunks:[validSummaryJson()]}));servers.push(server);
 const outcome=await runSummarizeJob({db,bili:fakeBili({subtitles:[{lan:'zh-CN'},{lan:'ai-zh',subtitle_url:'//x/ai.json'}]}),llm:{baseUrl:server.url,model:'m',apiKey:'k'}},{videoKey:VIDEO_KEY},ctxLog().ctx);
 expect(outcome.result).toBe('done');expect((await db.transcripts.get(VIDEO_KEY))?.source).toBe('ai_sub');await db.delete();
});

it('已验证的豆包完整转写按句送摘要，时间取首词，异常缓存回退词级且旧字幕不改变', async()=>{
 const db=freshDb(); const bodies:any[]=[];
 const output=JSON.parse(validSummaryJson());output.outline=[1,1,1,2,2,2].map(time=>({time,text:'要点'}));
 const fetchImpl=async(_input:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(output)}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};
 const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 const words=[{text:'开始',startMs:1200,endMs:1800},{text:'挑战任务',startMs:2400,endMs:3000}];
 const cues=words.map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues,charCount:6,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text:'开始挑战任务',utterances:[{text:'开始挑战任务',startMs:10000,endMs:11000,definite:true,words}]},cues}]};
 const call=async(t:typeof transcript)=>runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript:t,baseSummary,keepDone:false});
 await call(transcript);
 expect(bodies[0].messages[1].content).toContain('[1秒]开始挑战任务');
 expect(bodies[0].messages[1].content).not.toContain('[2秒]挑战任务');
 expect(bodies[0].messages[0].content).toContain('首次明确出现');
 const tampered={...transcript,cues:[cues[0]!,{...cues[1]!,from:5}]};expect(await call(tampered)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});expect(bodies).toHaveLength(1);
 await call({...transcript,asrComplete:false});expect(bodies[1].messages[1].content).toContain('[1秒]开始\n[2秒]挑战任务');
 await call({...transcript,source:'ai_sub' as 'asr'});expect(bodies[2].messages[1].content).toContain('[00:01]开始\n[00:02]挑战任务');expect(bodies[2].messages[0].content).not.toContain('首次明确出现');
 const noWords={...transcript,asrParts:[{...transcript.asrParts[0]!,result:{text:'开始挑战任务',utterances:[{text:'开始挑战任务',startMs:1200,endMs:3000,definite:true,words:[]}]}}]};await call(noWords);expect(bodies[3].messages[1].content).toContain('[1秒]开始\n[2秒]挑战任务');
 const symbolWords=[{text:'C++',startMs:1200,endMs:1800},{text:'+5%',startMs:2400,endMs:3000}];const symbolCues=symbolWords.map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));const symbols={...transcript,cues:symbolCues,asrParts:[{...transcript.asrParts[0]!,result:{text:'C 5',utterances:[{text:'C 5',startMs:1200,endMs:3000,definite:true,words:symbolWords}]}}]};expect(await call(symbols)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 const punctuation={...transcript,asrParts:[{...transcript.asrParts[0]!,result:{text:'开始，挑战任务！',utterances:[{text:'开始，挑战任务！',startMs:1200,endMs:3000,definite:true,words}]}}]};await call(punctuation);expect(bodies[4].messages[1].content).toContain('[1秒]开始，挑战任务！');expect(bodies[4].messages[0].content).toContain('首次明确出现');
 const timeWords=[{text:'12：30',startMs:1200,endMs:1800},{text:'1:2',startMs:2400,endMs:3000}];const timeCues=timeWords.map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));const times={...transcript,cues:timeCues,asrParts:[{...transcript.asrParts[0]!,result:{text:'1230 1:2',utterances:[{text:'1230 1:2',startMs:1200,endMs:3000,definite:true,words:timeWords}]}}]};expect(await call(times)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 const asciiTimes={...times,asrParts:[{...times.asrParts[0]!,result:{text:'12：30 12',utterances:[{text:'12：30 12',startMs:1200,endMs:3000,definite:true,words:timeWords}]}}]};expect(await call(asciiTimes)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 const spaceWords=[{text:'a',startMs:1200,endMs:1800},{text:' part',startMs:2400,endMs:3000}];const spaceCues=spaceWords.map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));const spaces={...transcript,cues:spaceCues,asrParts:[{...transcript.asrParts[0]!,result:{text:'apart',utterances:[{text:'apart',startMs:1200,endMs:3000,definite:true,words:spaceWords}]}}]};expect(await call(spaces)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 const chineseSpace={...transcript,asrParts:[{...transcript.asrParts[0]!,result:{text:'开始 挑战任务',utterances:[{text:'开始 挑战任务',startMs:1200,endMs:3000,definite:true,words}]}}]};await call(chineseSpace);expect(bodies[5].messages[1].content).toContain('[1秒]开始 挑战任务');expect(bodies[5].messages[0].content).toContain('首次明确出现');
 const spacedWords=[{text:'What',startMs:1200,endMs:1800},{text:' ',startMs:1800,endMs:1900},{text:'the',startMs:2400,endMs:3000}];const spacedCues=spacedWords.filter(w=>w.text.trim()).map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));const blanks={...transcript,cues:spacedCues,asrParts:[{...transcript.asrParts[0]!,result:{text:'What the',utterances:[{text:'What the',startMs:1200,endMs:3000,definite:true,words:spacedWords}]}}]};await call(blanks);expect(bodies[6].messages[1].content).toContain('[1秒]What the');expect(bodies[6].messages[0].content).toContain('首次明确出现');
 expect(bodies).toHaveLength(7);
 expect(transcript.cues).toEqual(cues);await db.delete();
});

it('长豆包句级转写分块与合并均要求章节主题起点',async()=>{
 const db=freshDb(), bodies:any[]=[];
 const fetchImpl=async(_input:unknown,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));bodies.push(b);const map=b.messages[0].content.includes('视频字幕片段分析器');const content=map?'[0秒] 开始挑战':validSummaryJson();return new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
 const utterances=Array.from({length:20},(_,i)=>{const text='话'.repeat(800);return {text,startMs:i*1000,endMs:i*1000+900,definite:true,words:[{text,startMs:i*1000,endMs:i*1000+900}]};});
 const cues=utterances.map(u=>({from:u.startMs/1000,to:u.endMs/1000,text:u.text}));
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues,charCount:16000,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text:utterances.map(u=>u.text).join(''),utterances},cues}]};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
 expect(bodies.some(b=>b.messages[0].content.includes('视频字幕片段分析器'))).toBe(true);
 for(const b of bodies)expect(b.messages[0].content).toContain('首次明确出现');
 const reduce=bodies.find(b=>!b.messages[0].content.includes('视频字幕片段分析器'));expect(reduce.messages[0].content).toContain('Map 要点');expect(reduce.messages[0].content).toContain('最早');
 await db.delete();
});

it('超长句不能使分块超预算，安全回退原词级输入且不丢文字',async()=>{
 const db=freshDb(), bodies:any[]=[];
 const fetchImpl=async(_input:unknown,init?:RequestInit)=>{const b=JSON.parse(String(init?.body));bodies.push(b);const map=b.messages[0].content.includes('视频字幕片段分析器');const content=map?'[0秒] 内容':validSummaryJson();return new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
 const words=[{text:'甲'.repeat(8000),startMs:1000,endMs:2000},{text:'乙'.repeat(8000),startMs:2000,endMs:3000}];const cues=words.map(w=>({from:w.startMs/1000,to:w.endMs/1000,text:w.text}));const text=words.map(w=>w.text).join('');
 const transcript={key:VIDEO_KEY,source:'asr' as const,lan:'zh',cues,charCount:text.length,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:600,whole:true,result:{text,utterances:[{text,startMs:1000,endMs:3000,definite:true,words}]},cues}]};
 const video={key:VIDEO_KEY,bvid:'BV1XynB6EEiM',aid:1,cid:123456,title:'视频',cover:'',owner:'',duration:600,page:1,fetchedAt:Date.now()};const baseSummary={key:summaryKey(VIDEO_KEY,'m'),videoKey:VIDEO_KEY,source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1};
 await runLlmAndPersist({db,bili:fakeBili({}),llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'x'},fetchImpl:fetchImpl as typeof fetch},ctxLog().ctx,{video,transcript,baseSummary,keepDone:false});
 const maps=bodies.filter(b=>b.messages[0].content.includes('视频字幕片段分析器'));
 expect(maps.length).toBeGreaterThan(1);expect(maps.some(b=>b.messages[1].content.includes('[1秒]'+words[0]!.text))).toBe(true);expect(maps.some(b=>b.messages[1].content.includes('[2秒]'+words[1]!.text))).toBe(true);
 for(const b of maps){expect(b.messages[1].content).not.toContain(text);expect(b.messages[0].content).not.toContain('首次明确出现');}
 await db.delete();
});
