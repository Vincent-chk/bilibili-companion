import type { StoredCue } from '../storage';

export interface AudioRange {start:number; end:number}
/** 片段不超过 30 秒；相邻片段重叠 1 秒。 */
export function audioSegmentRanges(duration:number): AudioRange[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const ranges:AudioRange[]=[];
  for (let start=0;start<duration;) {
    const end=Math.min(start+30,duration);ranges.push({start,end});
    if (end>=duration) break;
    start=end-1;
  }
  return ranges;
}
const valid=(c:StoredCue)=>Number.isFinite(c.from)&&Number.isFinite(c.to)&&c.from>=0&&c.to>c.from&&!!c.text.trim();
const norm=(s:string)=>s.replace(/[\s\p{P}\p{S}]/gu,'');
/** 输入需为有准确全局时间的词级 cue；无法确认时原样保留两侧，不删除疑似内容。 */
export function mergeTimedSegments(previous:StoredCue[],next:StoredCue[],overlapStart:number,overlapEnd:number):{confirmed:boolean;cues:StoredCue[]} {
  const combined=[...previous,...next];
  if (!Number.isFinite(overlapStart)||!Number.isFinite(overlapEnd)||overlapEnd<=overlapStart||combined.some(c=>!valid(c))) return {confirmed:false,cues:combined};
  const left=previous.filter(c=>c.to>overlapStart&&c.from<overlapEnd);
  const right=next.filter(c=>c.to>overlapStart&&c.from<overlapEnd);
  if (!left.length && !right.length) return {confirmed:true,cues:combined};
  if (!left.length || !right.length) return {confirmed:false,cues:combined};
  // 仅匹配后缀/前缀无法证明余下的重叠语音是否缺失或重复。
  if (left.length!==right.length || left.map(c=>norm(c.text)).join('').length<2 ||
      !left.every((c,i)=>norm(c.text)&&norm(c.text)===norm(right[i]!.text)&&Math.abs(c.from-right[i]!.from)<=0.2&&Math.abs(c.to-right[i]!.to)<=0.2)) {
    return {confirmed:false,cues:combined};
  }
  const matches=(a:StoredCue,b:StoredCue)=>norm(a.text)===norm(b.text)&&Math.abs(a.from-b.from)<=0.2&&Math.abs(a.to-b.to)<=0.2;
  if (left.some(c=>right.filter(r=>matches(c,r)).length!==1) || right.some(c=>left.filter(l=>matches(l,c)).length!==1)) return {confirmed:false,cues:combined};
  const remove=new Set(right);
  return {confirmed:true,cues:[...previous,...next.filter(c=>!remove.has(c))].sort((x,y)=>x.from-y.from)};
}
