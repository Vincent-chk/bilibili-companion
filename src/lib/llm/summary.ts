import type { LlmConfig, LlmMessage, StreamEvent, SummaryResult } from './types';
import { streamChatCompletion } from './client';

// Key 安全红线（三条）：Key 不落盘（不写任何文件/存储）、不入库（不进 Dexie 或任何数据库）、
// 不打印（不进日志与错误信息——错误只含 status 与打码后的 body 前 200 字符）。

/** 人设只改点评口吻（F8/决策 D12：摘要本体保持客观）。v1.0 三预设。 */
export const PERSONA_EVALUATION_STYLE: Record<string, string> = {
  spicy: '40-80字的豆包点评，毒舌包人设，可用豆系梗（如本豆/豆沙/出笼/豆子）',
  gentle: '40-80字的豆包点评，温柔包人设，语气亲和、以鼓励为主',
  academic: '40-80字的豆包点评，学术包人设，冷静克制、重论证与信息密度',
};

const BASE_SYSTEM_PROMPT = `你是「豆包」，一只陪用户看 B 站视频的吉祥物助手。任务：把视频内容整理成结构化笔记。

只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释文字。结构如下：
{"summary": "150-300字的客观摘要（简体中文，陈述事实，不带人设口吻）",
 "outline": [{"time": 秒数, "text": "该段要点，不超过30字"}],
 "evaluation": "{EVAL_STYLE}",
 "rating": 1到5的整数}

约束：
1. outline 6-12 条，按时间升序，time 必须是整数秒且来自所给内容的时间戳；
2. summary 保持客观、不评价；人设口吻只允许出现在 evaluation；
3. rating 为 1-5 的整数（1=最难以下咽，5=神作，理解成 1-5 颗 🫘）；
4. 严禁输出 JSON 以外的任何字符。`;

export function summarySystemPrompt(persona = 'spicy'): string {
  return BASE_SYSTEM_PROMPT.replace('{EVAL_STYLE}', PERSONA_EVALUATION_STYLE[persona] ?? PERSONA_EVALUATION_STYLE['spicy']!);
}

export interface SummaryVideoMeta {
  title: string;
  duration: number;
  cueCount: number;
}

export interface SummaryMessagesOptions {
  persona?: string;
  /** user 正文里内容的标签（单趟=紧凑字幕；Map-Reduce Reduce=各段要点）。 */
  bodyLabel?: string;
}

/** 紧凑内容（[mm:ss]文本行）由调用方拼好传入，lib 层不碰 bilibili 数据源。 */
export function buildSummaryMessages(
  videoMeta: SummaryVideoMeta,
  transcriptText: string,
  mo: SummaryMessagesOptions = {},
): LlmMessage[] {
  const label = mo.bodyLabel ?? '紧凑字幕（[mm:ss]文本）';
  const user = `视频标题：${videoMeta.title}\n时长：${videoMeta.duration}秒\n字幕条数：${videoMeta.cueCount}\n\n${label}：\n${transcriptText}`;
  return [
    { role: 'system', content: summarySystemPrompt(mo.persona) },
    { role: 'user', content: user },
  ];
}

/** 宽松解析：剥 ```json 围栏 → 直接 JSON.parse → 大括号切片兜底。 */
export function parseSummary(raw: string): { value: SummaryResult | null; error?: string } {
  let t = (raw ?? '').trim();
  const fence = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence?.[1] !== undefined) t = fence[1].trim();
  try {
    return { value: JSON.parse(t) as SummaryResult };
  } catch (e1) {
    const first = t.indexOf('{');
    const last = t.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return { value: JSON.parse(t.slice(first, last + 1)) as SummaryResult };
      } catch (e2) {
        return { value: null, error: `JSON 解析失败：${errText(e2)}` };
      }
    }
    return { value: null, error: `JSON 解析失败：${errText(e1)}` };
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Schema 校验（02-数据模型 §LLM 输出 Schema）。返回错误列表，空数组=通过。 */
export function validateSummary(v: unknown): string[] {
  const errs: string[] = [];
  if (typeof v !== 'object' || v === null) return ['顶层不是 JSON 对象'];
  const o = v as Record<string, unknown>;

  const s = o['summary'];
  if (typeof s !== 'string' || !s.trim()) errs.push('summary 缺失或非字符串');
  else {
    const n = s.trim().length;
    if (n < 150 || n > 300) errs.push(`summary 字数 ${n} 不在 150-300`);
  }

  const ol = o['outline'];
  if (!Array.isArray(ol) || ol.length === 0) errs.push('outline 缺失或非数组');
  else {
    const bad = ol.findIndex(
      (it) =>
        typeof it !== 'object' ||
        it === null ||
        typeof (it as Record<string, unknown>)['time'] !== 'number' ||
        !Number.isFinite((it as Record<string, unknown>)['time'] as number) ||
        typeof (it as Record<string, unknown>)['text'] !== 'string',
    );
    if (bad >= 0) errs.push(`outline[${bad}] 结构不符 {time:number,text:string}`);
    if (ol.length < 6 || ol.length > 12) errs.push(`outline 条数 ${ol.length} 不在 6-12`);
  }

  const ev = o['evaluation'];
  if (typeof ev !== 'string' || !ev.trim()) errs.push('evaluation 缺失或非字符串');
  else {
    const n = ev.trim().length;
    if (n < 40 || n > 80) errs.push(`evaluation 字数 ${n} 不在 40-80`);
  }

  const rt = o['rating'];
  if (typeof rt !== 'number' || !Number.isInteger(rt) || rt < 1 || rt > 5) {
    errs.push(`rating=${String(rt)} 不是 1-5 整数`);
  }
  return errs;
}

export interface SummarizeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onDelta?: (ev: StreamEvent) => void;
}

export interface SummarizeOutcome {
  degraded: boolean;
  summaryResult: SummaryResult | null;
  /** 降级时的纯文本兜底：最后一轮原始输出前 600 字（outline 置空）。 */
  plainText: string | null;
  attempts: number;
  usage?: unknown;
  ttftMs: number | null;
}

/**
 * 结构化完成链（可复用执行体）：stream → parse → 校验失败带错误信息重发 1 次 → 再失败降级纯文本。
 * 最多 2 次请求。传输类错误（LlmHttpError / LlmNetworkError）直接抛给调用方做错误映射，不做降级。
 */
export async function completeStructured(
  cfg: LlmConfig,
  baseMessages: LlmMessage[],
  opts: SummarizeOptions = {},
): Promise<SummarizeOutcome> {
  // 审查 P1-2：带错重发的两轮共享 timeoutMs 总预算——否则最坏 2×timeoutMs 击穿 SW 600s 看门狗
  const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
  const run = (messages: LlmMessage[]) =>
    streamChatCompletion(cfg, messages, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: deadline === undefined ? undefined : Math.max(1_000, deadline - Date.now()),
      onDelta: opts.onDelta,
    });

  let messages = baseMessages;
  for (let attempt = 1; ; attempt++) {
    const r = await run(messages);
    const { value, error } = parseSummary(r.text);
    const errs = error ? [error] : validateSummary(value);
    if (value && errs.length === 0) {
      return {
        degraded: false,
        summaryResult: value,
        plainText: null,
        attempts: attempt,
        usage: r.usage,
        ttftMs: r.ttftMs,
      };
    }
    if (attempt >= 2) {
      return {
        degraded: true,
        summaryResult: null,
        plainText: r.text.slice(0, 600),
        attempts: attempt,
        usage: r.usage,
        ttftMs: r.ttftMs,
      };
    }
    messages = [
      ...baseMessages,
      {
        role: 'user',
        content: `上一轮输出未通过校验：${errs.join('；')}。请严格只输出一个符合 Schema 的 JSON 对象，不要 Markdown 代码块与任何多余字符。`,
      },
    ];
  }
}

/** 单趟摘要（短字幕直用；长字幕走 mapReduceSummarize）。 */
export async function summarize(
  cfg: LlmConfig,
  videoMeta: SummaryVideoMeta,
  transcriptText: string,
  opts: SummarizeOptions & SummaryMessagesOptions = {},
): Promise<SummarizeOutcome> {
  const { persona, bodyLabel, ...streamOpts } = opts;
  return completeStructured(cfg, buildSummaryMessages(videoMeta, transcriptText, { persona, bodyLabel }), streamOpts);
}

export interface StoredLlmConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ResolvedConfig {
  config: LlmConfig | null;
  source: 'storage' | 'build-inject' | 'none';
  error?: string;
  /** 整流超时（ms）：POC_LLM_TIMEOUT_MS 构建期注入；缺省 60s（见 resolveLlmTimeoutMs）。 */
  timeoutMs: number;
}

export const LLM_DEFAULT_TIMEOUT_MS = 60_000;
/** 注入超时上限（审查 P1-2）：completeStructured 两轮共享 timeoutMs 总预算，clamp 后连同字幕抓取
 *  仍落在 SW 600s 看门狗内并留 ~60s 余量。 */
export const LLM_MAX_TIMEOUT_MS = 540_000;

/** 思考型模型（reasoning）全片摘要整流可远超 60s：真实 LLM 构建经 POC_LLM_TIMEOUT_MS 放宽（clamp 见 LLM_MAX_TIMEOUT_MS）。 */
export function resolveLlmTimeoutMs(): number {
  const raw = typeof __POC_LLM_TIMEOUT_MS__ === 'string' ? Number.parseInt(__POC_LLM_TIMEOUT_MS__, 10) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, LLM_MAX_TIMEOUT_MS) : LLM_DEFAULT_TIMEOUT_MS;
}

/**
 * 配置顺序：chrome.storage.local 的 llm 三件套（调用方传入，lib 层不读存储）
 * → 构建期注入 __POC_LLM_BASE_URL__/__POC_LLM_MODEL__/__POC_LLM_KEY__ → 都没有返回 null + 可读错误。
 */
export function resolveConfig(stored?: StoredLlmConfig): ResolvedConfig {
  const timeoutMs = resolveLlmTimeoutMs();
  if (stored?.baseUrl && stored.model && stored.apiKey) {
    return { config: { baseUrl: stored.baseUrl, model: stored.model, apiKey: stored.apiKey }, source: 'storage', timeoutMs };
  }
  const baseUrl = typeof __POC_LLM_BASE_URL__ === 'string' ? __POC_LLM_BASE_URL__ : '';
  const model = typeof __POC_LLM_MODEL__ === 'string' ? __POC_LLM_MODEL__ : '';
  const apiKey = typeof __POC_LLM_KEY__ === 'string' ? __POC_LLM_KEY__ : '';
  if (baseUrl && model && apiKey) {
    return { config: { baseUrl, model, apiKey }, source: 'build-inject', timeoutMs };
  }
  return {
    config: null,
    source: 'none',
    timeoutMs,
    error: '未配置 LLM：请在设置中填写 baseUrl / model / apiKey，或经 POC_LLM_BASE_URL / POC_LLM_MODEL / POC_LLM_API_KEY 环境变量在构建期注入',
  };
}

/** storage 里读用户 LLM 配置：settings.llm（modelId 字段，onboarding 后的标准位）优先，回退 Phase 0 的顶层 llm 三件套。 */
export async function readStoredLlmConfig(
  kv: { get<T>(key: string): Promise<T | undefined> },
): Promise<StoredLlmConfig | undefined> {
  const settings = await kv.get<{ llm?: { baseUrl?: string; modelId?: string; model?: string; apiKey?: string } }>('settings');
  const s = settings?.llm;
  if (s?.baseUrl && (s.modelId || s.model) && s.apiKey) {
    return { baseUrl: s.baseUrl, model: s.modelId ?? s.model, apiKey: s.apiKey };
  }
  const legacy = await kv.get<StoredLlmConfig>('llm');
  if (legacy?.baseUrl && legacy.model && legacy.apiKey) return legacy;
  return undefined;
}
