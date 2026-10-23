// P1.4 · Offscreen 执行体：接收 background 的 OFFSCREEN_RUN_JOB（含 LLM 配置与人设），
// 跑摘要全链路（lib/summarize/chain），进度经 SUMMARY_PROGRESS 消息回流 SW。
// 同源扩展页：可直接开 CompanionDB（IndexedDB）；fetch 带 host_permissions。
// 注意：offscreen 文档 API 受限（实测 chrome.storage/browser.storage 均不可用），
// 因此 LLM 配置与 persona 由 SW 解析后随消息传入，offscreen 不读 storage。
import { browser } from 'wxt/browser';
import { BiliClient } from '../../src/lib/bilibili/client';
import { runSummarizeJob } from '../../src/lib/summarize/chain';
import { CompanionDB } from '../../src/lib/storage';
import type { LlmConfig } from '../../src/lib/llm/types';

const db = new CompanionDB();

interface RunJobMsg {
  type?: 'OFFSCREEN_RUN_JOB';
  job?: { id: string; videoKey: string };
  llm?: LlmConfig;
  persona?: string;
}

/** 进度回传节流：token 级 delta 高频，200ms 合并一次防消息风暴。 */
function makeCtx(jobId: string) {
  let lastSentAt = 0;
  let pending: { stage?: string; progress?: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const payload = { jobId, ...pending };
    pending = null;
    void browser.runtime.sendMessage({ type: 'SUMMARY_PROGRESS', ...payload }).catch(() => {});
  };
  return {
    update: async (patch: { stage?: string; progress?: number }) => {
      pending = { ...(pending ?? {}), ...patch };
      const now = Date.now();
      if (now - lastSentAt >= 200) {
        lastSentAt = now;
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, 200);
      }
    },
  };
}

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as RunJobMsg;
  if (m?.type !== 'OFFSCREEN_RUN_JOB' || !m.job?.videoKey || !m.llm) return undefined; // 非本品消息交给其它 listener
  return handleRun(m.job, m.llm, m.persona).catch((e: unknown) => ({
    result: 'failed' as const,
    error: { code: 'CHAIN_ERROR', msg: String(e).slice(0, 200) },
  }));
});

async function handleRun(job: { id: string; videoKey: string }, llm: LlmConfig, persona?: string) {
  console.log(`[doubao] offscreen run job=${job.id} videoKey=${job.videoKey}`);
  const outcome = await runSummarizeJob(
    { db, bili: new BiliClient(), llm, persona },
    job,
    makeCtx(job.id),
  );
  console.log(`[doubao] offscreen job=${job.id} → ${outcome.result}`);
  return outcome;
}
