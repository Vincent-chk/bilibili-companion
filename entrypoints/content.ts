// content script：Phase 0 骨架（0.3）+ P1.2 watcher + P1.5 面板/共享 UI 层。
// 职责：识别当前页 bvid → Shadow DOM 挂豆包 + 面板 → SPA 路由变化重新识别
//       → watcher 有效观看计时（20s 触发 / WATCH_TICK 节流上报，经 runtime 消息走 background）。
// P1.5：单一 Shadow 宿主（doubao-ui-root）承载 mascot/panel/modal/toast；豆包点击开合面板；
//       Port（doubao-port）接收 SUMMARY_* 推送驱动面板流式/刷新。
// P1.6 将把此处占位豆包升级为完整状态机模块（src/content/mascot）。
import { browser } from 'wxt/browser';
import { Bridge } from '../src/content/bridge';
import { PanelController } from '../src/content/panel/panel';
import { mountDoubaoUi } from '../src/content/ui/root';
import { WatchSession } from '../src/content/watcher/dom';

export default defineContentScript({
  matches: ['*://www.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    const ui = mountDoubaoUi();
    let panel: PanelController | null = null;
    const bridge = new Bridge((e) => panel?.handleEvent(e));
    bridge.connect();
    panel = new PanelController({ ui, bridge });
    mountMascotPlaceholder(ui, () => panel?.toggle());

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

/**
 * P1.5 豆包占位（进 ui root；点击开合面板）。position:fixed 不参与文档流（浮层准则 #7）。
 * 默认位参考原型：右下区域、避开播放器控件；气泡头顶空间预留。P1.6 换完整模块（状态机/气泡/拖拽）。
 */
function mountMascotPlaceholder(ui: ReturnType<typeof mountDoubaoUi>, onClick: () => void): void {
  const wrap = ui.root.getElementById('mascot-wrap');
  const img = ui.root.querySelector<HTMLImageElement>('#mascot-img');
  if (!wrap || !img) return;
  wrap.classList.remove('hidden');
  wrap.style.left = `${Math.max(20, window.innerWidth - 380)}px`;
  wrap.style.top = `${Math.max(170, window.innerHeight - 280)}px`;
  img.src = browser.runtime.getURL('/mascot/mascot-idle.png');
  ui.root.getElementById('mascot')?.addEventListener('click', () => onClick());
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
