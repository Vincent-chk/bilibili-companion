// Phase 4.2：按已确认的完整视频音轨识别；只保存文字、时间和状态。
import { pickAudioStream } from '../asr';
import { decodeWholeAudio, probeAudioDuration } from '../asr/audio';
import { hasAsrSemanticMismatch, isRecoveryCandidate, timedCues } from '../asr/doubao';
import { isCacheFresh, summaryKey, type AsrRecovery, type StoredCue, type SummaryRow, type TranscriptRow, type VideoRow } from '../storage';
import { BiliApiError, pickPage } from '../bilibili/client';
import { runMap } from './mapReduce';
import { LlmHttpError, LlmNetworkError } from '../llm/client';
import { mapLlmError, parseVideoKey, runLlmAndPersist, type ChainCtx } from './chain';
import type { AsrJobDeps } from './asr';
import type { JobOutcome } from '../pipeline';

type Run = {videoKey:string;id?:string;sessionId?:string;runId?:string;recovery?:AsrRecovery};
const stale = () => new Error('ASR_JOB_STALE');


async function boundedAudio(fetchAudio:typeof fetch, url:string, maxBytes:number, signal?:AbortSignal):Promise<Blob> {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120_000);
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
  try {
    const response=await fetchAudio(url,{credentials:'omit',signal:controller.signal});
    if(!response.ok) throw new Error('ASR_AUDIO_HTTP');
    const size=Number(response.headers.get('content-length')||0);
    if(size>maxBytes) { await response.body?.cancel().catch(()=>{});controller.abort();throw new Error('ASR_AUDIO_TOO_LARGE'); }
    if(!response.body) throw new Error('ASR_AUDIO_FAILED');
    const reader=response.body.getReader(), chunks:Uint8Array<ArrayBuffer>[]=[];let total=0;
    try {
      for(;;){const {done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>maxBytes){await reader.cancel().catch(()=>{});throw new Error('ASR_AUDIO_TOO_LARGE');}chunks.push(new Uint8Array(value));}
    } finally {reader.releaseLock();}
    if(!total)throw new Error('ASR_AUDIO_FAILED');
    return new Blob(chunks,{type:'audio/mp4'});
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export async function runDoubaoAsrJob(deps:AsrJobDeps, job:Run, ctx:ChainCtx):Promise<JobOutcome> {
  const {db,bili,asr,llm}=deps;
  if(!job.id||!job.sessionId||!job.runId||!deps.transcribePcm) return {result:'failed',error:{code:'ASR_JOB_INVALID',msg:'语音任务状态无效，请重新确认'}};
  const session=await db.sessions.get(job.sessionId);
  if(!session || !['ACTIVE','GRACE'].includes(session.state)) return {result:'failed',error:{code:'ASR_JOB_STALE',msg:'陪看会话已结束'}};
  const initialState=session.state, skey=summaryKey(job.videoKey,llm.model), {bvid,cid}=parseVideoKey(job.videoKey);
  const active=async()=>{const current=await db.jobs.get(job.id!);const currentSession=await db.sessions.get(job.sessionId!);if(!current || current.status!=='running'||current.runId!==job.runId||current.sessionId!==job.sessionId||currentSession?.state!==initialState)throw stale();};
  const commit=async(transcript?:TranscriptRow,summary?:SummaryRow,video?:VideoRow)=>db.transaction('rw',db.jobs,db.sessions,db.transcripts,db.summaries,db.videos,async()=>{
    await active();
    if(video)await db.videos.put(video);
    if (!job.recovery) {if(transcript)await db.transcripts.put(transcript);if(summary)await db.summaries.put(summary);return;}
    const current=await db.jobs.get(job.id!);const recovery=current?.recovery;
    if (!recovery || recovery.committed || JSON.stringify(await db.transcripts.get(job.videoKey))!==JSON.stringify(recovery.original)) throw stale();
    if (summary?.status==='done') {
      const candidate=transcript??recovery.candidate;if(!candidate || !isRecoveryCandidate(candidate,job.videoKey,(await db.videos.get(job.videoKey))?.duration) || JSON.stringify(candidate)!==JSON.stringify(recovery.candidate))throw stale();
      for(const other of await db.summaries.where('videoKey').equals(job.videoKey).toArray())
        if(other.key!==summary.key && other.source==='asr' && other.status==='done')await db.summaries.put({...other,asrOutdated:true});
      await db.transcripts.put(candidate);await db.summaries.put({...summary,asrOutdated:undefined});
      await db.jobs.update(job.id!,{recovery:{...recovery,candidate,pending:false,committed:true}});
    } else {
      await db.jobs.update(job.id!,{recovery:{...recovery,...(transcript?{candidate:transcript,pending:!!transcript.asrPending}:{}),...(summary?.asrProgress?{progress:summary.asrProgress}:{})}});
    }
  });
  const notify=async()=>{try{await deps.onAsrPartial?.();}catch{/* 结果已持久化，通知失败不重新识别 */}};
  let transcript:TranscriptRow|undefined, summary:SummaryRow|undefined, timestampReason:string|undefined;
  try {
    await active();let video=await db.videos.get(job.videoKey);
    if(!video){const v=await bili.getView(bvid),pg=v.pages.find(p=>p.cid===cid)??pickPage(v.pages,1);if(!pg||pg.cid!==cid)throw new Error('ASR_VIDEO_MISMATCH');video={key:job.videoKey,bvid,aid:v.aid,cid:pg.cid,title:v.title,cover:v.cover,owner:v.owner,duration:pg.duration??v.duration,page:pg.page??1,fetchedAt:Date.now()};await commit(undefined,undefined,video);}
    if(!Number.isFinite(video.duration)||video.duration<=0)throw new Error('ASR_DURATION_UNKNOWN');
    const previous=await db.transcripts.get(job.videoKey);
    if(previous && hasAsrSemanticMismatch(previous) && !job.recovery) return {result:'failed',error:{code:'ASR_CONTENT_UNCONFIRMED',msg:'已有转写内容或时间不一致，原文和旧摘要已保留；请检查后再处理'}};
    if(job.recovery && JSON.stringify(previous)!==JSON.stringify(job.recovery.original))throw stale();
    if(job.recovery?.candidate?.asrComplete && (!isCacheFresh(job.recovery.candidate.cachedAt)||!isRecoveryCandidate(job.recovery.candidate,job.videoKey,video.duration)))return {result:'failed',error:{code:'ASR_RECOVERY_CHANGED',msg:'已保存的新转写不可用，请重新确认处理方式'}};
    transcript=job.recovery?.candidate ?? (job.recovery ? undefined : previous?.source==='asr'&&isCacheFresh(previous.cachedAt)?previous:undefined);
    // 旧通用接口缺失时间戳时会将整段文字伪装成 0→视频时长的一条 cue；不能当作精确时间复用。
    const legacyUntimed=transcript?.asrComplete===undefined && !transcript?.asrParts?.some(p=>p.whole===true) && transcript?.cues.length===1 && transcript.cues[0]?.from===0 && transcript.cues[0]?.to===video.duration;
    if(legacyUntimed && transcript) transcript={...transcript,asrComplete:false};
    const priorSummary=await db.summaries.get(skey);
    if(priorSummary?.status==='done' && !job.recovery)return {result:'done'};
    let targetDuration=transcript?.asrDuration??video.duration;
    const originalProgress=job.recovery?.progress ?? (transcript ? priorSummary?.asrProgress : undefined);
    let tailWarning=originalProgress?.warning?.match(/音轨尾部[^。]*。/)?.[0];
    summary={key:skey,videoKey:job.videoKey,source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:llm.model,persona:deps.persona??'spicy',createdAt:Date.now(),status:'streaming',asrProgress:{sessionId:job.sessionId,processedUntil:originalProgress?.processedUntil??0,targetDuration,status:'running',parts:originalProgress?.parts??[],...(legacyUntimed && transcript?{unconfirmed:[{from:0,to:video.duration,text:transcript.cues[0]!.text}]}:originalProgress?.unconfirmed?{unconfirmed:originalProgress.unconfirmed}:{}),...((tailWarning||transcript?.asrPending)?{warning:[tailWarning,transcript?.asrPending?'上次识别中断，重新提交该片段可能再次消耗额度。':undefined].filter(Boolean).join(' ')}:{})}};
    await commit(undefined,summary);await notify();
    if(!transcript || transcript.asrComplete===false){
      if(video.duration>900)throw new Error('ASR_DURATION_LIMIT');
      transcript=transcript??{key:job.videoKey,source:'asr',lan:'asr',cues:[],charCount:0,cachedAt:Date.now(),asrComplete:false,asrParts:[]};
      // 旧分段缓存继续保留。已有的全片识别结果优先重校验，不再次提交音频。
      let whole=transcript.asrParts?.find(p=>p.whole===true && p.start===0 && Math.abs(p.end-targetDuration)<0.05);
      if(!whole){
        await ctx.update({stage:'audio',progress:10});await active();await bili.fetchWbiKeys();
        const picked=pickAudioStream(await bili.getPlayUrlAudio(bvid,video.cid));if(!picked)throw new Error('ASR_AUDIO_MISSING');
        const blob=await boundedAudio(deps.fetchAudio??fetch.bind(globalThis),picked.url,Math.min(deps.asrMaxMB,25)*1024*1024,deps.signal);await active();
        const audioDuration=await (deps.getAudioDuration??probeAudioDuration)(blob,deps.signal);await active();
        if(!Number.isFinite(audioDuration)||audioDuration<=0||Math.abs(audioDuration-video.duration)>1||audioDuration-video.duration>0.05)throw new Error('ASR_DURATION_MISMATCH');
        targetDuration=Math.min(audioDuration,video.duration);
        if(transcript.asrDuration!==undefined&&Math.abs(transcript.asrDuration-targetDuration)>0.05)throw new Error('ASR_DURATION_MISMATCH');
        const decoded=await (deps.decodeWholeAudio??decodeWholeAudio)(blob,audioDuration,deps.signal);await active();
        let bytes=Math.round(targetDuration*16000)*2;
        if(decoded.length%2!==0)throw new Error('ASR_AUDIO_INCOMPLETE');
        // 容器元数据与重采样后的 PCM 可能相差一个编码帧；容许最多 25ms，以实际解码长度为准，绝不补造音频。
        if(decoded.length<bytes){if(bytes-decoded.length>800)throw new Error('ASR_AUDIO_INCOMPLETE');bytes=decoded.length;}
        targetDuration=bytes/32000;
        const excess=(decoded.length-bytes)/32000;
        if(excess>0.1)throw new Error('ASR_DURATION_MISMATCH');
        tailWarning=excess>0?`音轨尾部约 ${excess.toFixed(3)} 秒超出视频范围，未包含在识别中。`:undefined;
        transcript={...transcript,asrDuration:targetDuration,asrPending:{start:0,end:targetDuration},asrComplete:false,cachedAt:Date.now()};
        summary={...summary,asrProgress:{...summary.asrProgress!,targetDuration,...(tailWarning?{warning:tailWarning}:{})}};await commit(transcript,summary);
        await ctx.update({stage:'asr',progress:30});await active();
        const frame=await deps.transcribePcm(decoded.subarray(0,bytes),0);await active();
        if(!frame.final||!frame.result)throw new Error('ASR_INCOMPLETE');
        whole={start:0,end:targetDuration,result:frame.result,cues:[],whole:true,...(frame.audioDurationMs!==undefined?{serviceDurationMs:frame.audioDurationMs}:{})};
        transcript={...transcript,asrParts:[...(transcript.asrParts??[]).filter(p=>p.start!==0||Math.abs(p.end-targetDuration)>=0.05),whole],asrPending:undefined,cachedAt:Date.now()};
        await commit(transcript,summary);
      }
      const rawText=whole.result.text||whole.result.utterances.map(u=>u.text).join('');
      const durationError=whole.serviceDurationMs===undefined||!Number.isFinite(whole.serviceDurationMs)||whole.serviceDurationMs<=0?'ASR_SERVICE_DURATION_UNKNOWN':Math.abs(whole.serviceDurationMs-targetDuration*1000)>1000?'ASR_SERVICE_DURATION_MISMATCH':undefined;
      if(durationError){summary={...summary,asrProgress:{...summary.asrProgress!,unconfirmed:[{from:0,to:targetDuration,text:rawText}]}};await commit(transcript,summary);throw new Error(durationError);}
      if(whole.result.utterances.some(u=>u.text.trim()&&!u.definite)){
        summary={...summary,asrProgress:{...summary.asrProgress!,unconfirmed:[{from:0,to:targetDuration,text:rawText}]}};
        await commit(transcript,summary);throw new Error('ASR_UNCONFIRMED');
      }
      const cues=timedCues(whole.result,0,targetDuration,reason=>{timestampReason=reason;});
      if(cues===null){
        summary={...summary,asrProgress:{...summary.asrProgress!,unconfirmed:[{from:0,to:targetDuration,text:rawText}]}};
        await commit(transcript,summary);throw new Error('ASR_TIMESTAMP_MISSING');
      }
      whole={...whole,cues};
      transcript={...transcript,cues,charCount:cues.reduce((n,c)=>n+c.text.length,0),asrParts:[whole],asrComplete:true,asrPending:undefined,cachedAt:Date.now()};
      summary={...summary,asrProgress:{sessionId:job.sessionId,processedUntil:0,targetDuration,status:'running',parts:[],...(tailWarning?{warning:tailWarning}:{})}};
      await commit(transcript,summary);await notify();
    }
    await active();
    const chars=transcript.cues.reduce((n,c)=>n+Array.from(c.text.replace(/[\s\p{P}\p{S}]/gu,'')).length,0);
    if(!chars)throw new Error('ASR_NO_SPEECH');
    // 真实 5 字样本曾被模型扩写成无依据的大纲；保留转写，避免将极短文字伪装为完整摘要。
    if(chars<=5)throw new Error('ASR_TOO_SHORT');
    // 全片识别完成后按 3 分钟展示局部要点；它们只说明对应时间范围。
    for(let start=0,index=0;start<targetDuration;start+=180,index++){
      const end=Math.min(start+180,targetDuration);
      let note:string|undefined=summary.asrProgress!.parts.find(p=>p.from===start&&p.to===end)?.text;
      if(!note){
        const part=transcript.cues.filter(c=>c.from>=start&&c.from<end);
        note=part.length?await (deps.makeLocalNote?deps.makeLocalNote(part,index):runMap(llm,video.title,part,{fetchImpl:deps.fetchImpl,timeoutMs:deps.timeoutMs,signal:deps.signal,asrTranscript:true})):'此范围没有识别到语音。';
        await active();
      }
      const parts:{from:number;to:number;text:string}[]=[...summary.asrProgress!.parts.filter(p=>p.from!==start),{from:start,to:end,text:note}].sort((a,b)=>a.from-b.from);
      summary={...summary,asrProgress:{...summary.asrProgress!,processedUntil:end,targetDuration,status:'running',parts}};
      await commit(undefined,summary);await notify();
    }
    const warning=[tailWarning,video.duration-targetDuration>0.05?`音轨在 ${targetDuration.toFixed(2)} 秒结束；已处理到音轨结尾。`:undefined].filter(Boolean).join(' ');
    const completedProgress={...summary.asrProgress!,processedUntil:targetDuration,status:'done' as const,warning:warning||undefined};
    const baseSummary={...summary,asrProgress:completedProgress};
    const outcome=await runLlmAndPersist({...deps,requireStructured:true,persistSummary:async row=>{await commit(transcript,row);}},ctx,{video,transcript,baseSummary,keepDone:false});
    if(outcome.result==='done'){await notify();return outcome;}
    throw new Error('ASR_SUMMARY_FAILED');
  }catch(e){
    if(deps.signal?.aborted)return {result:'failed',error:{code:'ASR_JOB_STALE',msg:'陪看已结束或任务已取消'}};
    const code=e instanceof LlmHttpError||e instanceof LlmNetworkError?'ASR_SUMMARY_FAILED':e instanceof Error&&/^ASR_[A-Z_0-9]+$/.test(e.message)?e.message:'ASR_FAILED';
    if(code==='ASR_JOB_STALE')return {result:'failed',error:{code,msg:'陪看已结束或任务已取消'}};
    const messages:Record<string,string>={ASR_DURATION_LIMIT:'当前豆包语音最多支持 15 分钟的视频，暂不能处理更长的音轨',ASR_AUDIO_TOO_LONG:'当前豆包语音最多支持 15 分钟的音轨',ASR_AUDIO_TOO_LARGE:'音频超过当前 25 MiB 大小上限，暂不支持处理',ASR_AUDIO_CHANNEL_UNSUPPORTED:'该音轨声道格式暂不支持',ASR_AUDIO_INCOMPLETE:'音频解码不完整，暂不能识别，请稍后重试',ASR_SEND_TIMEOUT:'音频发送超时，请检查网络后重新确认',ASR_SERVICE_45000081:'语音服务等待音频包超时，识别未完成',ASR_SERVICE_DURATION_UNKNOWN:'语音服务未返回已处理时长，无法确认全片结果',ASR_SERVICE_DURATION_MISMATCH:'语音服务处理时长与音轨不一致，无法确认全片结果',ASR_AUDIO_MISSING:'无法获取该视频的音频',ASR_AUDIO_HTTP:'音频下载失败，请检查网络或登录状态',ASR_AUDIO_FAILED:'音频获取失败，请稍后重试',ASR_DURATION_MISMATCH:'音轨和视频时长不一致，暂不能确认处理范围',ASR_TIMESTAMP_MISSING:'部分语音缺少可靠时间信息，已保留内容，无法确认完整结果',ASR_UNCONFIRMED:'部分识别结果尚未确认，已保留内容，不能标记完整',ASR_NO_SPEECH:'该音频未识别到可用语音',ASR_TOO_SHORT:'识别到了少量语音，但内容不足以生成可靠摘要',ASR_SUMMARY_FAILED:'摘要生成未完成，可重试并复用已识别的文字'};
    const error=e instanceof BiliApiError ? mapLlmError(e) : {code,msg:messages[code]??'语音处理未完成，可检查设置后重试'};
    if(summary){const warning=transcript?.asrPending?'本次语音识别的计费状态不明；再次识别可能重复消耗额度。':code==='ASR_TIMESTAMP_MISSING'&&timestampReason?`部分语音时间无法确认：${timestampReason}。已保留内容。`:error.msg;const tail=summary.asrProgress?.warning?.match(/音轨尾部[^。]*。/)?.[0];summary={...summary,status:'need_asr',error,asrProgress:{...summary.asrProgress!,status:'partial',warning:[warning,tail].filter(Boolean).join(' ')}};try{await commit(transcript,summary);await notify();}catch{/* 会话已结束或数据已清除，不得复活 */}}
    return {result:'failed',error};
  }
}
