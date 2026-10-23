// content script：Phase 0 骨架（0.3）+ P1.2 watcher 接线。
// 职责：识别当前页 bvid → Shadow DOM 挂豆包立绘 → SPA 路由变化重新识别
//       → watcher 有效观看计时（20s 触发 / WATCH_TICK 节流上报，经 runtime 消息走 background）。
import { WatchSession } from '../src/content/watcher/dom';

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
  void startWatcher(bvid);
}

/** VIDEO_ENTER（background 解析元信息/多P）→ 建 WatchSession（有效观看→WATCH_TICK/TRIGGER_SUMMARY）。
 * 代数令牌：应答在途时用户又切视频 → 丢弃过期应答，否则旧视频的 session 永不 dispose，
 * 与新 session 双路累计同一 <video>，会给没在看的视频误触发摘要（真实 LLM 成本）。 */
let watchSession: WatchSession | null = null;
let watchGen = 0;

async function startWatcher(bvid: string | null): Promise<void> {
  const gen = ++watchGen;
  watchSession?.dispose();
  watchSession = null;
  if (!bvid) return;
  try {
    const r = (await browser.runtime.sendMessage({
      type: 'VIDEO_ENTER',
      bvid,
      url: location.href,
    })) as {
      ok: boolean;
      videoKey?: string;
      duration?: number;
      triggerSeconds?: number;
    } | undefined;
    if (gen !== watchGen) return; // 等待期间已切走：过期应答作废
    if (!r?.ok || !r.videoKey) return;
    const { videoKey, duration = 0, triggerSeconds = 20 } = r;
    watchSession = new WatchSession({
      videoKey,
      durationSec: duration,
      thresholdSec: triggerSeconds,
      onTick: (p) => {
        void browser.runtime.sendMessage({ type: 'WATCH_TICK', ...p }).catch(() => {});
      },
      onTrigger: (p) => {
        void browser.runtime.sendMessage({ type: 'TRIGGER_SUMMARY', ...p }).catch(() => {});
      },
    });
  } catch {
    /* background 未就绪时静默，下次路由变化重试 */
  }
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
