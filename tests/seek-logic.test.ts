// P1.8 · 大纲 seek 纯逻辑单测：URL 构造 / 标签页匹配 / 候选挑选 / 广播消费判定（审查 P1-2）。
import { describe, expect, it } from 'vitest';
import { buildVideoUrl, pickSeekTab, shouldConsumeSeek, tabMatchesVideo } from '../src/content/seek';

describe('buildVideoUrl', () => {
  it('单 P：省略 p，t 取整秒', () => {
    expect(buildVideoUrl('BV1XynB6EEiM', 1, 125)).toBe('https://www.bilibili.com/video/BV1XynB6EEiM/?t=125');
  });
  it('多 P：带 p 参数', () => {
    expect(buildVideoUrl('BV1h7pteyEww', 3, 60)).toBe('https://www.bilibili.com/video/BV1h7pteyEww/?p=3&t=60');
  });
  it('负数钳 0、小数向下取整', () => {
    expect(buildVideoUrl('BV1XynB6EEiM', 1, -5)).toBe('https://www.bilibili.com/video/BV1XynB6EEiM/?t=0');
    expect(buildVideoUrl('BV1XynB6EEiM', 1, 90.7)).toBe('https://www.bilibili.com/video/BV1XynB6EEiM/?t=90');
  });
});

describe('tabMatchesVideo', () => {
  const bvid = 'BV1XynB6EEiM';
  it('标准视频页（无 p）= 第 1 分P', () => {
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/`, bvid, 1)).toBe(true);
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}`, bvid, 1)).toBe(true);
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/?p=1&t=30`, bvid, 1)).toBe(true);
  });
  it('分 P 精确匹配', () => {
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/?p=2`, bvid, 2)).toBe(true);
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/?p=2`, bvid, 1)).toBe(false);
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/`, bvid, 2)).toBe(false);
  });
  it('bvid 不同不匹配', () => {
    expect(tabMatchesVideo(`https://www.bilibili.com/video/BV1DUnB61ErU/`, bvid, 1)).toBe(false);
  });
  it('非视频页/空/畸形 URL 不匹配且不抛', () => {
    expect(tabMatchesVideo('https://www.bilibili.com/', bvid, 1)).toBe(false);
    expect(tabMatchesVideo('https://www.bilibili.com/bangumi/play/ep123', bvid, 1)).toBe(false);
    expect(tabMatchesVideo(undefined, bvid, 1)).toBe(false);
    expect(tabMatchesVideo('not-a-url', bvid, 1)).toBe(false);
    expect(tabMatchesVideo('chrome://extensions/', bvid, 1)).toBe(false);
  });
  it('带 hash/额外 query 仍匹配', () => {
    expect(tabMatchesVideo(`https://www.bilibili.com/video/${bvid}/?spm_id_from=333.788&vd_source=x#tag`, bvid, 1)).toBe(true);
  });
});

describe('pickSeekTab', () => {
  const bvid = 'BV1XynB6EEiM';
  it('挑第一个 bvid+分P 匹配的标签页', () => {
    const tabs = [
      { id: 1, windowId: 1, url: 'https://www.bilibili.com/' },
      { id: 2, windowId: 1, url: `https://www.bilibili.com/video/${bvid}/?p=2` },
      { id: 3, windowId: 2, url: `https://www.bilibili.com/video/${bvid}/` },
    ];
    expect(pickSeekTab(tabs, bvid, 1)).toEqual(tabs[2]);
    expect(pickSeekTab(tabs, bvid, 2)).toEqual(tabs[1]);
  });
  it('无匹配返回 null；无 id 的候选被跳过', () => {
    expect(pickSeekTab([{ id: 1, url: 'https://www.bilibili.com/' }], bvid, 1)).toBeNull();
    expect(
      pickSeekTab([{ url: `https://www.bilibili.com/video/${bvid}/` }], bvid, 1),
      '缺 id（如 devtools 目标）不可用作 seek 目标',
    ).toBeNull();
  });
  it('非 www 主机名不匹配（m. 等子域无 content 消费方，审查 P2-2）', () => {
    expect(tabMatchesVideo(`https://m.bilibili.com/video/${bvid}/`, bvid, 1)).toBe(false);
    expect(tabMatchesVideo(`https://space.bilibili.com/video/${bvid}/`, bvid, 1)).toBe(false);
  });
  it('liveTabIds 过滤：孤儿标签（URL 匹配但无活端口）不入选 → null 让调用方落 new-tab（记账项收口）', () => {
    const tabs = [{ id: 3, windowId: 2, url: `https://www.bilibili.com/video/${bvid}/` }];
    expect(pickSeekTab(tabs, bvid, 1, new Set([3]))).toEqual(tabs[0]);
    expect(pickSeekTab(tabs, bvid, 1, new Set([9]))).toBeNull();
    expect(pickSeekTab(tabs, bvid, 1, new Set())).toBeNull();
    expect(pickSeekTab(tabs, bvid, 1), '省略 liveTabIds = 不过滤（旧行为）').toEqual(tabs[0]);
  });
});

describe('shouldConsumeSeek（审查 P1-1/P1-2：广播消费判定）', () => {
  const bvid = 'BV1XynB6EEiM';
  const key1 = `${bvid}:111`;
  const key2 = `${bvid}:222`; // 同 bvid 另一分P
  const href1 = `https://www.bilibili.com/video/${bvid}/`;
  const href2 = `https://www.bilibili.com/video/${bvid}/?p=2`;

  it('currentVideoKey 精确匹配即消费（与 href 无关）', () => {
    expect(shouldConsumeSeek({ videoKey: key1, time: 60 }, key1, 'https://www.bilibili.com/')).toBe(true);
    expect(shouldConsumeSeek({ videoKey: key2, time: 60 }, key1, href1)).toBe(false);
  });
  it('currentVideoKey 为 null 时退 URL 判定：同 bvid 同分P 消费', () => {
    expect(shouldConsumeSeek({ videoKey: key1, time: 60, page: 1 }, null, href1)).toBe(true);
    expect(shouldConsumeSeek({ videoKey: key2, time: 60, page: 2 }, null, href2)).toBe(true);
  });
  it('currentVideoKey 为 null 且同 bvid 异分P 不消费（P1-1 误 seek 回归）', () => {
    // p=1 页收到对 p=2 的广播：无 page 字段按 1 处理仍不匹配 p=2 目标；带 page 更不匹配
    expect(shouldConsumeSeek({ videoKey: key2, time: 60, page: 2 }, null, href1)).toBe(false);
    expect(shouldConsumeSeek({ videoKey: key1, time: 60, page: 1 }, null, href2)).toBe(false);
  });
  it('畸形/缺字段广播不消费', () => {
    expect(shouldConsumeSeek({ videoKey: key1 }, key1, href1), '缺 time').toBe(false);
    expect(shouldConsumeSeek({ videoKey: key1, time: Number.NaN }, key1, href1), 'NaN time').toBe(false);
    expect(shouldConsumeSeek({ time: 60 }, key1, href1), '缺 videoKey').toBe(false);
    expect(shouldConsumeSeek({ videoKey: 'nocolon', time: 60 }, null, href1), 'videoKey 无 cid 分隔').toBe(false);
  });
});
