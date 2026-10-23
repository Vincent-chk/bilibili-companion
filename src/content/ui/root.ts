// P1.5 · 共享 UI 层：单一 Shadow DOM 宿主承载 mascot / panel / modal / toast 四层
// （原型 #mascot-wrap/#panel/#modal-root/#toast-root 结构 1:1）。position:fixed 子元素
// 不参与宿主页面文档流——注入零重排（浮层准则 #7）。DOM 依赖注入 document 便于测试。
import { UI_STYLES } from './styles';

export const UI_HOST_ID = 'doubao-ui-root';

export interface DoubaoUi {
  host: HTMLElement;
  root: ShadowRoot;
}

/** 挂载（幂等）：已存在时直接复用。结构由各模块自行填充自己的容器。 */
export function mountDoubaoUi(doc: Document = document): DoubaoUi {
  let host = doc.getElementById(UI_HOST_ID);
  if (host?.shadowRoot) return { host, root: host.shadowRoot };
  if (!host) {
    host = doc.createElement('div');
    host.id = UI_HOST_ID;
    doc.documentElement.appendChild(host);
  }
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${UI_STYLES}</style>
    <div id="mascot-wrap" class="hidden"><div id="mascot-bubble" class="mascot-bubble hidden"></div><div id="mascot"><div class="mascot-float"><img id="mascot-img" alt="豆包" draggable="false"></div></div></div>
    <aside id="panel" aria-label="豆包陪看面板">
      <header class="p-head">
        <div class="p-head-row">
          <div class="p-mascot-avatar"><img alt="豆包"></div>
          <div class="p-titles"><div class="p-title">豆包的陪看小本本</div><div class="p-sub" id="p-status"></div></div>
        </div>
        <div class="p-head-actions hidden" id="p-head-actions"></div>
      </header>
      <div class="p-body" id="p-body">
        <section id="view-list"></section>
      </div>
    </aside>
    <div id="modal-root"></div>
    <div id="toast-root"></div>`;
  return { host, root };
}

/** toast 通知（原型 toast() 1:1；经 shadow root 渲染，不入页面 DOM）。 */
export function toast(ui: DoubaoUi, msg: string, ms = 2200): void {
  const rootEl = ui.root.getElementById('toast-root');
  if (!rootEl) return;
  const t = ui.root.ownerDocument.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  rootEl.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

/** HTML 转义（innerHTML 渲染前的必经通道——字幕/标题皆不可信文本）。 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
