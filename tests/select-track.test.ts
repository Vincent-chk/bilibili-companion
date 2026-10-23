// 任务 0.2 规格用例：选轨优先级语义（与 python select_track 语义一致，另见 wbi-sign.test.ts 移植版）。
import { describe, expect, it } from 'vitest';
import { selectTrack } from '@/lib/bilibili/track';

describe('selectTrack', () => {
  it('人工中文轨优先于 AI 轨', () => {
    const subs = [
      { lan: 'ai-zh', ai_status: 2, subtitle_url: '//x' },
      { lan: 'zh-Hans', ai_status: 0, subtitle_url: '//y' },
    ];
    expect(selectTrack(subs)?.lan).toBe('zh-Hans');
  });

  it('AI 翻译轨（ai-en/ai-ja 等）绝不选中', () => {
    const subs = [
      { lan: 'ai-en', ai_status: 2 },
      { lan: 'ai-ja', ai_status: 2 },
      { lan: 'ai-ko', ai_status: 2 },
    ];
    expect(selectTrack(subs)).toBeNull();
  });

  it('空列表返回 null', () => {
    expect(selectTrack([])).toBeNull();
  });

  it('仅 ai-zh 时选 ai-zh', () => {
    const subs = [{ lan: 'ai-zh', ai_status: 2 }];
    expect(selectTrack(subs)?.lan).toBe('ai-zh');
  });

  it('人工多语按优先级序取最优（zh-CN > zh-Hans > zh > …）', () => {
    const mixed = [
      { lan: 'zh-TW', ai_status: 0 },
      { lan: 'zh-HK', ai_status: 0 },
      { lan: 'zh-MO', ai_status: 0 },
    ];
    expect(selectTrack(mixed)?.lan).toBe('zh-HK');

    const withZh = [
      { lan: 'zh-Hans', ai_status: 0 },
      { lan: 'zh', ai_status: 0 },
    ];
    expect(selectTrack(withZh)?.lan).toBe('zh-Hans');
  });
});
