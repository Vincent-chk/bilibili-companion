import type { LlmConfig, LlmMessage, StreamEvent } from './types';

/** 非 2xx：仅保留状态码，避免服务端错误体回显用户数据。 */
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
  signal?: AbortSignal;
  /** 输出 token 上限（成本护栏：F13 分段解读 / F14 对话用；缺省=不限制）。 */
  maxTokens?: number;
  /** 思考模型关闭思维链（F13 分段解读提速：首字 TTFT 从 40–90s 压到秒级）。
   *  shortcut: 仅对 Ark（*.volces.com）注入 thinking 字段；其他供应商形态出现真实需求再扩。 */
  disableThinking?: boolean;
}

/** Ark（火山方舟）端点判定：chat/completions 支持 body.thinking={type:'disabled'}。 */
export function isArkBaseUrl(baseUrl: string): boolean {
  try {
    return /(^|\.)volces\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

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
  const thinkingOff = opts.disableThinking === true && isArkBaseUrl(cfg.baseUrl);
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const t0 = Date.now();
  let text = '';
  let usage: unknown;
  let ttftMs: number | null = null;

  try {
    if (controller.signal.aborted) throw new LlmNetworkError('LLM 请求已取消');
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
        ...(thinkingOff ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 错误体可能回显任意字幕、Cookie 或密钥，无法靠模式匹配完整脱敏。
      await res.text().catch(() => ''); // 读完以复用连接；正文不进入错误、日志或存储。
      throw new LlmHttpError(res.status, '服务端错误详情已隐藏');
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
      let j: { choices?: { delta?: { content?: string; reasoning_content?: string } }[]; usage?: unknown };
      try {
        j = JSON.parse(data) as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          usage?: unknown;
        };
      } catch {
        return; // 非 JSON 行（注释/心跳）忽略
      }
      if (j.usage) usage = j.usage;
      // 思维链增量：仅透传事件供存活诊断（不进 text/ttft/正文——分段解读关思考后通常无此行）
      const reasoning = j.choices?.[0]?.delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) onDelta?.({ type: 'reasoning', text: reasoning });
      const delta = j.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        text += delta;
        onDelta?.({ type: 'delta', text: delta });
      }
    };

    for (;;) {
      if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
      if (finished) break; // [DONE] 后不再等下一次 read（服务器可能不立即关流）
      const { done, value } = await reader.read();
      if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        onLine(line);
        if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
        if (finished) break;
        nl = buf.indexOf('\n');
      }
    }
    buf += decoder.decode();
    if (!finished && buf.trim()) onLine(buf.replace(/\r$/, '')); // 无尾换行的最后一行
    if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');

    onDelta?.({ type: 'done', usage });
    if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
    return { text, usage, ttftMs };
  } catch (e) {
    if (opts.signal?.aborted) throw new LlmNetworkError('LLM 请求已取消');
    if (e instanceof LlmHttpError) throw e;
    if (e instanceof LlmNetworkError) throw e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new LlmNetworkError(
      controller.signal.aborted ? `LLM 请求超时（>${timeoutMs}ms）` : `LLM 网络错误：${detail}`,
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}
