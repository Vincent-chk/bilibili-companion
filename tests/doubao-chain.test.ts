import { afterEach, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { CompanionDB, summaryKey } from '../src/lib/storage';
import { runAsrJob } from '../src/lib/summarize/asr';
import type { DoubaoFrame } from '../src/lib/asr/doubao';
import { isRecoveryCandidate, timedCues } from '../src/lib/asr/doubao';

const dbs: CompanionDB[]=[];

it.each([
 ['词句越界',{text:'真实讲话',utterances:[{text:'真实讲话',startMs:1000,endMs:2000,definite:true,words:[{text:'真实讲话',startMs:50000,endMs:51000}]}]}],
 ['句子倒序',{text:'甲乙',utterances:[{text:'甲',startMs:5000,endMs:6000,definite:true,words:[{text:'甲',startMs:5000,endMs:5100}]},{text:'乙',startMs:1000,endMs:7000,definite:true,words:[{text:'乙',startMs:6000,endMs:6100}]}]}],
] as const)('拒绝%s并保留原始文字，重试不自动重传',async(_name,result)=>{
 const f=await fixture(60);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:60000,result}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 const transcript=await f.db.transcripts.get(f.job.videoKey);expect(transcript?.asrComplete).toBe(false);expect(transcript?.asrParts?.[0]?.result).toEqual(result);
 expect(f.llm).not.toHaveBeenCalled();await runAsrJob(f.deps,f.job,f.ctx);expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});

it('合法无词级句子与轻微句词边界差异仍可使用',()=>{
 expect(timedCues({text:'你好',utterances:[{text:'你好',startMs:1000,endMs:2000,definite:true,words:[]}]},0,60)).toEqual([{from:1,to:2,text:'你好'}]);
 expect(timedCues({text:'你好',utterances:[{text:'你好',startMs:1000,endMs:2000,definite:true,words:[{text:'你好',startMs:900,endMs:2100}]}]},0,60)).toEqual([{from:.9,to:2.1,text:'你好'}]);
});

it('句词时间越界的恢复候选不能被复用',()=>{
 const cues=[{from:50,to:51,text:'真实讲话'}];const candidate={key:'v',source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrDuration:60,asrParts:[{start:0,end:60,whole:true,serviceDurationMs:60000,cues,result:{text:'真实讲话',utterances:[{text:'真实讲话',startMs:1000,endMs:2000,definite:true,words:[{text:'真实讲话',startMs:50000,endMs:51000}]}]}}]};
 expect(isRecoveryCandidate(candidate,'v',60)).toBe(false);
});
afterEach(async()=>{for(const db of dbs.splice(0)) await db.delete()});
async function fixture(duration=35) {
 const db=new CompanionDB(`phase42-${Math.random()}`,{indexedDB,IDBKeyRange}); dbs.push(db);
 const videoKey='BV1test12345:777',job={id:'j',videoKey,sessionId:'s',runId:'run-1'};
 await db.sessions.put({id:'s',state:'ACTIVE',startedAt:1,lastActiveAt:1});
 await db.jobs.put({id:'j',videoKey,sessionId:'s',runId:'run-1',type:'ASR_SUMMARIZE',status:'running',progress:0,retries:0,createdAt:1,updatedAt:1});
 await db.videos.put({key:videoKey,bvid:'BV1test12345',aid:1,cid:777,title:'测试',cover:'',owner:'',duration,page:1,fetchedAt:Date.now()});
 const bili={fetchWbiKeys:async()=>'x',getPlayUrlAudio:async()=>[{id:1,bandwidth:1,baseUrl:'https://upos-sz-x.bilivideo.com/a.m4s',backupUrl:[]}],getView:async()=>{throw Error('unexpected')},getPlayerSubtitles:async()=>{throw Error('unexpected')},fetchTranscript:async()=>{throw Error('unexpected')}};
 const final={summary:'简体中文摘要内容。'.repeat(22),outline:[0,1,2,3,4,5].map(i=>({time:i,text:'视频内容'})),evaluation:'这是基于视频语音内容生成的点评。'.repeat(4),rating:4};
 const llm=vi.fn(async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200,headers:{'content-type':'text/event-stream'}}));
 const frame=(n:number):DoubaoFrame=>({final:true,audioDurationMs:duration*1000,result:{text:n===0?'第一句话内容':'第二句话内容',utterances:[{text:n===0?'第一句话内容':'第二句话内容',startMs:n===0?1000:2000,endMs:n===0?2000:3000,definite:true,words:[{text:n===0?'第一句话内容':'第二句话内容',startMs:n===0?1000:2000,endMs:n===0?2000:3000}]}]}});
 const transcribe=vi.fn(async (_pcm:Uint8Array,index:number)=>frame(index));
 const extract=vi.fn(async(_blob:Blob,seconds:number)=>new Uint8Array(Math.round(seconds*16000)*2));
 const updates:{processedUntil:number;status:string}[]=[];
 const deps:any={db,bili,llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'k'},asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'k'},asrMaxMB:25,fetchAudio:async()=>new Response(new Uint8Array(64)),fetchImpl:llm,getAudioDuration:async()=>duration,decodeWholeAudio:extract,transcribePcm:transcribe,makeLocalNote:async(_c:any,index:number)=>`第${index+1}段局部要点`,onAsrPartial:async()=>{const row=await db.summaries.get(summaryKey(videoKey,'m'));if(row?.asrProgress)updates.push({processedUntil:row.asrProgress.processedUntil,status:row.asrProgress.status})}};
 return {db,job,deps,transcribe,extract,llm,updates,ctx:{update:async()=>{}}};
}

it('全片识别后逐段保存局部要点，全部完成后才生成全片摘要',async()=>{
 const f=await fixture(370);const result=await runAsrJob(f.deps,f.job,f.ctx);
 expect(result.result).toBe('done');expect(f.transcribe).toHaveBeenCalledTimes(1);
 expect(f.updates.some(x=>x.processedUntil===180&&x.status==='running')).toBe(true);
 const tr=await f.db.transcripts.get(f.job.videoKey);expect(tr?.asrComplete).toBe(true);
 const summary=await f.db.summaries.get(summaryKey(f.job.videoKey,'m'));expect(summary?.status).toBe('done');expect(summary?.source).toBe('asr');
});

it('语音局部要点明确告知模型没有画面输入',async()=>{
 const f=await fixture(10);delete f.deps.makeLocalNote;
 const systems:string[]=[];
 const final={summary:'简体中文摘要内容。'.repeat(22),outline:[0,1,2,3,4,5].map(i=>({time:i,text:'视频内容'})),evaluation:'语音内容的点评。'.repeat(8),rating:4};
 f.deps.fetchImpl=async(_input:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));const system=String(body.messages[0].content);systems.push(system);const output=system.includes('字幕片段分析器')?'[00:01] 语音要点':JSON.stringify(final);return new Response(`data: ${JSON.stringify({choices:[{delta:{content:output}}]})}\n\ndata: [DONE]\n\n`,{status:200});};
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 const local=systems.find(s=>s.includes('字幕片段分析器'));
 expect(local).toContain('不包含视频画面');expect(local).toContain('不能因为语音没有提到');
});

it('最终摘要失败后重试可复用已完成转写，不再发送音频',async()=>{
 const f=await fixture(10);f.deps.fetchImpl=vi.fn(async()=>new Response('',{status:500}));
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect(f.transcribe).toHaveBeenCalledTimes(1);
 f.deps.fetchImpl=f.llm;expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');expect(f.transcribe).toHaveBeenCalledTimes(1);
});

async function recoveryFixture() {
 const f=await fixture(10);const cues=[{from:1,to:2,text:'温度5度'}];const original={key:f.job.videoKey,source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrDuration:10,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};
 const old={key:summaryKey(f.job.videoKey,'m'),videoKey:f.job.videoKey,source:'asr' as const,summary:'旧摘要',outline:[{time:1,text:'旧大纲'}],evaluation:'旧点评',rating:4,modelId:'m',persona:'spicy',createdAt:1,status:'done' as const};
 await f.db.transcripts.put(original);await f.db.summaries.put(old);const recovery={original};await f.db.jobs.update(f.job.id,{recovery} as any);
 return {...f,original,old,job:{...f.job,recovery}};
}

it('恢复候选必须核实句级内容、时间、最终状态、视频身份与时长', () => {
 const cue={from:1,to:2,text:'真实的句子'};
 const candidate={key:'BV1test12345:777',source:'asr' as const,lan:'asr',cues:[cue],charCount:5,cachedAt:Date.now(),asrComplete:true,asrDuration:10,asrParts:[{start:0,end:10,whole:true,serviceDurationMs:10000,cues:[cue],result:{text:cue.text,utterances:[{text:cue.text,startMs:1000,endMs:2000,definite:true,words:[]}]}}]};
 const check=(t:typeof candidate, key='BV1test12345:777', duration=10)=>isRecoveryCandidate(t,key,duration);
 expect(check(candidate)).toBe(true);
 for(const edit of [
  (t:typeof candidate)=>{t.asrParts[0]!.result.utterances[0]!.definite=false},
  (t:typeof candidate)=>{t.asrParts[0]!.result.utterances[0]!.startMs=3000},
  (t:typeof candidate)=>{t.cues[0]!.text='错误的句子'},
  (t:typeof candidate)=>{t.cues[0]!.from=5},
  (t:typeof candidate)=>{t.key='BV1test12345:778'},
  (t:typeof candidate)=>{t.key='BV2test12345:777'},
 ]){const broken=structuredClone(candidate);edit(broken);expect(check(broken)).toBe(false)}
 expect(check(candidate,'BV1test12345:777',776)).toBe(false);
 expect(check(candidate,'BV1test12345:777',9.94)).toBe(false);
 expect(check(candidate,'BV1test12345:777',10.6)).toBe(true);
});

it('冲突恢复：识别或摘要失败不覆盖旧原文及旧摘要，显式重试复用候选',async()=>{
 const f=await recoveryFixture();f.deps.fetchImpl=vi.fn(async()=>new Response('',{status:500}));
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(f.original);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
 const job=await f.db.jobs.get(f.job.id);expect((job as any)?.recovery?.candidate?.asrComplete).toBe(true);expect(f.transcribe).toHaveBeenCalledTimes(1);
 f.deps.fetchImpl=f.llm;expect((await runAsrJob(f.deps,{...f.job,recovery:(job as any).recovery},f.ctx)).result).toBe('done');expect(f.transcribe).toHaveBeenCalledTimes(1);
 expect(await f.db.transcripts.get(f.job.videoKey)).not.toEqual(f.original);expect((await f.db.summaries.get(f.old.key))?.summary).not.toBe('旧摘要');
});

it.each(['same-bv-other-cid','other-bv','short','long'] as const)('异常候选 %s 不调用模型或修改两边记录',async(kind)=>{
 const f=await recoveryFixture();f.deps.fetchImpl=vi.fn(async()=>new Response('',{status:500}));
 await runAsrJob(f.deps,f.job,f.ctx);const saved=(await f.db.jobs.get(f.job.id))!.recovery!;
 const candidate=structuredClone(saved.candidate!);
 if(kind==='same-bv-other-cid')candidate.key='BV1test12345:778';
 if(kind==='other-bv')candidate.key='BV2test12345:777';
 if(kind==='short'||kind==='long'){const d=kind==='short'?5:10.06;candidate.asrDuration=d;candidate.asrParts![0]!.end=d;candidate.asrParts![0]!.serviceDurationMs=d*1000;}
 const other={...f.original,key:candidate.key};if(candidate.key!==f.job.videoKey)await f.db.transcripts.put(other);
 const recovery={...saved,candidate};await f.db.jobs.update(f.job.id,{recovery});f.llm.mockClear();f.transcribe.mockClear();f.deps.fetchImpl=f.llm;
 expect(await runAsrJob(f.deps,{...f.job,recovery},f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_RECOVERY_CHANGED'}});
 expect(f.llm).not.toHaveBeenCalled();expect(f.transcribe).not.toHaveBeenCalled();expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(f.original);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
 if(candidate.key!==f.job.videoKey)expect(await f.db.transcripts.get(candidate.key)).toEqual(other);
});

it('最终提交前视频时长改变时不覆盖旧原文和摘要',async()=>{
 const f=await recoveryFixture();f.deps.makeLocalNote=async()=>{await f.db.videos.update(f.job.videoKey,{duration:100});return '局部要点'};
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(f.original);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
});

it('冲突恢复发送前标记计费未知，失败后保留旧原文及旧摘要',async()=>{
 const f=await recoveryFixture();f.deps.transcribePcm=vi.fn(async()=>{expect((await f.db.jobs.get(f.job.id) as any)?.recovery?.pending).toBe(true);throw new Error('ASR_CONNECTION_CLOSED');});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect((await f.db.jobs.get(f.job.id) as any)?.recovery?.pending).toBe(true);
 expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(f.original);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
});

it('冲突恢复期间原始转写已变更时拒绝提交候选与摘要',async()=>{
 const f=await recoveryFixture();const other={...f.original,cachedAt:f.original.cachedAt+1};f.deps.makeLocalNote=async()=>{await f.db.transcripts.put(other);return '局部要点'};
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(other);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
});

it('冲突恢复成功时保留其他模型的旧摘要并标记其时间线过时',async()=>{
 const f=await recoveryFixture();const other={...f.old,key:summaryKey(f.job.videoKey,'other'),modelId:'other',summary:'另一模型的旧摘要'};await f.db.summaries.put(other);
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');expect(await f.db.summaries.get(other.key)).toEqual({...other,asrOutdated:true});
 expect((await f.db.summaries.get(f.old.key))?.asrOutdated).not.toBe(true);expect((await f.db.jobs.get(f.job.id) as any)?.recovery?.committed).toBe(true);
});

it('冲突恢复中清除会话与数据后迟到结果不得复活任何记录',async()=>{
 const f=await recoveryFixture();let release!:(frame:DoubaoFrame)=>void;let start!:()=>void;const started=new Promise<void>(r=>{start=r});
 f.deps.transcribePcm=()=>{start();return new Promise<DoubaoFrame>(r=>{release=r})};const work=runAsrJob(f.deps,f.job,f.ctx);await started;
 await f.db.transaction('rw',f.db.jobs,f.db.sessions,f.db.transcripts,f.db.summaries,async()=>{await f.db.jobs.clear();await f.db.sessions.clear();await f.db.transcripts.clear();await f.db.summaries.clear()});
 release({final:true,audioDurationMs:10000,result:{text:'稍后返回的内容',utterances:[{text:'稍后返回的内容',startMs:100,endMs:900,definite:true,words:[]}]}});
 await work;expect(await f.db.transcripts.count()).toBe(0);expect(await f.db.summaries.count()).toBe(0);expect(await f.db.jobs.count()).toBe(0);
});

it('冲突恢复在 GRACE 切回 ACTIVE 后保留计费不明状态，不自动重传',async()=>{
 const f=await recoveryFixture();await f.db.sessions.update('s',{state:'GRACE'});let release!:(frame:DoubaoFrame)=>void;let start!:()=>void;const started=new Promise<void>(r=>{start=r});
 f.deps.transcribePcm=vi.fn(()=>{start();return new Promise<DoubaoFrame>(r=>{release=r})});const work=runAsrJob(f.deps,f.job,f.ctx);await started;
 expect((await f.db.jobs.get(f.job.id))?.recovery?.pending).toBe(true);await f.db.sessions.update('s',{state:'ACTIVE'});
 release({final:true,audioDurationMs:10000,result:{text:'迟到的识别结果',utterances:[{text:'迟到的识别结果',startMs:100,endMs:900,definite:true,words:[]}]}});
 expect(await work).toMatchObject({result:'failed',error:{code:'ASR_JOB_STALE'}});expect((await f.db.jobs.get(f.job.id))?.recovery?.pending).toBe(true);
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(f.original);expect(await f.db.summaries.get(f.old.key)).toEqual(f.old);
});

it.each([0,25*60*60*1000])('旧的豆包完成缓存词句语义不一致时不发模型和音频且保留旧数据，缓存年龄 %s 毫秒',async(age)=>{
 const f=await fixture(10);const cues=[{from:1,to:2,text:'温度5度'}];const words=[{text:'温度5度',startMs:1000,endMs:2000}];
 const transcript={key:f.job.videoKey,source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now()-age,asrComplete:true,asrDuration:10,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words}]},cues}]};
 await f.db.transcripts.put(transcript);f.deps.fetchAudio=vi.fn(f.deps.fetchAudio);
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED'}});
 expect(f.transcribe).not.toHaveBeenCalled();expect(f.deps.fetchAudio).not.toHaveBeenCalled();expect(f.llm).not.toHaveBeenCalled();expect(await f.db.transcripts.get(f.job.videoKey)).toEqual(transcript);
});

it('清除任务后迟到的识别结果不会重新写入转写或摘要',async()=>{
 const f=await fixture(10);let release!:(f:DoubaoFrame)=>void;let start!:()=>void;const started=new Promise<void>(r=>{start=r});
 f.deps.transcribePcm=()=>{start();return new Promise<DoubaoFrame>(r=>{release=r})};
 const running=runAsrJob(f.deps,f.job,f.ctx);await started;await f.db.transaction('rw',f.db.jobs,f.db.summaries,f.db.transcripts,async()=>{await f.db.jobs.clear();await f.db.summaries.clear();await f.db.transcripts.clear()});
 release({final:true,audioDurationMs:10000,result:{text:'迟到',utterances:[{text:'迟到',startMs:0,endMs:1000,definite:true,words:[]}]}});await running;
 expect(await f.db.transcripts.count()).toBe(0);expect(await f.db.summaries.count()).toBe(0);
});

it('时间戳缺失的非空转写不得在重试时被当成静音或完整结果',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'这是没有时间戳的真实讲话',utterances:[]}}));
 const first=await runAsrJob(f.deps,f.job,f.ctx);expect(first).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 const second=await runAsrJob(f.deps,f.job,f.ctx);expect(second).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);
});

it.each([
 ['没有句子', {text:'真实内容',utterances:[]}, '缺少句子'],
 ['顶层与句子不一致', {text:'真实内容',utterances:[{text:'不同内容',startMs:100,endMs:900,definite:true,words:[]}]}, '顶层文字与句子不一致'],
 ['句词不一致', {text:'真实内容',utterances:[{text:'真实内容',startMs:100,endMs:900,definite:true,words:[{text:'真实',startMs:100,endMs:900}]}]}, '词语与句子不一致'],
 ['句子缺少时间', {text:'真实内容',utterances:[{text:'真实内容',startMs:null,endMs:900,definite:true,words:[]}]}, '句子缺少时间'],
 ['句子超出范围', {text:'真实内容',utterances:[{text:'真实内容',startMs:100,endMs:11000,definite:true,words:[]}]}, '句子时间超出片段'],
 ['词语缺少时间', {text:'真实内容',utterances:[{text:'真实内容',startMs:100,endMs:900,definite:true,words:[{text:'真实内容',startMs:null,endMs:900}]}]}, '词语缺少时间'],
 ['词语时间倒序', {text:'前后',utterances:[{text:'前后',startMs:100,endMs:900,definite:true,words:[{text:'前',startMs:500,endMs:900},{text:'后',startMs:100,endMs:400}]}]}, '词语时间倒序'],
 ['词语重叠', {text:'前后',utterances:[{text:'前后',startMs:100,endMs:900,definite:true,words:[{text:'前',startMs:100,endMs:700},{text:'后',startMs:300,endMs:900}]}]}, '词语时间重叠'],
])('已有缓存重试不发送音频，显示脱敏原因：%s',async(_label,result,reason)=>{
 const f=await fixture(10);await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues:[],charCount:0,cachedAt:Date.now(),asrComplete:false,asrDuration:10,asrParts:[{start:0,end:10,result,cues:[],whole:true,serviceDurationMs:10000}]});
 f.deps.fetchAudio=vi.fn(f.deps.fetchAudio);
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning).toContain(reason);
 expect(f.deps.transcribePcm).not.toHaveBeenCalled();expect(f.extract).not.toHaveBeenCalled();expect(f.deps.fetchAudio).not.toHaveBeenCalled();expect(f.llm).not.toHaveBeenCalled();
});

it('首次收到无效词级时间时展示脱敏原因并保留原始片段',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'隐私内容',utterances:[{text:'隐私内容',startMs:100,endMs:900,definite:true,words:[{text:'隐私内容',startMs:null,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 const warning=(await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning;
 expect(warning).toContain('词语缺少时间');expect(warning).not.toContain('隐私内容');expect((await f.db.transcripts.get(f.job.videoKey))?.asrParts).toHaveLength(1);
});

it('全片识别中断时记录计费不明，用户重试后才再次发送',async()=>{
 const f=await fixture();const original=f.transcribe;let failed=false;
 f.deps.transcribePcm=vi.fn(async(pcm:Uint8Array,index:number)=>{if(!failed){failed=true;throw new Error('ASR_CONNECTION_CLOSED')}return original(pcm,index)});
 const first=await runAsrJob(f.deps,f.job,f.ctx);expect(first.result).toBe('failed');
 const partial=await f.db.summaries.get(summaryKey(f.job.videoKey,'m'));expect(partial?.asrProgress).toMatchObject({processedUntil:0,status:'partial'});expect(partial?.asrProgress?.warning).toContain('计费');
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrPending).toEqual({start:0,end:35});expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect(f.deps.transcribePcm.mock.calls.map((x:any[])=>x[1])).toEqual([0,0]);
});

it('短讲话保留为转写并提示内容不足，不误报没有声音',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'你好',utterances:[{text:'你好',startMs:100,endMs:900,definite:true,words:[{text:'你好',startMs:100,endMs:900}]}]}}));
 const result=await runAsrJob(f.deps,f.job,f.ctx);expect(result).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues[0]?.text).toBe('你好');
});

it('缺少 Content-Length 的超大音频在读取中被拒绝，不发送音频',async()=>{
 const f=await fixture(10);f.deps.asrMaxMB=0.00001;
 const result=await runAsrJob(f.deps,f.job,f.ctx);expect(result).toMatchObject({result:'failed',error:{code:'ASR_AUDIO_TOO_LARGE'}});expect(f.transcribe).not.toHaveBeenCalled();
});

it('旧设置超过 25 MiB 时豆包音轨仍在下载前拒绝超出项目上限的响应',async()=>{
 const f=await fixture(10);f.deps.asrMaxMB=100;
 f.deps.fetchAudio=vi.fn(async()=>new Response(new Uint8Array(1),{headers:{'content-length':String(26*1024*1024)}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_AUDIO_TOO_LARGE'}});
 expect(f.extract).not.toHaveBeenCalled();expect(f.transcribe).not.toHaveBeenCalled();
});

it('旧设置超过 25 MiB 且响应未声明大小时，读取超过项目上限立即拒绝',async()=>{
 const f=await fixture(10);f.deps.asrMaxMB=100;
 let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(26*1024*1024));},cancel(){cancelled=true;}});
 f.deps.fetchAudio=vi.fn(async()=>new Response(stream));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_AUDIO_TOO_LARGE'}});
 expect(cancelled).toBe(true);expect(f.extract).not.toHaveBeenCalled();expect(f.transcribe).not.toHaveBeenCalled();
});

it.each([['温度+5度','温度5度'],['比例1:2倍','比例12倍'],['价格12.5元','价格125元'],['增长50%了','增长50了']])('词级结果丢失含义符号时保留原文，不标记完成：%s',async(text,wordText)=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text,utterances:[{text,startMs:100,endMs:900,definite:true,words:[{text:wordText,startMs:100,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 const tr=await f.db.transcripts.get(f.job.videoKey);expect(tr?.asrComplete).toBe(false);expect(tr?.asrParts?.[0]?.result.text).toBe(text);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe(text);
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});

it('句子丢失顶层原文含义符号时保留原文并禁止完整摘要',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'温度+5度',utterances:[{text:'温度5度',startMs:100,endMs:900,definite:true,words:[{text:'温度5度',startMs:100,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe('温度+5度');expect(f.llm).not.toHaveBeenCalled();
});

it('句词英文空格丢失时保留原文，普通中文句读差异仍可接受',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'a part',utterances:[{text:'a part',startMs:100,endMs:900,definite:true,words:[{text:'apart',startMs:100,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toBe('a part');
 const g=await fixture(10);g.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'你好，美丽世界。',utterances:[{text:'你好美丽世界',startMs:100,endMs:900,definite:true,words:[{text:'你好美丽世界',startMs:100,endMs:900}]}]}}));
 expect((await runAsrJob(g.deps,g.job,g.ctx)).result).toBe('done');
});

it('会话结束后，迟到的识别结果不能写入或继续下一段',async()=>{
 const f=await fixture();let release!:(v:DoubaoFrame)=>void;let start!:()=>void;const started=new Promise<void>(r=>{start=r});
 f.deps.transcribePcm=vi.fn(()=>{start();return new Promise<DoubaoFrame>(r=>{release=r})});
 const work=runAsrJob(f.deps,f.job,f.ctx);await started;await f.db.sessions.update('s',{state:'GRACE'});
 release({final:true,audioDurationMs:35000,result:{text:'迟到',utterances:[{text:'迟到',startMs:0,endMs:1000,definite:true,words:[]}]}});
 expect(await work).toMatchObject({result:'failed',error:{code:'ASR_JOB_STALE'}});expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrParts).toHaveLength(0);
});

it('全片一次识别保留原切点前后内容和时间，不发生分段拼接',async()=>{
 const f=await fixture();f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:35000,result:{text:'交界之前不同内容',utterances:[{text:'交界之前',startMs:29000,endMs:29800,definite:true,words:[{text:'交界之前',startMs:29000,endMs:29800}]},{text:'不同内容',startMs:30000,endMs:30800,definite:true,words:[{text:'不同内容',startMs:30000,endMs:30800}]}]}}));
 const final={summary:'简体中文摘要内容。'.repeat(22),outline:[29,29,29,30,30,30].map(time=>({time,text:'视频内容'})),evaluation:'这是基于视频语音内容生成的点评。'.repeat(4),rating:4};
 f.deps.fetchImpl=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues.map(c=>[c.text,c.from])).toEqual([['交界之前',29],['不同内容',30]]);
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});

it('旧的不完整分段缓存不会直接标为全片，重识别失败时保留局部结果',async()=>{
 const f=await fixture(35);const left=[{text:'秘密甲',from:29.1,to:29.4},{text:'。',from:29.5,to:29.6}];const right=[{text:'秘密乙',from:29.15,to:29.45},{text:'！',from:29.52,to:29.62}];
 const result=(text:string)=>({text,utterances:[{text,startMs:100,endMs:500,definite:true,words:[]}]});
 await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues:left,charCount:3,cachedAt:Date.now(),asrComplete:false,asrDuration:35,asrParts:[{start:0,end:30,result:result('秘密甲'),cues:left},{start:29,end:35,result:result('秘密乙'),cues:right}]});
 await f.db.summaries.put({key:summaryKey(f.job.videoKey,'m'),videoKey:f.job.videoKey,source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',status:'need_asr',createdAt:1,asrProgress:{sessionId:'s',processedUntil:30,targetDuration:35,status:'partial',parts:[{from:0,to:30,text:'已生成的局部要点'}]}});
 f.deps.transcribePcm=vi.fn(async()=>{throw new Error('ASR_CONNECTION_CLOSED')});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');
 const tr=await f.db.transcripts.get(f.job.videoKey);expect(tr?.asrComplete).toBe(false);expect(tr?.cues).toEqual(left);expect(tr?.asrParts).toHaveLength(2);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.parts[0]?.text).toBe('已生成的局部要点');expect(f.llm).not.toHaveBeenCalled();
});

it('视频整数时长和音轨实际时长略有差异时按真实音轨处理尾段',async()=>{
 const f=await fixture(32);f.deps.getAudioDuration=async()=>31.75;
 f.deps.transcribePcm=async(_pcm:Uint8Array,i:number)=>({final:true,audioDurationMs:31750,result:{text:i?'第二句话内容':'第一句话内容',utterances:[{text:i?'第二句话内容':'第一句话内容',startMs:i?1000:1000,endMs:i?2000:2000,definite:true,words:[{text:i?'第二句话内容':'第一句话内容',startMs:1000,endMs:2000}]}]}});
 const result=await runAsrJob(f.deps,f.job,f.ctx);expect(result.result).toBe('done');
 expect(f.extract).toHaveBeenCalledTimes(1);expect(f.extract.mock.calls[0]?.[1]).toBe(31.75);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.processedUntil).toBe(31.75);
});

it('音轨与视频长度明显不一致时不发送音频或假称完整',async()=>{
 const f=await fixture(32);f.deps.getAudioDuration=async()=>24;
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_DURATION_MISMATCH'}});
 expect(f.transcribe).not.toHaveBeenCalled();
});

it.each([
 ['服务只处理了前 30 秒',30000,'ASR_SERVICE_DURATION_MISMATCH'],
 ['服务没有提供处理时长',undefined,'ASR_SERVICE_DURATION_UNKNOWN'],
])('%s 时不能生成完整摘要，重试复用原始结果',async(_label,audioDurationMs,code)=>{
 const f=await fixture(370);const original=f.transcribe;
 f.deps.transcribePcm=vi.fn(async(pcm:Uint8Array,index:number)=>({...await original(pcm,index),audioDurationMs}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);expect(f.llm).not.toHaveBeenCalled();
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code}});
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});

it('最终帧中未确认的语句不得当作已确认片段或完整摘要',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'没有确认的语音内容',utterances:[{text:'没有确认的语音内容',startMs:100,endMs:900,definite:false,words:[{text:'没有确认的语音内容',startMs:100,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_UNCONFIRMED'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);
});

it('词级文字没有覆盖整句时不得静默丢失原文',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'这句话中间不能遗漏',utterances:[{text:'这句话中间不能遗漏',startMs:100,endMs:900,definite:true,words:[{text:'这句话',startMs:100,endMs:400},{text:'不能遗漏',startMs:500,endMs:900}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);
});

it('忽略没有内容的词条，但保留带时间的非空标点和文字',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'你好，美丽世界',utterances:[{text:'你好，美丽世界',startMs:100,endMs:1000,definite:true,words:[{text:'',startMs:null,endMs:null},{text:'你好',startMs:100,endMs:400},{text:'  ',startMs:null,endMs:null},{text:'，',startMs:400,endMs:500},{text:'美丽世界',startMs:500,endMs:1000}]}]}}));
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues.map(c=>c.text)).toEqual(['你好','，','美丽世界']);
});

it('非空标点缺少时间时依然拒绝，不会当作空白丢弃',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'你好，世界',utterances:[{text:'你好，世界',startMs:100,endMs:1000,definite:true,words:[{text:'你好',startMs:100,endMs:400},{text:'，',startMs:null,endMs:null},{text:'世界',startMs:500,endMs:1000}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning).toContain('词语缺少时间');
});

it('重新检查含空白词的缓存后继续处理，复用已识别内容且不重发音频',async()=>{
 const f=await fixture(10);const result={text:'你好美丽世界',utterances:[{text:'你好美丽世界',startMs:100,endMs:900,definite:true,words:[{text:'你好',startMs:100,endMs:400},{text:' ',startMs:null,endMs:null},{text:'美丽世界',startMs:500,endMs:900}]}]};
 await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues:[],charCount:0,cachedAt:Date.now(),asrComplete:false,asrDuration:10,asrParts:[{start:0,end:10,result,cues:[],whole:true,serviceDurationMs:10000}]});
 await f.db.summaries.put({key:summaryKey(f.job.videoKey,'m'),videoKey:f.job.videoKey,source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',status:'need_asr',createdAt:1,asrProgress:{sessionId:'s',processedUntil:0,targetDuration:10,status:'partial',parts:[],unconfirmed:[{from:0,to:10,text:'你好美丽世界'}]}});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');expect(f.transcribe).not.toHaveBeenCalled();expect(f.extract).not.toHaveBeenCalled();
 const tr=await f.db.transcripts.get(f.job.videoKey);expect(tr?.asrParts?.[0]?.cues.map(c=>c.text)).toEqual(['你好','美丽世界']);expect(tr?.asrComplete).toBe(true);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed??[]).toEqual([]);
});

it('旧版完整 ASR 缓存缺少 asrComplete 字段时仍可复用，不能重新发送音频',async()=>{
 const f=await fixture(10);await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues:[{from:0,to:9,text:'此前已经完成的有效转写内容'}],charCount:13,cachedAt:Date.now()});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');expect(f.transcribe).not.toHaveBeenCalled();expect(f.extract).not.toHaveBeenCalled();
});

it('服务时间戳超出当前音频范围时保留原始结果并禁止完整摘要',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'越界时间内容',utterances:[{text:'越界时间内容',startMs:90000,endMs:91000,definite:true,words:[{text:'越界时间内容',startMs:90000,endMs:91000}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);
});

it('时间错序的识别结果不得生成可跳转的完整摘要',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'先后',utterances:[{text:'先后',startMs:100,endMs:900,definite:true,words:[{text:'先',startMs:600,endMs:900},{text:'后',startMs:100,endMs:500}]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
});

it('顶层文字为空但句子有内容时不得误报静音，应保留未确认原文',async()=>{
 const f=await fixture(10);f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:10000,result:{text:'',utterances:[{text:'实际有讲话',startMs:100,endMs:900,definite:true,words:[]}]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TIMESTAMP_MISSING'}});
 const row=await f.db.summaries.get(summaryKey(f.job.videoKey,'m'));expect(row?.asrProgress?.unconfirmed?.[0]?.text).toContain('实际有讲话');
});

it('全片识别没有最终帧时不将临时内容写成可跳转字幕',async()=>{
 const f=await fixture();f.deps.transcribePcm=vi.fn(async()=>({final:false,result:{text:'临时内容',utterances:[]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_INCOMPLETE'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues).toEqual([]);
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).toBe(false);
});

it('全片结构化摘要降级为纯文本时保留局部内容，不标记完成',async()=>{
 const f=await fixture(10);f.deps.fetchImpl=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:'仅有普通文本而没有大纲或点评'}}]})}\n\ndata: [DONE]\n\n`,{status:200});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');
 const row=await f.db.summaries.get(summaryKey(f.job.videoKey,'m'));expect(row?.status).toBe('need_asr');expect(row?.asrProgress?.status).toBe('partial');
});

it('响应头已知音频超限时应取消下载流，不开始识别',async()=>{
 const f=await fixture(10);let cancelled=false;
 f.deps.fetchAudio=async()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-length':String(30*1024*1024)}});
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_AUDIO_TOO_LARGE'}});expect(cancelled).toBe(true);expect(f.transcribe).not.toHaveBeenCalled();
});
