// P1.5 · content ↔ background 桥：请求走 runtime.sendMessage（与 VIDEO_ENTER 同通道、
// 平铺字段），B→C 推送走 Port 长连接 doubao-port（runtime.sendMessage 到不了 content script）。
// SW 休眠会掐断 Port：onDisconnect 指数退避重连（架构 §7）。
// 依赖注入便于单测：connect/send 均可替换。
import { browser } from 'wxt/browser';

export type SummaryEventType =
  | 'SUMMARY_PROGRESS'
  | 'SUMMARY_DONE'
  | 'SUMMARY_FAILED'
  | 'SUMMARY_NEED_ASR'
  | 'SUMMARY_UPDATED'
  | 'SEGMENT_NOTE_STREAM'
  | 'SEGMENT_NOTE_DONE'
  | 'SEGMENT_NOTE_FAILED';

export interface UiEvent {
  type: SummaryEventType | 'SESSION_STATE' | 'SEEK_TO' | 'LOGIN_STATE' | 'UPDATE_AVAILABLE' | 'WATCH_SETTINGS';
  paused?: boolean;
  restartWatcher?: boolean;
  updateVersion?: string | null;
  updateRevision?: number;
  videoKey?: string;
  jobId?: string;
  stage?: string;
  progress?: number;
  deltaText?: string;
  state?: string;
  time?: number; // SEEK_TO 目标秒（P1.8）
  page?: number; // SEEK_TO 分P（P1.8 审查 P1-1：URL 兜底匹配须带分P，防同 bvid 异 P 误 seek）
  loggedIn?: boolean | null; // LOGIN_STATE（P1.10）
  segIndex?: number; // SEGMENT_NOTE_*（P1.11）
  text?: string; // SEGMENT_NOTE_DONE 终态文本
  error?: { code: string; msg: string }; // SEGMENT_NOTE_FAILED
  errorCode?: string; // SUMMARY_FAILED（P2.6）：失败码（KEY_INVALID→气泡「去设置」分流）
  errorMsg?: string; // SUMMARY_FAILED（P2.6）：失败文案
  truncated?: boolean; // 超长段截断标注
  closedAt?: number; // SESSION_STATE（P2.1）：GRACE 基准时刻
  retainUntil?: number; // SESSION_STATE（P2.1）：保留截止时刻（面板倒计时数据源）
}

export interface BridgeDeps {
  connectPort: (name: string) => PortLike;
  send: (msg: Record<string, unknown>) => Promise<unknown>;
  setTimeout?: typeof setTimeout;
}

/** browser.runtime.Port 的最小面。 */
export interface PortLike {
  onMessage: { addListener: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect?: () => void;
}

const PORT_NAME = 'doubao-port';

export class Bridge {
  #port: PortLike | null = null;
  #retry = 0;
  #closed = false;
  readonly #deps: BridgeDeps;

  constructor(
    private readonly onEvent: (e: UiEvent) => void,
    deps?: Partial<BridgeDeps>,
  ) {
    this.#deps = {
      connectPort: deps?.connectPort ?? ((name) => browser.runtime.connect({ name }) as unknown as PortLike),
      send: deps?.send ?? ((msg) => browser.runtime.sendMessage(msg)),
      setTimeout: deps?.setTimeout ?? (globalThis.setTimeout.bind(globalThis) as typeof setTimeout),
    };
  }

  connect(): void {
    if (this.#closed || this.#port) return;
    try {
      const port = this.#deps.connectPort(PORT_NAME);
      this.#port = port;
      this.#retry = 0;
      port.onMessage.addListener((msg) => {
        if (this.#port !== port) return;
        const e = msg as UiEvent;
        if (e && typeof e.type === 'string') this.onEvent(e);
      });
      port.onDisconnect.addListener(() => {
        if (this.#port !== port) return;
        this.#port = null;
        this.#reconnect();
      });
    } catch {
      this.#reconnect();
    }
  }

  /** 指数退避重连（600ms 起、×2、封顶 10s）。 */
  #reconnect(): void {
    if (this.#closed || this.#port) return;
    const delay = Math.min(600 * 2 ** this.#retry, 10_000);
    this.#retry += 1;
    this.#deps.setTimeout?.(() => this.connect(), delay);
  }

  request<T = unknown>(msg: Record<string, unknown>): Promise<T> {
    return this.#deps.send(msg) as Promise<T>;
  }

  /** 页面恢复时重连并由后台回放状态；旧连接排队中的消息不再消费。 */
  syncState(): void {
    const previous = this.#port;
    this.#port = null;
    try { previous?.disconnect?.(); } catch { /* 已断开 */ }
    this.connect();
  }
}
