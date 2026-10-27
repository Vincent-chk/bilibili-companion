// P3.3 · B 站暗色模式适配：Shadow DOM 不吃页面级联，把页面主题同步为宿主类（样式覆盖见 styles.ts）。
// 信号判定纯函数独立导出便于单测；MutationObserver 监听 html class/data-theme 属性变化。
export type PageThemeSignals = {
  /** document.documentElement.classList（DOMTokenList 或字符串数组均可） */
  htmlClass?: { contains(name: string): boolean } | string[];
  /** <html> 的 biligir / theme 系 data-* 属性值快照 */
  dataAttrs?: (string | null)[];
};

const has = (c: PageThemeSignals['htmlClass'], name: string): boolean =>
  Array.isArray(c) ? c.includes(name) : !!c?.contains(name);

/** B 站暗色判据：<html class="dark">（现行）或 theme 系 data 属性含 dark（历史变体）。 */
export function isDarkPage(s: PageThemeSignals): boolean {
  if (has(s.htmlClass, 'dark')) return true;
  return (s.dataAttrs ?? []).some((v) => typeof v === 'string' && v.includes('dark'));
}

/** 挂载主题同步；返回解绑函数。doc 注入便于测试。 */
export function setupThemeSync(doc: Document, host: HTMLElement): () => void {
  const apply = (): void => {
    const el = doc.documentElement;
    host.classList.toggle(
      'dark',
      isDarkPage({
        htmlClass: el.classList,
        dataAttrs: ['biligitheme', 'theme', 'data-theme'].map((a) => el.getAttribute(a)),
      }),
    );
  };
  apply();
  const mo = new MutationObserver(apply);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-biligitheme', 'data-theme'] });
  return () => mo.disconnect();
}
