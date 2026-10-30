// 测试助手：本地 mock LLM 服务器（node:http，SSE 流式），127.0.0.1 动态端口，不打真实网络。
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockLlmCall {
  body: { model?: string; messages?: { role: string; content: string }[] };
}

export interface MockLlmServer {
  url: string;
  calls: MockLlmCall[];
  close: () => Promise<void>;
}

/** chunks：该次响应的流式增量；省略 = 无 content（如纯 usage 帧）。 */
export type MockLlmResponder = (
  call: MockLlmCall,
  callsSoFar: number,
) => { status?: number; chunks?: string[]; delayMs?: number } | string;

export async function startMockLlm(respond: MockLlmResponder): Promise<MockLlmServer> {
  const calls: MockLlmCall[] = [];
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as MockLlmCall['body'];
    calls.push({ body });
    const r = respond({ body }, calls.length);
    const spec = typeof r === 'string' ? { chunks: [r] } : r;
    if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    if (spec.status && spec.status !== 200) {
      res.writeHead(spec.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock http ${spec.status}` } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    for (const c of spec.chunks ?? []) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 42 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

/** 生成一份通过 Schema 校验的合法摘要 JSON（与 tests/llm.test.ts 同口径）。 */
export const validSummaryJson = () =>
  JSON.stringify({
    summary: '这是一段用于测试的客观视频摘要。'.repeat(10), // 160 字
    outline: Array.from({ length: 8 }, (_, i) => ({ time: i === 7 ? 480 : i * 60, text: `第${i + 1}段要点：内容概述` })),
    evaluation: '本豆锐评：节奏尚可但有点水，豆沙含量一般。'.repeat(2), // 42 字
    rating: 4,
  });
