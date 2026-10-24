// content script：Phase 0 骨架（0.3）+ P1.2 watcher + P1.5 面板 + P1.6 豆包 + P1.7 onboarding + P1.8 seek。
// 职责：识别当前页 bvid → Shadow DOM 挂豆包 + 面板 → SPA 路由变化重新识别
//       → watcher 有效观看计时（20s 触发 / WATCH_TICK 节流上报，经 runtime 消息走 background）。
// UI：单一 Shadow 宿主（doubao-ui-root）；豆包（五表情状态机/气泡/拖拽/点击开合）+ 面板（列表/详情）+ onboarding 弹窗。
// 会话：开始/结束陪看走 SESSION_START/END（最小切片，完整保留期状态机是任务 2.1）；
//       未配置 LLM → NEED_ONBOARDING → onboarding 配置门槛（LLM 必填+测试连接+ASR 可选+TTS 置灰）。
// seek（P1.8）：面板大纲/转写点击 → 同页本地 seek；异页 SEEK_TO 走 background（聚焦已有标签页或新开 t= 直达）。
import { browser } from 'wxt/browser';
import type { PublicPath } from 'wxt/browser';
import { Bridge, type UiEvent } from '../src/content/bridge';
import { MascotController } from '../src/content/mascot/mascot';
import type { UiSessionState } from '../src/content/mascot/logic';
import { openOnboarding } from '../src/content/onboarding/onboarding';
import { PanelController } from '../src/content/panel/panel';
import { clockOf, fmtSec } from '../src/content/panel/view-models';
import { LOGIN_BUBBLE_TEXT, loginBubble } from '../src/content/login';
import { shouldConsumeSeek } from '../src/content/seek';
import { setupFullscreenMigration } from '../src/content/ui/fullscreen';
import { mountDoubaoUi, toast } from '../src/content/ui/root';
import { WatchSession, findVideoElement } from '../src/content/watcher/dom';

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
        if (r?.reason === 'EXPIRED_CONFIRM') {
          // P2.1：超期待确认期不开新会话（旧数据须先经确认链路处置）→ 引导到面板
          panel?.open();
          toast(ui, '上次陪看数据已超保留期，请先在面板中确认处理');
          return;
        }
        if (r?.reason === 'NEED_ONBOARDING') {
          // F1/F9：未配置 LLM 强制引导，无法跳过（关闭弹窗=保持未激活）
          openOnboarding({
            ui,
            assetUrl: (p) => browser.runtime.getURL(p as PublicPath),
            testConnection: (cfg, kind) =>
              bridge.request<{ ok: boolean; msg: string }>({ type: 'TEST_CONNECTION', kind, llm: cfg }),
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
        // P2.1：结束成功 toast 倒计时口径（原型同文案；只在发起结束的标签页提示）
        const r = await bridge.request<{ ok: boolean; retainUntil?: number }>({ type: 'SESSION_END' });
        if (r?.ok && r.retainUntil) {
          toast(ui, `已结束陪看，数据保留 1 小时（至 ${clockOf(r.retainUntil)}）`, 3200);
        }
      } catch {
        /* SW 未就绪：忽略，重试成本低 */
      }
    };

    const bridge = new Bridge((e: UiEvent) => {
      // P1.8：跨标签页 SEEK_TO 广播——只给「目标视频页」消费（判定纯函数见 seek.shouldConsumeSeek：
      // currentVideoKey 精确匹配优先；为 null 时退 URL bvid+分P 匹配，审查 P1-1 后兜底也带分P）。
      if (e.type === 'SEEK_TO' && shouldConsumeSeek(e, currentVideoKey, location.href)) {
        applyLocalSeek(e.time ?? 0);
        return;
      }
      panel?.handleEvent(e);
      if (e.type === 'SESSION_STATE' && e.state) {
        uiSessionState = e.state;
        mascot?.setSessionState(e.state as UiSessionState);
        // P2.5：隐藏豆包只在陪看会话内生效——回 INACTIVE 自动解除（激活入口必须可见）
        if (e.state === 'INACTIVE' && mascotHidden) {
          mascotHidden = false;
          mascot?.setHidden(false);
        }
        // P1.10 时机：激活/恢复后复核登录态（force 绕缓存）
        if (e.state === 'ACTIVE') void requestLoginCheck(1);
      }
      // P1.10：登录态翻转 → 气泡（未登录激活=login 限频 kind；翻正=welcome）；引导卡由面板自管
      if (e.type === 'LOGIN_STATE') applyLoginState(e.loggedIn ?? null);
      // 记完/失败的表情反馈只在激活期（睡觉时不吵醒，F3 克制语义）；
      // kind 供 P1.9 准则#4 同类气泡 10min 限频（连看多视频不轰炸）
      if (mascot?.session === 'ACTIVE') {
        if (e.type === 'SUMMARY_DONE') {
          mascot.pulse('happy', 9000);
          void mascot.say('写完啦！点我看笔记 📖', 9000, 'done');
        } else if (e.type === 'SUMMARY_FAILED') {
          // P2.6 F9/F11：Key 无效专属气泡（带去设置指引）；kind 限频防连败轰炸
          if (e.errorCode === 'KEY_INVALID') {
            void mascot.say('Key 无效了…到设置里检查一下吧', 7000, 'key-invalid');
          } else {
            void mascot.say('有个视频没记完…点开看看', 5000, 'failed');
          }
        }
      }
    });

    // P1.10：登录态应用（纯决策见 login.loginBubble）；prev 只记确定态，未知不覆盖翻转判定
    let prevLoggedIn: boolean | null = null;
    const applyLoginState = (loggedIn: boolean | null): void => {
      const b = loginBubble(loggedIn, prevLoggedIn, mascot?.session === 'ACTIVE');
      if (b === 'login') void mascot?.say(LOGIN_BUBBLE_TEXT.login, 5000, 'login');
      if (b === 'welcome') void mascot?.say(LOGIN_BUBBLE_TEXT.welcome, 4200);
      if (loggedIn !== null) prevLoggedIn = loggedIn;
    };
    const requestLoginCheck = async (force?: number): Promise<void> => {
      try {
        const r = await bridge.request<{ ok: boolean; loggedIn: boolean | null }>({
          type: 'LOGIN_CHECK',
          ...(force === 1 ? { force: 1 } : {}),
        });
        if (r && r.ok) applyLoginState(r.loggedIn);
      } catch {
        /* SW 未就绪：忽略，面板打开/激活时会再探 */
      }
    };

    // P1.8：本页 <video> 落 seek（选择器多路兜底见 watcher/dom.findVideoElement），toast 口径同原型。
    const applyLocalSeek = (timeSec: number): void => {
      const v = findVideoElement();
      if (!v) {
        toast(ui, '未找到视频播放器');
        return;
      }
      const t = Math.max(0, Math.floor(timeSec));
      try {
        v.currentTime = t;
      } catch {
        toast(ui, '跳转失败：播放器尚未就绪');
        return;
      }
      toast(ui, `已跳转到 ${fmtSec(t)}`);
    };

    /** 面板大纲/转写点击入口：同页本地 seek；异页交 background 聚焦已有标签页或新开（t= 参数直达）。 */
    const handleSeekRequest = async (videoKey: string, timeSec: number): Promise<void> => {
      if (videoKey === currentVideoKey) {
        applyLocalSeek(timeSec);
        return;
      }
      try {
        const r = await bridge.request<{ ok: boolean; mode?: string }>({ type: 'SEEK_TO', videoKey, time: timeSec });
        if (r?.ok && r.mode === 'new-tab') toast(ui, `已在新标签页打开并跳转到 ${fmtSec(timeSec)}`);
        // focus-tab：目标页收广播自行 seek+toast，本页即将失焦不重复提示
        if (!r?.ok) toast(ui, '跳转失败，稍后再试');
      } catch {
        toast(ui, '跳转失败，稍后再试');
      }
    };

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

    // P2.5：隐藏豆包（本次会话）——content 内存态（刷新即回归）；开关在设置页。
    // INACTIVE 下忽略隐藏（审查 P2-4：隐藏+关面板=激活入口锁死，唯一自愈是刷新）
    let mascotHidden = false;
    let uiSessionState: string | null = null;

    panel = new PanelController({
      ui,
      bridge,
      onSessionStart: () => void requestSessionStart(),
      onSessionEnd: () => void requestSessionEnd(),
      onSeek: (videoKey, timeSec) => void handleSeekRequest(videoKey, timeSec),
      // P2.3 F6-③：未配置 ASR → onboarding 补配模式（LLM 沿用不重填；保存后回卡片可继续）
      onNeedAsrConfig: () => {
        openOnboarding({
          ui,
          assetUrl: (p2) => browser.runtime.getURL(p2 as PublicPath),
          testConnection: (cfg, kind) =>
            bridge.request<{ ok: boolean; msg: string }>({ type: 'TEST_CONNECTION', kind, llm: cfg }),
          save: (payload) => bridge.request<{ ok: boolean; error?: string }>({ type: 'SETTINGS_SAVE', ...payload }),
          onDismiss: () => toast(ui, '可稍后在设置中配置 ASR'),
          onSaved: () => toast(ui, 'ASR 已配置，回到卡片点【调用 ASR 解析】', 3200),
          asrOnly: true,
        });
      },
      // P2.5/2.7b：当前视频（人设切换联动询问对象）+ 隐藏豆包开关（内存态）
      getCurrentVideoKey: () => currentVideoKey,
      mascotHidden: () => mascotHidden,
      onMascotHiddenChange: (h) => {
        if (h && (uiSessionState ?? 'INACTIVE') === 'INACTIVE') {
          toast(ui, '未激活时豆包需保持可见（这是激活入口）');
          return; // 审查 P2-4：INACTIVE 忽略隐藏
        }
        mascotHidden = h;
        mascot?.setHidden(h);
        if (h) toast(ui, '豆包已隐藏（记录照常），刷新页面或本次陪看数据清除后回归', 3200);
      },
    });

    // P1.9 准则#3：浏览器全屏时把 Shadow 宿主迁入全屏元素子树（退出迁回）
    setupFullscreenMigration(document, ui.host);
    // P1.9 准则#5：VIDEO_ENTER 解析出当前视频后通知面板跟随（startWatcher 在模块层回调）
    onVideoKeyResolved = (videoKey) => panel?.followVideo(videoKey);

    bridge.connect(); // 连接后 SW 回放 SESSION_STATE → 豆包按当前会话态初始化表情/气泡
    void requestLoginCheck(); // P1.10 时机③：content 首连探登录态（引导卡/气泡数据源）

    report(detectBvid(location.href));

    // B 站是 SPA：路由变化不重载页面。主路=SW webNavigation.onHistoryStateUpdated → ROUTE_CHANGED
    // （B 站真 SPA 的 pushState 发生在主世界，content 孤立世界的 history 补丁拦不到——P1.9 E2E 实测）；
    // popstate 与 history 补丁仅作兜底（后退/前进、孤立世界内的调用）。
    // 去重键= bvid+分P（审查 P2-1）：同视频 ?t=/?spm 类 replaceState 不重建 watcher
    // （否则内存 watchedMs 归零、20s 触发被无限推迟）；非视频页按整 URL。
    const routeKey = (href: string): string => {
      const bvid = detectBvid(href);
      if (!bvid) return href;
      try {
        return `${bvid}:p${new URL(href).searchParams.get('p') ?? 1}`;
      } catch {
        return href;
      }
    };
    let lastKey = routeKey(location.href);
    const onRoute = (url?: string) => {
      const href = url ?? location.href;
      const key = routeKey(href);
      if (key === lastKey) return;
      lastKey = key;
      report(detectBvid(href));
    };
    window.addEventListener('popstate', () => onRoute());
    patchHistoryPushState(() => onRoute());
    browser.runtime.onMessage.addListener((m: unknown) => {
      const msg = m as { type?: string; url?: string };
      if (msg?.type !== 'ROUTE_CHANGED' || !msg.url) return undefined;
      console.log('[doubao-poc] route-changed', msg.url); // 去重前原始计数：B 站播放期 replaceState 频度真机观察（验收记录 §5.4）
      onRoute(msg.url);
      return undefined;
    });

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
/** 本页当前视频的 videoKey（VIDEO_ENTER 成功才有值；P1.8 seek 同页判定与广播匹配用）。 */
let currentVideoKey: string | null = null;
/** P1.9 准则#5：main() 注入——VIDEO_ENTER 解析成功后通知面板上下文跟随。 */
let onVideoKeyResolved: ((videoKey: string) => void) | null = null;

async function startWatcher(bvid: string | null): Promise<void> {
  const gen = ++watchGen;
  watchSession?.dispose();
  watchSession = null;
  currentVideoKey = null;
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
    currentVideoKey = videoKey;
    onVideoKeyResolved?.(videoKey); // 准则#5：面板开着则跟随当前视频卡片
    watchSession = new WatchSession({
      videoKey,
      durationSec: duration,
      thresholdSec: triggerSeconds,
      onTick: (p) => {
        void browser.runtime
          .sendMessage({ type: 'WATCH_TICK', ...p })
          .then((r) => {
            // 审查 P2-2：SW 拒收（暂停）→ dispose 本地计时，暂停窗口时长不追溯补记
            if ((r as { ok?: boolean; reason?: string } | undefined)?.reason === 'paused') watchSession?.dispose();
          })
          .catch(() => {});
      },
      onTrigger: (p) => {
        // 首次真实触发（去重后）→ 豆包 note 态 + 气泡（F2）；deduped=幂等重放不打扰
        void browser.runtime
          .sendMessage({ type: 'TRIGGER_SUMMARY', ...p })
          .then((r2) => {
            const res = r2 as { ok?: boolean; deduped?: boolean } | undefined;
            if (res?.ok && !res.deduped && mascot?.session === 'ACTIVE') {
              mascot.setState('note');
              void mascot.say('开始偷偷记笔记啦～', 4200, 'note'); // kind=note：准则#4 限频
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
