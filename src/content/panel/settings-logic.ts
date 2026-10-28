// P2.5 · 设置页纯逻辑（无 DOM/browser，单测覆盖）：
// Key 打码（F9：设置页仅尾 4 位）、「未改动的打码 Key = 沿用旧 Key」哨兵解析、
// 阈值钳位（数据模型 §2：5–300）、v1.0 人设枚举（spicy/gentle/academic；v1.1.1 五风格属 F15/Phase 5）。
import type { ModelConfigInput } from '../onboarding/onboarding-logic';

/** Key 打码：最多保留尾 4 位，遮挡字符数量与密钥长度一致。 */
export function maskApiKey(key: string): string {
  const k = (key ?? '').trim();
  return k.length <= 4 ? '*'.repeat(k.length) : `${'*'.repeat(k.length - 4)}${k.slice(-4)}`;
}

/**
 * 设置页保存时的 Key 哨兵解析：输入为空或恰为旧 Key 的打码形态（未改动）→ 沿用旧 Key；
 * 其余按新输入。onboarding 无旧 Key 时空输入原样返回（由 validateLlm 拦截必填）。
 */
export function resolveApiKey(prevKey: string | undefined, input: string): string {
  const v = (input ?? '').trim();
  if (!v) return prevKey ?? '';
  if (prevKey && (v === maskApiKey(prevKey) || v === (prevKey.trim().length <= 4 ? '****' : `****${prevKey.trim().slice(-4)}`))) return prevKey;
  return v;
}

/** 阈值钳位（数据模型 §2 triggerSeconds 5–300；滑杆 5–120 step5 是 UI 档位，存储仍按全域钳位）。 */
export function clampThreshold(v: unknown, fallback = 10): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(300, Math.max(5, n));
}

/** v1.0 人设预设（计划 2.5：沿用三预设；F15 五风格属 v1.1.1/Phase 5，此处不预留）。 */
export const PERSONA_OPTIONS = [
  { id: 'spicy', label: '🌶 毒舌包' },
  { id: 'gentle', label: '🫘 温柔包' },
  { id: 'academic', label: '🎓 学术包' },
] as const;

export type PersonaId = (typeof PERSONA_OPTIONS)[number]['id'];

export function isPersonaId(v: unknown): v is PersonaId {
  return PERSONA_OPTIONS.some((p) => p.id === v);
}

/** 人设合法化：非法值回默认 spicy（存储层兜底；UI 单选只会发合法值）。 */
export function sanitizePersona(v: unknown): PersonaId {
  return isPersonaId(v) ? v : 'spicy';
}

/** 设置页模型区保存载荷：apiKey 走哨兵（空/打码=沿用），由 SW 侧 resolveApiKey 终判。 */
export interface SettingsModelSave {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export function toModelConfigInput(s: SettingsModelSave): ModelConfigInput {
  return { baseUrl: s.baseUrl.trim(), modelId: s.modelId.trim(), apiKey: s.apiKey.trim() };
}
