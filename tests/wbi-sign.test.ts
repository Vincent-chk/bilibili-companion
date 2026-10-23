// test_wbi_sign.py 的 1:1 移植（15 用例，用例名/向量/断言语义保持一致）。
// 已知向量来源：bilibili-API-collect wbi.md 文档示例。
import { describe, expect, it } from 'vitest';
import {
  MIXIN_KEY_ENC_TABLE,
  WBI_CHR_FILTER,
  getMixinKey,
  wbiSign,
} from '@/lib/bilibili/wbi';
import { selectTrack } from '@/lib/bilibili/track';
import { classifyNonSpeech } from '@/lib/bilibili/classify';

const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

describe('TestMixinKey', () => {
  it('test_documented_example', () => {
    // 打乱表 + 截断 32 位：与 bilibili-API-collect 文档示例一致。
    expect(getMixinKey(IMG_KEY, SUB_KEY)).toBe(MIXIN_KEY);
  });

  it('test_table_length', () => {
    expect(MIXIN_KEY_ENC_TABLE.length).toBe(64);
    expect(new Set(MIXIN_KEY_ENC_TABLE).size).toBe(64); // 0..63 各出现一次
  });
});

describe('TestWbiSign', () => {
  it('test_documented_example_w_rid', () => {
    // 文档示例参数 + 固定 wts → 固定 w_rid（与官方文档对齐的锚点用例）。
    const signed = wbiSign({ foo: '114', bar: '514', baz: 2233 }, MIXIN_KEY, 1702204800);
    expect(signed['wts']).toBe(1702204800);
    expect(signed['w_rid']).toBe('2e265325e5e7f98351220466f88653f3');
  });

  it('test_query_ordering_independent_of_input', () => {
    // 参数顺序不影响签名（内部按 key 排序）。
    const a = wbiSign({ bvid: 'BV1XynB6EEiM', cid: 123 }, MIXIN_KEY, 1);
    const b = wbiSign({ cid: 123, bvid: 'BV1XynB6EEiM' }, MIXIN_KEY, 1);
    expect(a['w_rid']).toBe(b['w_rid']);
  });

  it('test_chr_filter', () => {
    // 参数值中的 !'()* 字符在签名前被剔除。
    const plain = wbiSign({ foo: 'ab', bar: '514', baz: 2233 }, MIXIN_KEY, 1702204800);
    const dirty = wbiSign({ foo: "a!'()*b", bar: '514', baz: 2233 }, MIXIN_KEY, 1702204800);
    expect(plain['w_rid']).toBe(dirty['w_rid']);
    expect(WBI_CHR_FILTER).toBe("!'()*");
  });

  it('test_does_not_mutate_input', () => {
    const params = { bvid: 'BV1XynB6EEiM' };
    wbiSign(params, MIXIN_KEY, 1);
    expect(params).toEqual({ bvid: 'BV1XynB6EEiM' });
  });

  it('test_w_rid_shape', () => {
    const signed = wbiSign({ cid: 1 }, MIXIN_KEY);
    expect(signed['w_rid']).toMatch(/^[0-9a-f]{32}$/);
    expect(Number(signed['wts'])).toBeGreaterThan(1600000000);
  });
});

describe('TestSelectTrack', () => {
  it('test_manual_over_ai', () => {
    const subs = [
      { lan: 'ai-zh', ai_status: 2 },
      { lan: 'zh-CN', ai_status: 0 },
    ];
    expect(selectTrack(subs)?.lan).toBe('zh-CN');
  });

  it('test_ai_zh_when_no_manual', () => {
    const subs = [
      { lan: 'ai-en', ai_status: 2 },
      { lan: 'ai-zh', ai_status: 2 },
    ];
    expect(selectTrack(subs)?.lan).toBe('ai-zh');
  });

  it('test_never_translation_track', () => {
    const subs = [
      { lan: 'ai-en', ai_status: 2 },
      { lan: 'ai-ja', ai_status: 2 },
    ];
    expect(selectTrack(subs)).toBeNull();
  });

  it('test_manual_zh_priority_order', () => {
    const subs = [
      { lan: 'zh-Hant', ai_status: 0 },
      { lan: 'zh', ai_status: 0 },
    ];
    expect(selectTrack(subs)?.lan).toBe('zh');
  });

  it('test_empty', () => {
    expect(selectTrack([])).toBeNull();
  });
});

describe('TestClassify', () => {
  it('test_short_duration', () => {
    expect(classifyNonSpeech('随便什么标题', 93)).toBe(true);
  });

  it('test_music_keyword', () => {
    expect(classifyNonSpeech('【某团】Birthday Wish 舞台 MV', 210)).toBe(true);
  });

  it('test_speech', () => {
    expect(classifyNonSpeech('iPhone Duo 首发评测：苹果的双屏奇谋', 1595)).toBe(false);
  });
});
