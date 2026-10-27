// P3.3 · 暗色模式判据纯函数单测：html.dark / theme 系 data 属性 → 宿主 .dark 同步依据。
import { describe, expect, it } from 'vitest';
import { isDarkPage } from '../src/content/ui/theme';

describe('isDarkPage（B 站暗色信号判定）', () => {
  it('html class 含 dark（DOMTokenList 形态）→ true', () => {
    expect(isDarkPage({ htmlClass: { contains: (n: string) => n === 'dark' } })).toBe(true);
  });
  it('html class 数组含 dark → true；不含 → false', () => {
    expect(isDarkPage({ htmlClass: ['dark'] })).toBe(true);
    expect(isDarkPage({ htmlClass: ['light', 'biligitheme-pink'] })).toBe(false);
  });
  it('data 属性快照含 dark 值（历史变体）→ true', () => {
    expect(isDarkPage({ dataAttrs: [null, 'dark', null] })).toBe(true);
    expect(isDarkPage({ dataAttrs: ['light-mode', null] })).toBe(false);
  });
  it('空信号/全 null → false（浅色默认，不误暗）', () => {
    expect(isDarkPage({})).toBe(false);
    expect(isDarkPage({ htmlClass: [], dataAttrs: [null, null, null] })).toBe(false);
  });
});
