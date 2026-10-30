import { expect, it, vi } from 'vitest';
import { renderSettingsView, type SettingsViewDeps } from '../src/content/panel/settings';

it('编辑模型配置后清除旧连接结果，也忽略编辑前发出的迟到结果', async () => {
  const listeners = new Map<object, Record<string, () => void>>();
  const target = <T extends object>(o: T) => Object.assign(o, {
    addEventListener: (type: string, cb: () => void) => {
      const registered = listeners.get(o) ?? {};
      registered[type] = cb;
      listeners.set(o, registered);
    },
  });
  const inputs = [
    target({ value: 'https://old.example/v1', getAttribute: () => 'baseUrl' }),
    target({ value: 'old-model', getAttribute: () => 'modelId' }),
    target({ value: '********1234', getAttribute: () => 'apiKey' }),
  ];
  const section = { querySelectorAll: () => inputs };
  const status = { className: 'test-status hidden', textContent: '' };
  const btn = target({ disabled: false, textContent: '测试连接', getAttribute: () => 'sec-llm', hasAttribute: (a: string) => a === 'data-test' });
  const box = {
    innerHTML: '',
    querySelector: (s: string) => s === '#sec-llm' ? section : s === '[data-status="sec-llm"]' ? status : null,
    querySelectorAll: (s: string) => s === '[data-test]' ? [btn] : [],
  };
  let complete!: (value: { ok: boolean; msg: string }) => void;
  const bridge = { request: vi.fn(() => new Promise(resolve => { complete = resolve; })) };
  renderSettingsView({
    ui: { root: { getElementById: () => box } }, bridge,
    data: { ok: true, llm: { baseUrl: 'https://old.example/v1', modelId: 'old-model', apiKeyMasked: '********1234' }, triggerSeconds: 10, persona: 'spicy', bubbles: true, paused: false, asrMaxMB: 25 },
    mascotHidden: false, onBack() {}, onSaved() {}, onWipe() {}, onMascotHiddenChange() {},
  } as unknown as SettingsViewDeps);
  listeners.get(btn)!.click!();
  complete({ ok: true, msg: '连接成功（HTTP 200）' });
  await vi.waitFor(() => expect(status.textContent).toContain('连接成功'));
  inputs[1]!.value = 'new-model';
  listeners.get(inputs[1]!)?.input?.();
  expect(status.className).toContain('hidden');
  listeners.get(btn)!.click!();
  inputs[0]!.value = 'https://new.example/v1';
  listeners.get(inputs[0]!)?.input?.();
  complete({ ok: true, msg: '连接成功（HTTP 200）' });
  await vi.waitFor(() => expect(btn.disabled).toBe(false));
  expect(status.className).toContain('hidden');
});

it('ASR 设置说明自动识别整段音频、费用及剧透风险', () => {
  const box = { innerHTML:'', querySelector:()=>null, querySelectorAll:()=>[] };
  renderSettingsView({ui:{root:{getElementById:()=>box}},bridge:{request:vi.fn()},data:{ok:true,triggerSeconds:10,persona:'spicy',bubbles:true,paused:false,asrMaxMB:25},mascotHidden:false,onBack(){},onSaved(){},onWipe(){},onMascotHiddenChange(){}} as unknown as SettingsViewDeps);
  expect(box.innerHTML).toContain('自动');
  expect(box.innerHTML).toContain('完整音频');
  expect(box.innerHTML).toContain('消耗');
  expect(box.innerHTML).toContain('剧透');
  expect(box.innerHTML).not.toContain('识别前需确认');
});
