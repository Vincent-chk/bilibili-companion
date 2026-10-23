// P1.8 · 大纲 seek 纯逻辑（无 DOM/browser 依赖，单测覆盖）：
// 目标视频 URL 构造（B 站原生 t= 秒参数）、标签页 URL 与 bvid+分P 的匹配、候选标签页挑选。
// 路由决策（同页本地 seek / 跨标签页聚焦 / 新开标签页）见 content.ts handleSeekRequest 与
// background handleSeekTo——本模块只提供其中可测的判定函数。

/** 视频页 URL：t=秒为 B 站原生起播参数（新标签页路径靠它免消息直达时间点）；p=1 省略。 */
export function buildVideoUrl(bvid: string, page: number, timeSec: number): string {
  const t = Math.max(0, Math.floor(timeSec));
  const p = page > 1 ? `p=${page}&` : '';
  return `https://www.bilibili.com/video/${bvid}/?${p}t=${t}`;
}

/**
 * 标签页 URL 是否为指定 bvid+分P 的视频页。
 * p 缺省=第 1 分P；非视频页（首页/番剧等）一律不匹配。畸形 URL 返回 false，不抛。
 * hostname 限定 www：content script 仅注入 www.bilibili.com（m. 等子域匹配了也无消费方，
 * 聚焦后静默失败且不回退 new-tab——审查 P2-2）。
 */
export function tabMatchesVideo(url: string | undefined, bvid: string, page: number): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname !== 'www.bilibili.com') return false;
  const m = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/);
  if (!m || m[1] !== bvid) return false;
  const p = Number(u.searchParams.get('p')) || 1;
  return p === page;
}

/**
 * SEEK_TO 广播是否由本页消费（审查 P1-1/P1-2 抽出的纯判定）：
 * ① currentVideoKey 非空时精确匹配（VIDEO_ENTER 应答为权威，含 cid，多 P 不误伤）；
 * ② currentVideoKey 为 null（VIDEO_ENTER 未成功/应答在途）时退 URL 判定——
 *    必须带分P（background 按 bvid+page 选中本页、广播携带同一 page），
 *    否则同 bvid 异分P 的隐藏页会被误 seek（P1-1）。
 */
export function shouldConsumeSeek(
  e: { videoKey?: string; time?: number; page?: number },
  currentVideoKey: string | null,
  href: string,
): boolean {
  if (!e.videoKey || typeof e.time !== 'number' || !Number.isFinite(e.time)) return false;
  if (currentVideoKey !== null) return e.videoKey === currentVideoKey;
  const bvid = e.videoKey.slice(0, e.videoKey.lastIndexOf(':'));
  return !!bvid && tabMatchesVideo(href, bvid, e.page ?? 1);
}

export interface SeekTabCandidate {
  id?: number;
  windowId?: number;
  url?: string;
}

/** 候选标签页中挑第一个匹配的视频页（tabs.query 结果；无 host 权限的标签页 url 为 undefined，天然被滤掉）。 */
export function pickSeekTab(
  tabs: SeekTabCandidate[],
  bvid: string,
  page: number,
): SeekTabCandidate | null {
  return tabs.find((t) => t.id !== undefined && tabMatchesVideo(t.url, bvid, page)) ?? null;
}
