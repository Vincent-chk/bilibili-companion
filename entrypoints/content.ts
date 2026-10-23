// content script：Phase 0 骨架（0.3）+ P1.2 watcher + P1.5 面板 + P1.6 豆包 + P1.7 onboarding。
// 职责：识别当前页 bvid → Shadow DOM 挂豆包 + 面板 → SPA 路由变化重新识别
//       → watcher 有效观看计时（20s 触发 / WATCH_TICK 节流上报，经 runtime 消息走 background）。
// UI：单一 Shadow 宿主（doubao-ui-root）；豆包（五表情状态机/气泡/拖拽/点击开合）+ 面板（列表/详情）+ onboarding 弹窗。
// 会话：开始/结束陪看走 SESSION_START/END（最小切片，完整保留期状态机是任务 2.1）；
//       未配置 LLM → NEED_ONBOARDING → onboarding 配置门槛（LLM 必填+测试连接+ASR 可选+TTS 置灰）。
import { browser } from 'wxt/browser';
import type { PublicPath } from 'wxt/browser';
import { Bridge, type UiEvent } from '../src/content/bridge';
import { MascotController } from '../src/content/mascot/mascot';
import type { UiSessionState } from '../src/content/mascot/logic';
import { openOnboarding } from '../src/content/onboarding/onboarding';
import { PanelController } from '../src/content/panel/panel';
import { mountDoubaoUi, toast } from '../src/content/ui/root';
import { WatchSession } from '../src/content/watcher/dom';

let mascot: MascotController | null = null;

export default defineContentScript({
  matches: ['*://www.bilibili.com/*'],
  runAt: 'document_idle',
  main() {
    const ui = mountDoubaoUi();
    let panel: PanelController | null = null;

    const requestSessionStart = async (): Promise<void> => {
      try {
        const r = await bridge.request<{ ok: boolean; reason?: string }>({ type: 'SESSION_START' });
        if (r?.ok) return; // 表情/气泡/头部按钮由 SESSION_STATE 广播统一驱动（跨标签页一致）
        if (r?.reason === 'NEED_ONBOARDING') {
          // F1/F9：未配置 LLM 强制引导，无法跳过（关闭弹窗=保持未激活）
          openOnboarding({
            ui,
            assetUrl: (p) => browser.runtime.getURL(p as PublicPath),
            testConnection: (cfg) =>
              bridge.request<{ ok: boolean; msg: string }>({ type: 'TEST_CONNECTION', llm: cfg }),
            save: (payload) => bridge.request<{ ok: boolean; error?: string }>({ type: 'SETTINGS_SAVE', ...payload }),
            onDismiss: () => toast(ui, '配置好 LLM 后随时点我开始陪看'),
            onSaved: () => void requestSessionStart(), // 配置已就绪，激活必成
          });
        }
      } catch {
        toast(ui, '激活失败，稍后再试');
      }
    };
    const requestSessionEnd = async (): Promise<void> => {
      try {
        await bridge.request({ type: 'SESSION_END' });
      } catch {
        /* SW 未就绪：忽略，重试成本低 */
      }
    };

    const bridge = new Bridge((e: UiEvent) => {
      panel?.handleEvent(e);
      if (e.type === 'SESSION_STATE' && e.state) mascot?.setSessionState(e.state as UiSessionState);
      // 记完/失败的表情反馈只在激活期（睡觉时不吵醒，F3 克制语义）
      if (mascot?.session === 'ACTIVE') {
        if (e.type === 'SUMMARY_DONE') {
          mascot.pulse('happy', 9000);
          void mascot.say('写完啦！点我看笔记 📖', 9000);
        } else if (e.type === 'SUMMARY_FAILED') {
          void mascot.say('有个视频没记完…点开看看');
        }
      }
    });

    mascot = new MascotController({
      ui,
      assetUrl: (p) => browser.runtime.getURL(p as PublicPath),
      storage: {
        get: async <T>(key: string) => ((await browser.storage.local.get(key)) as Record<string, T>)[key],
        set: (key, value) => browser.storage.local.set({ [key]: value }),
      },
      onBodyClickActive: () => panel?.toggle(),
      onStartClick: () => void requestSessionStart(),
      bubblesEnabled: async () =>
        ((await browser.storage.local.get('settings'))['settings'] as { bubbles?: boolean } | undefined)?.bubbles !==
        false,
    });

    panel = new PanelController({
      ui,
      bridge,
      onSessionStart: () => void requestSessionStart(),
      onSessionEnd: () => void requestSessionEnd(),
    });

    bridge.connect(); // 连接后 SW 回放 SESSION_STATE → 豆包按当前会话态初始化表情/气泡

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
        // 首次真实触发（去重后）→ 豆包 note 态 + 气泡（F2）；deduped=幂等重放不打扰
        void browser.runtime
          .sendMessage({ type: 'TRIGGER_SUMMARY', ...p })
          .then((r2) => {
            const res = r2 as { ok?: boolean; deduped?: boolean } | undefined;
            if (res?.ok && !res.deduped && mascot?.session === 'ACTIVE') {
              mascot.setState('note');
              void mascot.say('开始偷偷记笔记啦～', 4200);
            }
          })
          .catch(() => {});
      },
    });
  } catch {
    /* background 未就绪时静默，下次路由变化重试 */
  }
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
