import {afterEach, expect, it, vi} from 'vitest';
import {indexedDB, IDBKeyRange} from 'fake-indexeddb';
import {CompanionDB, summaryKey} from '../src/lib/storage';
import {runAsrJob} from '../src/lib/summarize/asr';

const databases:CompanionDB[]=[];
afterEach(async()=>{for(const db of databases.splice(0)) await db.delete();});
async function fixture() {
  const db=new CompanionDB(`fast-${Math.random()}`,{indexedDB,IDBKeyRange});databases.push(db);
  const videoKey='BV1test12345:777',job={id:'j',videoKey,sessionId:'s',runId:'r'};
  await db.sessions.put({id:'s',state:'ACTIVE',startedAt:1,lastActiveAt:1});
  await db.jobs.put({id:'j',videoKey,sessionId:'s',runId:'r',type:'ASR_SUMMARIZE',status:'running',progress:0,retries:0,createdAt:1,updatedAt:1});
  await db.videos.put({key:videoKey,bvid:'BV1test12345',aid:1,cid:777,title:'测试',cover:'',owner:'',duration:75,page:1,fetchedAt:Date.now()});
  const final={summary:'简体中文摘要内容。'.repeat(22),outline:[0,10,20,30,40,60].map(time=>({time,text:'视频内容'})),evaluation:'这是基于视频语音内容生成的点评。'.repeat(4),rating:4};
  const llm=vi.fn(async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200,headers:{'content-type':'text/event-stream'}}));
  const result={text:'开头中间结尾',utterances:[{text:'开头',startMs:100,endMs:1000,definite:true,words:[{text:'开头',startMs:100,endMs:1000}]},{text:'中间',startMs:35000,endMs:36000,definite:true,words:[{text:'中间',startMs:35000,endMs:36000}]},{text:'结尾',startMs:74000,endMs:74800,definite:true,words:[{text:'结尾',startMs:74000,endMs:74800}]}]};
  const transcribe=vi.fn(async()=>({final:true,audioDurationMs:75000,result}));
  const decode=vi.fn(async()=>new Uint8Array(75*32000));
  const deps:any={db,bili:{fetchWbiKeys:async()=>'x',getPlayUrlAudio:async()=>[{id:1,bandwidth:1,baseUrl:'https://upos-sz-x.bilivideo.com/a.m4s',backupUrl:[]}]},llm:{baseUrl:'https://llm.test/v1',model:'m',apiKey:'k'},asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'k'},asrMaxMB:25,fetchAudio:async()=>new Response(new Uint8Array(64)),fetchImpl:llm,getAudioDuration:async()=>75,decodeWholeAudio:decode,transcribePcm:transcribe,makeLocalNote:async()=> '片段的局部要点'};
  return {db,job,deps,decode,transcribe,llm,ctx:{update:async()=>{}}};
}

it('超过 30 秒的音频以一个识别请求完整发送，首中尾时间保持全局位置',async()=>{
 const f=await fixture();expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect(f.decode).toHaveBeenCalledTimes(1);expect(f.transcribe).toHaveBeenCalledTimes(1);
 const row=await f.db.transcripts.get(f.job.videoKey);expect(row?.asrComplete).toBe(true);expect(row?.cues.map(c=>c.from)).toEqual([0.1,35,74]);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.status).toBe('done');
});

it.each(['','。'])('真实服务形态的 5 字短讲话保留转写，标点 %s 不计作内容',async(punctuation)=>{
 const f=await fixture();const duration=1.271;
 await f.db.videos.update(f.job.videoKey,{duration});
 f.deps.getAudioDuration=async()=>duration;f.deps.decodeWholeAudio=async()=>new Uint8Array(40672);
 const words=[{text:'今',startMs:80,endMs:280},{text:'天',startMs:280,endMs:480},{text:'下',startMs:480,endMs:720},{text:'雨',startMs:720,endMs:920},{text:`了${punctuation}`,startMs:920,endMs:1080}];
 f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:1270,result:{text:`今天下雨了${punctuation}`,utterances:[{text:`今天下雨了${punctuation}`,startMs:80,endMs:1080,definite:true,words}]}}));
 const final={summary:'这是根据短语音生成的模拟摘要。'.repeat(12),outline:[0,0,0,1,1,1].map(time=>({time,text:'语音要点'})),evaluation:'这是根据测试语音生成的模拟点评。'.repeat(4),rating:4};
 const llm=vi.fn(async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200}));f.deps.fetchImpl=llm;f.deps.makeLocalNote=vi.fn(async()=> '不应生成');
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_TOO_SHORT'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues).toHaveLength(5);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.status).toBe('need_asr');expect(llm).not.toHaveBeenCalled();expect(f.deps.makeLocalNote).not.toHaveBeenCalled();
});

it('静音使用真实服务返回形态时提示无语音，不生成摘要',async()=>{
 const f=await fixture();const duration=3;
 await f.db.videos.update(f.job.videoKey,{duration});
 f.deps.getAudioDuration=async()=>duration;f.deps.decodeWholeAudio=async()=>new Uint8Array(96000);
 f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:3000,result:{text:'',utterances:[]}}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_NO_SPEECH'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.status).toBe('need_asr');expect(f.llm).not.toHaveBeenCalled();
});

it('服务确认处理时长明显短于音轨时不生成完整摘要',async()=>{
 const f=await fixture();const frame=await f.transcribe();f.deps.transcribePcm=vi.fn(async()=>({...frame,audioDurationMs:30000}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_SERVICE_DURATION_MISMATCH'}});
 expect((await f.db.transcripts.get(f.job.videoKey))?.asrComplete).not.toBe(true);expect(f.llm).not.toHaveBeenCalled();
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toContain('开头');
});

it('服务未报告处理时长时不假称全片完整且重试不重发',async()=>{
 const f=await fixture();const frame=await f.transcribe();f.deps.transcribePcm=vi.fn(async()=>({...frame,audioDurationMs:undefined}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_SERVICE_DURATION_UNKNOWN'}});
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_SERVICE_DURATION_UNKNOWN'}});
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);expect(f.llm).not.toHaveBeenCalled();
});

it('音轨比视频明显更长时不截断上传，也不标为完成',async()=>{
 const f=await fixture();f.deps.getAudioDuration=async()=>75.6;
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_DURATION_MISMATCH'}});
 expect(f.transcribe).not.toHaveBeenCalled();
});

it('容器时长与实际解码相差几个采样点时，发送真实 PCM 并以样本数记录处理范围',async()=>{
 const f=await fixture();await f.db.videos.update(f.job.videoKey,{duration:76});
 f.deps.getAudioDuration=async()=>75.252833;
 const actualBytes=Math.round(75.252625*16000)*2;
 f.deps.decodeWholeAudio=async()=>new Uint8Array(actualBytes);
 const frame=await f.transcribe();f.deps.transcribePcm=vi.fn(async()=>({...frame,audioDurationMs:75252}));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'done'});
 expect(f.deps.transcribePcm.mock.calls[0]![0].length).toBe(actualBytes);
 const row=await f.db.transcripts.get(f.job.videoKey);
 expect(row?.asrDuration).toBe(actualBytes/32000);
 expect(row?.asrParts?.[0]?.end).toBe(actualBytes/32000);
 expect(row?.asrComplete).toBe(true);
});

it('容器元数据比实际 PCM 长约 3 毫秒时仍发送完整解码样本，不补静音',async()=>{
 const f=await fixture();await f.db.videos.update(f.job.videoKey,{duration:39});
 f.deps.getAudioDuration=async()=>38.152971;
 const actualBytes=610402*2;
 f.deps.decodeWholeAudio=async()=>new Uint8Array(actualBytes);
 const result={text:'开头中间结尾',utterances:[{text:'开头',startMs:100,endMs:1000,definite:true,words:[{text:'开头',startMs:100,endMs:1000}]},{text:'中间',startMs:18000,endMs:19000,definite:true,words:[{text:'中间',startMs:18000,endMs:19000}]},{text:'结尾',startMs:37000,endMs:38000,definite:true,words:[{text:'结尾',startMs:37000,endMs:38000}]}]};
 f.deps.transcribePcm=vi.fn(async()=>({final:true,audioDurationMs:38150,result}));
 const final={summary:'简体中文摘要内容。'.repeat(22),outline:[0,5,10,20,27,37].map(time=>({time,text:'视频内容'})),evaluation:'这是基于视频语音内容生成的点评。'.repeat(4),rating:4};
 f.deps.fetchImpl=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200});
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'done'});
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
 expect(f.deps.transcribePcm.mock.calls[0]![0].length).toBe(actualBytes);
 const row=await f.db.transcripts.get(f.job.videoKey);
 expect(row?.asrDuration).toBe(38.150125);
 expect(row?.asrParts?.[0]?.end).toBe(38.150125);
});

it('解码音频比容器时长短超过 25 毫秒时拒绝发送，不填充缺失音频',async()=>{
 const f=await fixture();f.deps.decodeWholeAudio=async()=>new Uint8Array(75*32000-802);
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_AUDIO_INCOMPLETE'}});
 expect(f.transcribe).not.toHaveBeenCalled();
});

it('解码出来的音频比元数据明显更长时不静默截断',async()=>{
 const f=await fixture();f.deps.decodeWholeAudio=async()=>new Uint8Array(Math.round(75.6*32000));
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_DURATION_MISMATCH'}});
 expect(f.transcribe).not.toHaveBeenCalled();
});

it('解码尾部有少量填充被裁去时，完成结果明确告知处理范围',async()=>{
 const f=await fixture();f.deps.decodeWholeAudio=async()=>new Uint8Array(Math.round(75.06*32000));
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning).toContain('尾部');
});

it('摘要重试时保留解码尾部提示并复用已识别内容',async()=>{
 const f=await fixture();f.deps.decodeWholeAudio=async()=>new Uint8Array(Math.round(75.06*32000));f.deps.fetchImpl=async()=>new Response('',{status:500});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');f.deps.fetchImpl=f.llm;
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning).toContain('尾部');expect(f.transcribe).toHaveBeenCalledTimes(1);
});

it('取消信号已触发时不把取消记为识别失败',async()=>{
 const f=await fixture();const controller=new AbortController();f.deps.signal=controller.signal;
 f.deps.decodeWholeAudio=async()=>{controller.abort();throw new Error('aborted')};
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_JOB_STALE'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.error).toBeUndefined();
});

it('语音服务等包超时时保留明确错误和计费不明提示，不自动重发',async()=>{
 const f=await fixture();f.deps.transcribePcm=vi.fn(async()=>{throw new Error('ASR_SERVICE_45000081')});
 const result=await runAsrJob(f.deps,f.job,f.ctx);
 expect(result).toMatchObject({result:'failed',error:{code:'ASR_SERVICE_45000081',msg:expect.stringContaining('等待音频包超时')}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.warning).toContain('计费状态不明');
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});

it('未确认的语音原文会保留并以不可跳转状态展示',async()=>{
 const f=await fixture();const frame=await f.transcribe();frame.result.utterances[0]!.definite=false;
 f.deps.transcribePcm=vi.fn(async()=>frame);
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_UNCONFIRMED'}});
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.unconfirmed?.[0]?.text).toContain('开头');
});

it('完整语音已缓存后摘要失败重试，不重新转码或识别',async()=>{
 const f=await fixture();f.deps.fetchImpl=async()=>new Response('',{status:500});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');expect(f.transcribe).toHaveBeenCalledTimes(1);
 f.deps.fetchImpl=f.llm;expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect(f.transcribe).toHaveBeenCalledTimes(1);expect(f.decode).toHaveBeenCalledTimes(1);
});

it('旧版整段占位时间不可当作真实时间复用，用户确认后须重识别',async()=>{
 const f=await fixture();const legacy={key:f.job.videoKey,source:'asr' as const,lan:'asr',cues:[{from:0,to:75,text:'旧版没有分段时间的转写'}],charCount:13,cachedAt:Date.now()};
 await f.db.transcripts.put(legacy);
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');
 expect(f.transcribe).toHaveBeenCalledTimes(1);expect(f.decode).toHaveBeenCalledTimes(1);
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues.map(c=>c.from)).toEqual([0.1,35,74]);
});

it('旧版无时间转写重识别失败时保留文字，不生成摘要或自动重发',async()=>{
 const f=await fixture();const cues=[{from:0,to:75,text:'旧版没有分段时间的转写'}];
 await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues,charCount:13,cachedAt:Date.now()});
 f.deps.transcribePcm=vi.fn(async()=>{throw new Error('ASR_CONNECTION_CLOSED')});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);expect(f.llm).not.toHaveBeenCalled();
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues).toEqual(cues);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.status).toBe('need_asr');
});

it('旧版存在多个有时间片段的转写仍可复用，不重复识别',async()=>{
 const f=await fixture();const cues=[{from:1,to:2,text:'开头内容'},{from:30,to:31,text:'中间内容'}];
 await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues,charCount:8,cachedAt:Date.now()});
 const final={summary:'简体中文摘要内容。'.repeat(22),outline:[1,1,1,30,30,30].map(time=>({time,text:'视频内容'})),evaluation:'这是基于视频语音内容生成的点评。'.repeat(4),rating:4};
 f.deps.fetchImpl=async()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(final)}}]})}\n\ndata: [DONE]\n\n`,{status:200});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('done');expect(f.transcribe).not.toHaveBeenCalled();
});

it('长于支持范围的视频不下载或发送音频，也不假称完成',async()=>{
 const f=await fixture();await f.db.videos.update(f.job.videoKey,{duration:901});
 const fetch=vi.fn(f.deps.fetchAudio);f.deps.fetchAudio=fetch;
 expect(await runAsrJob(f.deps,f.job,f.ctx)).toMatchObject({result:'failed',error:{code:'ASR_DURATION_LIMIT'}});
 expect(fetch).not.toHaveBeenCalled();expect(f.transcribe).not.toHaveBeenCalled();
});

it('发送前会话结束时不会上传语音',async()=>{
 const f=await fixture();const ctx={update:async(p:{stage?:string})=>{if(p.stage==='asr') await f.db.sessions.update('s',{state:'GRACE'});}};
 expect(await runAsrJob(f.deps,f.job,ctx)).toMatchObject({result:'failed',error:{code:'ASR_JOB_STALE'}});
 expect(f.transcribe).not.toHaveBeenCalled();
});

it('全片识别失败时保留此前的局部结果，不自动重新发送',async()=>{
 const f=await fixture();const cue={from:1,to:2,text:'已经确认的开头'};
 await f.db.transcripts.put({key:f.job.videoKey,source:'asr',lan:'asr',cues:[cue],charCount:cue.text.length,cachedAt:Date.now(),asrComplete:false,asrDuration:75,asrParts:[]});
 await f.db.summaries.put({key:summaryKey(f.job.videoKey,'m'),videoKey:f.job.videoKey,source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',status:'need_asr',createdAt:1,asrProgress:{sessionId:'s',processedUntil:30,targetDuration:75,status:'partial',parts:[{from:0,to:30,text:'先前的局部要点'}]}});
 f.deps.transcribePcm=vi.fn(async()=>{throw new Error('ASR_CONNECTION_CLOSED')});
 expect((await runAsrJob(f.deps,f.job,f.ctx)).result).toBe('failed');
 expect((await f.db.transcripts.get(f.job.videoKey))?.cues).toEqual([cue]);
 expect((await f.db.summaries.get(summaryKey(f.job.videoKey,'m')))?.asrProgress?.parts[0]?.text).toBe('先前的局部要点');
 expect(f.deps.transcribePcm).toHaveBeenCalledTimes(1);
});
