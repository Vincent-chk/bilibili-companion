// P1.2 · 有效观看计时（纯逻辑，无 DOM；DOM 绑定见 dom.ts）。
// 规则（架构 §3.1 / 验收 F2）：有效观看 = 前台 && 播放中 的媒体时间增量；
// seek/倍速跳变（步长 >2s 或回退）不计入；阈值触发在本实例内幂等，跨页面刷新的
// 会话级幂等由 background 依 visits.triggered 判定（刷新/重进不重触发、不重复调 LLM）。

export interface WatchTickPayload {
  videoKey: string;
  watchedSeconds: number;
  progressPct: number;
}

export interface WatchTriggerPayload {
  videoKey: string;
}

export interface WatchTrackerOptions {
  videoKey: string;
  durationSec: number;
  thresholdSec: number;
  onTick: (p: WatchTickPayload) => void;
  onTrigger: (p: WatchTriggerPayload) => void;
  /** 节流用墙钟（ms），测试注入；默认 Date.now。 */
  now?: () => number;
}

/** WATCH_TICK 上报节流（协议 §3：每秒节流）。 */
export const WATCH_TICK_MIN_INTERVAL_MS = 1000;
/** 单次 timeupdate 允许计入的最大媒体步长（秒）：超过视为 seek/跳集，不计有效观看。 */
const MAX_STEP_SEC = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class WatchTracker {
  #playing = false;
  #visible = true;
  #watchedMs = 0;
  #lastMediaSec: number | null = null;
  #currentSec = 0;
  #triggered = false;
  #lastTickWallMs = -Infinity;
  readonly #now: () => number;

  constructor(private readonly o: WatchTrackerOptions) {
    this.#now = o.now ?? Date.now;
  }

  get watchedSeconds(): number {
    return Math.floor(this.#watchedMs / 1000);
  }

  get triggered(): boolean {
    return this.#triggered;
  }

  get progressPct(): number {
    if (!this.o.durationSec) return 0;
    return clamp(Math.round((this.#currentSec / this.o.durationSec) * 100), 0, 100);
  }

  setPlaying(playing: boolean): void {
    this.#playing = playing;
    if (!playing) this.#lastMediaSec = null; // 重基线：暂停期间拖进度条不被计入
  }

  setVisible(visible: boolean): void {
    this.#visible = visible;
  }

  /** timeupdate（≈4Hz）喂入媒体当前时间。 */
  onMediaTime(sec: number): void {
    this.#currentSec = sec;
    if (this.#playing && this.#visible) {
      const last = this.#lastMediaSec;
      this.#lastMediaSec = sec;
      if (last !== null) {
        const step = sec - last;
        if (step > 0 && step <= MAX_STEP_SEC) this.#watchedMs += step * 1000;
      }
    } else {
      this.#lastMediaSec = null; // 非有效观看期间只刷进度，不累计（恢复时重基线）
    }
    this.#maybeTick();
    this.#maybeTrigger();
  }

  #maybeTick(): void {
    const t = this.#now();
    if (t - this.#lastTickWallMs < WATCH_TICK_MIN_INTERVAL_MS) return;
    this.#lastTickWallMs = t;
    this.o.onTick({
      videoKey: this.o.videoKey,
      watchedSeconds: this.watchedSeconds,
      progressPct: this.progressPct,
    });
  }

  #maybeTrigger(): void {
    if (this.#triggered || this.#watchedMs < this.o.thresholdSec * 1000) return;
    this.#triggered = true;
    this.o.onTrigger({ videoKey: this.o.videoKey });
  }
}
