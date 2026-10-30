import { afterEach,describe,expect,it,vi } from 'vitest';
vi.mock('wxt/browser',()=>({browser:{runtime:{getURL:()=> 'chrome-extension://test/offscreen.html'}}}));
import { decodeWholeAudio, extractPcmSegment, probeAudioDuration } from '../src/lib/asr/audio';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('PCM 音频提取输入安全边界',()=>{
  it('无效区间在创建浏览器音频对象前拒绝',async()=>{
    await expect(extractPcmSegment(new Blob(),-1,1)).rejects.toThrow('ASR_AUDIO_RANGE_INVALID');
    await expect(extractPcmSegment(new Blob(),0,30.01)).rejects.toThrow('ASR_AUDIO_RANGE_INVALID');
    await expect(extractPcmSegment(new Blob(),0,0)).rejects.toThrow('ASR_AUDIO_RANGE_INVALID');
  });
  it('开始前中止不会创建或播放音频',async()=>{
    const c=new AbortController();c.abort();await expect(extractPcmSegment(new Blob(),0,1,c.signal)).rejects.toThrow('ASR_AUDIO_CANCELLED');
  });
  it('探测时长在中止时不创建音频对象',async()=>{const c=new AbortController();c.abort();await expect(probeAudioDuration(new Blob(),c.signal)).rejects.toThrow('ASR_AUDIO_CANCELLED');});
  it('音轨元数据超时后释放 Blob URL 和音频对象',async()=>{
    vi.useFakeTimers();
    const revoke=vi.fn(), audio=Object.assign(new EventTarget(),{preload:'',src:'',load:vi.fn(),removeAttribute:vi.fn()});
    vi.stubGlobal('Audio',function(){return audio;});vi.stubGlobal('URL',Object.assign(class {},{createObjectURL:vi.fn(()=> 'blob:fixture'),revokeObjectURL:revoke}));
    const pending=probeAudioDuration(new Blob());const check=expect(pending).rejects.toThrow('ASR_AUDIO_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15000);await check;
    expect(revoke).toHaveBeenCalledWith('blob:fixture');expect(audio.removeAttribute).toHaveBeenCalledWith('src');
  });
  it('音轨元数据读取失败后释放 Blob URL',async()=>{
    const revoke=vi.fn(), audio=Object.assign(new EventTarget(),{preload:'',src:'',load:vi.fn(),removeAttribute:vi.fn()});
    vi.stubGlobal('Audio',function(){return audio;});vi.stubGlobal('URL',Object.assign(class {},{createObjectURL:vi.fn(()=> 'blob:fixture'),revokeObjectURL:revoke}));
    const pending=probeAudioDuration(new Blob());audio.dispatchEvent(new Event('error'));await expect(pending).rejects.toThrow('ASR_AUDIO_DECODE_FAILED');
    expect(revoke).toHaveBeenCalledWith('blob:fixture');
  });
});

describe('离线完整音轨解码',()=>{
  it('超长或取消的输入在解码前被拒绝',async()=>{
    await expect(decodeWholeAudio(new Blob([new Uint8Array(2)]),900.1)).rejects.toThrow('ASR_AUDIO_TOO_LONG');
    const controller=new AbortController();controller.abort();await expect(decodeWholeAudio(new Blob([new Uint8Array(2)]),1,controller.signal)).rejects.toThrow('ASR_AUDIO_CANCELLED');
  });
  it('双声道按样本混合，输出完整的 16 位 PCM',async()=>{
    const a=new Float32Array([1,-1,.5,0]),b=new Float32Array([0,0,.5,1]);
    const buffer={numberOfChannels:2,sampleRate:16000,length:4,duration:4/16000,getChannelData:(i:number)=>i?a:b};
    vi.stubGlobal('OfflineAudioContext',class {decodeAudioData=vi.fn(async()=>buffer)});
    const out=await decodeWholeAudio(new Blob([new Uint8Array(2)]),4/16000);
    const view=new DataView(out.buffer);expect([0,1,2,3].map(i=>view.getInt16(i*2,true))).toEqual([16384,-16384,16384,16384]);
  });
  it('容器和实际解码长度明显不一致时拒绝',async()=>{
    vi.stubGlobal('OfflineAudioContext',class {decodeAudioData=vi.fn(async()=>({numberOfChannels:1,sampleRate:16000,length:16000,duration:1}))});
    await expect(decodeWholeAudio(new Blob([new Uint8Array(2)]),3)).rejects.toThrow('ASR_DURATION_MISMATCH');
  });
  it('解码期间取消后丢弃返回的结果',async()=>{
    let finish!:(value:unknown)=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r});
    vi.stubGlobal('OfflineAudioContext',class {decodeAudioData=vi.fn(()=>{started();return new Promise(r=>{finish=r})})});
    const controller=new AbortController();const result=decodeWholeAudio(new Blob([new Uint8Array(2)]),1,controller.signal);await ready;controller.abort();finish({numberOfChannels:1,sampleRate:16000,length:16000,duration:1});
    await expect(result).rejects.toThrow('ASR_AUDIO_CANCELLED');
  });
});
