import {test,expect,chromium} from '@playwright/test';
import {mkdtemp, mkdir, writeFile, readFile, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

test('真实离屏 AudioWorklet 能提取音频、拒绝不足片段并清理取消任务',async()=>{
 test.setTimeout(45000);
 const root=await mkdtemp(join(tmpdir(),'asr42-')),ext=join(root,'ext'); await mkdir(ext);
 let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
 try {
  execFileSync('pnpm',['exec','tsc','--ignoreConfig','src/lib/asr/audio.ts','--target','es2022','--module','esnext','--moduleResolution','bundler','--skipLibCheck','--outDir',join(root,'tsout')],{cwd:process.cwd()});
  const js=(await readFile(join(root,'tsout','audio.js'),'utf8')).replace("import { browser } from 'wxt/browser';",'const browser = chrome;');
  await writeFile(join(ext,'audio.mjs'),js);await cp(resolve('public/asr-pcm-worklet.js'),join(ext,'asr-pcm-worklet.js'));
  await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'ASR offscreen fixture',version:'1.0',permissions:['offscreen'],background:{service_worker:'background.js'}}));
  await writeFile(join(ext,'background.js'),'chrome.runtime.onMessage.addListener(()=>{});');
  await writeFile(join(ext,'offscreen.html'),'<!doctype html><script type="module" src="test.mjs"></script>');
  await writeFile(join(ext,'test.mjs'),`
import {extractPcmSegment,probeAudioDuration} from './audio.mjs';
chrome.runtime.onMessage.addListener(m=>{
 if(m?.type!=='RUN_TEST')return;
 return (async()=>{
  let created=0,revoked=0,closed=0;const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL),close=AudioContext.prototype.close;
  URL.createObjectURL=b=>{created++;return create(b)};URL.revokeObjectURL=u=>{revoked++;return revoke(u)};AudioContext.prototype.close=function(){closed++;return close.call(this)};
  const n=75840,bytes=new Uint8Array(44+n),v=new DataView(bytes.buffer);const put=(o,s)=>Array.from(s).forEach((c,i)=>bytes[o+i]=c.charCodeAt(0));put(0,'RIFF');v.setUint32(4,36+n,true);put(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,n,true);for(let i=0;i<n/2;i++)v.setInt16(44+i*2,Math.round(Math.sin(i/10)*10000),true);const blob=new Blob([bytes],{type:'audio/wav'});
  const duration=await probeAudioDuration(blob);const out=await extractPcmSegment(blob,.4,1);let early='';try{await extractPcmSegment(blob,2,1)}catch(e){early=e.message}
  let aborted='';const ctl=new AbortController();const pending=extractPcmSegment(blob,0,1.5,ctl.signal);setTimeout(()=>ctl.abort(),250);try{await pending}catch(e){aborted=e.message}
  const full=await extractPcmSegment(blob,0,duration);
  return {duration,length:out.length,nonzero:out.some(x=>x!==0),early,aborted,created,revoked,closed,fullLength:full.length};
 })().catch(e=>({error:e.message}));
});`);
  context=await chromium.launchPersistentContext(join(root,'profile'),{executablePath:process.env.E2E_BROWSER,...(process.env.E2E_BROWSER?{}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  const worker=context.serviceWorkers().find(w=>w.url().endsWith('background.js'))??await context.waitForEvent('serviceworker');
  const result=await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;await c.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS','WORKERS'],justification:'语音识别分段测试'});
    let response;for(let i=0;i<12;i++){try{response=await c.runtime.sendMessage({type:'RUN_TEST'});break}catch{await new Promise(r=>setTimeout(r,250));}}
    await c.offscreen.closeDocument();return response;
  });
  expect(result).toEqual({duration:2.37,length:32000,nonzero:true,early:'ASR_AUDIO_INCOMPLETE',aborted:'ASR_AUDIO_CANCELLED',created:5,revoked:5,closed:4,fullLength:75840});
 } finally {await context?.close();await rm(root,{recursive:true,force:true});}
});

test('离线解码立体声 AAC 保留首中尾且快于实时播放',async()=>{
 test.skip(process.platform!=='darwin','此受控测试使用 macOS 自带 AAC 编码器');
 test.setTimeout(45000);
 const root=await mkdtemp(join(tmpdir(),'asr-offline-')),ext=join(root,'ext');await mkdir(ext);
 let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
 try {
  const sr=44100,frames=sr*6,pcm=Buffer.alloc(44+frames*4);pcm.write('RIFF');pcm.writeUInt32LE(36+frames*4,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(2,22);pcm.writeUInt32LE(sr,24);pcm.writeUInt32LE(sr*4,28);pcm.writeUInt16LE(4,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(frames*4,40);
  for(let i=0;i<frames;i++){const hz=i<sr*2?220:i<sr*4?440:880;const v=Math.round(Math.sin(2*Math.PI*hz*i/sr)*12000);pcm.writeInt16LE(v,44+i*4);pcm.writeInt16LE(Math.round(v/2),46+i*4);}
  const wav=join(root,'input.wav'),m4a=join(root,'input.m4a');await writeFile(wav,pcm);execFileSync('/usr/bin/afconvert',['-f','m4af','-d','aac','-b','96000',wav,m4a]);
  const encoded=(await readFile(m4a)).toString('base64');
  execFileSync('pnpm',['exec','tsc','--ignoreConfig','src/lib/asr/audio.ts','--target','es2022','--module','esnext','--moduleResolution','bundler','--skipLibCheck','--outDir',join(root,'tsout')],{cwd:process.cwd()});
  const js=(await readFile(join(root,'tsout','audio.js'),'utf8')).replace("import { browser } from 'wxt/browser';",'const browser = chrome;');await writeFile(join(ext,'audio.mjs'),js);
  await writeFile(join(ext,'manifest.json'),JSON.stringify({manifest_version:3,name:'Offline fixture',version:'1.0',permissions:['offscreen'],background:{service_worker:'background.js'}}));await writeFile(join(ext,'background.js'),'chrome.runtime.onMessage.addListener(()=>{});');await writeFile(join(ext,'offscreen.html'),'<!doctype html><script type="module" src="test.mjs"></script>');
  await writeFile(join(ext,'test.mjs'),`import {decodeWholeAudio,probeAudioDuration} from './audio.mjs';chrome.runtime.onMessage.addListener(m=>{if(m?.type!=='RUN')return;return (async()=>{const raw=atob('${encoded}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));const blob=new Blob([bytes],{type:'audio/mp4'});const duration=await probeAudioDuration(blob);const start=performance.now();const pcm=await decodeWholeAudio(blob,duration);const ms=performance.now()-start;const view=new DataView(pcm.buffer);function crossings(t){let n=0;for(let i=t*16000+1;i<(t+1)*16000;i++)if(view.getInt16((i-1)*2,true)<=0&&view.getInt16(i*2,true)>0)n++;return n;}const ctl=new AbortController();ctl.abort();let cancelled='';try{await decodeWholeAudio(blob,duration,ctl.signal)}catch(e){cancelled=e.message}let large='';try{await decodeWholeAudio(blob,901)}catch(e){large=e.message}return {duration,samples:pcm.length/2,ms,freq:[crossings(0),crossings(2),crossings(4)],cancelled,large};})()});`);
  context=await chromium.launchPersistentContext(join(root,'profile'),{executablePath:process.env.E2E_BROWSER,...(process.env.E2E_BROWSER?{}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  const worker=context.serviceWorkers().find(w=>w.url().endsWith('background.js'))??await context.waitForEvent('serviceworker');
  const result=await worker.evaluate(async()=>{const c=(globalThis as any).chrome;await c.offscreen.createDocument({url:'offscreen.html',reasons:['BLOBS'],justification:'音频解码验证'});let response;for(let i=0;i<12;i++){try{response=await c.runtime.sendMessage({type:'RUN'});break}catch{await new Promise(r=>setTimeout(r,250));}}return response;});
  expect(Math.abs(result.duration-6)).toBeLessThan(.15);expect(Math.abs(result.samples/16000-result.duration)).toBeLessThan(.1);expect(result.freq[0]).toBeGreaterThan(200);expect(result.freq[0]).toBeLessThan(230);expect(result.freq[1]).toBeGreaterThan(420);expect(result.freq[1]).toBeLessThan(450);expect(result.freq[2]).toBeGreaterThan(850);expect(result.freq[2]).toBeLessThan(890);expect(result.ms).toBeLessThan(5000);expect(result.cancelled).toBe('ASR_AUDIO_CANCELLED');expect(result.large).toBe('ASR_AUDIO_TOO_LONG');
 } finally {await context?.close();await rm(root,{recursive:true,force:true});}
});
