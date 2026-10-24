import { getMixinKey, toSortedQuery, wbiSign, type WbiParams } from './wbi';
import { normalizeSubtitleUrl, type SubtitleTrack } from './track';

const API_BASE = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

// -412 风控 / -352 登录态校验失败（Cookie 过期）/ -101 未登录（00-纪要 §4.2 常见错误码）
const CODE_MESSAGES: Record<number, string> = {
  [-412]: '请求被风控拦截（-412），请降频或稍后重试',
  [-352]: '登录态校验失败（-352），Cookie 可能已过期',
  [-101]: '账号未登录（-101），请先登录 bilibili',
};

export class BiliApiError extends Error {
  constructor(
    readonly code: number,
    readonly api: string,
    message?: string,
  ) {
    super(message ?? `${CODE_MESSAGES[code] ?? `接口返回非零 code ${code}`}（${api}）`);
    this.name = 'BiliApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BiliClientOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  intervalMs?: number;
  /** JSON code -412 / HTTP 412 的熔断等待（对齐 python 版 60s） */
  breakerWaitMs?: number;
  /** 调用方注入的附加请求头（如 Cookie）；扩展真机下浏览器会自动带 Cookie，此参数供测试与兜底注入 */
  extraHeaders?: Record<string, string>;
  /** buvid3 兜底取到指纹 Cookie 后回调，由调用方（background）落地；lib 层不碰 chrome API */
  onCookie?: (cookies: Record<string, string>) => void;
}

interface NavResp {
  code?: number;
  data?: { wbi_img?: { img_url?: string; sub_url?: string }; isLogin?: boolean };
}
interface ViewPage {
  cid: number;
  page: number;
  part: string;
  /** 该 P 时长（秒）。注意 view 顶层 duration 是全部分 P 之和（多 P 视频不可用作单 P 时长）。 */
  duration?: number;
}
interface ViewResp {
  code?: number;
  data?: { aid: number; title: string; duration: number; pic?: string; owner?: { name?: string }; pages?: ViewPage[] };
}
export interface VideoView {
  aid: number;
  cid: number;
  title: string;
  cover: string;
  owner: string;
  duration: number;
  pages: ViewPage[];
}

/** 多 P 选页（架构 §3.3：只取当前 cid）：p 为 1 起始的分 P 号，越界/缺省回退第 1P。 */
export function pickPage(pages: ViewPage[], p: number | null): ViewPage | undefined {
  if (!pages.length) return undefined;
  return pages.find((pg) => pg.page === p) ?? pages[0];
}
interface PlayerV2Resp {
  code?: number;
  data?: { subtitle?: { subtitles?: SubtitleTrack[]; need_login_subtitle?: boolean } };
}
export interface PlayerSubtitles {
  subtitles: SubtitleTrack[];
  needLoginSubtitle: boolean | null;
}
export interface TranscriptCue {
  from: number;
  to: number;
  content: string;
}
interface FingerSpiResp {
  code?: number;
  data?: { b_3?: string; b_4?: string };
}
// P2.3 · playurl DASH 音轨（响应字段驼峰/下划线两种形态都容忍——实测两种都出现过）
interface PlayUrlResp {
  code?: number;
  data?: {
    dash?: {
      audio?: ({
        id?: number;
        bandwidth?: number;
        baseUrl?: string;
        backupUrl?: string[];
        backup_url?: string[];
      })[];
    };
  };
}
export interface DashAudioStream {
  id: number;
  bandwidth: number;
  baseUrl: string;
  backupUrl: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function keyFromUrl(url: string | undefined): string {
  return (url ?? '').split('/').pop()?.split('.')[0] ?? '';
}

export class BiliClient {
  #fetchImpl: FetchLike;
  #timeoutMs: number;
  #intervalMs: number;
  #breakerWaitMs: number;
  #extraHeaders: Record<string, string>;
  #onCookie?: (cookies: Record<string, string>) => void;
  #mixinKey: string | null = null;
  #tLast = -Infinity; // performance.now() 自进程起算，-Infinity 保证首个请求不等待（python monotonic 自开机起等效）
  #fingerCookies: Record<string, string> = {};

  constructor(opts: BiliClientOptions = {}) {
    // 裸存 fetch 引用会在 ServiceWorker 里 Illegal invocation（脱离 globalThis 上下文）——必须 bind
    this.#fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    // ≥5s：57.9h 多 P 课程 view 实测 1.6s（07 报告 §6.1 耗时注），默认 6s
    this.#timeoutMs = opts.timeoutMs ?? 6000;
    this.#intervalMs = opts.intervalMs ?? 800; // 红线 ≤2 req/s
    this.#breakerWaitMs = opts.breakerWaitMs ?? 60_000;
    this.#extraHeaders = opts.extraHeaders ?? {};
    this.#onCookie = opts.onCookie;
  }

  // -- 基础设施 -------------------------------------------------------------
  async #pace(): Promise<void> {
    const wait = this.#intervalMs - (performance.now() - this.#tLast);
    if (wait > 0) await sleep(wait);
    this.#tLast = performance.now();
  }

  #apiHeaders(): Record<string, string> {
    // UA/Referer 对齐 python 版；扩展内 fetch 会忽略受禁头（UA 由浏览器自带），不影响功能
    const h: Record<string, string> = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      ...this.#extraHeaders,
    };
    const finger = Object.entries(this.#fingerCookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const cookie = [this.#extraHeaders['Cookie'] ?? '', finger].filter(Boolean).join('; ');
    if (cookie) h['Cookie'] = cookie;
    return h;
  }

  #requireMixin(): string {
    if (!this.#mixinKey) throw new Error('WBI mixin key 未初始化，请先调用 fetchWbiKeys()');
    return this.#mixinKey;
  }

  /** GET 并解析 JSON。JSON code!=0 / HTTP 412 抛 BiliApiError；-412 熔断后重试 1 次；网络异常重试 1 次。 */
  async #getJson<T>(path: string, params?: WbiParams, signed = false): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      // 每次尝试都从原始参数重签（python 版重试时会带着旧 w_rid 再签，此处修正）
      const finalParams = signed ? wbiSign(params ?? {}, this.#requireMixin()) : params;
      const qs = finalParams ? toSortedQuery(finalParams) : '';
      const url = qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
      await this.#pace();
      try {
        const res = await this.#fetchImpl(url, {
          headers: this.#apiHeaders(),
          credentials: 'include',
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (res.status === 412) {
          // HTTP 层风控与 JSON code -412 同等处理（对齐 python：熔断后重试 1 次）
          if (attempt === 1) {
            await sleep(this.#breakerWaitMs);
            continue;
          }
          throw new BiliApiError(-412, path, `HTTP 412 风控拦截（${path}）`);
        }
        let json: { code?: number };
        try {
          json = (await res.json()) as { code?: number };
        } catch {
          throw new BiliApiError(res.status, path, `非 JSON 响应（HTTP ${res.status}，${path}）`);
        }
        const apiCode = json.code ?? 0;
        if (apiCode !== 0) {
          if (apiCode === -412 && attempt === 1) {
            await sleep(this.#breakerWaitMs);
            continue;
          }
          throw new BiliApiError(apiCode, path);
        }
        return json as T;
      } catch (e) {
        if (e instanceof BiliApiError || attempt === 2) throw e;
        // 网络异常（含超时 AbortError）重试 1 次（对齐 python）
      }
    }
    throw new Error('unreachable');
  }

  // -- 业务接口 -------------------------------------------------------------
  /**
   * P1.10 登录态探测（架构 §3.9）：nav 是唯一判据（need_login_subtitle 恒为 None 不可用，
   * 07 报告 F-4 三次复证）。true=已登录；false=未登录（code -101/-352 或 isLogin=false）；
   * null=未知（网络/-412 等瞬时错误——不得误报未登录轰炸用户）。
   */
  async checkLogin(): Promise<boolean | null> {
    try {
      const j = await this.#getJson<NavResp>('/x/web-interface/nav');
      return j.data?.isLogin === true;
    } catch (e) {
      if (e instanceof BiliApiError && (e.code === -101 || e.code === -352)) return false;
      return null;
    }
  }

  async fetchWbiKeys(): Promise<string> {
    const j = await this.#getJson<NavResp>('/x/web-interface/nav');
    const wbi = j.data?.wbi_img ?? {};
    const img = keyFromUrl(wbi.img_url);
    const sub = keyFromUrl(wbi.sub_url);
    if (!img || !sub) throw new Error(`获取 WBI key 失败：${JSON.stringify(wbi)}`);
    this.#mixinKey = getMixinKey(img, sub);
    return this.#mixinKey;
  }

  /** 多 P 视频只取当前 cid（由调用方从 pages 里选）；cid 为第 1P 的 cid。 */
  async getView(bvid: string): Promise<VideoView> {
    const j = await this.#getJson<ViewResp>('/x/web-interface/view', { bvid });
    const d = j.data;
    if (!d) throw new Error(`view 无 data：${bvid}`);
    const pages = d.pages ?? [];
    return {
      aid: d.aid,
      cid: pages[0]?.cid ?? 0,
      title: d.title ?? '',
      cover: d.pic ?? '',
      owner: d.owner?.name ?? '',
      duration: d.duration ?? 0,
      pages,
    };
  }

  async getPlayerSubtitles(bvid: string, cid: number): Promise<PlayerSubtitles> {
    let sub = await this.#playerSubtitle(bvid, cid);
    // G-1（07 报告 §3）：SESSDATA 是取轨唯一必要条件，buvid3 仅兜底——
    // 只在轨存在却缺 subtitle_url（has_url=false）时补指纹 Cookie 重试一次，不做启动预热
    if (sub.subtitles.some((t) => !t.subtitle_url)) {
      if (await this.#fingerFallback()) {
        const retried = await this.#playerSubtitle(bvid, cid);
        if (retried.subtitles.length > 0) sub = retried;
      }
    }
    return { subtitles: sub.subtitles, needLoginSubtitle: sub.need_login_subtitle ?? null };
  }

  async #playerSubtitle(
    bvid: string,
    cid: number,
  ): Promise<{ subtitles: SubtitleTrack[]; need_login_subtitle?: boolean }> {
    const j = await this.#getJson<PlayerV2Resp>('/x/player/wbi/v2', { bvid, cid }, true);
    const sub = j.data?.subtitle;
    return { subtitles: sub?.subtitles ?? [], need_login_subtitle: sub?.need_login_subtitle };
  }

  // ---- P2.3 · ASR 音频流（playurl，仅确认流使用；架构 §3.3/§3.8） ----------------

  /** DASH 音轨候选（bandwidth 为选档依据；baseUrl/backupUrl 为选源依据）。 */
  async getPlayUrlAudio(bvid: string, cid: number): Promise<DashAudioStream[]> {
    // fnval=16 → DASH；qn 对 DASH 无关紧要（音轨不随视频清晰度变），带 16（最低档）示意
    const j = await this.#getJson<PlayUrlResp>('/x/player/wbi/playurl', { bvid, cid, fnval: 16, qn: 16 }, true);
    return (j.data?.dash?.audio ?? []).map((a) => ({
      id: a.id ?? 0,
      bandwidth: a.bandwidth ?? Number.MAX_SAFE_INTEGER,
      baseUrl: a.baseUrl ?? '',
      backupUrl: a.backupUrl ?? a.backup_url ?? [],
    }));
  }

  async #fingerFallback(): Promise<boolean> {
    try {
      const j = await this.#getJson<FingerSpiResp>('/x/frontend/finger/spi');
      const d = j.data ?? {};
      const cookies: Record<string, string> = {};
      if (d.b_3) cookies['buvid3'] = d.b_3;
      if (d.b_4) cookies['buvid4'] = d.b_4;
      if (!cookies['buvid3']) return false;
      this.#fingerCookies = cookies;
      this.#onCookie?.(cookies);
      return true;
    } catch {
      return false; // 兜底失败不阻断主流程
    }
  }

  /** 匿名直下字幕 JSON：不带 Cookie/Referer——auth_key 自鉴权（07 报告 §4 第 3 次复证）。 */
  async fetchTranscript(subtitleUrl: string): Promise<TranscriptCue[]> {
    const url = normalizeSubtitleUrl(subtitleUrl);
    await this.#pace();
    const res = await this.#fetchImpl(url, {
      headers: { 'User-Agent': UA },
      credentials: 'omit',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`字幕下载失败：HTTP ${res.status}`);
    const j = (await res.json()) as { body?: TranscriptCue[] };
    return j.body ?? [];
  }
}
