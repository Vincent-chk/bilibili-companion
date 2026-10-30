import { expect, it, vi } from 'vitest';
import { openOnboarding, type OnboardingDeps } from '../src/content/onboarding/onboarding';

it.each([false,true])('首次配置和补配均说明自动发送完整音频及费用剧透（补配=%s）', (asrOnly) => {
  const modal={innerHTML:'',className:'',querySelector:()=>null,querySelectorAll:()=>[]};
  const holder={dataset:{} as Record<string,string>,classList:{contains:()=>false,add:vi.fn()},replaceChildren:vi.fn()};
  const root={ownerDocument:{createElement:()=>modal},getElementById:()=>holder};
  openOnboarding({ui:{root},assetUrl:()=>'',testConnection:vi.fn(),save:vi.fn(),onDismiss:vi.fn(),onSaved:vi.fn(),asrOnly} as unknown as OnboardingDeps);
  expect(modal.innerHTML).toContain('自动');
  expect(modal.innerHTML).toContain('完整音频');
  expect(modal.innerHTML).toContain('消耗');
  expect(modal.innerHTML).toContain('剧透');
  expect(modal.innerHTML).not.toContain('视频识别前请求你的确认');
});
