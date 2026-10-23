import { md5 } from 'js-md5';

// WBI 打乱索引表（bilibili-API-collect / yt-dlp 通用表），与 scripts/coverage_probe.py 逐字符一致
export const MIXIN_KEY_ENC_TABLE: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

// WBI 规范：参数值中需剔除的字符
export const WBI_CHR_FILTER = "!'()*";

export type WbiParams = Record<string, string | number>;
export type WbiSigned = Record<string, string | number>;

export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TABLE.map((i) => raw[i] ?? '')
    .join('')
    .slice(0, 32);
}

// 与 python urllib.parse.urlencode(quote_plus) 语义一致（空格→+），保证签名串逐字节可复现
export function urlencodeComponent(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

export function toSortedQuery(params: WbiParams): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${urlencodeComponent(k)}=${urlencodeComponent(String(params[k]))}`)
    .join('&');
}

/** 对参数做 WBI 签名：注入 wts → 值过滤 → 按 key 排序 urlencode → md5 得 w_rid。不改动入参对象。 */
export function wbiSign(params: WbiParams, mixinKey: string, wts?: number): WbiSigned {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    p[k] = String(v).replace(/[!'()*]/g, '');
  }
  const wtsVal = Math.floor(wts ?? Date.now() / 1000);
  p['wts'] = String(wtsVal);
  const query = toSortedQuery(p);
  return { ...p, wts: wtsVal, w_rid: md5(query + mixinKey) };
}
