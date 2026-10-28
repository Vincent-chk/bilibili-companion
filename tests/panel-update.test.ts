import { expect, it, vi } from 'vitest';
import { PanelController, type ListQueryResponse, type PanelDeps } from '../src/content/panel/panel';

it('迟到的旧列表响应不能覆盖已收到的新版本提示', async () => {
  const banner = { innerHTML: '', classList: { toggle: vi.fn() } };
  const root = {
    ownerDocument: { addEventListener: vi.fn() },
    getElementById: (id: string) => id === 'update-banner' ? banner : null,
    querySelector: () => null,
  };
  let respond!: (value: ListQueryResponse) => void;
  const response = new Promise<ListQueryResponse>(resolve => { respond = resolve; });
  const panel = new PanelController({
    ui: { root },
    bridge: { request: () => response },
    onSessionStart: () => {}, onSessionEnd: () => {}, onSeek: () => {}, onNeedAsrConfig: () => {},
  } as unknown as PanelDeps);
  const refresh = panel.refresh();
  panel.handleEvent({ type: 'UPDATE_AVAILABLE', updateVersion: 'v1.2.0', updateRevision: 2 });
  respond({ ok: true, items: [], sessionState: 'INACTIVE', triggerSeconds: 20, loggedIn: null, updateVersion: null, updateRevision: 1 });
  await refresh;
  expect(banner.innerHTML).toContain('v1.2.0');
  expect(banner.classList.toggle).toHaveBeenLastCalledWith('hidden', false);
});

it('较早的列表查询迟到时不能覆盖较新的陪看状态', async () => {
  const status = { innerHTML: '', textContent: '' };
  const root = {
    ownerDocument: { addEventListener: vi.fn() },
    getElementById: (id: string) => id === 'p-status' ? status : null,
    querySelector: () => null,
  };
  let finishOld!: (value: ListQueryResponse) => void;
  let finishNew!: (value: ListQueryResponse) => void;
  const oldResponse = new Promise<ListQueryResponse>(resolve => { finishOld = resolve; });
  const newResponse = new Promise<ListQueryResponse>(resolve => { finishNew = resolve; });
  let calls = 0;
  const panel = new PanelController({
    ui: { root },
    bridge: { request: () => ++calls === 1 ? oldResponse : newResponse },
    onSessionStart: () => {}, onSessionEnd: () => {}, onSeek: () => {}, onNeedAsrConfig: () => {},
  } as unknown as PanelDeps);
  const oldRefresh = panel.refresh();
  const newRefresh = panel.refresh();
  finishNew({ ok: true, items: [], sessionState: 'ACTIVE', triggerSeconds: 10, loggedIn: null });
  await newRefresh;
  expect(status.innerHTML).toContain('陪看中');
  finishOld({ ok: true, items: [], sessionState: 'INACTIVE', triggerSeconds: 10, loggedIn: null });
  await oldRefresh;
  expect(status.textContent).not.toContain('未激活');
  expect(status.innerHTML).toContain('陪看中');
});
