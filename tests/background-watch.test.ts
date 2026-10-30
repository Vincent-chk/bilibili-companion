import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { CompanionDB, updateVisitProgress, upsertVisit } from '../src/lib/storage';
import { Pipeline } from '../src/lib/pipeline';

const mock = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  sessionValues: { browserSessionReady: true } as Record<string, unknown>,
  listener: null as null | ((message: unknown) => Promise<unknown>),
  onSettingsRead: null as null | (() => Promise<void>),
  connect: null as null | ((port: unknown) => void),
  recoveryResolve: null as null | ((count: number) => void),
  permissionRequest: vi.fn(async (_value: { origins: string[] }) => true),
  permissionContains: vi.fn(async (_value: { origins: string[] }) => true),
}));
const local = {
  async get(key: string) {
    const value = mock.values[key];
    if (key === 'settings') await mock.onSettingsRead?.();
    return { [key]: value };
  },
  async set(values: Record<string, unknown>) { Object.assign(mock.values, values); },
  async remove(keys: string | string[]) { for (const key of [keys].flat()) delete mock.values[key]; },
};
vi.mock('wxt/browser', () => ({ browser: { storage: { local } } }));
const db = new CompanionDB(undefined, { indexedDB, IDBKeyRange });

beforeAll(async () => {
  Dexie.dependencies.indexedDB = indexedDB;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  vi.stubGlobal('indexedDB', indexedDB);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('defineBackground', (start: () => void) => start);
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('browser', {
    storage: { local, session: {
      get: async (key: string) => ({ [key]: mock.sessionValues[key] }),
      set: async (values: Record<string, unknown>) => { Object.assign(mock.sessionValues, values); },
      remove: async (key: string) => { delete mock.sessionValues[key]; },
    } },
    permissions: { request: mock.permissionRequest, contains: mock.permissionContains },
    alarms: { create: vi.fn(), get: vi.fn(async () => undefined), onAlarm: { addListener: vi.fn() } },
    runtime: {
      id: 'fixture', getURL: (path: string) => `chrome-extension://fixture${path}`, getManifest: () => ({ version: '0.0.1' }),
      sendMessage: vi.fn(async () => undefined),
      onConnect: { addListener: (listener: typeof mock.connect) => { mock.connect = listener; } },
      onMessage: { addListener: (listener: typeof mock.listener) => { mock.listener = listener; } },
    },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
    declarativeNetRequest: { updateDynamicRules: vi.fn(), updateSessionRules: vi.fn() },
  });
  vi.spyOn(Pipeline.prototype, 'recover').mockImplementationOnce(() => new Promise<number>(resolve => { mock.recoveryResolve = resolve; })).mockResolvedValue(0);
  vi.spyOn(Pipeline.prototype, 'drain').mockResolvedValue(undefined);
  mock.values.settings = { paused: true };
  const start = (await import('../entrypoints/background')).default as unknown as () => void;
  start();
  await new Promise(resolve => setTimeout(resolve, 10));
});

beforeEach(async () => {
  await db.visits.clear();
  await db.jobs.clear();
  mock.values.sessionPointer = { sessionId: 's', state: 'ACTIVE', lastActiveAt: Date.now() };
  mock.values.settings = { triggerSeconds: 5 };
  mock.onSettingsRead = null;
  mock.permissionRequest.mockReset().mockResolvedValue(true);
  mock.permissionContains.mockReset().mockResolvedValue(true);
  await upsertVisit(db, { sessionId: 's', videoKey: 'v', now: 1 });
});
afterAll(async () => { await db.delete(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('没有保存过观看阈值时以 10 秒触发，并保留用户自设的阈值', async () => {
  mock.values.settings = {};
  expect(await mock.listener!({ type: 'SETTINGS_GET' })).toMatchObject({ triggerSeconds: 10 });
  expect(await mock.listener!({ type: 'WATCH_TICK', videoKey: 'v', watchId: 'a', watchedSeconds: 9 })).toMatchObject({ ok: true });
  expect(await db.jobs.count()).toBe(0);
  expect(await mock.listener!({ type: 'WATCH_TICK', videoKey: 'v', watchId: 'a', watchedSeconds: 10 })).toMatchObject({ summaryTriggered: true });
  mock.values.settings = { triggerSeconds: 20 };
  expect(await mock.listener!({ type: 'SETTINGS_GET' })).toMatchObject({ triggerSeconds: 20 });
});

it('后台收到 Port 断开时同步消费 lastError',()=>{
 let disconnect!:()=>void;let reads=0;
 const runtime=browser.runtime as unknown as Record<string,unknown>;
 Object.defineProperty(runtime,'lastError',{configurable:true,get(){reads++;return {message:'channel closed'};}});
 mock.connect!({name:'doubao-port',onDisconnect:{addListener:(fn:()=>void)=>{disconnect=fn;}},postMessage:()=>{}});
 disconnect();expect(reads).toBe(1);delete runtime.lastError;
});

it('启动恢复任务后，向主链和分段链发送显式恢复信号', async () => {
  const drain = vi.mocked(Pipeline.prototype.drain);
  drain.mockClear();
  expect(mock.recoveryResolve).not.toBeNull();
  expect(drain).not.toHaveBeenCalled();
  mock.recoveryResolve!(2);
  await vi.waitFor(() => expect(drain.mock.calls.filter(([resume]) => resume === true)).toHaveLength(2), { timeout: 1000 });
  expect(new Set(drain.mock.instances).size).toBe(2);
});

for (const type of ['WATCH_TICK', 'TRIGGER_SUMMARY']) {
  it(`${type} 入队不覆盖其间另一监听器提交的观看增量`, async () => {
    if (type === 'TRIGGER_SUMMARY') await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchId: 'a', watchedSeconds: 5, progressPct: 10 });
    let resume!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const reading = new Promise<void>(resolve => { reached = resolve; });
    let reads = 0;
    mock.onSettingsRead = async () => {
      if (++reads === (type === 'WATCH_TICK' ? 3 : 2)) { reached(); await gate; }
    };
    const request = mock.listener!({ type, videoKey: 'v', watchId: 'a', watchedSeconds: 5, progressPct: 10 });
    await reading;
    await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchId: 'b', watchedSeconds: 3, progressPct: 20 });
    resume();
    await request;
    expect(await db.visits.toArray()).toEqual([expect.objectContaining({ watchedSeconds: 8, watchedByTracker: { a: 5, b: 3 }, triggered: 1 })]);
    expect(await db.jobs.count()).toBe(1);
  });
}

it('连接回放迟到时不覆盖已经收到的结束陪看状态', async () => {
  let resume!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const reading = new Promise<void>(resolve => { reached = resolve; });
  mock.onSettingsRead = async () => { reached(); await gate; };
  const states: string[] = [];
  mock.connect!({ name: 'doubao-port', onDisconnect: { addListener: vi.fn() }, postMessage: (m: { type: string; state: string }) => { if (m.type === 'SESSION_STATE') states.push(m.state); } });
  await reading;
  await mock.listener!({ type: 'SESSION_END' });
  expect(states.at(-1)).toBe('GRACE');
  resume();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(states.at(-1)).toBe('GRACE');
});

it('连接回放迟到时不覆盖其他标签页已广播的暂停状态', async () => {
  let resume!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const reading = new Promise<void>(resolve => { reached = resolve; });
  mock.onSettingsRead = async () => { reached(); await gate; };
  const states: boolean[] = [];
  mock.connect!({ name: 'doubao-port', onDisconnect: { addListener: vi.fn() }, postMessage: (m: { type: string; paused: boolean }) => { if (m.type === 'WATCH_SETTINGS') states.push(m.paused); } });
  await reading;
  mock.onSettingsRead = null;
  await mock.listener!({ type: 'SETTINGS_SAVE', paused: true });
  expect(states.at(-1)).toBe(true);
  resume();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(states.at(-1)).toBe(true);
});

it('保留期主动打开未生成的摘要会建立可执行的用户任务', async () => {
  mock.values.sessionPointer = { sessionId: 's', state: 'GRACE', closedAt: Date.now(), lastActiveAt: Date.now() };
  await mock.listener!({ type: 'SUMMARY_OPEN', videoKey: 'v', retry: 1 });
  expect(await db.jobs.toArray()).toEqual([expect.objectContaining({ type: 'SUMMARIZE', videoKey: 'v', status: 'pending', prio: -1 })]);
});

it.each(['LOW_CONTENT','ASR_NO_SPEECH','ASR_TOO_SHORT'] as const)('打开 %s 的已处理 ASR 结果时不自动重排摘要任务',async(code)=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  const summary={key:'v:m',videoKey:'v',source:'asr' as const,summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'failed' as const,error:{code,msg:'语音内容不足'}};
  await db.summaries.put(summary);
  await db.jobs.put({id:'completed-asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',error:{code,msg:'语音内容不足'},progress:0,retries:0,createdAt:1,updatedAt:1});
  const before=await db.jobs.toArray();
  const result=await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v',retry:1}) as any;
  expect(result.item.summary).toEqual(summary);expect(result.item.job).toBeUndefined();expect(await db.jobs.toArray()).toEqual(before);
  await db.summaries.clear();
});

it('打开其他失败的摘要仍可按既定逻辑重试',async()=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'failed',error:{code:'KEY_INVALID',msg:'模型不可用'}});
  await db.jobs.put({id:'failed-asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',error:{code:'KEY_INVALID',msg:'模型不可用'},progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v',retry:1});
  expect((await db.jobs.toArray()).some(j=>j.type==='SUMMARIZE'&&j.status==='pending')).toBe(true);
  await db.summaries.clear();
});

it('保留期主动打开已有自动摘要时，提升原任务并唤醒队列', async () => {
  mock.values.sessionPointer = { sessionId: 's', state: 'GRACE', closedAt: Date.now(), lastActiveAt: Date.now() };
  await db.jobs.put({ id: 'existing-summary', type: 'SUMMARIZE', sessionId: 's', videoKey: 'v', status: 'pending', progress: 0, retries: 0, createdAt: 1, updatedAt: 1 });
  const drain = vi.mocked(Pipeline.prototype.drain);
  drain.mockClear();
  await mock.listener!({ type: 'SUMMARY_OPEN', videoKey: 'v', retry: 1 });
  expect(await db.jobs.toArray()).toEqual([expect.objectContaining({ id: 'existing-summary', prio: -1, status: 'pending' })]);
  await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(true));
});

it('保留期点击等待中的分段预取会提升并唤醒队列', async () => {
  mock.values.sessionPointer = { sessionId: 's', state: 'GRACE', closedAt: Date.now(), lastActiveAt: Date.now() };
  await db.summaries.put({ key: 'v:m', videoKey: 'v', modelId: 'm', persona: '', source: 'ai_sub', status: 'done', summary: '摘要', outline: [{ time: 1, text: '要点' }], evaluation: '', rating: 3, createdAt: 1 });
  await db.jobs.put({ id: 'existing-segment', type: 'SEGMENT_ANALYZE', segIndex: 0, sessionId: 's', videoKey: 'v', prio: 1, status: 'pending', progress: 0, retries: 0, createdAt: 1, updatedAt: 1 });
  const drain = vi.mocked(Pipeline.prototype.drain);
  drain.mockClear();
  await mock.listener!({ type: 'SEGMENT_NOTE_OPEN', videoKey: 'v', segIndex: 0 });
  expect(await db.jobs.get('existing-segment')).toMatchObject({ prio: 0, status: 'pending' });
  await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(true));
  await db.summaries.clear();
});

it('触发请求先于最终 tick 到达时，后续 tick 仍只入队一次', async () => {
  await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchId: 'a', watchedSeconds: 4, progressPct: 10 });
  expect(await mock.listener!({ type: 'TRIGGER_SUMMARY', videoKey: 'v' })).toMatchObject({ ok: false, reason: 'below-threshold' });
  expect(await db.jobs.count()).toBe(0);
  expect(await mock.listener!({ type: 'WATCH_TICK', videoKey: 'v', watchId: 'a', watchedSeconds: 5, progressPct: 10 })).toMatchObject({ ok: true, summaryTriggered: true });
  expect(await mock.listener!({ type: 'TRIGGER_SUMMARY', videoKey: 'v' })).toMatchObject({ ok: true, deduped: true });
  expect(await db.jobs.count()).toBe(1);
});

it('tick 已触发时迟到的 TRIGGER_SUMMARY 返回去重，不重复报告首次触发', async () => {
  await updateVisitProgress(db, { sessionId: 's', videoKey: 'v' }, { watchId: 'a', watchedSeconds: 5, progressPct: 10 });
  let resume!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const reading = new Promise<void>(resolve => { reached = resolve; });
  let reads = 0;
  mock.onSettingsRead = async () => { if (++reads === 2) { reached(); await gate; } };
  const trigger = mock.listener!({ type: 'TRIGGER_SUMMARY', videoKey: 'v' });
  await reading;
  await mock.listener!({ type: 'WATCH_TICK', videoKey: 'v', watchId: 'a', watchedSeconds: 6, progressPct: 20 });
  resume();
  expect(await trigger).toMatchObject({ ok: true, deduped: true });
  expect(await db.jobs.count()).toBe(1);
});


for (const type of ['SETTINGS_SAVE', 'TEST_CONNECTION']) {
  it(`${type} 在消息同步阶段申请合法端点权限，避免异步后丢失手势`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const result = mock.listener!({ type, llm: { baseUrl: 'https://model.example/v1', modelId: 'fixture', apiKey: 'fake-only' } });
    const requestedBeforeFirstAwait = mock.permissionRequest.mock.calls.slice();
    await result;
    expect(requestedBeforeFirstAwait).toEqual([[{ origins: ['https://model.example/*'] }]]);
  });
}

it('不完整的模型配置不申请新的域权限', async () => {
  const result = await mock.listener!({ type: 'SETTINGS_SAVE', llm: { baseUrl: 'https://unused.example/v1', modelId: '', apiKey: 'fake-only' } });
  expect(result).toMatchObject({ ok: false });
  expect(mock.permissionRequest).not.toHaveBeenCalled();
});

it('模型授权待决时，其他标签页的暂停设置仍能保存', async () => {
  let decide!: (granted: boolean) => void;
  mock.permissionRequest.mockImplementationOnce(() => new Promise<boolean>(resolve => { decide = resolve; }));
  let completed = false;
  const configSave = mock.listener!({ type: 'SETTINGS_SAVE', llm: { baseUrl: 'https://model.example/v1', modelId: 'fixture', apiKey: 'fake-only' } }).then(r => { completed = true; return r; });
  const pauseSave = mock.listener!({ type: 'SETTINGS_SAVE', paused: true });
  try {
    await vi.waitFor(() => expect((mock.values.settings as { paused?: boolean }).paused).toBe(true), { timeout: 500 });
    expect(completed).toBe(false);
  } finally { decide(true); await configSave; await pauseSave; }
});


it('拒绝域权限后保留配置并返回具体 denied 域供界面提示', async () => {
  mock.permissionRequest.mockResolvedValueOnce(false);
  mock.permissionContains.mockResolvedValue(false);
  const result = await mock.listener!({ type: 'SETTINGS_SAVE', llm: { baseUrl: 'https://model.example/v1', modelId: 'fixture', apiKey: 'fake-only' } });
  expect(result).toMatchObject({ ok: true, granted: [], denied: ['https://model.example/*'] });
  expect((mock.values.settings as { llm?: { modelId: string } }).llm?.modelId).toBe('fixture');
});

it('豆包配置保存服务类型与固定模型，读取只返回掩码；旧配置没有类型时保持兼容', async () => {
  mock.values.settings = { llm: {baseUrl:'https://example.com/v1',modelId:'m',apiKey:'existing'} };
  const saved = await mock.listener!({type:'SETTINGS_SAVE',asr:{provider:'doubao-agent-plan',baseUrl:'',modelId:'',apiKey:'test-secret'}}) as any;
  expect(saved.ok).toBe(true);
  const stored = (mock.values.settings as any).asr;
  expect(stored).toMatchObject({provider:'doubao-agent-plan',modelId:'doubao-seed-asr-2.0',apiKey:'test-secret'});
  const shown = await mock.listener!({type:'SETTINGS_GET'}) as any;
  expect(shown.asr.provider).toBe('doubao-agent-plan');
  expect(JSON.stringify(shown)).not.toContain('test-secret');
  mock.values.settings = {asr:{baseUrl:'https://old.example/v1',modelId:'old',apiKey:'old-secret'}};
  const legacy = await mock.listener!({type:'SETTINGS_GET'}) as any;
  expect(legacy.asr.provider ?? 'openai-compatible').toBe('openai-compatible');
});

it('切换 ASR 服务类型时不得沿用旧服务的密钥', async () => {
  mock.values.settings = {llm:{baseUrl:'https://example.com/v1',modelId:'m',apiKey:'k'},asr:{baseUrl:'https://old.example/v1',modelId:'old',apiKey:'old-secret'}};
  const result = await mock.listener!({type:'SETTINGS_SAVE',asr:{provider:'doubao-agent-plan',baseUrl:'https://old.example/v1',modelId:'old',apiKey:''}}) as any;
  expect(result.ok).toBe(false);
  expect((mock.values.settings as any).asr.apiKey).toBe('old-secret');
});

it('音频识别内部消息拒绝来自网页的调用，避免绕过确认流程', async () => {
  const result = await (mock.listener as any)({type:'DOUBAO_TRANSCRIBE_PCM',pcm:[0,0]}, {url:'https://www.bilibili.com/video/anything'});
  expect(result).toMatchObject({ok:false});
});

it('豆包语音权限拒绝时不得宣称鉴权通过', async () => {
  mock.permissionRequest.mockResolvedValue(false);
  const result = await mock.listener!({type:'TEST_CONNECTION',kind:'asr',llm:{provider:'doubao-agent-plan',baseUrl:'',modelId:'',apiKey:'secret'}}) as any;
  expect(result.ok).toBe(false);
  expect(result.msg).toContain('授权');
});

it('临时认证规则只能由扩展离屏文档设置，其他页面不能安装规则', async () => {
  const result = await (mock.listener as any)({type:'DOUBAO_AUTH_RULE',rule:{id:78}}, {url:'https://www.bilibili.com/'});
  expect(result).toMatchObject({ok:false});
});

it('后台仅用固定语音地址和自身发起者构造临时规则', async () => {
  const update = (globalThis as any).browser.declarativeNetRequest.updateSessionRules;
  update.mockClear();
  const result=await (mock.listener as any)({type:'DOUBAO_AUTH_RULE',authRule:{key:'fake-only',requestId:'12345678-1234-1234-1234-123456789abc'}},{url:'chrome-extension://fixture/offscreen.html'});
  expect(result.ok).toBe(true);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({removeRuleIds:[78],addRules:[expect.objectContaining({condition:{urlFilter:'|wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream|',initiatorDomains:['fixture'],resourceTypes:['websocket']}})]}));
});

it('离屏 PCM 调用在未授权时停止，不读取服务或发送音频', async () => {
  mock.values.settings = {asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  mock.permissionContains.mockResolvedValue(false);
  const result=await (mock.listener as any)({type:'DOUBAO_TRANSCRIBE_PCM',pcm:[0,0]},{url:'chrome-extension://fixture/offscreen.html'});
  expect(result).toEqual({ok:false,error:'ASR_PERMISSION_DENIED'});
});

it('清除数据关闭离屏文档时也移除在途的豆包认证规则', async () => {
  const browser=(globalThis as any).browser;
  browser.offscreen={closeDocument:vi.fn(async()=>{})};
  browser.declarativeNetRequest.updateSessionRules.mockClear();
  const result=await mock.listener!({type:'WIPE_NOW'}) as any;
  expect(result.ok).toBe(true);
  expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({removeRuleIds:[78]});
});

it('关闭离屏文档失败时也移除豆包认证规则', async () => {
  const browser=(globalThis as any).browser;
  browser.offscreen={closeDocument:vi.fn(async()=>{throw new Error('closed')})};
  browser.declarativeNetRequest.updateSessionRules.mockClear();
  await mock.listener!({type:'WIPE_NOW'});
  expect(browser.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({removeRuleIds:[78]});
});

it('清除数据期间不允许新安装豆包认证规则', async () => {
  const browser=(globalThis as any).browser;
  let release!:()=>void, reached!:()=>void;
  const gate=new Promise<void>(r=>{release=r}), started=new Promise<void>(r=>{reached=r});
  browser.offscreen={closeDocument:vi.fn(async()=>{reached();await gate;})};
  const wipe=mock.listener!({type:'WIPE_NOW'});await started;
  const auth=await (mock.listener as any)({type:'DOUBAO_AUTH_RULE',authRule:{key:'fake',requestId:'12345678-1234-1234-1234-123456789abc'}},{url:'chrome-extension://fixture/offscreen.html'});
  expect(auth.ok).toBe(false);release();await wipe;
});

it('清除数据等待已开始的规则安装，然后再移除规则', async () => {
  const browser=(globalThis as any).browser; const update=browser.declarativeNetRequest.updateSessionRules;
  let release!:()=>void, reached!:()=>void, active=false;
  const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{reached=r});
  update.mockImplementation(async (change:{addRules?:unknown[]})=>{if(change.addRules){reached();await gate;active=true;}else active=false;});
  browser.offscreen={closeDocument:vi.fn(async()=>{})};
  try {
    const auth=(mock.listener as any)({type:'DOUBAO_AUTH_RULE',authRule:{key:'fake',requestId:'12345678-1234-1234-1234-123456789abc'}},{url:'chrome-extension://fixture/offscreen.html'});
    await started; const wipe=mock.listener!({type:'WIPE_NOW'});await new Promise(resolve=>setTimeout(resolve,0));
    release(); await auth; const result=await wipe as any;
    expect(result.ok).toBe(true);expect(active).toBe(false);
  } finally {update.mockReset();}
});

it('豆包语音权限未授予时确认不入队任何收费任务',async()=>{
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  mock.permissionContains.mockResolvedValue(false);
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v'})).toMatchObject({ok:false,reason:'ASR_PERMISSION_DENIED'});
  expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(0);
});

it('首次无字幕且配置授权就绪时并发自动切换只入队一个独立语音任务',async()=>{
  const {tryAutoAsr}=await import('../entrypoints/background') as unknown as {tryAutoAsr:(id:string,requireWaitingMarker?:boolean)=>Promise<void>};
  expect(tryAutoAsr).toBeTypeOf('function');
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:10,retries:0,createdAt:1,updatedAt:1});
  await Promise.all([tryAutoAsr('subtitle'),tryAutoAsr('subtitle')]);
  const rows=await db.jobs.toArray();expect(rows.filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(1);
  expect((await db.jobs.get('subtitle'))?.status).toBe('done');
});

it('字幕任务真正进入待处理状态后触发自动语音任务',async()=>{
  const {onJobTransition}=await import('../entrypoints/background') as unknown as {onJobTransition:(row:unknown)=>void};
  expect(onJobTransition).toBeTypeOf('function');
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  const p=new Pipeline(db,{execute:async()=>{
    await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}});
    return {result:'need_confirm'};
  }},{onTransition:onJobTransition});
  await p.enqueue({type:'SUMMARIZE',videoKey:'v',sessionId:'s'});await p.tick();
  await vi.waitFor(async()=>expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(1));
});

it('旧版无记录的待确认条目打开后重新检查字幕并自动继续',async()=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  delete mock.sessionValues['manualJob:legacy'];
  const visit=await db.visits.where({sessionId:'s',videoKey:'v'}).first();await db.visits.update(visit!.id!,{triggered:1,watchedSeconds:10});
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'legacy',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v',retry:1});
  expect((await db.jobs.get('legacy'))?.status).toBe('pending');
  expect((await db.summaries.get('v:m'))?.error?.code).toBe('AUTO_ASR_PENDING');
  expect(mock.sessionValues['manualJob:legacy']).toBeUndefined();
});

it('进入已经达到阈值的旧视频时仅为当前视频重新检查字幕',async()=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  mock.values.settings={triggerSeconds:5,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  await db.videos.put({key:'BV1234567890:1',bvid:'BV1234567890',aid:1,cid:1,title:'t',cover:'',owner:'',duration:60,page:1,fetchedAt:Date.now()});
  const visit=await upsertVisit(db,{sessionId:'s',videoKey:'BV1234567890:1',now:1});await db.visits.update(visit.id!,{triggered:1,watchedSeconds:10});
  await db.summaries.put({key:'BV1234567890:1:m',videoKey:'BV1234567890:1',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'legacy-current',type:'SUMMARIZE',videoKey:'BV1234567890:1',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'VIDEO_ENTER',bvid:'BV1234567890',url:'https://www.bilibili.com/video/BV1234567890'});
  expect((await db.jobs.get('legacy-current'))?.status).toBe('pending');
});

it('旧视频尚未达到观看阈值时，进入页面或打开详情不触发自动迁移',async()=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  mock.values.settings={triggerSeconds:10,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  await db.videos.put({key:'BV1234567890:1',bvid:'BV1234567890',aid:1,cid:1,title:'t',cover:'',owner:'',duration:60,page:1,fetchedAt:Date.now()});
  await upsertVisit(db,{sessionId:'s',videoKey:'BV1234567890:1',now:1});
  await db.summaries.put({key:'BV1234567890:1:m',videoKey:'BV1234567890:1',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'legacy-current',type:'SUMMARIZE',videoKey:'BV1234567890:1',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'VIDEO_ENTER',bvid:'BV1234567890',url:'https://www.bilibili.com/video/BV1234567890'});
  await mock.listener!({type:'SUMMARY_OPEN',videoKey:'BV1234567890:1',retry:1});
  expect((await db.jobs.get('legacy-current'))?.status).toBe('need_confirm');
});

it.each(['ASR_DECLINED','ASR_INTERRUPTED'] as const)('旧版待处理存在%s记录时不自动启动',async(reason)=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  const visit=await db.visits.where({sessionId:'s',videoKey:'v'}).first();await db.visits.update(visit!.id!,{triggered:1,watchedSeconds:10});
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',...(reason==='ASR_DECLINED'?{error:{code:reason,msg:'用户暂不处理'}}:{})});
  await db.jobs.put({id:'legacy',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  if(reason==='ASR_INTERRUPTED')await db.jobs.put({id:'failed-asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',error:{code:reason,msg:'失败'},progress:0,retries:0,createdAt:0,updatedAt:0});
  await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v',retry:1});
  expect((await db.jobs.get('legacy'))?.status).toBe('need_confirm');
});

it.each(['doubao-agent-plan','openai-compatible'] as const)('%s 音频任务开始前权限被撤销则不得交给离屏任务',async(provider)=>{
  const {executeViaOffscreen}=await import('../entrypoints/background');
  mock.values.settings={llm:{baseUrl:'https://llm.example/v1',modelId:'m',apiKey:'fake'},asr:provider==='doubao-agent-plan'?{provider,baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}:{provider,baseUrl:'https://asr.example/v1',modelId:'m',apiKey:'fake'}};
  mock.permissionContains.mockResolvedValue(false);
  const runtime=browser.runtime as any;runtime.getContexts=vi.fn(async()=>[{}]);runtime.onMessage.removeListener=vi.fn();
  const send=vi.mocked(browser.runtime.sendMessage);send.mockClear();send.mockResolvedValue({result:'done'} as never);
  const result=await executeViaOffscreen({id:'asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'running',progress:0,retries:0,createdAt:1,updatedAt:1},{update:async()=>{}});
  expect(result).toMatchObject({result:'failed',error:{code:'ASR_NOT_SENT_PERMISSION'}});
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({type:'OFFSCREEN_RUN_JOB'}));
});

it('语音任务未发送前权限撤销，授权后只恢复该未发送任务',async()=>{
  const {executeViaOffscreen}=await import('../entrypoints/background');
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={llm:{baseUrl:'https://llm.example/v1',modelId:'m',apiKey:'fake'},asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}});
  const job={id:'preflight-asr',type:'ASR_SUMMARIZE' as const,videoKey:'v',sessionId:'s',status:'running' as const,runId:'lease',progress:0,retries:0,createdAt:1,updatedAt:1};await db.jobs.put(job);
  mock.permissionContains.mockResolvedValue(false);
  const out=await executeViaOffscreen(job,{update:async()=>{}});
  expect(out).toMatchObject({result:'failed',error:{code:'ASR_NOT_SENT_PERMISSION'}});
  expect((await db.summaries.get('v:m'))?.error?.code).toBe('ASR_PERMISSION_DENIED');
  if(out.result==='failed')await db.jobs.update(job.id,{status:'failed',error:out.error});
  mock.permissionContains.mockResolvedValue(true);
  await mock.listener!({type:'SETTINGS_SAVE',asr:{provider:'doubao-agent-plan',apiKey:'fake'}});
  await vi.waitFor(async()=>expect((await db.jobs.get(job.id))?.status).toBe('pending'));
});

it.each(['缺配置','缺授权'] as const)('自动切换%s时停留待处理并提供原因',async(reason)=>{
  const {tryAutoAsr}=await import('../entrypoints/background') as unknown as {tryAutoAsr:(id:string)=>Promise<void>};
  expect(tryAutoAsr).toBeTypeOf('function');
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings=reason==='缺配置'?{}:{asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  if(reason==='缺授权')mock.permissionContains.mockResolvedValue(false);
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:10,retries:0,createdAt:1,updatedAt:1});
  await tryAutoAsr('subtitle');
  expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(0);
  expect((await db.summaries.get('v:m'))?.error?.code).toBe(reason==='缺配置'?'NEED_ASR_CONFIG':'ASR_PERMISSION_DENIED');
});

it.each(['失败历史','已有转写','未确认原文','暂停','已结束'] as const)('自动切换遇到%s时不得发送音频',async(reason)=>{
  const {tryAutoAsr}=await import('../entrypoints/background') as unknown as {tryAutoAsr:(id:string)=>Promise<void>};
  expect(tryAutoAsr).toBeTypeOf('function');
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={paused:reason==='暂停',asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  if(reason==='已结束')mock.values.sessionPointer={sessionId:'s',state:'GRACE',closedAt:Date.now(),lastActiveAt:Date.now()};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',...(reason==='未确认原文'?{asrProgress:{processedUntil:0,targetDuration:10,status:'partial' as const,parts:[],unconfirmed:[{from:0,to:10,text:'保留原文'}]}}:{})});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:10,retries:0,createdAt:1,updatedAt:1});
  if(reason==='失败历史')await db.jobs.put({id:'old-asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',progress:0,retries:0,createdAt:0,updatedAt:0});
  if(reason==='已有转写')await db.transcripts.put({key:'v',source:'asr',lan:'asr',cues:[{from:1,to:2,text:'原文'}],charCount:2,cachedAt:1});
  await tryAutoAsr('subtitle');
  expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE'&&j.id!=='old-asr')).toHaveLength(0);
});

it('完成语音配置后只继续自动流程留下的等待项，不启动旧待确认或失败项',async()=>{
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={llm:{baseUrl:'https://llm.example/v1',modelId:'m',apiKey:'fake'}};
  for(const [key,reason] of [['v','NEED_ASR_CONFIG'],['legacy',''],['failed','NEED_ASR_CONFIG'],['declined','NEED_ASR_CONFIG']] as const){
    await db.summaries.put({key:`${key}:m`,videoKey:key,source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',...(reason?{error:{code:reason,msg:'等待配置'}}:{})});
    await db.jobs.put({id:`subtitle-${key}`,type:'SUMMARIZE',videoKey:key,sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  }
  await db.jobs.put({id:'old-asr',type:'ASR_SUMMARIZE',videoKey:'failed',sessionId:'s',status:'failed',progress:0,retries:0,createdAt:0,updatedAt:0});
  await mock.listener!({type:'ASR_DECLINE',videoKey:'declined'});
  await mock.listener!({type:'SETTINGS_SAVE',asr:{provider:'doubao-agent-plan',apiKey:'fake'}});
  await vi.waitFor(async()=>expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE'&&j.id!=='old-asr').map(j=>j.videoKey)).toEqual(['v']));
  expect((await db.jobs.get('subtitle-legacy'))?.status).toBe('need_confirm');
  expect((await db.jobs.get('subtitle-failed'))?.status).toBe('need_confirm');
  expect((await db.jobs.get('subtitle-declined'))?.status).toBe('need_confirm');
});

it('暂停时持久化的自动等待项在恢复陪看后继续',async()=>{
  await db.summaries.clear();await db.transcripts.delete('v');
  mock.values.settings={paused:true,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'SETTINGS_SAVE',paused:false});
  await vi.waitFor(async()=>expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(1));
});

it('用户暂不处理后，即使自动切换回调迟到也不发送语音',async()=>{
  const {tryAutoAsr}=await import('../entrypoints/background') as unknown as {tryAutoAsr:(id:string)=>Promise<void>};
  await db.transcripts.delete('v');await db.summaries.clear();
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr'});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await mock.listener!({type:'ASR_DECLINE',videoKey:'v'});
  await tryAutoAsr('subtitle');
  expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(0);
});

it.each(['pending','running'] as const)('暂不处理与已%s语音任务竞态时正确处理',async(status)=>{
  await db.summaries.clear();
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}});
  await db.jobs.put({id:'auto-asr',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status,progress:0,retries:0,createdAt:1,updatedAt:1});
  const result=await mock.listener!({type:'ASR_DECLINE',videoKey:'v'});
  if(status==='pending'){
    expect(result).toMatchObject({ok:true});
    expect((await db.jobs.get('auto-asr'))?.status).toBe('failed');
    expect((await db.summaries.get('v:m'))?.error?.code).toBe('ASR_DECLINED');
  } else {
    expect(result).toMatchObject({ok:false,reason:'ASR_ALREADY_STARTED'});
    expect((await db.jobs.get('auto-asr'))?.status).toBe('running');
    expect((await db.summaries.get('v:m'))?.error?.code).toBe('AUTO_ASR_PENDING');
  }
});

it('过期字幕已无可用新轨时保护旧字幕，自动和手动均不启动覆盖它的语音任务',async()=>{
  const {tryAutoAsr}=await import('../entrypoints/background') as unknown as {tryAutoAsr:(id:string,requireWaitingMarker?:boolean)=>Promise<void>};
  await db.summaries.clear();
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  const old={key:'v',source:'manual_sub' as const,lan:'zh',cues:[{from:1,to:2,text:'旧字幕'}],charCount:3,cachedAt:1};await db.transcripts.put(old);
  await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',createdAt:1,status:'need_asr',error:{code:'AUTO_ASR_PENDING',msg:'等待语音识别'}});
  await db.jobs.put({id:'subtitle',type:'SUMMARIZE',videoKey:'v',sessionId:'s',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
  await tryAutoAsr('subtitle',true);
  expect((await db.summaries.get('v:m'))?.error?.code).toBe('ASR_EXISTING_SUBTITLE');
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v'})).toMatchObject({ok:false,reason:'ASR_EXISTING_SUBTITLE'});
  expect((await db.jobs.toArray()).filter(j=>j.type==='ASR_SUMMARIZE')).toHaveLength(0);
  expect(await db.transcripts.get('v')).toEqual(old);
  await db.transcripts.delete('v');
});

it('冲突恢复必须显式确认，双标签仅排一个豆包任务',async()=>{
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  const cues=[{from:1,to:2,text:'温度5度'}];const original={key:'v',source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};
  await db.transcripts.put(original);expect((await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'}) as any).recovery?.status).toBe('available');expect(await db.jobs.count()).toBe(0);
  const replies=await Promise.all([mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'}),mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})]);expect(replies.every((r:any)=>r.ok)).toBe(true);
  const jobs=await db.jobs.toArray();expect(jobs).toHaveLength(1);expect((jobs[0] as any).recovery.original).toEqual(original);await db.transcripts.delete('v');
});

it('冲突恢复忽略旧会话未运行队列，但不能与其他会话正在运行的任务并发',async()=>{
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  const cues=[{from:1,to:2,text:'温度5度'}];const original={key:'v',source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};await db.transcripts.put(original);
  await db.jobs.put({id:'old',type:'SUMMARIZE',videoKey:'v',sessionId:'old-session',status:'pending',progress:0,retries:0,createdAt:1,updatedAt:1});
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})).toMatchObject({ok:true,started:true});
  await db.jobs.clear();await db.jobs.put({id:'running',type:'SUMMARIZE',videoKey:'v',sessionId:'old-session',status:'running',progress:0,retries:0,createdAt:1,updatedAt:1});
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})).toMatchObject({ok:false,error:'busy'});expect(await db.jobs.count()).toBe(1);await db.transcripts.delete('v');
});

it('非豆包服务明确拒绝冲突恢复且不入队',async()=>{
  mock.values.settings={asr:{provider:'openai-compatible',baseUrl:'https://asr.example',modelId:'m',apiKey:'fake'}};
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})).toMatchObject({ok:false,reason:'ASR_RECOVERY_UNSUPPORTED'});expect(await db.jobs.count()).toBe(0);
});

it('冲突恢复候选过期或界面操作过时不会重传，待确认后才排队',async()=>{
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  const cues=[{from:1,to:2,text:'温度5度'}];const original={key:'v',source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};
  const candidate={...original,cachedAt:Date.now()-25*60*60*1000};await db.transcripts.put(original);
  await db.jobs.put({id:'old',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',progress:0,retries:0,createdAt:1,updatedAt:1,recovery:{original,candidate,pending:true}});
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'continue'})).toMatchObject({ok:false,reason:'ASR_RECOVERY_CHANGED'});expect(await db.jobs.count()).toBe(1);
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})).toMatchObject({ok:true,started:true});expect(await db.jobs.count()).toBe(2);await db.transcripts.delete('v');
});

it('冲突恢复有效候选仅允许继续汇总，复制候选后不发送新音频',async()=>{
  await db.videos.put({key:'v',bvid:'BV1test12345',aid:1,cid:777,title:'测试',cover:'',owner:'',duration:10,page:1,fetchedAt:Date.now()});
  mock.values.settings={asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake'}};
  const cues=[{from:1,to:2,text:'温度5度'}];const original={key:'v',source:'asr' as const,lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]};
  const fixedCues=[{from:1,to:2,text:'温度+5度'}];const candidate={...original,asrDuration:10,cues:fixedCues,asrParts:[{...original.asrParts[0]!,serviceDurationMs:10000,cues:fixedCues,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度+5度',startMs:1000,endMs:2000}]}]}}]};await db.transcripts.put(original);
  await db.jobs.put({id:'old',type:'ASR_SUMMARIZE',videoKey:'v',sessionId:'s',status:'failed',progress:0,retries:0,createdAt:1,updatedAt:1,recovery:{original,candidate}});
  expect((await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'}) as any).recovery.status).toBe('candidate');
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'recognize'})).toMatchObject({ok:false,reason:'ASR_RECOVERY_CHANGED'});
  mock.values.settings={};mock.permissionContains.mockResolvedValue(false);
  expect(await mock.listener!({type:'ASR_CONFIRM',videoKey:'v',recovery:true,recoveryAction:'continue'})).toMatchObject({ok:true,started:true});
  const job=(await db.jobs.toArray()).find(j=>j.id!=='old');expect(job?.recovery?.candidate).toEqual(candidate);expect(await db.transcripts.get('v')).toEqual(original);await db.transcripts.delete('v');
});

it.each(['ai_sub','manual_sub'] as const)('有效%s摘要不显示旧冲突ASR恢复卡',async(source)=>{
  const cues=[{from:1,to:2,text:'温度5度'}];await db.transcripts.put({key:'v',source:'asr',lan:'asr',cues,charCount:4,cachedAt:Date.now(),asrComplete:true,asrParts:[{start:0,end:10,whole:true,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words:[{text:'温度5度',startMs:1000,endMs:2000}]}]},cues}]});
  await db.summaries.put({key:'v:valid',videoKey:'v',source,summary:'字幕摘要',outline:[{time:1,text:'内容'}],evaluation:'点评',rating:4,modelId:'valid',persona:'spicy',status:'done',createdAt:Date.now()});
  const response:any=await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'});expect(response.item.summary.source).toBe(source);expect(response.recovery).toBeUndefined();
  await db.summaries.delete('v:valid');await db.transcripts.delete('v');
});

it('查看部分识别结果不会自动排队字幕任务或覆盖已完成片段',async()=>{
 await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',status:'need_asr',createdAt:1,asrProgress:{processedUntil:30,targetDuration:60,status:'partial',parts:[{from:0,to:30,text:'局部内容'}]}});
 await db.jobs.put({id:'old-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'failed',progress:20,retries:0,createdAt:1,updatedAt:1});
 const result=await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v',retry:1}) as any;
 expect(result.item.summary.asrProgress.parts[0].text).toBe('局部内容');
 expect((await db.jobs.toArray()).filter(j=>j.type==='SUMMARIZE')).toHaveLength(0);
 await db.summaries.clear();
});

it('摘要详情仅对本视频未过期的完整 ASR 转写标记可复用',async()=>{
 const row={key:'v',source:'asr' as const,lan:'asr',cues:[{from:0,to:1,text:'内容'}],charCount:2,cachedAt:Date.now(),asrComplete:true};
 try {
  await db.transcripts.put(row);expect(await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'})).toMatchObject({asrCached:true});
  await db.transcripts.put({...row,asrComplete:false});expect(await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'})).toMatchObject({asrCached:false});
  await db.transcripts.put({...row,cachedAt:Date.now()-25*60*60*1000});expect(await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'})).toMatchObject({asrCached:false});
  await db.transcripts.put({...row,source:'ai_sub'});expect(await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'})).toMatchObject({asrCached:false});
 } finally {await db.transcripts.delete('v');}
});

it('新会话不会被旧会话同视频的待确认任务阻塞',async()=>{
 await db.jobs.put({id:'old-session-job',type:'SUMMARIZE',sessionId:'old',videoKey:'v',status:'need_confirm',progress:0,retries:0,createdAt:1,updatedAt:1});
 const result=await mock.listener!({type:'SUMMARY_OPEN',videoKey:'v'}) as any;
 expect(result.item.job?.sessionId).toBe('s');
});

it('结束陪看使当前 ASR 租约失效并把局部结果标为未完成',async()=>{
 await db.sessions.put({id:'s',state:'ACTIVE',startedAt:1,lastActiveAt:1});
 await db.jobs.put({id:'asr-live',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:30,retries:0,createdAt:1,updatedAt:1});
 await db.summaries.put({key:'v:m',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'m',persona:'spicy',status:'streaming',createdAt:1,asrProgress:{sessionId:'s',processedUntil:30,targetDuration:60,status:'running',parts:[{from:0,to:30,text:'已完成内容'}]}});
 expect(await mock.listener!({type:'SESSION_END'})).toMatchObject({ok:true});
 expect(await db.jobs.get('asr-live')).toMatchObject({status:'failed',error:{code:'ASR_INTERRUPTED'}});expect((await db.jobs.get('asr-live'))?.runId).toBeUndefined();
 expect((await db.summaries.get('v:m'))?.asrProgress).toMatchObject({status:'partial',processedUntil:30});
 await db.summaries.clear();await db.sessions.clear();
});

it('结束陪看后通知现存离屏文档取消当前会话语音任务，不创建离屏文档',async()=>{
 const runtime=(globalThis as any).browser.runtime;runtime.sendMessage.mockClear();
 await db.sessions.put({id:'s',state:'ACTIVE',startedAt:1,lastActiveAt:1});
 await db.jobs.put({id:'asr-abort',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:0,retries:0,createdAt:1,updatedAt:1});
 expect(await mock.listener!({type:'SESSION_END'})).toMatchObject({ok:true});
 expect(runtime.sendMessage).toHaveBeenCalledWith({type:'OFFSCREEN_CANCEL_ASR',sessionId:'s'});
 expect((await db.jobs.get('asr-abort'))?.status).toBe('failed');await db.sessions.clear();
});

it('离屏语音任务完成消息只收口匹配租约的在途任务',async()=>{
 await db.jobs.put({id:'live-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'current',progress:50,retries:0,createdAt:1,updatedAt:1});
 const send=(mock.listener as any);
 expect(await send({type:'OFFSCREEN_ASR_DONE',jobId:'live-asr',runId:'old',outcome:{result:'done'}},{url:'chrome-extension://fixture/offscreen.html'})).toMatchObject({ok:false});
 expect((await db.jobs.get('live-asr'))?.status).toBe('running');
 expect(await send({type:'OFFSCREEN_ASR_DONE',jobId:'live-asr',runId:'current',outcome:{result:'done'}},{url:'chrome-extension://fixture/offscreen.html'})).toMatchObject({ok:true});
 expect(await db.jobs.get('live-asr')).toMatchObject({status:'done',progress:100});
});

it('离屏语音任务收口时保留可操作的大小限制提示，且不回显不可信的错误正文',async()=>{
 const send=(mock.listener as any);
 const sender={url:'chrome-extension://fixture/offscreen.html'};
 await db.jobs.put({id:'large-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:1,retries:0,createdAt:1,updatedAt:1});
 await send({type:'OFFSCREEN_ASR_DONE',jobId:'large-asr',runId:'lease',outcome:{result:'failed',error:{code:'ASR_AUDIO_TOO_LARGE',msg:'secret-should-not-appear'}}},sender);
 const job=await db.jobs.get('large-asr');expect(job?.error?.code).toBe('ASR_AUDIO_TOO_LARGE');expect(job?.error?.msg).toContain('25 MiB');expect(job?.error?.msg).not.toContain('secret-should-not-appear');
 await db.jobs.put({id:'incomplete-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:1,retries:0,createdAt:1,updatedAt:1});
 await send({type:'OFFSCREEN_ASR_DONE',jobId:'incomplete-asr',runId:'lease',outcome:{result:'failed',error:{code:'ASR_AUDIO_INCOMPLETE',msg:'secret-should-not-appear'}}},sender);
 const incomplete=await db.jobs.get('incomplete-asr');expect(incomplete?.error?.code).toBe('ASR_AUDIO_INCOMPLETE');expect(incomplete?.error?.msg).toContain('音频解码不完整');expect(incomplete?.error?.msg).not.toContain('secret-should-not-appear');
 await db.jobs.put({id:'packet-timeout-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:30,retries:0,createdAt:1,updatedAt:1});
 await send({type:'OFFSCREEN_ASR_DONE',jobId:'packet-timeout-asr',runId:'lease',outcome:{result:'failed',error:{code:'ASR_SERVICE_45000081',msg:'secret-should-not-appear'}}},sender);
 const packetTimeout=await db.jobs.get('packet-timeout-asr');expect(packetTimeout?.error?.code).toBe('ASR_SERVICE_45000081');expect(packetTimeout?.error?.msg).toContain('等待音频包超时');expect(packetTimeout?.error?.msg).not.toContain('secret-should-not-appear');
 await db.jobs.put({id:'compatible-timeout',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:30,retries:0,createdAt:1,updatedAt:1});
 await send({type:'OFFSCREEN_ASR_DONE',jobId:'compatible-timeout',runId:'lease',outcome:{result:'failed',error:{code:'ASR_TIMEOUT',msg:'secret-should-not-appear'}}},sender);
 const timeout=await db.jobs.get('compatible-timeout');expect(timeout?.error?.code).toBe('ASR_TIMEOUT');expect(timeout?.error?.msg).toContain('超时');expect(timeout?.error?.msg).not.toContain('secret-should-not-appear');
 await db.jobs.put({id:'unknown-asr',type:'ASR_SUMMARIZE',sessionId:'s',videoKey:'v',status:'running',runId:'lease',progress:1,retries:0,createdAt:1,updatedAt:1});
 await send({type:'OFFSCREEN_ASR_DONE',jobId:'unknown-asr',runId:'lease',outcome:{result:'failed',error:{code:'ASR_UNKNOWN',msg:'secret-should-not-appear'}}},sender);
 expect((await db.jobs.get('unknown-asr'))?.error?.msg).not.toContain('secret-should-not-appear');
});

it('ASR 看门狗允许协议最长会话和摘要阶段，真正超时撤销租约并取消离屏任务', async () => {
  const { executeViaOffscreen } = await import('../entrypoints/background');
  const runtime = browser.runtime as any;
  const originalAdd = runtime.onMessage.addListener;
  const originalRemove = runtime.onMessage.removeListener;
  let progress!: (msg: unknown) => void;
  runtime.onMessage.addListener = (fn: typeof progress) => { progress = fn; };
  runtime.onMessage.removeListener = vi.fn();
  runtime.getContexts = vi.fn(async () => [{}]);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers: { ms: number; callback: () => void; cleared: boolean }[] = [];
  const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms && ms >= 240_000) {
      const timer = {ms, callback: fn, cleared: false}; timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
    const match = timers.find(t => t === timer as unknown);
    if (match) match.cleared = true; else realClearTimeout(timer);
  }) as typeof clearTimeout);
  mock.values.settings = {llm:{baseUrl:'https://example.com/v1',modelId:'m',apiKey:'fake'},asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'m',apiKey:'fake'}};
  const job = {id:'timeout-asr',type:'ASR_SUMMARIZE' as const,sessionId:'s',videoKey:'v',status:'running' as const,runId:'lease',progress:0,retries:0,createdAt:1,updatedAt:1};
  await db.jobs.put(job);
  await db.summaries.put({key:'v:timeout',videoKey:'v',source:'asr',summary:'',outline:[],evaluation:'',rating:0,modelId:'timeout',persona:'spicy',status:'streaming',createdAt:1,asrProgress:{sessionId:'s',processedUntil:30,targetDuration:60,status:'running',parts:[{from:0,to:30,text:'已完成内容'}]}});
  const messages: unknown[] = [];
  const send = vi.spyOn(runtime, 'sendMessage').mockImplementation(async (message: any) => {
    messages.push(message);
    if (message.type === 'OFFSCREEN_CANCEL_ASR') {
      expect(await db.jobs.get(job.id)).toMatchObject({status:'failed',runId:undefined});
      return {ok:true};
    }
    return new Promise(() => {});
  });
  try {
    const result = executeViaOffscreen(job, {update: async () => {}});
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]!.ms).toBeGreaterThan(600_000);
    progress({type:'SUMMARY_PROGRESS',jobId:job.id,stage:'asr',progress:30});
    expect(timers[0]!.cleared).toBe(true);
    expect(timers[1]!.ms).toBeGreaterThan(600_000);
    progress({type:'SUMMARY_PROGRESS',jobId:job.id,stage:'summarize',progress:70});
    expect(timers[1]!.cleared).toBe(true);
    expect(timers[2]!.ms).toBeGreaterThan(600_000);
    timers[2]!.callback();
    await result;
    expect(messages).toContainEqual({type:'OFFSCREEN_CANCEL_ASR',sessionId:'s'});
    expect(await db.jobs.get(job.id)).toMatchObject({status:'failed',error:{code:'ASR_INTERRUPTED'}});
    expect(await db.summaries.get('v:timeout')).toMatchObject({status:'need_asr',asrProgress:{status:'partial',processedUntil:30}});
    expect(await (mock.listener as any)({type:'OFFSCREEN_ASR_DONE',jobId:job.id,runId:'lease',outcome:{result:'done'}},{url:'chrome-extension://fixture/offscreen.html'})).toMatchObject({ok:false});
  } finally {
    await db.summaries.delete('v:timeout');
    send.mockRestore(); setSpy.mockRestore(); clearSpy.mockRestore();
    runtime.onMessage.addListener = originalAdd; runtime.onMessage.removeListener = originalRemove;
  }
});
