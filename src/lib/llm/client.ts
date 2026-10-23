import type { LlmConfig, LlmMessage, StreamEvent } from './types';

/** 非 2xx：body 已打码（Key 剔除）并截断到前 200 字符。 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`LLM HTTP ${status}: ${body}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.body = body;
  }
}

/** 网络/超时类失败（DNS、断连、abort 等）。 */
export class LlmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmNetworkError';
  }
}

export interface StreamResult {
  text: string;
  usage?: unknown;
  ttftMs: number | null;
}

export interface StreamOptions {
  onDelta?: (ev: StreamEvent) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 输出 token 上限（成本护栏：F13 分段解读 / F14 对话用；缺省=不限制）。 */
  maxTokens?: number;
}

// 服务端错误 body 里可能回显 Key：先剔除本次 Key，再兜底打码 Bearer/sk-/ark- 形态 token，只留前 200 字符。
const sanitizeBody = (raw: string, apiKey: string): string => {
  let out = raw;
  if (apiKey) out = out.split(apiKey).join('***');
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1***');
  out = out.replace(/\b(?:sk|ark)-[A-Za-z0-9][A-Za-z0-9-]{8,}/g, '***');
  return out.slice(0, 200);
};

/**
 * SSE 流式 chat/completions。手写行缓冲解析（TextDecoder(stream) + 按 \n 切行），
 * 不依赖任何 SSE 库；[DONE] 或流自然结束即完成，返回完整文本 + usage + 首 token 延迟。
 */
export async function streamChatCompletion(
  cfg: LlmConfig,
  messages: LlmMessage[],
  opts: StreamOptions = {},
): Promise<StreamResult> {
  // 裸存 fetch 引用会在 ServiceWorker 里 Illegal invocation（脱离 globalThis 上下文）——必须 bind
  const { onDelta, fetchImpl = fetch.bind(globalThis), timeoutMs = 60000 } = opts;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const t0 = Date.now();
  let text = '';
  let usage: unknown;
  let ttftMs: number | null = null;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.7,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new LlmHttpError(res.status, sanitizeBody(raw, cfg.apiKey));
    }
    if (!res.body) throw new LlmNetworkError('LLM 响应无 body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finished = false;

    const onLine = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        finished = true;
        return;
      }
      let j: { choices?: { delta?: { content?: string } }[]; usage?: unknown };
      try {
        j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: unknown };
      } catch {
        return; // 非 JSON 行（注释/心跳）忽略
      }
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        text += delta;
        onDelta?.({ type: 'delta', text: delta });
      }
    };

    for (;;) {
      if (finished) break; // [DONE] 后不再等下一次 read（服务器可能不立即关流）
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        onLine(line);
        if (finished) break;
        nl = buf.indexOf('\n');
      }
    }
    buf += decoder.decode();
    if (!finished && buf.trim()) onLine(buf.replace(/\r$/, '')); // 无尾换行的最后一行

    onDelta?.({ type: 'done', usage });
    return { text, usage, ttftMs };
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    if (e instanceof LlmNetworkError) throw e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new LlmNetworkError(
      controller.signal.aborted ? `LLM 请求超时（>${timeoutMs}ms）` : `LLM 网络错误：${detail}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
