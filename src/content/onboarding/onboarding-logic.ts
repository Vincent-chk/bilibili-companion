// P1.7 · onboarding 纯逻辑（无 DOM/browser，单测覆盖）：
// LLM 必填三件套校验、端点 URL 安全校验（拒绝非 loopback 明文 http，风险合规红线）、
// ASR 可选三元组（全空跳过/部分填写报错）、optional_host_permissions 的 origin 模式。
export interface ModelConfigInput {
  provider?: 'openai-compatible' | 'doubao-agent-plan';
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface LlmValidation {
  ok: boolean;
  missing: ('baseUrl' | 'modelId' | 'apiKey')[];
  /** 端点级错误（非缺项）：非 loopback 明文 http / URL 不可解析。 */
  error?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 端点校验：可解析 + 拒绝 http:// 非 loopback（04-风险合规 §Key 安全；BiliNote 同款）；
 *  另拒 URL 内嵌凭据与查询串/锚点（探活与真实链按 baseUrl 直接拼路径，带 ?/# 必错）。 */
export function validateEndpointUrl(baseUrl: string): { ok: boolean; origin?: string; error?: string } {
  const raw = baseUrl.trim();
  if (!raw) return { ok: false, error: 'Base URL 为空' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'Base URL 无法解析（需含协议，如 https://api.example.com/v1）' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))) {
    return { ok: false, error: '明文 http 端点仅允许本机 loopback；请使用 https://' };
  }
  if (u.username || u.password) return { ok: false, error: 'Base URL 不应内嵌用户名/密码' };
  if (u.search || u.hash) return { ok: false, error: 'Base URL 不应包含查询串（?…）或锚点（#…）' };
  return { ok: true, origin: u.origin };
}

/** LLM 必填校验（F9：三项缺一不可，逐项标红）。 */
export function validateLlm(cfg: ModelConfigInput): LlmValidation {
  const missing: ('baseUrl' | 'modelId' | 'apiKey')[] = [];
  if (!cfg.baseUrl.trim()) missing.push('baseUrl');
  if (!cfg.modelId.trim()) missing.push('modelId');
  if (!cfg.apiKey.trim()) missing.push('apiKey');
  const endpoint = missing.length === 0 ? validateEndpointUrl(cfg.baseUrl) : undefined;
  return {
    ok: missing.length === 0 && !!endpoint?.ok,
    missing,
    error: endpoint && !endpoint.ok ? endpoint.error : undefined,
  };
}

/** ASR 可选：全空=跳过；全填=有效；部分填=错误（静默忽略会让用户误以为已配置）。 */
export function validateAsr(cfg: ModelConfigInput): { kind: 'skip' | 'ok' | 'error'; error?: string } {
  if (cfg.provider === 'doubao-agent-plan') return cfg.apiKey.trim() ? { kind: 'ok' } : { kind: 'error', error: '请填写 Agent Plan Key' };
  const filled = [cfg.baseUrl.trim(), cfg.modelId.trim(), cfg.apiKey.trim()].filter(Boolean).length;
  if (filled === 0) return { kind: 'skip' };
  if (filled < 3) return { kind: 'error', error: 'ASR 三项需同时填写（或全部留空稍后再配）' };
  const endpoint = validateEndpointUrl(cfg.baseUrl);
  if (!endpoint.ok) return { kind: 'error', error: endpoint.error };
  return { kind: 'ok' };
}

/** optional_host_permissions 申请模式：origin + 路径通配（F9：弹窗仅含所填端点）。 */
export function originPattern(baseUrl: string): string | null {
  const r = validateEndpointUrl(baseUrl);
  return r.ok ? `${r.origin}/*` : null;
}

/** onboarding 保存载荷（content → background SETTINGS_SAVE）。
 *  P2.3：llm 可选——ASR 补配模式只带 asr（SW 沿用已存 LLM，Key 明文不下发面板）。 */
export interface SettingsSavePayload {
  llm?: ModelConfigInput;
  asr?: ModelConfigInput;
}

export function buildSavePayload(llm: ModelConfigInput, asr: ModelConfigInput | null): SettingsSavePayload {
  const asrKind = validateAsr(asr ?? { baseUrl: '', modelId: '', apiKey: '' });
  return asr && asrKind.kind === 'ok' ? { llm, asr } : { llm };
}
