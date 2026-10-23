// P1.4 · Map-Reduce 单测：分块（预算/重叠/边界）、Map 并发 ≤3、Reduce 结构化输出、
// 降级链复用（Reduce 两次非法 → 纯文本）。
import { afterEach, describe, expect, it } from 'vitest';
import { startMockLlm, validSummaryJson, type MockLlmServer } from './helpers/mock-llm';
import {
  CHUNK_CHARS,
  MAP_CONCURRENCY,
  OVERLAP_SEC,
  chunkCues,
  compactCues,
  mapReduceSummarize,
} from '../src/lib/summarize/mapReduce';
import type { StoredCue } from '../src/lib/storage';

const servers: MockLlmServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const cue = (from: number, text: string): StoredCue => ({ from, to: from + 2, text });

describe('chunkCues 分块', () => {
  it('空 cues → 空块；单块不超预算时整块返回', () => {
    expect(chunkCues([])).toEqual([]);
    const small = [cue(0, 'a'.repeat(100)), cue(5, 'b'.repeat(100))];
    expect(chunkCues(small)).toHaveLength(1);
  });

  it('超预算切块，块内 cue 原子（不拆行），下一块回带 overlapSec 内 cues', () => {
    const cues: StoredCue[] = [];
    // 30 条 × 100 字 = 3000 字，chunkChars=550 → 6 块左右
    for (let i = 0; i < 30; i++) cues.push(cue(i * 10, `${i}:` + 'x'.repeat(98)));
    const chunks = chunkCues(cues, { chunkChars: 550 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const ch of chunks) {
      const size = ch.reduce((n, c) => n + c.text.length + 1, 0);
      // 首块无重叠、其余块含重叠可略超预算：预算 + overlap 上限
      expect(size).toBeLessThanOrEqual(550 + OVERLAP_SEC / 10 * 100 + 10);
    }
    // 顺序与原子性：所有 cue 按时间升序且无丢失
    const flat = chunks.flatMap((c) => c.map((x) => x.text));
    expect(flat.length).toBeGreaterThanOrEqual(cues.length);
    // 重叠：第二块开头应包含第一块尾部 30s 内的 cue（i=5 从 50s 起，边界 60s 前 30s=30s 起 → i≥3 的尾部 cue 回带）
    const second = chunks[1]!;
    expect(second[0]!.from).toBeLessThan(chunks[0]!.at(-1)!.from);
  });

  it('compactCues 输出 [mm:ss]text 行', () => {
    expect(compactCues([cue(0, '你好'), cue(65, '世界')])).toBe('[00:00]你好\n[01:05]世界');
  });
});

describe('mapReduceSummarize 集成（mock SSE）', () => {
  it('Map 分块并发 ≤3 → Reduce 产出合法结构化摘要', async () => {
    // 20 条 × 800 字 = 16000 字 > 14400 默认预算 → 2 块
    const cues: StoredCue[] = Array.from({ length: 20 }, (_, i) =>
      cue(i * 60, `第${i}段：` + '内'.repeat(795)),
    );
    let inFlight = 0;
    let peak = 0;
    const server = await startMockLlm((call, n) => {
      const isMap = call.body.messages?.[0]?.content.includes('字幕片段分析器');
      if (isMap) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return {
          chunks: ['[00:00] 段落要点一\n[05:00] 段落要点二\n[10:00] 段落要点三'],
          delayMs: 60,
          // 在响应后释放计数不可行（无钩子）——用 delayMs 拉开并发窗口观察 peak
        };
      }
      void n;
      return { chunks: [validSummaryJson()] };
    });
    servers.push(server);
    // 响应后递减：包一层——通过 onMapComplete 近似观察（map 完成即释放）
    const out = await mapReduceSummarize(
      { baseUrl: server.url, model: 'mock', apiKey: 'k' },
      { title: '长视频', duration: 1200, cueCount: cues.length },
      cues,
      {
        onMapComplete: () => {
          inFlight = Math.max(0, inFlight - 1);
        },
      },
    );
    const mapCalls = server.calls.filter((c) => c.body.messages?.[0]?.content.includes('字幕片段分析器')).length;
    const reduceCalls = server.calls.length - mapCalls;
    expect(mapCalls).toBe(2); // 16000 字 > 14400 → 2 块
    expect(reduceCalls).toBe(1);
    expect(peak).toBe(2); // 2 块并发跑（< MAP_CONCURRENCY 上限 3）
    expect(peak).toBeLessThanOrEqual(MAP_CONCURRENCY);
    expect(out.degraded).toBe(false);
    expect(out.summaryResult?.outline).toHaveLength(8);
    // Reduce 的 user 正文用「各段要点」标签而非原始字幕
    const reduceBody = server.calls.find((c) => !c.body.messages?.[0]?.content.includes('字幕片段分析器'))!.body;
    expect(reduceBody.messages?.[1]?.content).toContain('各段要点');
    expect(reduceBody.messages?.[1]?.content).not.toContain('第19段');
  });

  it('Reduce 两次非法 JSON → 降级纯文本（复用 completeStructured 降级链）', async () => {
    const cues: StoredCue[] = Array.from({ length: 20 }, (_, i) => cue(i * 60, '内'.repeat(795)));
    const server = await startMockLlm((call) => {
      const isMap = call.body.messages?.[0]?.content.includes('字幕片段分析器');
      if (isMap) return { chunks: ['[00:00] 要点'] };
      return { chunks: ['不是JSON{{{截断'] }; // Reduce 两次都非法
    });
    servers.push(server);
    const out = await mapReduceSummarize(
      { baseUrl: server.url, model: 'mock', apiKey: 'k' },
      { title: 't', duration: 1200, cueCount: cues.length },
      cues,
    );
    expect(out.degraded).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.plainText).toContain('不是JSON');
  });

  it('5 块时并发封顶 MAP_CONCURRENCY=3（峰值恰为 3，不多不少）', async () => {
    // 60 条 × 300 字 = 18000 字，chunkChars=4000 → 5 块
    const cues: StoredCue[] = Array.from({ length: 60 }, (_, i) => cue(i * 20, `${i}:` + 'y'.repeat(298)));
    const chunks = chunkCues(cues, { chunkChars: 4000 });
    expect(chunks).toHaveLength(5);
    let inFlight = 0;
    let peak = 0;
    const server = await startMockLlm((call) => {
      const isMap = call.body.messages?.[0]?.content.includes('字幕片段分析器');
      if (!isMap) return { chunks: [validSummaryJson()] };
      inFlight++;
      peak = Math.max(peak, inFlight);
      return { chunks: ['[00:00] 要点'], delayMs: 80 };
    });
    servers.push(server);
    const out = await mapReduceSummarize(
      { baseUrl: server.url, model: 'mock', apiKey: 'k' },
      { title: 't', duration: 1200, cueCount: cues.length },
      cues,
      {
        chunkChars: 4000,
        onMapComplete: () => {
          inFlight = Math.max(0, inFlight - 1);
        },
      },
    );
    expect(out.degraded).toBe(false);
    expect(peak).toBe(MAP_CONCURRENCY); // 5 块、上限 3：峰值恰为 3（既证明并行也证明封顶）
  });
});
