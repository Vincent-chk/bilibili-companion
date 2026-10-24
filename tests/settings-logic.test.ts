// P2.5 · 设置页纯逻辑单测：Key 打码/哨兵解析、阈值钳位、人设枚举。
import { describe, expect, it } from 'vitest';
import { PERSONA_OPTIONS, clampThreshold, isPersonaId, maskApiKey, resolveApiKey, sanitizePersona } from '../src/content/panel/settings-logic';

describe('maskApiKey（F9 仅尾 4 位）', () => {
  it('常规 Key：仅尾 4 位可见', () => {
    expect(maskApiKey('sk-abcdef123456')).toBe('****3456');
  });
  it('≤4 位 Key 全遮（不泄露整 Key）', () => {
    expect(maskApiKey('sk-x')).toBe('****');
    expect(maskApiKey('')).toBe('****');
  });
});

describe('resolveApiKey（打码哨兵：未改动=沿用旧 Key）', () => {
  it('空输入 → 沿用旧 Key（用户没动打码占位就清空也不丢配置）', () => {
    expect(resolveApiKey('sk-real-key-9999', '')).toBe('sk-real-key-9999');
  });
  it('输入恰为旧 Key 的打码形态 → 沿用（不把 ****xxxx 当新 Key 存库）', () => {
    expect(resolveApiKey('sk-real-key-9999', maskApiKey('sk-real-key-9999'))).toBe('sk-real-key-9999');
  });
  it('新输入 → 新 Key', () => {
    expect(resolveApiKey('sk-old', 'sk-brand-new')).toBe('sk-brand-new');
  });
  it('无旧 Key + 空输入 → 空（onboarding validateLlm 拦必填）', () => {
    expect(resolveApiKey(undefined, '')).toBe('');
    expect(resolveApiKey(undefined, '  ')).toBe('');
  });
});

describe('clampThreshold（5–300，数据模型 §2）', () => {
  it('边界：5/300 内保留，越界钳位，非数回默认 20', () => {
    expect(clampThreshold(5)).toBe(5);
    expect(clampThreshold(120)).toBe(120);
    expect(clampThreshold(300)).toBe(300);
    expect(clampThreshold(1)).toBe(5);
    expect(clampThreshold(999)).toBe(300);
    expect(clampThreshold('60' as never)).toBe(20);
    expect(clampThreshold(NaN)).toBe(20);
  });
  it('小数取整（滑杆 step=5 不产生，存储防御）', () => {
    expect(clampThreshold(20.7)).toBe(21);
  });
});

describe('v1.0 人设枚举（三预设）', () => {
  it('恰三预设：spicy/gentle/academic（F15 五风格属 Phase 5，不预留）', () => {
    expect(PERSONA_OPTIONS.map((p) => p.id)).toEqual(['spicy', 'gentle', 'academic']);
  });
  it('isPersonaId/sanitizePersona', () => {
    expect(isPersonaId('spicy')).toBe(true);
    expect(isPersonaId('witty')).toBe(false); // v1.1.1 风格，v1.0 拒绝
    expect(sanitizePersona('gentle')).toBe('gentle');
    expect(sanitizePersona('rigorous')).toBe('spicy');
    expect(sanitizePersona(undefined)).toBe('spicy');
  });
});
