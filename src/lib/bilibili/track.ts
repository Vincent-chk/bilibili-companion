export interface SubtitleTrack {
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
  ai_status?: number;
}

// 中文人工轨优先级（越靠前越优），其后 ai-zh；其余 ai-* 为 AI 翻译轨一律排除。
// ai_status 仅作徽章展示、不参与选择（05-专项调研实测语义：0=人工轨、2=AI 轨可用）。
const MANUAL_ZH_PRIORITY = ['zh-CN', 'zh-Hans', 'zh', 'zh-Hant', 'zh-HK', 'zh-TW', 'zh-MO'] as const;

export function selectTrack(subtitles: SubtitleTrack[]): SubtitleTrack | null {
  const byLan = new Map<string, SubtitleTrack>();
  for (const s of subtitles) {
    if (s.lan) byLan.set(s.lan, s);
  }
  for (const lan of MANUAL_ZH_PRIORITY) {
    const t = byLan.get(lan);
    if (t) return t;
  }
  return byLan.get('ai-zh') ?? null;
}

// F-7：B 站返回协议相对地址（//aisubtitle.hdslb.com/...），fetch 需要绝对 URL；
// auth_key 位于 URL 尾部，截断即 403——本函数只加前缀，绝不改动其余字符。
export function normalizeSubtitleUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}
