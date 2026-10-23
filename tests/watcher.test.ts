// P1.2 · watcher 单测：有效观看计时（前台+播放中）、seek 跳变不计、暂停/后台重基线、
// 20s 阈值幂等触发、WATCH_TICK 1Hz 节流、进度百分比。配套 pickPage 多 P 选页。
import { describe, expect, it } from 'vitest';
import { WatchTracker, type WatchTickPayload, type WatchTriggerPayload } from '../src/content/watcher/tracker';
import { pickPage } from '../src/lib/bilibili/client';

function mkTracker(opts: { thresholdSec?: number; durationSec?: number; now?: () => number } = {}) {
  const ticks: WatchTickPayload[] = [];
  const triggers: WatchTriggerPayload[] = [];
  let clock = 0;
  const t = new WatchTracker({
    videoKey: 'BV1x:111',
    durationSec: opts.durationSec ?? 600,
    thresholdSec: opts.thresholdSec ?? 20,
    now: opts.now ?? (() => clock),
    onTick: (p) => ticks.push(p),
    onTrigger: (p) => triggers.push(p),
  });
  return {
    t,
    ticks,
    triggers,
    tick: (sec: number) => t.onMediaTime(sec),
    advanceClock: (ms: number) => {
      clock += ms;
    },
    play: () => t.setPlaying(true),
    pause: () => t.setPlaying(false),
    show: () => t.setVisible(true),
    hide: () => t.setVisible(false),
  };
}

/** 以 1s 步长喂 n 秒媒体时间；首个 tick 只建立基线（真实 timeupdate 持续喂入，语义一致）。 */
const feed = (w: ReturnType<typeof mkTracker>, from: number, n: number) => {
  w.tick(from);
  for (let i = 1; i <= n; i++) w.tick(from + i);
};

describe('有效观看计时', () => {
  it('播放+前台累计；暂停不累计', () => {
    const w = mkTracker();
    w.play();
    feed(w, 0, 10);
    expect(w.t.watchedSeconds).toBe(10);
    w.pause();
    feed(w, 10, 30); // 暂停期间 timeupdate（理论上不来，防御性喂入）
    expect(w.t.watchedSeconds).toBe(10);
  });

  it('后台标签页不累计（有效观看=前台+播放中，F2）', () => {
    const w = mkTracker();
    w.play();
    feed(w, 0, 5);
    w.hide();
    feed(w, 5, 60);
    expect(w.t.watchedSeconds).toBe(5);
    w.show();
    feed(w, 65, 5); // 回前台后首个 tick 只建基线，其后正常累计
    expect(w.t.watchedSeconds).toBe(10);
  });

  it('seek 前跳/回退不计入；暂停期间 seek 恢复播放不计间隙', () => {
    const w = mkTracker();
    w.play();
    feed(w, 0, 5);
    expect(w.t.watchedSeconds).toBe(5);
    w.tick(120); // +115s 跳变：不计
    expect(w.t.watchedSeconds).toBe(5);
    w.tick(118); // 回退：不计
    expect(w.t.watchedSeconds).toBe(5);
    w.pause();
    w.tick(300); // 暂停中拖到 300s
    w.play();
    w.tick(301); // 恢复播放首 tick 只建基线
    w.tick(302);
    expect(w.t.watchedSeconds).toBe(6); // 仍只含恢复后的 1s
  });

  it('progressPct 按媒体时间/时长计算并夹取 0-100', () => {
    const w = mkTracker({ durationSec: 200 });
    w.play();
    w.tick(100);
    expect(w.t.progressPct).toBe(50);
    w.tick(199);
    expect(w.t.progressPct).toBe(100);
    w.tick(1); // 回退到开头
    expect(w.t.progressPct).toBe(1); // 四舍五入
    const zero = mkTracker({ durationSec: 0 });
    zero.play();
    zero.tick(10);
    expect(zero.t.progressPct).toBe(0); // 时长未知不除零
  });
});

describe('20s 阈值触发（F2）', () => {
  it('累计达阈值触发一次，之后不再触发（实例内幂等）', () => {
    const w = mkTracker({ thresholdSec: 20 });
    w.play();
    feed(w, 0, 19);
    expect(w.triggers).toHaveLength(0);
    feed(w, 19, 1); // 第 20 秒
    expect(w.triggers).toEqual([{ videoKey: 'BV1x:111' }]);
    feed(w, 20, 40);
    expect(w.triggers).toHaveLength(1);
  });

  it('阈值可配（设置 triggerSeconds）', () => {
    const w = mkTracker({ thresholdSec: 60 });
    w.play();
    feed(w, 0, 59);
    expect(w.triggers).toHaveLength(0);
    feed(w, 59, 1);
    expect(w.triggers).toHaveLength(1);
  });

  it('暂停离开后再回来，累计跨时段继续（19s+1s 触发）', () => {
    const w = mkTracker({ thresholdSec: 20 });
    w.play();
    feed(w, 0, 19);
    w.pause();
    feed(w, 19, 300);
    w.play();
    w.tick(320); // 基线
    w.tick(321); // +1s → 满 20
    expect(w.triggers).toHaveLength(1);
    expect(w.t.watchedSeconds).toBe(20);
  });
});

describe('WATCH_TICK 节流（协议 §3：每秒节流）', () => {
  it('1s 内多次媒体事件只上报一次；跨秒再次上报；载荷字段齐备', () => {
    const w = mkTracker();
    w.play();
    // timeupdate ≈4Hz：0.25s 步长喂 4 次（墙钟同 1s 内）。首个 tick 是基线（累计 0）
    for (const s of [0.25, 0.5, 0.75, 1.0]) w.tick(s);
    expect(w.ticks).toHaveLength(1);
    expect(w.ticks[0]).toMatchObject({ videoKey: 'BV1x:111', watchedSeconds: 0, progressPct: 0 });
    w.advanceClock(1000);
    w.tick(1.25);
    expect(w.ticks).toHaveLength(2);
    expect(w.ticks[1]!.watchedSeconds).toBe(1); // 0.75 + 0.25 = 1s
  });
});

describe('pickPage 多 P 选页', () => {
  const pages = [
    { cid: 111, page: 1, part: 'p1' },
    { cid: 222, page: 2, part: 'p2' },
  ];
  it('?p=2 取第二 P；无 p / 越界回退第 1P；空 pages 返回 undefined', () => {
    expect(pickPage(pages, 2)?.cid).toBe(222);
    expect(pickPage(pages, null)?.cid).toBe(111);
    expect(pickPage(pages, 99)?.cid).toBe(111);
    expect(pickPage([], 1)).toBeUndefined();
  });
});
