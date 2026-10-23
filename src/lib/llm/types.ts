/** LLM 结构化摘要结果（02-数据模型 §LLM 输出 Schema）。 */
export interface SummaryResult {
  summary: string;
  outline: { time: number; text: string }[];
  evaluation: string;
  rating: number;
}

/** OpenAI-compatible 供应商配置（chrome.storage.local 或构建期注入，由调用方传入）。 */
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 流式事件：delta=文本增量，done=流结束（携带 usage 若有）。 */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: unknown };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
