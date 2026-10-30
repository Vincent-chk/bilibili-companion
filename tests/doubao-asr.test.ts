import { describe, expect, it, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeDoubaoFrame, decodeDoubaoFrame, doubaoResultToCues } from '../src/lib/asr/doubao';

function serverFrame(body: unknown, flags = 1): ArrayBuffer {
  const data = gzipSync(Buffer.from(JSON.stringify(body)));
  const out = new Uint8Array(12 + data.length);
  out.set([0x11, 0x90 | flags, 0x11, 0]);
  const view = new DataView(out.buffer);
  view.setInt32(4, flags === 3 ? -2 : 2);
  view.setUint32(8, data.length);
  out.set(data, 12);
  return out.buffer;
}

describe('豆包语音协议', () => {
  it('音频结束帧使用 gzip 与最后一帧标记', async () => {
    const frame = new Uint8Array(await encodeDoubaoFrame(2, new Uint8Array([1, 2, 3]), true));
    expect([...frame.slice(0, 4)]).toEqual([0x11, 0x22, 0x01, 0]);
    expect(new DataView(frame.buffer).getUint32(4)).toBe(frame.length - 8);
    const raw = await new Response(new Blob([frame.slice(8)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    expect([...new Uint8Array(raw)]).toEqual([1, 2, 3]);
  });
  it('解析累计最终结果，保留词级毫秒时间戳并应用视频偏移', async () => {
    const parsed = await decodeDoubaoFrame(serverFrame({result:{text:'你好',utterances:[{text:'你好',start_time:100,end_time:900,definite:true,words:[{text:'你',start_time:100,end_time:400},{text:'好',start_time:400,end_time:900}]}]}}, 3));
    expect(parsed.final).toBe(true);
    expect(parsed.result?.utterances[0]?.words).toEqual([{text:'你',startMs:100,endMs:400},{text:'好',startMs:400,endMs:900}]);
    expect(doubaoResultToCues(parsed.result!, 30)).toEqual([{from:30.1,to:30.9,text:'你好'}]);
  });
  it('解析服务确认的音频时长，以便判断是否处理完整',async()=>{
    const frame=await decodeDoubaoFrame(serverFrame({audio_info:{duration:28447},result:{text:'你好',utterances:[]}},3));
    expect(frame.audioDurationMs).toBe(28447);
    const invalid=await decodeDoubaoFrame(serverFrame({audio_info:{duration:-1},result:{text:'你好',utterances:[]}},3));
    expect(invalid.audioDurationMs).toBeUndefined();
  });
  it('非法时间戳不产生伪造的可跳转字幕', async () => {
    const parsed = await decodeDoubaoFrame(serverFrame({result:{text:'你好',utterances:[{text:'你好',start_time:-1,end_time:900}]}}, 3));
    expect(doubaoResultToCues(parsed.result!, 0)).toEqual([]);
  });
  it('服务错误不回显可能包含密钥或音频文字的正文', async () => {
    const body = Buffer.from('secret and transcript');
    const out = new Uint8Array(12 + body.length); out.set([0x11,0xf0,0,0]);
    const view = new DataView(out.buffer); view.setUint32(4,45000010); view.setUint32(8,body.length); out.set(body,12);
    const frame = await decodeDoubaoFrame(out.buffer);
    expect(frame).toEqual({ errorCode: 45000010, final: false });
    expect(JSON.stringify(frame)).not.toContain('secret');
  });
});

import { validateAsr } from '../src/content/onboarding/onboarding-logic';
import { transcribeAudio } from '../src/lib/asr';

describe('服务区分', () => {
  it('豆包预设只需 Key，旧配置仍需 OpenAI 兼容三项', () => {
    expect(validateAsr({ provider:'doubao-agent-plan', baseUrl:'', modelId:'', apiKey:'k' })).toEqual({kind:'ok'});
    expect(validateAsr({ baseUrl:'', modelId:'', apiKey:'k' }).kind).toBe('error');
  });
  it('豆包不能被发送到旧 multipart 接口', async () => {
    let sent = false;
    await expect(transcribeAudio({provider:'doubao-agent-plan',baseUrl:'https://example.test',modelId:'x',apiKey:'k'}, {bytes:new ArrayBuffer(1),filename:'a'}, 1, {fetchImpl: async () => {sent = true; throw new Error('sent');}})).rejects.toThrow('ASR_DOUBAO_REQUIRES_PCM');
    expect(sent).toBe(false);
  });
});

import { runDoubaoSession } from '../src/lib/asr/doubao';

class FakeSocket {
  binaryType = '';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: ArrayBuffer}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(private readonly fail = false) { setTimeout(() => this.fail ? this.onerror?.() : this.onopen?.(), 0); }
  send(buffer: ArrayBuffer) {
    const kind = new Uint8Array(buffer)[1]! >> 4;
    const final = (new Uint8Array(buffer)[1]! & 2) !== 0;
    if (kind === 1) setTimeout(() => this.onmessage?.({data:serverFrame({})}), 0);
    if (kind === 2 && final) setTimeout(() => this.onmessage?.({data:serverFrame({result:{text:'你好',utterances:[{text:'你好',start_time:10,end_time:800}]}},3)}), 0);
  }
  close() { this.closed = true; }
}

it('超过 30 秒的 PCM 可以快速发送且只结束一次', async () => {
  let frames = 0, finals = 0;
  class CountingSocket extends FakeSocket { override send(b:ArrayBuffer) {if((new Uint8Array(b)[1]!>>4)===2){frames++;if(new Uint8Array(b)[1]!&2)finals++;}super.send(b);} }
  const start=Date.now();
  const out=await runDoubaoSession('fixture-secret',new Uint8Array(960002),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>new CountingSocket() as unknown as WebSocket});
  expect(out.final).toBe(true);expect(frames).toBe(151);expect(finals).toBe(1);expect(Date.now()-start).toBeLessThan(5000);
},10000);

it('超过 15 分钟的 PCM 在建立连接前拒绝', async()=>{
 let connected=false;
 await expect(runDoubaoSession('fixture-secret',new Uint8Array(28800002),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>{connected=true;return new FakeSocket() as unknown as WebSocket;}})).rejects.toThrow('ASR_PCM_INVALID');
 expect(connected).toBe(false);
});

it('发送队列已满时等待排空，不继续发送音频',async()=>{
 let socket!:FakeSocket;let audioFrames=0;
 class SlowSocket extends FakeSocket { override send(b:ArrayBuffer){if((new Uint8Array(b)[1]!>>4)===2){audioFrames++;if(audioFrames===1){this.bufferedAmount=3*1024*1024;setTimeout(()=>{this.bufferedAmount=0},400);}}super.send(b);} }
 const pending=runDoubaoSession('fixture-secret',new Uint8Array(12800),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>{socket=new SlowSocket();return socket as unknown as WebSocket;}});
 await new Promise(r=>setTimeout(r,280));expect(audioFrames).toBe(1);expect((await pending).final).toBe(true);expect(audioFrames).toBe(2);
});

it('服务处理缓慢时限制未确认音频的积压，收到响应后继续发送',async()=>{
 let socket!:FakeSocket, audioFrames=0, ready!:()=>void;
 const reached=new Promise<void>(resolve=>{ready=resolve});
 class SlowServer extends FakeSocket {
  override send(buffer:ArrayBuffer){
   if((new Uint8Array(buffer)[1]!>>4)===1)return super.send(buffer);
   audioFrames++;if(audioFrames===1024)ready();
  }
 }
 const controller=new AbortController();
 const pending=runDoubaoSession('fixture-secret',new Uint8Array(2000*6400),{runtimeId:'ext',signal:controller.signal,updateRules:async()=>{},createSocket:()=>{socket=new SlowServer();return socket as unknown as WebSocket;}});
 void pending.catch(()=>{});
 try {
  await reached;await new Promise(resolve=>setTimeout(resolve,1200));
  const before=audioFrames;expect(before).toBeLessThan(2000);
  socket.onmessage?.({data:serverFrame({})});
  await vi.waitFor(()=>expect(audioFrames).toBeGreaterThan(before),{timeout:1000,interval:25});
 } finally {controller.abort();await pending.catch(()=>{});}
},10000);

it('服务暂不响应时仍定期发送后续真实音频包',async()=>{
 let audioFrames=0, nextAudio:Buffer|undefined, ready!:()=>void;const reached=new Promise<void>(resolve=>{ready=resolve});
 class SilentServer extends FakeSocket {
  override send(buffer:ArrayBuffer){
   if((new Uint8Array(buffer)[1]!>>4)===1)return super.send(buffer);
   audioFrames++;if(audioFrames===1024)ready();if(audioFrames===1025)nextAudio=gunzipSync(Buffer.from(buffer).subarray(8));
  }
 }
 const controller=new AbortController();
 const pcm=new Uint8Array(1100*6400);pcm.fill(73,1024*6400,1025*6400);
 const pending=runDoubaoSession('fixture-secret',pcm,{runtimeId:'ext',signal:controller.signal,updateRules:async()=>{},createSocket:()=>new SilentServer() as unknown as WebSocket});
 void pending.catch(()=>{});
 try {
  await reached;const before=audioFrames;
  await vi.waitFor(()=>expect(audioFrames).toBeGreaterThan(before),{timeout:6500,interval:50});
  expect(nextAudio).toHaveLength(6400);expect(nextAudio?.every(byte=>byte===73)).toBe(true);
 } finally {controller.abort();await pending.catch(()=>{});}
},12000);

it('服务逐包缓慢处理时保持有限积压并完成最后一包',async()=>{
 let sent=0, processed=0, maxOutstanding=0, scheduledAt=Date.now();
 class ProcessingServer extends FakeSocket {
  override send(buffer:ArrayBuffer){
   const b=new Uint8Array(buffer);if((b[1]!>>4)===1)return super.send(buffer);
   sent++;maxOutstanding=Math.max(maxOutstanding,sent-processed);
   scheduledAt=Math.max(scheduledAt,Date.now())+1;
   const final=(b[1]!&2)!==0;
   setTimeout(()=>{processed++;this.onmessage?.({data:final?serverFrame({result:{text:'完成',utterances:[]}},3):serverFrame({})});},Math.max(0,scheduledAt-Date.now()));
  }
 }
 const result=await runDoubaoSession('fixture-secret',new Uint8Array(1200*6400),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>new ProcessingServer() as unknown as WebSocket});
 expect(result).toMatchObject({final:true,result:{text:'完成'}});
 expect(sent).toBe(1200);expect(processed).toBe(1200);expect(maxOutstanding).toBeLessThanOrEqual(1024);
},10000);

it('完成握手立即移除只匹配本扩展和精确语音地址的临时规则，返回最终结果', async () => {
  let active: any;
  const history: any[] = [];
  const socket = new FakeSocket();
  const result = await runDoubaoSession('fixture-secret', new Uint8Array(6400), {
    runtimeId:'extensionid',
    updateRules: async (rule) => { active = rule; history.push(rule); },
    createSocket: () => socket as unknown as WebSocket,
  });
  expect(history[0].condition).toEqual({urlFilter:'|wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream|',initiatorDomains:['extensionid'],resourceTypes:['websocket']});
  expect(active).toBeNull();
  expect(socket.closed).toBe(true);
  expect(result.final).toBe(true);
  expect(result.result?.text).toBe('你好');
});

it('握手失败时清除规则，错误不回显 Key', async () => {
  let active: unknown;
  await expect(runDoubaoSession('fixture-secret', undefined, {
    runtimeId:'extensionid', updateRules: async rule => { active = rule; },
    createSocket: () => new FakeSocket(true) as unknown as WebSocket,
  })).rejects.toThrow('ASR_CONNECTION_FAILED');
  expect(active).toBeNull();
});

it('豆包视频链路尚未接入时给出明确提示，而不是未知错误', async () => {
  const {mapAsrError} = await import('../src/lib/asr');
  expect(mapAsrError(new Error('ASR_DOUBAO_REQUIRES_PCM'))).toEqual({code:'ASR_NOT_READY',msg:'豆包视频语音处理尚未接入，请等待后续版本'});
});

it('豆包任务缺少运行租约时不下载或发送视频音频', async () => {
  const {runAsrJob} = await import('../src/lib/summarize/asr');
  const result = await runAsrJob({asr:{provider:'doubao-agent-plan',baseUrl:'',modelId:'',apiKey:'k'},llm:{model:'m'}} as never,{videoKey:'BV1xxxxxxxxx:1'},{update:async()=>{}} as never);
  expect(result).toMatchObject({result:'failed',error:{code:'ASR_JOB_INVALID'}});
});

it('取消会关闭连接并清除临时认证规则', async () => {
  const controller = new AbortController(); let active: unknown; let socket!: FakeSocket;
  let ready!:()=>void;const first=new Promise<void>(r=>{ready=r});
  class BlockedSocket extends FakeSocket { override send(b:ArrayBuffer) {if((new Uint8Array(b)[1]!>>4)===2){this.bufferedAmount=3*1024*1024;ready();}super.send(b);} }
  const pending = runDoubaoSession('fixture-secret',new Uint8Array(12800),{
    runtimeId:'extensionid', signal:controller.signal,
    updateRules: async rule => {active=rule;}, createSocket:()=>{socket=new BlockedSocket(); return socket as unknown as WebSocket;},
  });
  await first; controller.abort();
  await expect(pending).rejects.toThrow('ASR_CANCELLED_OR_TIMEOUT');
  expect(active).toBeNull(); expect(socket.closed).toBe(true);
});

it('多个会话串行执行，认证规则不会相互覆盖', async () => {
  let active = 0, max = 0, rule: unknown;
  class CountedSocket extends FakeSocket {
    constructor() { super(); active++; max = Math.max(max, active); }
    override close() { super.close(); active--; }
  }
  const deps = {runtimeId:'extensionid',updateRules:async(value:unknown)=>{rule=value;},createSocket:()=>new CountedSocket() as unknown as WebSocket};
  const one=runDoubaoSession('first',new Uint8Array(12800),deps);
  const two=runDoubaoSession('second',new Uint8Array(6400),deps);
  expect((await one).final).toBe(true); expect((await two).final).toBe(true);
  expect(max).toBe(1); expect(active).toBe(0); expect(rule).toBeNull();
});

it('连接中断时清理规则且不把未完成识别当作成功', async () => {
  let active: unknown;
  class DisconnectSocket extends FakeSocket { override send() {setTimeout(()=>this.onclose?.(),0);} }
  await expect(runDoubaoSession('fixture-secret',new Uint8Array(6400),{runtimeId:'extensionid',updateRules:async rule=>{active=rule},createSocket:()=>new DisconnectSocket() as unknown as WebSocket})).rejects.toThrow('ASR_CONNECTION_CLOSED');
  expect(active).toBeNull();
});

it('最终帧到达后立即断开时仍能等待解析并正确完成', async () => {
  class CloseAfterFinalSocket extends FakeSocket {
    override send(buffer:ArrayBuffer) {
      const b=new Uint8Array(buffer);
      if ((b[1]! >> 4)===1) return super.send(buffer);
      setTimeout(()=>{this.onmessage?.({data:serverFrame({result:{text:'结束',utterances:[{text:'结束',start_time:0,end_time:600}]}},3)}); this.onclose?.();},0);
    }
  }
  const result=await runDoubaoSession('fixture-secret',new Uint8Array(6400),{runtimeId:'extensionid',updateRules:async()=>{},createSocket:()=>new CloseAfterFinalSocket() as unknown as WebSocket});
  expect(result.final).toBe(true); expect(result.result?.text).toBe('结束');
});

it('累计与重复的临时结果不会重复拼接，只有最终结果被返回', async () => {
  class CumulativeSocket extends FakeSocket {
    override send(buffer:ArrayBuffer) {
      if ((new Uint8Array(buffer)[1]! >> 4)===1) return super.send(buffer);
      setTimeout(()=>{
        this.onmessage?.({data:serverFrame({result:{text:'你好'}})});
        this.onmessage?.({data:serverFrame({result:{text:'你好'}})});
        this.onmessage?.({data:serverFrame({result:{text:'你好世界',utterances:[]}},3)});
      },0);
    }
  }
  const result=await runDoubaoSession('fixture-secret',new Uint8Array(6400),{runtimeId:'extensionid',updateRules:async()=>{},createSocket:()=>new CumulativeSocket() as unknown as WebSocket});
  expect(result.final).toBe(true); expect(result.result?.text).toBe('你好世界');
});

it('鉴权错误帧不发送音频，不回显服务正文并清理规则', async () => {
  let active:unknown, audioSent=false;
  class ErrorSocket extends FakeSocket {
    override send(buffer:ArrayBuffer) {
      if ((new Uint8Array(buffer)[1]! >> 4)===2) {audioSent=true; return;}
      const body=Buffer.from('fixture-secret private speech'); const frame=new Uint8Array(12+body.length);frame.set([0x11,0xf0,0,0]);const view=new DataView(frame.buffer);view.setUint32(4,45000010);view.setUint32(8,body.length);frame.set(body,12);
      setTimeout(()=>this.onmessage?.({data:frame.buffer}),0);
    }
  }
  await expect(runDoubaoSession('fixture-secret',new Uint8Array(6400),{runtimeId:'extensionid',updateRules:async rule=>{active=rule},createSocket:()=>new ErrorSocket() as unknown as WebSocket})).rejects.toThrow('ASR_SERVICE_45000010');
  expect(audioSent).toBe(false);expect(active).toBeNull();
});

it('服务在音频尚未发送完就提前结束时不能判为成功', async () => {
  class EarlyFinalSocket extends FakeSocket {
    override send(buffer:ArrayBuffer) {
      const bytes=new Uint8Array(buffer);if ((bytes[1]!>>4)===1) return super.send(buffer);
      this.bufferedAmount=3*1024*1024;
      setTimeout(()=>this.onmessage?.({data:serverFrame({result:{text:'部分'}},3)}),0);
    }
  }
  await expect(runDoubaoSession('fixture-secret',new Uint8Array(12800),{runtimeId:'extensionid',updateRules:async()=>{},createSocket:()=>new EarlyFinalSocket() as unknown as WebSocket})).rejects.toThrow('ASR_EARLY_FINAL');
});

it('初始化阶段收到最终帧时不得发送音频或报告成功', async () => {
  let sentAudio=false;
  class InitFinalSocket extends FakeSocket {
    override send(buffer:ArrayBuffer) {if((new Uint8Array(buffer)[1]!>>4)===2){sentAudio=true;return;} setTimeout(()=>this.onmessage?.({data:serverFrame({result:{text:'意外结果'}},3)}),0);}
  }
  await expect(runDoubaoSession('fixture-secret',new Uint8Array(6400),{runtimeId:'extensionid',updateRules:async()=>{},createSocket:()=>new InitFinalSocket() as unknown as WebSocket})).rejects.toThrow('ASR_EARLY_FINAL');
  expect(sentAudio).toBe(false);
});

it('大量暂定帧只校验协议头并刷新等待计时，最终帧仍被解析',async()=>{
 const timer=vi.spyOn(globalThis,'setTimeout');
 const interim=new Uint8Array(serverFrame({result:{text:'暂定'}}));interim[interim.length-1]=interim[interim.length-1]!^0xff;
 class InterimSocket extends FakeSocket {
  override send(buffer:ArrayBuffer){
   if((new Uint8Array(buffer)[1]!>>4)===1)return super.send(buffer);
   setTimeout(()=>{for(let i=0;i<1000;i++)this.onmessage?.({data:interim.buffer});},10);
   setTimeout(()=>this.onmessage?.({data:interim.buffer}),35);
   setTimeout(()=>this.onmessage?.({data:serverFrame({result:{text:'最终',utterances:[]}},3)}),75);
  }
 }
 try {
  const out=await runDoubaoSession('fixture',new Uint8Array(6400),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>new InterimSocket() as unknown as WebSocket});
  expect(out).toMatchObject({final:true,result:{text:'最终'}});
  expect(timer.mock.calls.filter(call=>call[1]===180_000).length).toBeGreaterThanOrEqual(3);
 } finally {timer.mockRestore();}
});

it('暂定帧的协议头损坏时不能因随后最终帧而报告成功',async()=>{
 class BadInterimSocket extends FakeSocket {
  override send(buffer:ArrayBuffer){
   if((new Uint8Array(buffer)[1]!>>4)===1)return super.send(buffer);
   const broken=new Uint8Array(serverFrame({result:{text:'暂定'}}));new DataView(broken.buffer).setUint32(8,999999);
   setTimeout(()=>{this.onmessage?.({data:broken.buffer});this.onmessage?.({data:serverFrame({result:{text:'最终'}},3)});},10);
  }
 }
 await expect(runDoubaoSession('fixture',new Uint8Array(6400),{runtimeId:'ext',updateRules:async()=>{},createSocket:()=>new BadInterimSocket() as unknown as WebSocket})).rejects.toThrow('ASR_PROTOCOL');
});
