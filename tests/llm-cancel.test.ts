import {expect,it,vi} from 'vitest';
import {streamChatCompletion} from '../src/lib/llm/client';
import {completeStructured} from '../src/lib/llm/summary';
import {mapReduceSummarize} from '../src/lib/summarize/mapReduce';
const cfg={baseUrl:'https://example.test/v1',model:'m',apiKey:'fake'};

it('已取消的任务不会启动通用模型请求',async()=>{
 const controller=new AbortController();controller.abort();const fetchImpl=vi.fn();
 await expect(streamChatCompletion(cfg,[],{fetchImpl:fetchImpl as typeof fetch,signal:controller.signal})).rejects.toThrow('已取消');
 expect(fetchImpl).not.toHaveBeenCalled();
});

it('外部取消会中断正在等待的通用模型请求',async()=>{
 const controller=new AbortController();let reached!:()=>void;const started=new Promise<void>(r=>{reached=r});
 const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
   reached();init?.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
 }));
 const work=streamChatCompletion(cfg,[],{fetchImpl:fetchImpl as typeof fetch,signal:controller.signal});
 await started;controller.abort();
 const result=await Promise.race([work.then(()=> 'resolved',()=> 'cancelled'),new Promise<string>(r=>setTimeout(()=>r('timeout'),100))]);
 expect(result).toBe('cancelled');expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('结构化输出期间取消不应触发校验重试',async()=>{
 const controller=new AbortController();const fetchImpl=vi.fn(async()=>new Response('data: {"choices":[{"delta":{"content":"invalid"}}]}\n\ndata: [DONE]\n\n'));
 await expect(completeStructured(cfg,[],{fetchImpl:fetchImpl as typeof fetch,signal:controller.signal,onDelta:()=>controller.abort()})).rejects.toThrow('已取消');
 expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('分块处理中取消时不再启动剩余分块或最终合并',async()=>{
 const controller=new AbortController();let reached!:()=>void;const started=new Promise<void>(r=>{reached=r});
 const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
  reached();init?.signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
 }));
 const cues=Array.from({length:4},(_,i)=>({from:i*10,to:i*10+1,text:'这里有一段文字'}));
 const work=mapReduceSummarize(cfg,{title:'t',duration:40,cueCount:4},cues,{fetchImpl:fetchImpl as typeof fetch,signal:controller.signal,chunkChars:9,mapConcurrency:1});
 await started;controller.abort();
 const result=await Promise.race([work.then(()=> 'resolved',()=> 'cancelled'),new Promise<string>(r=>setTimeout(()=>r('timeout'),100))]);
 expect(result).toBe('cancelled');expect(fetchImpl).toHaveBeenCalledTimes(1);
});
