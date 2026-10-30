// P1.5 · 面板视图模型单测：五态徽章映射（F4）、列表装配/排序、来源/阶段文案、
// 流式摘要抽取（F5/F7 打字机数据源）、转写节选（F7）、相对时间与星级。
import { describe, expect, it } from 'vitest';
import type { VisitRow } from '../src/lib/storage';
import {
  BADGE_HTML,
  SOURCE_LABEL,
  STAGE_LABEL,
  badgeFor,
  clockOf,
  excerptOf,
  extractStreamingSummary,
  fmtCountdown,
  fmtSec,
  relativeTimeLabel,
  sortListItems,
  starsHtml,
  toListItemVM,
  type ListQueryItem,
} from '../src/content/panel/view-models';

const visit = (over: Partial<VisitRow> = {}): VisitRow => ({
  id: 1,
  sessionId: 's1',
  videoKey: 'BV1x:111',
  firstSeenAt: 0,
  lastSeenAt: 1000,
  watchedSeconds: 0,
  progressPct: 0,
  triggered: 0,
  ...over,
});

describe('徽章映射（F4）', () => {
  it('无摘要无任务 → 未生成（灰）', () => {
    expect(badgeFor({})).toBe('ungenerated');
  });
  it('pending/running 任务 → 生成中（蓝，即使已有 done 摘要=重生成中）', () => {
    expect(badgeFor({ job: { status: 'pending' } })).toBe('generating');
    expect(badgeFor({ job: { status: 'running' }, summary: { status: 'done' } as never })).toBe('generating');
  });
  it('摘要 done → 已总结（绿）', () => {
    expect(badgeFor({ summary: { status: 'done' } as never })).toBe('summarized');
  });
  it('旧版保存的截断 JSON 不应显示为已总结', () => {
    const summary = { status: 'done', summary: '{"summary":"摘要", "outline":[{"time":9,' } as never;
    expect(badgeFor({ summary })).toBe('failed');
  });
  it('普通文本提到 JSON 字段或以普通花括号开头时仍显示已总结', () => {
    for (const summary of ['视频解释字段 "summary": 的含义。', '{模型参数} 包含温度和长度']) {
      expect(badgeFor({ summary: { status: 'done', summary, outline: [], evaluation: '' } as never })).toBe('summarized');
    }
  });
  it('有效结构化结果的摘要正文即使以 JSON 示例开头也不误判为旧损坏记录', () => {
    const summary = { status: 'done', summary: '{"summary":"示例"} 是视频展示的代码。',
      outline: [{ time: 0, text: '讲解示例' }], evaluation: '点评' } as never;
    expect(badgeFor({ summary })).toBe('summarized');
  });
  it('need_asr / need_confirm 任务 → 无字幕·待确认（橙）', () => {
    expect(badgeFor({ summary: { status: 'need_asr' } as never })).toBe('nosub');
    expect(badgeFor({ job: { status: 'need_confirm' } })).toBe('nosub');
  });
  it('极短语音提示内容不足，且仍让活动任务优先显示生成中', () => {
    const summary = {status:'need_asr',error:{code:'ASR_TOO_SHORT'}} as never;
    expect(badgeFor({summary})).toBe('insufficient');
    expect(badgeFor({summary,job:{status:'running'}})).toBe('generating');
    expect(BADGE_HTML.insufficient).toContain('内容不足');
  });
  it('已处理但未识别到语音时也显示内容不足', () => {
    expect(badgeFor({summary:{status:'need_asr',error:{code:'ASR_NO_SPEECH'}} as never})).toBe('insufficient');
  });
  it('摘要 failed 且无活动任务 → 解析失败（红）', () => {
    expect(badgeFor({ summary: { status: 'failed' } as never })).toBe('failed');
  });
  it('徽章文案齐全', () => {
    expect(Object.keys(BADGE_HTML).sort()).toEqual(['failed', 'generating', 'insufficient', 'nosub', 'summarized', 'ungenerated']);
  });
});

describe('列表装配与排序', () => {
  it('toListItemVM：缺失 video 行时兜底 videoKey 为标题；进度钳位 0-100', () => {
    const vm = toListItemVM({ visit: visit({ progressPct: 130, videoKey: 'BV1y:222' }) });
    expect(vm.title).toBe('BV1y:222');
    expect(vm.progressPct).toBe(100);
    expect(vm.cover).toBe('');
  });
  it('正常行：取 video 元信息 + done 摘要带出来源', () => {
    const vm = toListItemVM({
      visit: visit(),
      video: {
        key: 'BV1x:111', bvid: 'BV1x', aid: 1, cid: 111, title: '标题', cover: 'https://i0.hdslb.com/x.jpg',
        owner: 'UP主', duration: 2744, page: 1, fetchedAt: 0,
      },
      summary: { status: 'done', source: 'ai_sub' } as never,
    });
    expect(vm.title).toBe('标题');
    expect(vm.badge).toBe('summarized');
    expect(vm.source).toBe('ai_sub');
  });
  it('sortListItems 按最近观看倒序（F4）', () => {
    const items = [toListItemVM({ visit: visit({ lastSeenAt: 100 }) }), toListItemVM({ visit: visit({ lastSeenAt: 300 }) })];
    expect(sortListItems(items).map((i) => i.lastSeenAt)).toEqual([300, 100]);
  });
});

describe('文案与格式化', () => {
  it('来源徽章三态（F5：人工/AI/ASR）', () => {
    expect(SOURCE_LABEL.manual_sub).toBe('人工字幕');
    expect(SOURCE_LABEL.ai_sub).toBe('AI字幕');
    expect(SOURCE_LABEL.asr).toBe('ASR转写');
  });
  it('阶段文案五段', () => {
    for (const k of ['subtitle', 'audio', 'asr', 'llm_map', 'llm_reduce']) expect(STAGE_LABEL[k]).toBeTruthy();
  });
  it('fmtSec：mm:ss 与 h:mm:ss', () => {
    expect(fmtSec(0)).toBe('00:00');
    expect(fmtSec(65)).toBe('01:05');
    expect(fmtSec(3671)).toBe('1:01:11');
  });
  it('relativeTimeLabel 边界', () => {
    const now = 1_000_000;
    expect(relativeTimeLabel(now - 30_000, now)).toBe('刚刚');
    expect(relativeTimeLabel(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(relativeTimeLabel(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(relativeTimeLabel(now - 90_000_000, now)).toBe('更早');
  });
  it('starsHtml：1-5 🫘 + 暗豆兜底，越界钳位', () => {
    expect(starsHtml(4)).toBe('🫘🫘🫘🫘<span class="dim">🫘</span>');
    expect(starsHtml(0)).toBe('<span class="dim">🫘🫘🫘🫘🫘</span>');
    expect(starsHtml(9).startsWith('🫘🫘🫘🫘🫘')).toBe(true); // 越界钳位为 5（空 dim span 不渲染）
  });
});

describe('流式摘要抽取（F5 打字机数据源）', () => {
  it('未进入 summary 字段 → 空串（UI 显示阶段文案）', () => {
    expect(extractStreamingSummary('')).toBe('');
    expect(extractStreamingSummary('{"outline": [{"time"')).toBe('');
  });
  it('字段值未闭合 → 输出已到达部分', () => {
    expect(extractStreamingSummary('{"summary": "豆包看到')).toBe('豆包看到');
  });
  it('字段闭合 → 完整值；后续 JSON 内容不串入', () => {
    expect(extractStreamingSummary('{"summary": "完整摘要", "evaluation": "点评"')).toBe('完整摘要');
  });
  it('校验重发第二轮 JSON → 后出现的 summary 赢（lastIndexOf）', () => {
    const acc = '{"summary": "第一轮坏输出", "x": 1} 请严格输出 {"summary": "第二轮好输出"';
    expect(extractStreamingSummary(acc)).toBe('第二轮好输出');
  });
  it('转义：\\" \\\\ \\n \\uXXXX', () => {
    expect(extractStreamingSummary('{"summary": "a\\"b\\\\c')).toBe('a"b\\c');
    expect(extractStreamingSummary('{"summary": "a\\nb')).toBe('a\nb');
    expect(extractStreamingSummary('{"summary": "豆\\u30d5')).toBe('豆フ');
  });
  it('键名是别的字段（如 mysummary）不误匹配', () => {
    expect(extractStreamingSummary('{"xsummary": "nope')).toBe('');
  });
  it('surrogate pair（\\ud83d\\ude00=😀）按两个 \\u 转义还原（审查 P2-7）', () => {
    expect(extractStreamingSummary('{"summary": "a\\ud83d\\ude00b')).toBe('a😀b');
  });
  it('冒号后空白/换行形态："summary" : "x" 也能命中（审查 P2-7）', () => {
    expect(extractStreamingSummary('{"summary" : "间隔形态"')).toBe('间隔形态');
    expect(extractStreamingSummary('{"summary":\n"换行形态"')).toBe('换行形态');
  });
});

describe('转写节选（F7）', () => {
  const mk = (n: number) => ({
    key: 'BV1x:111',
    source: 'ai_sub' as const,
    lan: 'ai-zh',
    cues: Array.from({ length: n }, (_, i) => ({ from: i, to: i + 1, text: `t${i}` })),
    charCount: n * 3,
    cachedAt: 0,
  });
  it('无转写 → undefined', () => {
    expect(excerptOf(undefined)).toBeUndefined();
  });
  it('旧 ASR 占位时间原文保留但不作为可跳转 cue',()=>{
    const t={...mk(1),source:'asr' as const,cues:[{from:0,to:600,text:'旧原文'}]};
    expect(excerptOf(t,200,0,600)).toMatchObject({cues:[],unconfirmedText:'旧原文'});
    expect(excerptOf({...t,source:'ai_sub'},200,0,600)?.cues).toHaveLength(1);
  });
  it('超限时截断并保留总条数（标注「共 N 条，前 M 条」的据）', () => {
    const e = excerptOf(mk(205), 200)!;
    expect(e.cues).toHaveLength(200);
    expect(e.total).toBe(205);
  });
  it('未超限全量', () => {
    expect(excerptOf(mk(5))!.cues).toHaveLength(5);
  });
  it('整段已确认 ASR 以句为单位分页，可查看第 201 句至结尾', () => {
    const utterances=Array.from({length:273},(_,i)=>({text:`句${i}`,startMs:i*2800,endMs:i*2800+2000,definite:true,words:[]}));
    const t={...mk(2),source:'asr' as const,asrComplete:true,asrDuration:765,cues:utterances.map(u=>({from:u.startMs/1000,to:u.endMs/1000,text:u.text})),asrParts:[{start:0,end:765,whole:true,serviceDurationMs:765000,result:{text:utterances.map(u=>u.text).join(''),utterances},cues:[]}]};
    const first=excerptOf(t,200,0)!;const second=excerptOf(t,200,1)!;
    expect(first.total).toBe(273);expect(first.cues).toHaveLength(200);
    expect(second.total).toBe(273);expect(second.cues).toHaveLength(73);
    expect(second.cues[0]).toEqual({from:560,to:562,text:'句200'});
    expect(second.cues.at(-1)?.text).toBe('句272');
    expect(second.page).toBe(1);
  });
  it('旧转写与不完整或未确认的 ASR 不从原始句子暴露可跳转内容', () => {
    const t={...mk(2),source:'asr' as const,asrComplete:false,asrDuration:3,asrParts:[{start:0,end:3,whole:true,result:{text:'未经确认',utterances:[{text:'未经确认',startMs:0,endMs:1000,definite:false,words:[]}]},cues:[]}]};
    expect(excerptOf(t,200,1)?.cues).toEqual(t.cues);
    expect(excerptOf(mk(205),200,1)?.cues[0]?.text).toBe('t0');
  });
  it('句子边界从已验证的词时间推导，原始句时间不作为跳转依据',()=>{
    const words=[{text:'你好',startMs:1200,endMs:1800},{text:'朋友',startMs:1800,endMs:2400}];
    const t={...mk(2),source:'asr' as const,asrComplete:true,asrDuration:20,cues:[{from:1.2,to:1.8,text:'你好'},{from:1.8,to:2.4,text:'朋友'}],asrParts:[{start:0,end:20,whole:true,result:{text:'你好朋友',utterances:[{text:'你好朋友',startMs:10000,endMs:11000,definite:true,words}]},cues:[]}]};
    expect(excerptOf(t)?.cues).toEqual([{from:1.2,to:2.4,text:'你好朋友'}]);
    expect(excerptOf({...t,cues:[{from:5,to:6,text:'错误'}]})?.page).toBeUndefined();
    const modified={...t,asrParts:[{...t.asrParts[0]!,result:{text:'伪造的句子',utterances:[{...t.asrParts[0]!.result.utterances[0]!,text:'伪造的句子'}]}}]};
    expect(excerptOf(modified)?.page).toBeUndefined();
  });
  it('已完成的旧豆包转写若存在语义符号丢失，显示原文但禁止时间跳转',()=>{
    const words=[{text:'温度5度',startMs:1000,endMs:2000}];const cues=[{from:1,to:2,text:'温度5度'}];
    const t={...mk(1),source:'asr' as const,asrComplete:true,cues,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words}]},cues}]};
    expect(excerptOf(t)).toMatchObject({cues:[],unconfirmedText:'温度+5度'});
    const generic={...t,asrParts:undefined};expect(excerptOf(generic)?.cues).toEqual(cues);
  });
  it('豆包全片顶层文字为空而句子非空时展示句子原文且禁止跳转',()=>{
    const cues=[{from:1,to:2,text:'有效句子'}];const t={...mk(1),source:'asr' as const,asrComplete:true,cues,asrParts:[{start:0,end:10,whole:true,result:{text:'',utterances:[{text:'有效句子',startMs:1000,endMs:2000,definite:true,words:[]}]},cues}]};
    expect(excerptOf(t)).toMatchObject({cues:[],unconfirmedText:'有效句子'});
  });
  it('豆包全片缺少句子但顶层文字与持久内容冲突时展示原文且禁止跳转',()=>{
    const cues=[{from:1,to:2,text:'温度5度'}];const t={...mk(1),source:'asr' as const,asrComplete:true,cues,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[]},cues}]};
    expect(excerptOf(t)).toMatchObject({cues:[],unconfirmedText:'温度+5度'});
  });
});

describe('ListQueryItem 形状（background 组装契约）', () => {
  it('visit/video/summary/job 四槽位', () => {
    const item: ListQueryItem = { visit: visit(), video: undefined, summary: undefined, job: undefined };
    expect(item.visit.videoKey).toBe('BV1x:111');
  });
});

describe('P2.1 保留期倒计时格式化（F10）', () => {
  it('fmtCountdown：hh:mm:ss 补零 / 负值钳 0（原型 fmtCountdown 同款）', () => {
    expect(fmtCountdown(0)).toBe('00:00:00');
    expect(fmtCountdown(59_000)).toBe('00:00:59');
    expect(fmtCountdown(60_000)).toBe('00:01:00');
    expect(fmtCountdown(59 * 60_000 + 59_000)).toBe('00:59:59');
    expect(fmtCountdown(3_600_000)).toBe('01:00:00');
    expect(fmtCountdown(-5_000)).toBe('00:00:00'); // 已到点：钳 0（到点即触发重判，不闪负数）
  });
  it('clockOf：时间戳 → 本机 HH:MM（「数据保留至 HH:MM」口径）', () => {
    const d = new Date(2026, 9, 24, 9, 5, 0); // 本机时区构造，clockOf 读同源字段
    expect(clockOf(d.getTime())).toBe('09:05');
    expect(clockOf(new Date(2026, 9, 24, 23, 59).getTime())).toBe('23:59');
  });
});

it('ASR 确认文案说明接收方、处理范围、费用与未观看内容', async () => {
  const {asrConsentText} = await import('../src/content/panel/view-models');
  const text = asrConsentText(132);
  expect(text).toContain('语音服务');
  expect(text).toContain('02:12');
  expect(text).toContain('额度');
  expect(text).toContain('未观看');
  expect(text).toContain('确认后可能下载');
  expect(text).toContain('可以复用');
  expect(text).toContain('否则');
});

it('分段进度保留局部范围和失败提示，不把局部内容标为全片', async () => {
  const {asrProgressView} = await import('../src/content/panel/view-models');
  const view = asrProgressView({processedUntil:29,targetDuration:90,status:'partial',parts:[{from:0,to:29,text:'片段要点'}],warning:'边界未确认'});
  expect(view.label).toContain('00:29');
  expect(view.label).toContain('未完成');
  expect(view.parts).toEqual([{range:'00:00–00:29',text:'片段要点'}]);
  expect(view.warning).toContain('边界未确认');
});

it('未确认识别原文单独展示，不伪造可跳转的时间', async () => {
  const {asrProgressView} = await import('../src/content/panel/view-models');
  const view = asrProgressView({processedUntil:10,targetDuration:30,status:'partial',parts:[{from:0,to:10,text:'已确认要点'}],unconfirmed:[{from:10,to:30,text:'尚未对齐的原文'}]});
  expect(view.parts).toEqual([{range:'00:00–00:10',text:'已确认要点'}]);
  expect(view.unconfirmed).toEqual(['尚未对齐的原文']);
});
