import {expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({listeners:[] as any[], signal:undefined as AbortSignal|undefined, socketSignal:undefined as AbortSignal|undefined, start:undefined as (()=>void)|undefined}));
vi.mock('wxt/browser',()=>({browser:{runtime:{id:'fixture',getURL:(s:string)=>`chrome-extension://fixture${s}`,sendMessage:vi.fn(async()=>({ok:true})),onMessage:{addListener:(f:any)=>state.listeners.push(f)}}}}));
vi.mock('../src/lib/summarize/asr',()=>({runAsrJob:async(deps:any)=>{state.signal=deps.signal;state.start?.();try{await deps.transcribePcm(new Uint8Array(6400));return {result:'done'};}catch{return {result:'failed',error:{code:'ASR_CANCELLED',msg:'cancelled'}};}}}));
vi.mock('../src/lib/asr/doubao',()=>({runDoubaoSession:async(_k:string,_pcm:Uint8Array,deps:any)=>{state.socketSignal=deps.signal;return await new Promise((_r,reject)=>{deps.signal.addEventListener('abort',()=>reject(Error('ASR_CANCELLED')),{once:true});});}}));

it('非后台来源不能启动离屏识别任务',async()=>{
 await import('../entrypoints/offscreen/main');
 const response=await state.listeners[0]({type:'OFFSCREEN_RUN_JOB',job:{id:'j',sessionId:'s',runId:'r',videoKey:'v',type:'ASR_SUMMARIZE'},llm:{model:'m'},asr:{provider:'doubao-agent-plan',apiKey:'fake'}},{url:'https://untrusted.example'});
 expect(response).toMatchObject({result:'failed',error:{code:'ASR_UNAUTHORIZED'}});
 expect(state.signal).toBeUndefined();
});

it('结束指定会话时中止离屏任务及其豆包连接，其他来源不能取消',async()=>{
 await import('../entrypoints/offscreen/main');
 let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve});state.start=started;
 const run=state.listeners[0]({type:'OFFSCREEN_RUN_JOB',job:{id:'j',sessionId:'s',runId:'r',videoKey:'v',type:'ASR_SUMMARIZE'},llm:{model:'m'},asr:{provider:'doubao-agent-plan',apiKey:'fake'}},{url:'chrome-extension://fixture/background.js'});
 await ready;
 await state.listeners[0]({type:'OFFSCREEN_CANCEL_ASR',sessionId:'s'},{url:'https://untrusted.example'});
 expect(state.signal?.aborted).toBe(false);
 await state.listeners[0]({type:'OFFSCREEN_CANCEL_ASR',sessionId:'other'},{url:'chrome-extension://fixture/background.js'});
 expect(state.signal?.aborted).toBe(false);
 await state.listeners[0]({type:'OFFSCREEN_CANCEL_ASR',sessionId:'s'},{url:'chrome-extension://fixture/background.js'});
 expect(state.signal?.aborted).toBe(true);expect(state.socketSignal?.aborted).toBe(true);
 expect(await run).toMatchObject({result:'failed'});
});
