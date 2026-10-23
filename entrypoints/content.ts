// Phase 0 PoC · content script 骨架（0.3）
// 职责：识别当前页 bvid → Shadow DOM 挂豆包立绘（零页面重排）→ SPA 路由变化重新识别。
// 摘要链路（bvid → 字幕 → LLM）经 chrome.runtime 消息由 background 执行（host_permissions）。
export default defineContentScript({
  matches: ['*://www.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    mountMascot();
    report(detectBvid(location.href));

    // B 站是 SPA：路由变化不重载页面，监听 history API + popstate 重新识别。
    let last = location.href;
    const onRoute = () => {
      if (location.href !== last) {
        last = location.href;
        report(detectBvid(location.href));
      }
    };
    window.addEventListener('popstate', onRoute);
    patchHistoryPushState(onRoute);

    console.log('[doubao-poc] content script injected:', location.href);
  },
});

/** 从 URL 提取 BV 号（兼容带任意 query/分P路径，参考 00-纪要 §3.1 的正则结论）。 */
export function detectBvid(url: string): string | null {
  const m = url.match(/\/video\/(BV[0-9A-Za-z]{10})/);
  return m?.[1] ?? null;
}

function report(bvid: string | null) {
  console.log('[doubao-poc] bvid =', bvid);
  void browser.runtime.sendMessage({ type: 'VIDEO_SEEN', bvid }).catch(() => {
    /* background 未就绪时静默（PoC 级容错） */
  });
}

/** Shadow DOM 挂载豆包立绘：position:fixed 不参与文档流，避免页面重排（对标准则 #7）。 */
function mountMascot() {
  const HOST_ID = 'doubao-poc-host';
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      img { position: fixed; right: 24px; bottom: 24px; width: 72px; height: 72px;
            z-index: 2147483647; opacity: .92; cursor: pointer;
            animation: doubao-float 3s ease-in-out infinite; }
      @keyframes doubao-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
    </style>
    <img src="${browser.runtime.getURL('/mascot/mascot-idle.png')}" alt="豆包" />`;
  root.querySelector('img')?.addEventListener('click', () => {
    console.log('[doubao-poc] mascot clicked');
  });
}

function patchHistoryPushState(onChange: () => void) {
  const origPush = history.pushState.bind(history);
  history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
    const r = origPush(data, unused, url);
    onChange();
    return r;
  }) as typeof history.pushState;

  const origReplace = history.replaceState.bind(history);
  history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    const r = origReplace(data, unused, url);
    onChange();
    return r;
  }) as typeof history.replaceState;
}
