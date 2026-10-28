// P1.2 · watcher 的 DOM 绑定：找 <video>、挂事件、喂 WatchTracker；SPA 切视频由
// content 入口 dispose 旧会话再新建（架构 §3.2：选择器多路兜底，不依赖 B 站容器结构）。
import { WatchTracker, type WatchTickPayload, type WatchTriggerPayload } from './tracker';

export interface WatchSessionOptions {
  videoKey: string;
  durationSec: number;
  thresholdSec: number;
  onTick: (p: WatchTickPayload) => void;
  onTrigger: (p: WatchTriggerPayload) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 多路选择器：播放器容器内 video 优先，退而求其次页面首个 video（预览小窗不在容器内时防误绑）。 */
export function findVideoElement(doc: Document = document): HTMLVideoElement | null {
  return (
    doc.querySelector<HTMLVideoElement>('.bpx-player-video-area video') ??
    doc.querySelector<HTMLVideoElement>('video')
  );
}

async function waitForVideoElement(timeoutMs = 15_000): Promise<HTMLVideoElement | null> {
  const t0 = Date.now();
  for (;;) {
    const v = findVideoElement();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(300);
  }
}

/** 挂事件到 video 元素并喂 tracker；返回解绑函数。绑定时对齐一次当前播放/可见状态。 */
export function bindVideo(video: HTMLVideoElement, t: WatchTracker): () => void {
  const onPlay = () => t.setPlaying(true);
  const onStop = () => t.setPlaying(false);
  const onTime = () => t.onMediaTime(video.currentTime);
  const onVis = () => t.setVisible(document.visibilityState === 'visible');

  video.addEventListener('play', onPlay);
  video.addEventListener('playing', onPlay);
  video.addEventListener('pause', onStop);
  video.addEventListener('ended', onStop);
  video.addEventListener('timeupdate', onTime);
  document.addEventListener('visibilitychange', onVis);

  t.setPlaying(!video.paused && !video.ended);
  t.setVisible(document.visibilityState === 'visible');

  return () => {
    video.removeEventListener('play', onPlay);
    video.removeEventListener('playing', onPlay);
    video.removeEventListener('pause', onStop);
    video.removeEventListener('ended', onStop);
    video.removeEventListener('timeupdate', onTime);
    document.removeEventListener('visibilitychange', onVis);
    t.setPlaying(false); // 切页/解绑时上报最后确认的前台观看，按 watchId 幂等合并
  };
}

/** 一次视频的陪看会话：等 video 就绪 → 建 tracker → 绑定；dispose 可在等待期打断。 */
export class WatchSession {
  #disposed = false;
  #unbind: (() => void) | null = null;

  constructor(private readonly o: WatchSessionOptions) {
    void this.#start();
  }

  async #start(): Promise<void> {
    const video = await waitForVideoElement();
    if (this.#disposed || !video) return;
    const tracker = new WatchTracker({
      videoKey: this.o.videoKey,
      watchId: crypto.randomUUID(),
      durationSec: this.o.durationSec,
      thresholdSec: this.o.thresholdSec,
      onTick: this.o.onTick,
      onTrigger: this.o.onTrigger,
    });
    this.#unbind = bindVideo(video, tracker);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const unbind = this.#unbind;
    this.#unbind = null;
    unbind?.();
  }
}
