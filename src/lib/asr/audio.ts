import { browser } from 'wxt/browser';

/** 完整音轨离线解码，限制输入与解码时长；不写入扩展存储。 */
export async function decodeWholeAudio(blob:Blob,containerDuration:number,signal?:AbortSignal):Promise<Uint8Array> {
  if(signal?.aborted)throw new Error('ASR_AUDIO_CANCELLED');
  if(!Number.isFinite(containerDuration)||containerDuration<=0)throw new Error('ASR_AUDIO_DURATION_UNKNOWN');
  if(containerDuration>900)throw new Error('ASR_AUDIO_TOO_LONG');
  if(!blob.size)throw new Error('ASR_AUDIO_FAILED');
  if(blob.size>25*1024*1024)throw new Error('ASR_AUDIO_TOO_LARGE');
  try {
    const bytes=await blob.arrayBuffer();
    if(signal?.aborted)throw new Error('ASR_AUDIO_CANCELLED');
    const context=new OfflineAudioContext(1,1,16000);
    const decoded=await context.decodeAudioData(bytes);
    if(signal?.aborted)throw new Error('ASR_AUDIO_CANCELLED');
    if(decoded.sampleRate!==16000)throw new Error('ASR_AUDIO_RATE_UNSUPPORTED');
    if(decoded.numberOfChannels<1||decoded.numberOfChannels>2)throw new Error('ASR_AUDIO_CHANNEL_UNSUPPORTED');
    if(!Number.isFinite(decoded.duration)||decoded.duration<=0||decoded.length<=0||decoded.length>900*16000)throw new Error('ASR_AUDIO_TOO_LONG');
    if(Math.abs(decoded.duration-containerDuration)>1)throw new Error('ASR_DURATION_MISMATCH');
    const out=new Uint8Array(decoded.length*2),view=new DataView(out.buffer);
    const a=decoded.getChannelData(0),b=decoded.numberOfChannels===2?decoded.getChannelData(1):undefined;
    for(let i=0;i<decoded.length;i++){
      const sample=Math.max(-1,Math.min(1,b?(a[i]!+b[i]!)/2:a[i]!));
      view.setInt16(i*2,sample<0?Math.round(sample*32768):Math.round(sample*32767),true);
    }
    if(signal?.aborted)throw new Error('ASR_AUDIO_CANCELLED');
    return out;
  } catch(e) {
    if(e instanceof Error&&/^ASR_[A-Z_]+$/.test(e.message))throw e;
    throw new Error('ASR_AUDIO_DECODE_FAILED');
  }
}

/** 只读取压缩音轨的容器元数据，不整段解码音频。 */
export async function probeAudioDuration(blob:Blob,signal?:AbortSignal):Promise<number> {
  if(signal?.aborted)throw new Error('ASR_AUDIO_CANCELLED');
  const audio=new Audio(),url=URL.createObjectURL(blob);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await new Promise<number>((resolve,reject)=>{
      const cleanup=()=>{audio.removeEventListener('loadedmetadata',loaded);audio.removeEventListener('error',bad);signal?.removeEventListener('abort',abort);if(timer)clearTimeout(timer);};
      const loaded=()=>{cleanup();const value=audio.duration;if(!Number.isFinite(value)||value<=0)reject(new Error('ASR_AUDIO_DURATION_UNKNOWN'));else resolve(value);};
      const bad=()=>{cleanup();reject(new Error('ASR_AUDIO_DECODE_FAILED'));};
      const abort=()=>{cleanup();reject(new Error('ASR_AUDIO_CANCELLED'));};
      audio.addEventListener('loadedmetadata',loaded,{once:true});audio.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{cleanup();reject(new Error('ASR_AUDIO_TIMEOUT'));},15000);
      audio.preload='metadata';audio.src=url;audio.load();
    });
  } finally {audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);}
}

/** 从压缩音频 Blob 提取一个片段；只保留压缩音频和至多 30 秒 PCM。 */
export async function extractPcmSegment(blob:Blob, startSec:number, durationSec:number, signal?:AbortSignal):Promise<Uint8Array> {
  if(!Number.isFinite(startSec)||startSec<0||!Number.isFinite(durationSec)||durationSec<=0||durationSec>30) throw new Error('ASR_AUDIO_RANGE_INVALID');
  if(signal?.aborted) throw new Error('ASR_AUDIO_CANCELLED');
  const expected=Math.round(durationSec*16000);
  const result=new Uint8Array(expected*2);
  const audio=new Audio(), url=URL.createObjectURL(blob);
  let context:AudioContext | undefined, node:AudioWorkletNode | undefined;
  const controller=new AbortController();
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,Math.max(15000,Math.ceil(durationSec*1000)+15000));
  const waitEvent=(target:EventTarget,event:string)=>new Promise<void>((resolve,reject)=>{
    const done=()=>{cleanup();resolve();};
    const bad=()=>{cleanup();reject(new Error('ASR_AUDIO_DECODE_FAILED'));};
    const aborted=()=>{cleanup();reject(new Error('ASR_AUDIO_CANCELLED'));};
    const cleanup=()=>{target.removeEventListener(event,done);audio.removeEventListener('error',bad);controller.signal.removeEventListener('abort',aborted);};
    if(controller.signal.aborted){aborted();return;}
    target.addEventListener(event,done,{once:true});audio.addEventListener('error',bad,{once:true});controller.signal.addEventListener('abort',aborted,{once:true});
  });
  try {
    audio.preload='auto';audio.src=url;
    const metadata=waitEvent(audio,'loadedmetadata');audio.load();await metadata;
    if(!Number.isFinite(audio.duration)||startSec>=audio.duration) throw new Error('ASR_AUDIO_RANGE_INVALID');
    context=new AudioContext({sampleRate:16000});
    if(context.sampleRate!==16000) throw new Error('ASR_AUDIO_RATE_UNSUPPORTED');
    const runtime = browser.runtime as unknown as {getURL(path:string):string};
    await context.audioWorklet.addModule(new URL('asr-pcm-worklet.js',runtime.getURL('/offscreen.html')).href);
    if(controller.signal.aborted) throw new Error('ASR_AUDIO_CANCELLED');
    const source=context.createMediaElementSource(audio);
    node=new AudioWorkletNode(context,'doubao-pcm-capture',{channelCount:1,channelCountMode:'explicit',numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    source.connect(node);node.connect(context.destination);
    if(startSec>0){const seeked=waitEvent(audio,'seeked');audio.currentTime=startSec;await seeked;}
    let used=0;
    const complete=new Promise<Uint8Array>((resolve,reject)=>{
      const cleanup=()=>{audio.removeEventListener('ended',ended);audio.removeEventListener('error',bad);controller.signal.removeEventListener('abort',aborted);};
      const finish=()=>{cleanup();if(used!==result.length)reject(new Error('ASR_AUDIO_INCOMPLETE'));else resolve(result);};
      const ended=()=>node!.port.postMessage({type:'stop'});
      const bad=()=>{cleanup();reject(new Error('ASR_AUDIO_DECODE_FAILED'));};
      const aborted=()=>{cleanup();reject(new Error('ASR_AUDIO_CANCELLED'));};
      node!.port.onmessage=(event:MessageEvent<{type:string;buffer?:ArrayBuffer}>)=>{
        if(event.data.type==='pcm'&&event.data.buffer){const bytes=new Uint8Array(event.data.buffer);if(used+bytes.length>result.length){cleanup();reject(new Error('ASR_AUDIO_OVERFLOW'));return;}result.set(bytes,used);used+=bytes.length;}
        if(event.data.type==='done'||event.data.type==='stopped')finish();
      };
      audio.addEventListener('ended',ended,{once:true});audio.addEventListener('error',bad,{once:true});controller.signal.addEventListener('abort',aborted,{once:true});
    });
    void complete.catch(()=>{}); // 播放失败时 complete 仍可能因清理中止而拒绝。
    await context.resume();
    if(controller.signal.aborted) throw new Error('ASR_AUDIO_CANCELLED');
    // 启动捕获与播放同一事件循环，不预先计入暂停时的静音。
    audio.addEventListener('play',()=>node!.port.postMessage({type:'start',samples:expected}),{once:true});
    await audio.play();
    return await complete;
  } catch(e) {
    if(e instanceof Error&&/^ASR_[A-Z_]+$/.test(e.message))throw e;
    throw new Error('ASR_AUDIO_DECODE_FAILED');
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();audio.pause();audio.removeAttribute('src');audio.load();node?.disconnect();if(context)await context.close().catch(()=>{});URL.revokeObjectURL(url);
  }
}
