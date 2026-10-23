// P1.4 · Offscreen 执行体：接收 background 的 OFFSCREEN_RUN_JOB，跑摘要全链路（lib/summarize/chain），
// 进度经 SUMMARY_PROGRESS 消息回流 SW（pipeline ctx 落库 jobs.stage/progress）。
// 同源扩展页：可直接开 CompanionDB（IndexedDB）与 storage.local；fetch 带 host_permissions。
import { BiliClient } from '../../src/lib/bilibili/client';
import { readStoredLlmConfig, resolveConfig } from '../../src/lib/llm/summary';
import { runSummarizeJob } from '../../src/lib/summarize/chain';
import { CompanionDB } from '../../src/lib/storage';
import { browserKv } from '../../src/lib/storage/browserKv';

const db = new CompanionDB();

interface RunJobMsg {
  type?: 'OFFSCREEN_RUN_JOB';
  job?: { id: string; videoKey: string };
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
    update: async (patch: { stage?: never; progress?: number } | { stage?: string; progress?: number }) => {
      pending = { ...(pending ?? {}), ...patch } as { stage?: string; progress?: number };
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
  if (m?.type !== 'OFFSCREEN_RUN_JOB' || !m.job?.videoKey) return undefined; // 非本品消息交给其它 listener
  return handleRun(m.job).catch((e: unknown) => ({
    result: 'failed' as const,
    error: { code: 'CHAIN_ERROR', msg: String(e).slice(0, 200) },
  }));
});

async function handleRun(job: { id: string; videoKey: string }) {
  const stored = await readStoredLlmConfig(browserKv);
  const { config, error } = resolveConfig(stored);
  if (!config) {
    return { result: 'failed' as const, error: { code: 'NO_LLM_CONFIG', msg: error ?? '未配置 LLM' } };
  }
  const settings = (await browser.storage.local.get('settings'))['settings'] as { persona?: string } | undefined;
  console.log(`[doubao] offscreen run job=${job.id} videoKey=${job.videoKey}`);
  const outcome = await runSummarizeJob(
    { db, bili: new BiliClient(), llm: config, persona: settings?.persona },
    job,
    makeCtx(job.id),
  );
  console.log(`[doubao] offscreen job=${job.id} → ${outcome.result}`);
  return outcome;
}
