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
      id: 'fixture', getManifest: () => ({ version: '0.0.1' }),
      onConnect: { addListener: (listener: typeof mock.connect) => { mock.connect = listener; } },
      onMessage: { addListener: (listener: typeof mock.listener) => { mock.listener = listener; } },
    },
    webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
    declarativeNetRequest: { updateDynamicRules: vi.fn() },
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

it('启动恢复任务后，向主链和分段链发送显式恢复信号', async () => {
  const drain = vi.mocked(Pipeline.prototype.drain);
  drain.mockClear();
  expect(mock.recoveryResolve).not.toBeNull();
  mock.recoveryResolve!(2);
  await vi.waitFor(() => expect(drain.mock.calls).toEqual([[true], [true]]), { timeout: 1000 });
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
