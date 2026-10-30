import { describe,it,expect } from 'vitest';
import { audioSegmentRanges, mergeTimedSegments } from '../src/lib/asr/segments';

describe('语音分段及衔接',()=>{
 it('30 秒分段保留 1 秒重叠，末段不足 30 秒仍处理',()=>{
  expect(audioSegmentRanges(64)).toEqual([{start:0,end:30},{start:29,end:59},{start:58,end:64}]);
  expect(audioSegmentRanges(30)).toEqual([{start:0,end:30}]);
  expect(audioSegmentRanges(0)).toEqual([]);
 });
 it('重叠词含相同时间和唯一文字时删除新片段中重复的词',()=>{
  const previous=[{text:'前文',from:28,to:29},{text:'你好',from:29.2,to:29.7}];
  const next=[{text:'你好',from:29.21,to:29.71},{text:'世界',from:30,to:30.5}];
  expect(mergeTimedSegments(previous,next,29,30)).toEqual({confirmed:true,cues:[...previous,next[1]]});
 });
 it('重叠区只有部分词匹配时保留两侧全部内容且不标记完整',()=>{
  const previous=[{text:'前文',from:28,to:29.2},{text:'你好',from:29.2,to:29.7}];
  const next=[{text:'你好',from:29.21,to:29.71},{text:'世界',from:29.71,to:30.5}];
  expect(mergeTimedSegments(previous,next,29,30)).toEqual({confirmed:false,cues:[...previous,...next]});
 });
 it('重复文字的近似时间对应不唯一时不删除内容',()=>{
  const previous=[{text:'相同',from:29.1,to:29.3},{text:'相同',from:29.2,to:29.4}];
  const next=[{text:'相同',from:29.11,to:29.31},{text:'相同',from:29.21,to:29.41}];
  expect(mergeTimedSegments(previous,next,29,30)).toEqual({confirmed:false,cues:[...previous,...next]});
 });
 it('无法可靠对齐时保留原始两段并明确未确认',()=>{
  const prev=[{text:'相同',from:29.1,to:29.4},{text:'相同',from:29.5,to:29.8}];
  const next=[{text:'相同',from:29.2,to:29.5},{text:'之后',from:30,to:30.5}];
  const r=mergeTimedSegments(prev,next,29,30);
  expect(r.confirmed).toBe(false);expect(r.cues).toEqual([...prev,...next]);
 });
 it('重叠区双方都没有语音时安全拼接',()=>{
  const prev=[{text:'前文',from:1,to:2}],next=[{text:'后文',from:30.1,to:31}];
  expect(mergeTimedSegments(prev,next,29,30)).toEqual({confirmed:true,cues:[...prev,...next]});
 });
 it('一侧缺失时间信息时不得静默标记对齐成功',()=>{
  const r=mergeTimedSegments([{text:'前文',from:28,to:30}],[{text:'未知',from:NaN,to:31}],29,30);
  expect(r.confirmed).toBe(false);expect(r.cues).toHaveLength(2);
 });
 it('单字重复不能仅凭相近时间删除任何内容',()=>{
  const prev=[{text:'是',from:29.2,to:29.4}],next=[{text:'是',from:29.21,to:29.41}];
  expect(mergeTimedSegments(prev,next,29,30)).toEqual({confirmed:false,cues:[...prev,...next]});
 });
});
