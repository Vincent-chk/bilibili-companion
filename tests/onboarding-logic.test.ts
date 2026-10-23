// P1.7 · onboarding 纯逻辑单测：LLM 必填校验、端点安全（非 loopback http 拒绝）、
// ASR 可选三元组语义、optional_host_permissions origin 模式。
import { describe, expect, it } from 'vitest';
import {
  buildSavePayload,
  originPattern,
  validateAsr,
  validateEndpointUrl,
  validateLlm,
} from '../src/content/onboarding/onboarding-logic';

const OK_LLM = { baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat', apiKey: 'sk-xxx' };

describe('端点 URL 安全校验（风险合规红线）', () => {
  it('https 端点通过', () => {
    expect(validateEndpointUrl('https://api.deepseek.com/v1').ok).toBe(true);
    expect(validateEndpointUrl('https://ark.cn-beijing.volces.com/api/v3').ok).toBe(true);
  });
  it('loopback 明文 http 允许（本地部署/自建服务）', () => {
    expect(validateEndpointUrl('http://127.0.0.1:11434/v1').ok).toBe(true);
    expect(validateEndpointUrl('http://localhost:8000/v1').ok).toBe(true);
  });
  it('非 loopback 明文 http 拒绝', () => {
    const r = validateEndpointUrl('http://api.example.com/v1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('https');
  });
  it('不可解析/空 URL 拒绝', () => {
    expect(validateEndpointUrl('').ok).toBe(false);
    expect(validateEndpointUrl('api.deepseek.com/v1').ok).toBe(false); // 缺协议
  });
  it('内嵌凭据 / 查询串 / 锚点拒绝（审查 P2）', () => {
    expect(validateEndpointUrl('https://user:pass@api.example.com/v1').ok).toBe(false);
    expect(validateEndpointUrl('https://api.example.com/v1?token=x').ok).toBe(false);
    expect(validateEndpointUrl('https://api.example.com/v1#frag').ok).toBe(false);
  });
});

describe('LLM 必填校验（F9 三项缺一不可）', () => {
  it('全填且端点合法 → ok', () => {
    expect(validateLlm(OK_LLM).ok).toBe(true);
  });
  it('逐项缺失被点名（标红依据）', () => {
    expect(validateLlm({ ...OK_LLM, baseUrl: ' ' }).missing).toEqual(['baseUrl']);
    expect(validateLlm({ ...OK_LLM, modelId: '' }).missing).toEqual(['modelId']);
    expect(validateLlm({ ...OK_LLM, apiKey: '' }).missing).toEqual(['apiKey']);
    expect(validateLlm({ baseUrl: '', modelId: '', apiKey: '' }).missing).toEqual(['baseUrl', 'modelId', 'apiKey']);
  });
  it('全填但端点非法 → ok=false 且带端点错误', () => {
    const r = validateLlm({ ...OK_LLM, baseUrl: 'http://api.example.com/v1' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

describe('ASR 可选三元组', () => {
  it('全空 → skip（可跳过，F9）', () => {
    expect(validateAsr({ baseUrl: '', modelId: '', apiKey: '' }).kind).toBe('skip');
  });
  it('全填且合法 → ok', () => {
    expect(
      validateAsr({ baseUrl: 'https://api.siliconflow.cn/v1', modelId: 'FunAudioLLM/SenseVoiceSmall', apiKey: 'sk-a' })
        .kind,
    ).toBe('ok');
  });
  it('部分填写 → error（防「以为配好了」）', () => {
    const r = validateAsr({ baseUrl: 'https://x.example/v1', modelId: '', apiKey: 'sk-a' });
    expect(r.kind).toBe('error');
    expect(r.error).toContain('同时填写');
  });
});

describe('optional_host_permissions origin 模式（F9：仅含所填端点）', () => {
  it('origin + /* ', () => {
    expect(originPattern('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/*');
  });
  it('端口保留；非法端点返回 null', () => {
    expect(originPattern('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/*');
    expect(originPattern('http://api.example.com')).toBeNull();
  });
});

describe('保存载荷组装', () => {
  it('ASR 全空不带 asr 键；全填携带', () => {
    expect(buildSavePayload(OK_LLM, null)).toEqual({ llm: OK_LLM });
    const asr = { baseUrl: 'https://a.example/v1', modelId: 'm', apiKey: 'k' };
    expect(buildSavePayload(OK_LLM, asr)).toEqual({ llm: OK_LLM, asr });
  });
});
