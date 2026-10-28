import { expect, it, vi } from 'vitest';
import { PanelController, type PanelDeps } from '../src/content/panel/panel';

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
