import { expect, it, vi } from 'vitest';
import { PanelController, type PanelDeps } from '../src/content/panel/panel';

it('识别失败的未确认原文可见且没有时间跳转入口',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'failed',source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code:'ASR_TIMESTAMP_MISSING',msg:'时间信息不完整'},asrProgress:{processedUntil:0,targetDuration:120,status:'partial',parts:[],unconfirmed:[{from:0,to:120,text:'保留的原文'}]}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('保留的原文'));
 expect(box.innerHTML).toContain('时间不可用于跳转');expect(box.innerHTML).not.toContain('class="tr-line"');expect(box.innerHTML).not.toContain('class="d-outline"');
});

it('旧字幕保护状态说明无法启动识别且不提供误导性确认按钮',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'need_asr',source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code:'ASR_EXISTING_SUBTITLE',msg:'旧字幕已保留，当前无法安全启动语音识别'}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('旧字幕已保留'));
 expect(box.innerHTML).toContain('无法安全启动语音识别');expect(box.innerHTML).not.toContain('id="btn-asr-ok"');
});

it.each(['need_asr','failed'] as const)('语音内容不足时可查看转写，不提示再次调用摘要或语音服务：%s',async(status)=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status,source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code:'ASR_TOO_SHORT',msg:'识别到了少量语音，但内容不足以生成可靠摘要'},asrProgress:{processedUntil:0,targetDuration:20,status:'partial',parts:[]}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,asrCached:true,transcript:{source:'asr',total:1,cues:[{from:0,to:1,text:'今天下雨了'}]}}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('今天下雨了'));
 expect(box.innerHTML).toContain('内容不足');expect(box.innerHTML).not.toContain('id="btn-asr-ok"');expect(box.innerHTML).not.toContain('id="d-regen"');expect(box.innerHTML).not.toContain('调用摘要模型');expect(box.innerHTML).not.toContain('asr-local-progress');
});

it.each([{status:'need_asr',code:'ASR_NO_SPEECH'},{status:'failed',code:'LOW_CONTENT'}])('未识别到语音时明确说明，且不提示用空转写继续调用模型：$code',async({status,code})=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status,source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code,msg:'该音频未识别到可用语音'},asrProgress:{processedUntil:0,targetDuration:20,status:'partial',parts:[]}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,asrCached:true,transcript:{source:'asr',total:0,cues:[]}}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('未识别到可用语音'));
 expect(box.innerHTML).not.toContain('调用摘要模型');expect(box.innerHTML).not.toContain('id="btn-asr-ok"');expect(box.innerHTML).not.toContain('id="d-regen"');expect(box.innerHTML).not.toContain('asr-local-progress');expect(box.innerHTML).not.toContain('共 0 条');
});

it('已完成的旧摘要即使残留短语音错误也保留正常操作',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'done',source:'asr',summary:'已保存的摘要',outline:[],evaluation:'',rating:0,error:{code:'ASR_TOO_SHORT',msg:'旧错误'}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('已保存的摘要'));
 expect(box.innerHTML).toContain('id="d-regen"');expect(box.innerHTML).toContain('id="d-copy"');
});

it('旧 ASR 时间未确认时保留摘要文字但隐藏大纲与分段解读入口',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'done',source:'asr',summary:'旧摘要文字',outline:[{time:10,text:'不可用大纲'}],evaluation:'',rating:4}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,transcript:{source:'asr',total:1,cues:[],unconfirmedText:'旧原文'}}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('旧摘要文字'));
 expect(box.innerHTML).toContain('时间未确认');expect(box.innerHTML).not.toContain('不可用大纲');expect(box.innerHTML).not.toContain('seg-btn');expect(box.innerHTML).toContain('旧原文');
});

it.each(['ai_sub','manual_sub'] as const)('旧 ASR 原文混合缓存不隐藏已完成的 %s 字幕摘要大纲',async(source)=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'done',source,summary:'字幕摘要',outline:[{time:10,text:'字幕大纲'}],evaluation:'',rating:0}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,transcript:{source:'asr',total:1,cues:[],unconfirmedText:'旧 ASR 原文'}}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('字幕摘要'));
 expect(box.innerHTML).toContain('字幕大纲');expect(box.innerHTML).toContain('seg-btn');expect(box.innerHTML).toContain('历史 ASR 原文（未确认）');expect(box.innerHTML).toContain('旧 ASR 原文');expect(box.innerHTML).not.toContain('转写时间未确认，暂不显示大纲');expect(box.innerHTML).not.toContain('asr-recovery-confirm');
});

it('完整语音缓存可用时说明复用和缓存失效仍需重新识别',async()=>{
 let click:(()=>void)|undefined;let cached=true;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f;},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},video:{duration:120},summary:{status:'need_asr',source:'asr',summary:'',outline:[],evaluation:'',rating:0}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,asrCached:cached}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('继续处理'));
 expect(box.innerHTML).toContain('缓存可以复用');expect(box.innerHTML).toContain('摘要模型');expect(box.innerHTML).not.toContain('服务类型变化时会重新下载');
 cached=false;panel.handleEvent({type:'SUMMARY_UPDATED',videoKey:'BV1x:111'});await vi.waitFor(()=>expect(box.innerHTML).toContain('调用 ASR 解析'));
 expect(box.innerHTML).not.toContain('已保存完整语音转写');expect(box.innerHTML).not.toContain('请确认是否调用');
});

it('已确认语音转写翻页后可跳转末尾，切换视频重置页码',async()=>{
 const handlers=new Map<string,()=>void>(), requests:{videoKey:string;transcriptPage?:number}[]=[];const seek=vi.fn();let selected='BV1x:111';
 const itemEl={addEventListener:(_:string,f:()=>void)=>handlers.set('item',f),getAttribute:()=>selected};
 const cueEl={addEventListener:(_:string,f:(e:{target:null})=>void)=>handlers.set('seek',()=>f({target:null})),getAttribute:()=> '760'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[itemEl]:s==='.d-outline li, .tr-line'?[cueEl]:[],querySelector:()=>null};
 const button=(id:string)=>({addEventListener:(_:string,f:()=>void)=>handlers.set(id,f)});
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:['tr-next','tr-prev','d-back'].includes(id)?button(id):null,querySelector:()=>null};
 const mk=(videoKey:string)=>({visit:{videoKey,lastSeenAt:1,progressPct:0},summary:{status:'done',source:'asr',summary:'摘要',outline:[],evaluation:'',rating:0}});
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string;videoKey:string;transcriptPage?:number})=>{
   if(m.type==='LIST_QUERY')return {ok:true,items:[mk('BV1x:111'),mk('BV2y:222')],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null};
   if(m.type==='SUMMARY_OPEN'){requests.push(m);const page=m.transcriptPage??0;return {ok:true,item:mk(m.videoKey),transcript:{source:'asr',total:273,page,cues:[{from:page?760:0,to:page?761:1,text:page?'视频结尾':'视频开头'}]}};}
   return {ok:true,loggedIn:null};}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:seek,onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(handlers.has('item')).toBe(true));handlers.get('item')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('视频开头'));
 handlers.get('tr-next')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('视频结尾'));expect(box.innerHTML).toContain('第 2 / 2 页');
 handlers.get('seek')!();expect(seek).toHaveBeenCalledWith('BV1x:111',760);
 handlers.get('tr-prev')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('视频开头'));expect(box.innerHTML).toContain('class="d-sec d-transcript" open');
 handlers.get('d-back')!();await vi.waitFor(()=>expect(handlers.has('item')).toBe(true));selected='BV2y:222';handlers.get('item')!();await vi.waitFor(()=>expect(requests.length).toBe(4));expect(requests[3]).toMatchObject({videoKey:'BV2y:222',transcriptPage:0});
});

it('重新生成失败但保留旧摘要时显示失败原因', async () => {
  let clickItem: (() => void) | undefined;
  const itemElement = {
    addEventListener: (_: string, listener: () => void) => { clickItem = listener; },
    getAttribute: () => 'BV1x:111',
  };
  const box = {
    innerHTML: '', classList: { add: vi.fn(), remove: vi.fn() },
    querySelectorAll: (selector: string) => selector === '.v-item' ? [itemElement] : [],
    querySelector: () => null,
  };
  const root = {
    ownerDocument: { addEventListener: vi.fn() },
    getElementById: (id: string) => id === 'view-list' ? box : null,
    querySelector: () => null,
  };
  const item = {
    visit: { videoKey: 'BV1x:111', lastSeenAt: 1, progressPct: 10 },
    summary: { status: 'done', source: 'ai_sub', summary: '旧摘要', outline: [], evaluation: '', rating: 0 },
    lastJob: { type: 'REGENERATE', status: 'failed', error: { code: 'DEGRADED', msg: '新大纲不完整，旧摘要已保留，可重新生成' } },
  };
  const panel = new PanelController({
    ui: { root },
    bridge: { request: async (message: { type: string }) => {
      if (message.type === 'LIST_QUERY') return { ok: true, items: [item], sessionState: 'ACTIVE', triggerSeconds: 10, loggedIn: null };
      if (message.type === 'SUMMARY_OPEN') return { ok: true, item };
      return { ok: true, loggedIn: null };
    } },
    onSessionStart: () => {}, onSessionEnd: () => {}, onSeek: () => {}, onNeedAsrConfig: () => {},
  } as unknown as PanelDeps);
  panel.open();
  await vi.waitFor(() => expect(clickItem).toBeDefined());
  clickItem!();
  await vi.waitFor(() => expect(box.innerHTML).toContain('旧摘要'));
  expect(box.innerHTML).toContain('新大纲不完整，旧摘要已保留，可重新生成');
});

it('查看历史详情时标明它与当前视频不同，并在暂停期间切换页面后更新标识',async()=>{
 let clickItem:(()=>void)|undefined;
 const badge={textContent:''};
 const el={addEventListener:(_:string,listener:()=>void)=>{clickItem=listener;},getAttribute:()=> 'BV1vtK1zpEjN:30736058699'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:id==='d-video-context'?badge:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1vtK1zpEjN:30736058699',lastSeenAt:1,progressPct:0},video:{key:'BV1vtK1zpEjN:30736058699',bvid:'BV1vtK1zpEjN',page:1,title:'短视频',duration:32},summary:{status:'done',source:'asr',summary:'短视频摘要',outline:[],evaluation:'',rating:0}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',paused:true,triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true,loggedIn:null}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{},getCurrentVideoUrl:()=> 'https://www.bilibili.com/video/BV13u411J7Zn'} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(clickItem).toBeDefined());clickItem!();await vi.waitFor(()=>expect(box.innerHTML).toContain('短视频摘要'));
 expect(badge.textContent).toContain('不是当前播放的视频');
 panel.routeChanged('https://www.bilibili.com/video/BV1vtK1zpEjN');expect(badge.textContent).toContain('当前播放的视频');
 panel.routeChanged('https://www.bilibili.com/video/BV13u411J7Zn');expect(badge.textContent).toContain('不是当前播放的视频');expect(box.innerHTML).toContain('短视频摘要');
});

function routePanelFixture(initialUrl: string, deferred = false) {
  let clickItem: (() => void) | undefined;
  let resolveDetail: ((value: unknown) => void) | undefined;
  const calls: string[] = [];
  const badge = { textContent: '' };
  const item = {
    visit: { videoKey: 'BV1vtK1zpEjN:111', lastSeenAt: 1, progressPct: 0 },
    video: { key: 'BV1vtK1zpEjN:111', bvid: 'BV1vtK1zpEjN', page: 1, title: '旧视频标题', duration: 32 },
    summary: { status: 'done', source: 'asr', summary: '旧视频摘要正文', outline: [], evaluation: '', rating: 0 },
  };
  const el = { addEventListener: (_: string, listener: () => void) => { clickItem = listener; }, getAttribute: () => item.visit.videoKey };
  const box = { innerHTML: '', classList: { add: vi.fn(), remove: vi.fn() }, querySelectorAll: (s: string) => s === '.v-item' ? [el] : [], querySelector: () => null };
  const root = { ownerDocument: { addEventListener: vi.fn() }, getElementById: (id: string) => id === 'view-list' ? box : id === 'd-video-context' ? badge : null, querySelector: () => null };
  const panel = new PanelController({ ui: { root }, bridge: { request: async (message: { type: string }) => {
    calls.push(message.type);
    if (message.type === 'LIST_QUERY') return { ok: true, items: [item], sessionState: 'INACTIVE', paused: true, triggerSeconds: 10, loggedIn: null };
    if (message.type === 'SUMMARY_OPEN') return deferred ? new Promise((resolve) => { resolveDetail = resolve; }) : { ok: true, item };
    return { ok: true, loggedIn: null };
  } }, onSessionStart: () => {}, onSessionEnd: () => {}, onSeek: () => {}, onNeedAsrConfig: () => {}, getCurrentVideoUrl: () => initialUrl } as unknown as PanelDeps);
  return { panel, box, badge, calls, click: () => clickItem!(), resolve: () => resolveDetail!({ ok: true, item }) };
}

it('暂停时自动切到新视频使原当前视频详情回到列表，不自动请求摘要', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV1vtK1zpEjN');
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频摘要正文'));
  f.panel.routeChanged('https://www.bilibili.com/video/BV13u411J7Zn');
  await vi.waitFor(() => expect(f.box.innerHTML).not.toContain('旧视频摘要正文'));
  expect(f.calls.filter((s) => s === 'SUMMARY_OPEN')).toHaveLength(1);
});

it('同 BV 切换分 P 也跟随，关闭后重新打开不残留旧详情', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV1vtK1zpEjN?p=1');
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频摘要正文'));
  f.panel.close(); f.panel.routeChanged('https://www.bilibili.com/video/BV1vtK1zpEjN?p=2'); f.panel.open();
  await vi.waitFor(() => expect(f.box.innerHTML).not.toContain('旧视频摘要正文'));
});

it('主动打开历史视频后不受迟到的视频解析结果影响', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV13u411J7Zn');
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频摘要正文'));
  f.panel.followVideo('BV13u411J7Zn:222');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.box.innerHTML).toContain('旧视频摘要正文');
  expect(f.badge.textContent).toContain('不是当前播放的视频');
});

it('切视频时旧当前视频在途详情的迟到响应不得抢回面板', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV1vtK1zpEjN', true);
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.calls).toContain('SUMMARY_OPEN'));
  f.panel.routeChanged('https://www.bilibili.com/video/BV13u411J7Zn'); f.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.box.innerHTML).not.toContain('旧视频摘要正文');
});

it('主动选择历史视频的在途详情在切集与迟到解析后仍可打开', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV13u411J7Zn', true);
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.calls).toContain('SUMMARY_OPEN'));
  f.panel.routeChanged('https://www.bilibili.com/video/BV178iDBaESN');
  f.panel.followVideo('BV178iDBaESN:222'); f.resolve();
  await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频摘要正文'));
  expect(f.badge.textContent).toContain('不是当前播放的视频');
});

it('切集后又回原视频时，切集前的详情请求仍不可迟到抢回', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV1vtK1zpEjN', true);
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.calls).toContain('SUMMARY_OPEN'));
  f.panel.routeChanged('https://www.bilibili.com/video/BV13u411J7Zn');
  f.panel.routeChanged('https://www.bilibili.com/video/BV1vtK1zpEjN'); f.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.box.innerHTML).not.toContain('旧视频摘要正文');
});

it('当前视频仅变更时间参数不会使在途详情失效', async () => {
  const f = routePanelFixture('https://www.bilibili.com/video/BV1vtK1zpEjN', true);
  f.panel.open(); await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频标题'));
  f.click(); await vi.waitFor(() => expect(f.calls).toContain('SUMMARY_OPEN'));
  f.panel.routeChanged('https://www.bilibili.com/video/BV1vtK1zpEjN?t=10'); f.resolve();
  await vi.waitFor(() => expect(f.box.innerHTML).toContain('旧视频摘要正文'));
});

it('已知转写冲突需明确同意后恢复，保留旧摘要且候选转写可继续汇总',async()=>{
 const handlers=new Map<string,()=>void>(),requests:any[]=[];let state:'available'|'pending'|'candidate'|'running'='available';
 const el={addEventListener:(_:string,f:()=>void)=>handlers.set('item',f),getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:['asr-recovery-confirm','asr-recovery-cancel'].includes(id)?{addEventListener:(_:string,f:()=>void)=>handlers.set(id,f)}:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},video:{duration:120},summary:{status:'done',source:'asr',summary:'旧摘要文字',outline:[{time:10,text:'不可信大纲'}],evaluation:'',rating:0}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:any)=>{requests.push(m);if(m.type==='LIST_QUERY')return {ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null};if(m.type==='SUMMARY_OPEN')return {ok:true,item,transcript:{source:'asr',total:1,cues:[],unconfirmedText:'温度+5度'},recovery:{status:state,...(state==='running'?{progress:{processedUntil:60,targetDuration:120,status:'running',parts:[{from:0,to:60,text:'已确认局部要点'}]}}:{})}};if(m.type==='ASR_CONFIRM'){state='running';return {ok:true,started:true};}return {ok:true};}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(handlers.has('item')).toBe(true));handlers.get('item')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('旧摘要文字'));
 expect(box.innerHTML).toContain('旧摘要');expect(box.innerHTML).toContain('未确认');expect(box.innerHTML).toContain('豆包');expect(box.innerHTML).toContain('完整音轨');expect(box.innerHTML).toContain('额度');expect(box.innerHTML).toContain('剧透');expect(box.innerHTML).toContain('确认重新识别');expect(box.innerHTML).not.toContain('不可信大纲');expect(requests.some(m=>m.type==='ASR_CONFIRM')).toBe(false);
 handlers.get('asr-recovery-cancel')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('本次陪看'));expect(requests.some(m=>m.type==='ASR_CONFIRM')).toBe(false);handlers.get('item')!();await vi.waitFor(()=>expect(box.innerHTML).toContain('确认重新识别'));
 handlers.get('asr-recovery-confirm')!();await vi.waitFor(()=>expect(requests).toContainEqual({type:'ASR_CONFIRM',videoKey:'BV1x:111',recovery:true,recoveryAction:'recognize'}));await vi.waitFor(()=>expect(box.innerHTML).toContain('恢复处理中'));expect(box.innerHTML).toContain('旧摘要文字');expect(box.innerHTML).toContain('局部要点（非全片结论）');expect(box.innerHTML).toContain('已确认局部要点');
 state='candidate';panel.handleEvent({type:'SUMMARY_UPDATED',videoKey:'BV1x:111'});await vi.waitFor(()=>expect(box.innerHTML).toContain('确认继续汇总'));expect(box.innerHTML).toContain('已保存新转写');expect(box.innerHTML).toContain('失效');
 handlers.get('asr-recovery-confirm')!();await vi.waitFor(()=>expect(requests).toContainEqual({type:'ASR_CONFIRM',videoKey:'BV1x:111',recovery:true,recoveryAction:'continue'}));
 state='pending';panel.handleEvent({type:'SUMMARY_UPDATED',videoKey:'BV1x:111'});await vi.waitFor(()=>expect(box.innerHTML).toContain('计费状态不明'));expect(box.innerHTML).toContain('确认重新识别');
});

it('其他模型的旧 ASR 摘要标明基于旧转写并隐藏不可信大纲',async()=>{
 let click:(()=>void)|undefined;const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'done',source:'asr',summary:'旧模型摘要',outline:[{time:10,text:'不可信大纲'}],evaluation:'',rating:0,asrOutdated:true}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item,transcript:{source:'asr',total:1,cues:[{from:1,to:2,text:'新转写'}]}}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('旧模型摘要'));expect(box.innerHTML).toContain('基于旧转写');expect(box.innerHTML).not.toContain('不可信大纲');expect(box.innerHTML).not.toContain('seg-btn');expect(box.innerHTML).toContain('重新生成');
});

it.each([
  ['NEED_ASR_CONFIG', '配置 ASR'],
  ['ASR_PERMISSION_DENIED', '去设置授权'],
] as const)('自动 ASR 遇到 %s 时提供可执行引导', async (code, label) => {
  const handlers=new Map<string,()=>void>();
  const listItem={addEventListener:(_:string,f:()=>void)=>handlers.set('item',f),getAttribute:()=> 'BV1x:111'};
  const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[listItem]:[],querySelector:()=>null};
  const config=vi.fn(); const requests:string[]=[];
  const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:id==='asr-setup' ? {addEventListener:(_:string,f:()=>void)=>handlers.set('setup',f)}:null,querySelector:()=>null};
  const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},video:{duration:120},summary:{status:'need_asr',source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code,msg:'需要配置'}}};
  const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>{requests.push(m.type);if(m.type==='LIST_QUERY')return {ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null};if(m.type==='SUMMARY_OPEN')return {ok:true,item};return {ok:false};}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:config} as unknown as PanelDeps);
  panel.open();await vi.waitFor(()=>expect(handlers.has('item')).toBe(true));handlers.get('item')!();await vi.waitFor(()=>expect(box.innerHTML).toContain(label));
  expect(box.innerHTML).toContain('自动');
  expect(box.innerHTML).not.toContain('请确认是否调用');
  expect(box.innerHTML).toContain('完成设置后自动继续');
  expect(box.innerHTML).not.toContain('确认后可能下载');
  expect(box.innerHTML).toContain('继续处理');
  handlers.get('setup')!();
  if(code==='NEED_ASR_CONFIG')expect(config).toHaveBeenCalledOnce();
  else await vi.waitFor(()=>expect(requests).toContain('SETTINGS_GET'));
});

it('自动切换等待中说明将自动处理而非要求再次确认',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'need_asr',source:'asr',summary:'',outline:[],evaluation:'',rating:0,error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('准备自动'));
 expect(box.innerHTML).not.toContain('请确认是否调用');expect(box.innerHTML).not.toContain('确认后可能下载');expect(box.innerHTML).not.toContain('可能消耗');
});

it('旧版待处理界面不再显示逐视频语音确认提示',async()=>{
 let click:(()=>void)|undefined;
 const el={addEventListener:(_:string,f:()=>void)=>{click=f},getAttribute:()=> 'BV1x:111'};
 const box={innerHTML:'',classList:{add:vi.fn(),remove:vi.fn()},querySelectorAll:(s:string)=>s==='.v-item'?[el]:[],querySelector:()=>null};
 const root={ownerDocument:{addEventListener:vi.fn()},getElementById:(id:string)=>id==='view-list'?box:null,querySelector:()=>null};
 const item={visit:{videoKey:'BV1x:111',lastSeenAt:1,progressPct:0},summary:{status:'need_asr',source:'asr',summary:'',outline:[],evaluation:'',rating:0}};
 const panel=new PanelController({ui:{root},bridge:{request:async(m:{type:string})=>m.type==='LIST_QUERY'?{ok:true,items:[item],sessionState:'ACTIVE',triggerSeconds:10,loggedIn:null}:m.type==='SUMMARY_OPEN'?{ok:true,item}:{ok:true}},onSessionStart:()=>{},onSessionEnd:()=>{},onSeek:()=>{},onNeedAsrConfig:()=>{}} as unknown as PanelDeps);
 panel.open();await vi.waitFor(()=>expect(click).toBeDefined());click!();await vi.waitFor(()=>expect(box.innerHTML).toContain('语音识别'));
 expect(box.innerHTML).not.toContain('请确认是否调用');expect(box.innerHTML).not.toContain('确认后可能下载');
});
