// Phase 0 PoC · background service worker（集成 0.2 Bili 接口层 + 0.4 LLM 客户端）
// 链路：VIDEO_SEEN(bvid) → fetchWbiKeys → view → player/wbi/v2 选轨 → 字幕直取
//       → LLM 摘要（SSE 流式，mock 或真实 OpenAI-compatible）→ console 打印。
// E2E 标记协议（scripts/e2e-poc.mjs 依赖）：E2E view ok / E2E subtitle ok / E2E llm ok / E2E CHAIN DONE / E2E FAIL。
import { BiliClient } from '../src/lib/bilibili/client';
import { selectTrack } from '../src/lib/bilibili/track';
import { resolveConfig, summarize } from '../src/lib/llm/summary';
import type { StoredLlmConfig } from '../src/lib/llm/summary';

const seen = new Set<string>();

export default defineBackground(() => {
  console.log('[doubao-poc] background ready');

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; bvid?: string | null };
    if (m?.type === 'PING') return Promise.resolve({ pong: true });
    if (m?.type === 'VIDEO_SEEN' && m.bvid) void runChain(m.bvid);
    return undefined; // 未识别消息交给其它 listener
  });
});

/** PoC 触发=进页面即跑（幂等：每视频每会话一次）；Phase 1 换 watcher 的 20s 有效观看触发。 */
async function runChain(bvid: string): Promise<void> {
  if (seen.has(bvid)) return;
  seen.add(bvid);
  const t0 = Date.now();
  try {
    const client = new BiliClient(); // credentials:'include' 内置：扩展宿主下自动带登录 Cookie
    await client.fetchWbiKeys();
    const view = await client.getView(bvid);
    console.log(`[doubao-poc] E2E view ok: "${view.title.slice(0, 30)}" dur=${view.duration}s cid=${view.cid}`);

    const { subtitles } = await client.getPlayerSubtitles(bvid, view.cid);
    const track = selectTrack(subtitles);
    if (!track?.subtitle_url) {
      console.log(
        `[doubao-poc] E2E FAIL subtitle: 无可用轨（tracks=${subtitles.length}；有轨样本出现此错误=登录态未带上）`,
      );
      return;
    }
    const cues = await client.fetchTranscript(track.subtitle_url);
    console.log(`[doubao-poc] E2E subtitle ok: cues=${cues.length} lan=${track.lan}`);

    const stored = ((await browser.storage.local.get('llm'))['llm'] ?? undefined) as
      | StoredLlmConfig
      | undefined;
    const { config } = resolveConfig(stored);
    if (!config) {
      console.log('[doubao-poc] E2E FAIL llm: 未配置（storage.local.llm 三件套或构建期 POC_LLM_* 环境变量）');
      return;
    }
    const transcript = cues.map((c) => `[${mmss(c.from)}]${c.content}`).join('\n');
    const out = await summarize(
      config,
      { title: view.title, duration: view.duration, cueCount: cues.length },
      transcript,
    );
    if (out.summaryResult) {
      const r = out.summaryResult;
      console.log(
        `[doubao-poc] E2E llm ok: degraded=false rating=${r.rating} summaryChars=${r.summary.length}` +
          ` attempts=${out.attempts} ttft=${out.ttftMs}ms outline=${r.outline.length}条`,
      );
      console.log(`[doubao-poc] 摘要：${r.summary}`);
      console.log(`[doubao-poc] 豆包说：${r.evaluation}（${r.rating}🫘）`);
    } else {
      console.log(
        `[doubao-poc] E2E llm ok: degraded=true chars=${out.plainText?.length ?? 0} attempts=${out.attempts}`,
      );
    }
    console.log(`[doubao-poc] E2E CHAIN DONE bvid=${bvid} in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`[doubao-poc] E2E FAIL ${String(e).slice(0, 300)}`);
  }
}

function mmss(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
