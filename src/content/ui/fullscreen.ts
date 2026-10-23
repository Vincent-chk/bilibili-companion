// P1.9 · 准则#3 全屏避让：浏览器全屏（Fullscreen API）时页内 fixed 浮层会被全屏层遮挡
// （架构 §2.1 风险 1）→ 监听 fullscreenchange，把 Shadow 宿主迁入全屏元素子树；退出迁回
// documentElement。网页全屏（B 站 CSS 全屏，不走 Fullscreen API）靠 z-index 2147483000 段位
// 保持在上层，无需迁移。迁移判定纯函数见 mascot/logic.fullscreenHostParent（单测覆盖）。
import { fullscreenHostParent } from '../mascot/logic';

/** 挂载迁移监听；返回解绑函数。doc/host 注入便于测试。 */
export function setupFullscreenMigration(doc: Document, host: HTMLElement): () => void {
  const onChange = (): void => {
    const target = fullscreenHostParent(doc.fullscreenElement, host, doc.documentElement);
    if (target) target.appendChild(host);
  };
  doc.addEventListener('fullscreenchange', onChange);
  return () => doc.removeEventListener('fullscreenchange', onChange);
}
