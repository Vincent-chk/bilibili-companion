// F-7：协议相对地址补 https 前缀；auth_key 在 URL 尾部，截断即 403，必须逐字符保留。
import { describe, expect, it } from 'vitest';
import { normalizeSubtitleUrl } from '@/lib/bilibili/track';

const RELATIVE =
  '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/10245508717302118691-1-c2FtcGxlXzM?auth_key=1761186000-72d4a6ff-0-0123456789abcdef0123456789abcdef';

describe('normalizeSubtitleUrl', () => {
  it('协议相对地址补 https: 前缀', () => {
    expect(normalizeSubtitleUrl(RELATIVE)).toBe(`https:${RELATIVE}`);
    expect(normalizeSubtitleUrl(RELATIVE).startsWith('https://aisubtitle.hdslb.com/')).toBe(true);
  });

  it('绝对 URL 原样返回', () => {
    const abs = `https:${RELATIVE}`;
    expect(normalizeSubtitleUrl(abs)).toBe(abs);
    expect(normalizeSubtitleUrl('http://aisubtitle.hdslb.com/bfs/x.json')).toBe(
      'http://aisubtitle.hdslb.com/bfs/x.json',
    );
  });

  it('URL 尾部字符一个不丢（auth_key 尾部 -0-<32hex> 丢失会 403）', () => {
    const out = normalizeSubtitleUrl(RELATIVE);
    expect(out).toHaveLength('https:'.length + RELATIVE.length);
    expect(out.endsWith('-0-0123456789abcdef0123456789abcdef')).toBe(true);
  });
});
