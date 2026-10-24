// P1.4 · Offscreen 执行体：接收 background 的 OFFSCREEN_RUN_JOB（含 LLM 配置与人设），
// 跑摘要全链路（lib/summarize/chain），进度经 SUMMARY_PROGRESS 消息回流 SW。
// 同源扩展页：可直接开 CompanionDB（IndexedDB）；fetch 带 host_permissions。
// 注意：offscreen 文档 API 受限（实测 chrome.storage/browser.storage 均不可用），
// 因此 LLM 配置与 persona 由 SW 解析后随消息传入，offscreen 不读 storage。
import { browser } from 'wxt/browser';
import { BiliClient } from '../../src/lib/bilibili/client';
import { runSummarizeJob } from '../../src/lib/summarize/chain';
import { runSegmentJob } from '../../src/lib/summarize/segment';
import { CompanionDB } from '../../src/lib/storage';
import type { LlmConfig } from '../../src/lib/llm/types';

const db = new CompanionDB();

interface RunJobMsg {
  type?: 'OFFSCREEN_RUN_JOB';
  job?: { id: string; videoKey: string; type?: string; segIndex?: number };
  llm?: LlmConfig;
  persona?: string;
  /** 整流超时（SW resolveConfig 解析，思考型真实模型 > 默认 60s）。 */
  timeoutMs?: number;
}

/** 进度回传节流：token 级 delta 高频，200ms 合并一次防消息风暴（stage/progress/deltaText 共用）。
 *  P1.11：segIndex 非空时消息类型改 SEGMENT_PROGRESS（分段解读流式通道）。 */
function makeCtx(jobId: string, segIndex?: number) {
  const msgType = segIndex !== undefined ? 'SEGMENT_PROGRESS' : 'SUMMARY_PROGRESS';
  let lastSentAt = 0;
  let pending: { stage?: string; progress?: number; deltaText?: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const payload = { jobId, ...(segIndex !== undefined ? { segIndex } : {}), ...pending };
    pending = null;
    void browser.runtime.sendMessage({ type: msgType, ...payload }).catch(() => {});
  };
  const schedule = () => {
    const now = Date.now();
    if (now - lastSentAt >= 200) {
      lastSentAt = now;
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, 200);
    }
  };
  return {
    update: async (patch: { stage?: string; progress?: number }) => {
      pending = { ...(pending ?? {}), ...patch };
      schedule();
    },
    /** P1.5：LLM 流式增量缓冲（deltaText 累计到下次 flush 一并发出）。 */
    pushDelta: (text: string) => {
      pending = { ...(pending ?? {}), deltaText: (pending?.deltaText ?? '') + text };
      schedule();
    },
  };
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as RunJobMsg;
  if (m?.type !== 'OFFSCREEN_RUN_JOB' || !m.job?.videoKey || !m.llm) return undefined; // 非本品消息交给其它 listener
  return handleRun(m.job, m.llm, m.persona, m.timeoutMs).catch((e: unknown) => ({
    result: 'failed' as const,
    error: { code: 'CHAIN_ERROR', msg: String(e).slice(0, 200) },
  }));
});

async function handleRun(
  job: { id: string; videoKey: string; type?: string; segIndex?: number },
  llm: LlmConfig,
  persona?: string,
  timeoutMs?: number,
) {
  console.log(
    `[doubao] offscreen run job=${job.id} videoKey=${job.videoKey}${job.type === 'SEGMENT_ANALYZE' ? ` seg=${job.segIndex}` : ''}`,
  );
  const ctx = makeCtx(job.id, job.segIndex);
  const outcome =
    job.type === 'SEGMENT_ANALYZE'
      ? job.segIndex === undefined
        ? {
            result: 'failed' as const,
            error: { code: 'BAD_JOB', msg: 'SEGMENT_ANALYZE 缺 segIndex（审查 P2-9：不得静默解读第 0 段写脏缓存）' },
          }
        : await runSegmentJob(
            { db, bili: new BiliClient(), llm, timeoutMs, onDelta: (t) => ctx.pushDelta(t) },
            { videoKey: job.videoKey, segIndex: job.segIndex },
            ctx,
          )
      : await runSummarizeJob(
          { db, bili: new BiliClient(), llm, persona, timeoutMs, onDelta: (t) => ctx.pushDelta(t) },
          job,
          ctx,
          { force: job.type === 'REGENERATE' }, // 2.7a：重新生成绕过 done 缓存，成功整行覆盖
        );
  console.log(`[doubao] offscreen job=${job.id} → ${outcome.result}`);
  return outcome;
}
