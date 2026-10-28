import type { LlmConfig, LlmMessage, StreamEvent, SummaryResult } from './types';
import { streamChatCompletion } from './client';

// Key 保存在 chrome.storage.local；不写源码、构建产物、Dexie 或日志。

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
  outlineCoverage?: { from: number; to: number };
}

/** 紧凑内容（[mm:ss]文本行）由调用方拼好传入，lib 层不碰 bilibili 数据源。 */
export function buildSummaryMessages(
  videoMeta: SummaryVideoMeta,
  transcriptText: string,
  mo: SummaryMessagesOptions = {},
): LlmMessage[] {
  const label = mo.bodyLabel ?? '紧凑字幕（[mm:ss]文本）';
  const coverage = mo.outlineCoverage;
  const coverageHint = coverage ? `\n这是长视频。字幕实际范围为 ${Math.floor(coverage.from)}–${Math.floor(coverage.to)} 秒。先通读全部内容，再将全片章节合并为 6–12 条大纲；必须同时覆盖前段、中段和最后四分之一的内容，不能只用开头细节凑满条数。每条仍须使用该内容的真实时间戳，禁止为满足覆盖范围而虚构时间。` : '';
  const user = `视频标题：${videoMeta.title}\n时长：${videoMeta.duration}秒\n字幕条数：${videoMeta.cueCount}${coverageHint}\n\n${label}：\n${transcriptText}`;
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

/** 避免将截断的结构化模型输出当作正文；也识别旧版本已保存的原始 JSON。 */
export function looksLikeStructuredSummary(raw: string): boolean {
  const text = raw.trim();
  return /^(?:```(?:json)?\s*)?\{\s*"(?:summary|outline|evaluation|rating)"\s*:/i.test(text);
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
  /** 长视频按实际字幕范围检查大纲，拒绝只覆盖开头的结果。 */
  outlineCoverage?: { from: number; to: number };
}

export interface SummarizeOutcome {
  degraded: boolean;
  summaryResult: SummaryResult | null;
  /** 降级时的纯文本兜底；结构化输出损坏时为 null，不展示原始 JSON。 */
  plainText: string | null;
  attempts: number;
  usage?: unknown;
  ttftMs: number | null;
}

/**
 * 结构化完成链：校验失败带错重发 1 次；优先保留结构完整的结果，损坏的 JSON 不作为正文。
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
  let usable: SummaryResult | null = null;
  for (let attempt = 1; ; attempt++) {
    const r = await run(messages);
    const { value, error } = parseSummary(r.text);
    const errs = error ? [error] : validateSummary(value);
    const range = opts.outlineCoverage;
    if (value && range && Array.isArray(value.outline) && value.outline.length && value.outline.every(o => typeof o?.time === 'number' && Number.isFinite(o.time))) {
      const times = value.outline.map(o => o.time);
      const span = range.to - range.from;
      if (times.some((time, i) => time < Math.floor(range.from) || time > Math.ceil(range.to) || (i > 0 && time <= times[i - 1]!))) errs.push('outline 时间戳须位于字幕范围内并严格递增');
      if (span > 0 && (times[0]! > range.from + span * .25 || times.at(-1)! < range.from + span * .75 || !times.some(t => t >= range.from + span * .25 && t <= range.from + span * .75))) {
        errs.push(`outline 覆盖不足：需依据真实字幕同时概括前段、中段和最后四分之一（${Math.floor(range.from + span * .75)}秒以后），请合并开头细节并补充后半段章节`);
      }
    }
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
    // 字数与条数只是格式目标，不应丢弃字段完整的摘要和可用大纲。
    if (value && errs.every((e) => /^(?:summary 字数|outline 条数|evaluation 字数)/.test(e))) usable = value;
    if (attempt >= 2) {
      if (usable) return { degraded: false, summaryResult: usable, plainText: null, attempts: attempt, usage: r.usage, ttftMs: r.ttftMs };
      return {
        degraded: true,
        summaryResult: null,
        plainText: looksLikeStructuredSummary(r.text) ? null : r.text.slice(0, 600),
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
  return completeStructured(cfg, buildSummaryMessages(videoMeta, transcriptText, { persona, bodyLabel, outlineCoverage: opts.outlineCoverage }), streamOpts);
}

export interface StoredLlmConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface ResolvedConfig {
  config: LlmConfig | null;
  source: 'storage' | 'none';
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
 * 使用运行期配置（调用方从 chrome.storage.local 读取），未配置则返回可读错误。
 */
export function resolveConfig(stored?: StoredLlmConfig): ResolvedConfig {
  const timeoutMs = resolveLlmTimeoutMs();
  if (stored?.baseUrl && stored.model && stored.apiKey) {
    return { config: { baseUrl: stored.baseUrl, model: stored.model, apiKey: stored.apiKey }, source: 'storage', timeoutMs };
  }
  return {
    config: null,
    source: 'none',
    timeoutMs,
    error: '未配置 LLM：请在设置中填写 baseUrl / model / apiKey',
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
