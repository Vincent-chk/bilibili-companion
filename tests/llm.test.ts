import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LlmHttpError, LlmNetworkError, streamChatCompletion } from '../src/lib/llm/client';
import { resolveConfig, summarize, validateSummary } from '../src/lib/llm/summary';

const META = { title: '测试视频', duration: 600, cueCount: 100 };
const validPayload = () =>
  JSON.stringify({
    summary: '这是一段用于测试的客观视频摘要。'.repeat(10), // 160 字
    outline: Array.from({ length: 8 }, (_, i) => ({ time: i * 60, text: `第${i + 1}段要点：内容概述` })),
    evaluation: '本豆锐评：节奏尚可但有点水，豆沙含量一般。'.repeat(2), // 42 字
    rating: 4,
  });
const BAD = () => '这不是JSON{{{「summary": "oops 截断了';

// ---- 临时 node:http 服务器（仅 127.0.0.1，不依赖外部网络） ----
const servers: http.Server[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const c of children.splice(0)) c.kill();
});

async function start(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

/** SSE 响应：payload 切 ≥5 个 data: chunk + usage chunk + [DONE]。 */
function writeSse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const piece of text.match(/.{1,60}/gs) ?? []) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 起真实 mock-llm-server.mjs（port 0），等 stdout 的 `ready port=<N>`。 */
async function startMockScript(): Promise<string> {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const child = spawn(process.execPath, [resolve(root, 'scripts/mock-llm-server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const port = await new Promise<number>((resolvePort, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`mock server 未就绪: ${out}`)), 5000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/ready port=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`mock server 退出 code=${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

describe('llm client + summary', () => {
  it('① 合法 SSE 流 → parse+校验通过 → degraded=false，usage/流式透传可用', async () => {
    const base = await start(async (req, res) => {
      await readBody(req);
      writeSse(res, validPayload());
    });
    const deltas: string[] = [];
    const out = await summarize({ baseUrl: base, model: 'mock', apiKey: 'sk-t1' }, META, '[00:00]大家好', {
      onDelta: (e) => {
        if (e.type === 'delta') deltas.push(e.text);
      },
    });
    expect(out.degraded).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.summaryResult).not.toBeNull();
    expect(validateSummary(out.summaryResult)).toEqual([]);
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20 });
    expect(deltas.join('')).toBe(validPayload());
    expect(out.ttftMs).not.toBeNull();
  });

  it('② 首轮坏 JSON → 带错误信息重发 1 次 → 通过', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const base = await start(async (req, res) => {
      bodies.push(await readBody(req));
      calls += 1;
      writeSse(res, calls === 1 ? BAD() : validPayload());
    });
    const out = await summarize({ baseUrl: base, model: 'mock', apiKey: 'sk-t2' }, META, 'BADJSON\n[00:00]大家好');
    expect(out.degraded).toBe(false);
    expect(out.attempts).toBe(2);
    expect(bodies).toHaveLength(2);
    const msgs = (JSON.parse(bodies[1]!) as { messages: { role: string; content: string }[] }).messages;
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('未通过校验');
  });

  it('③ 始终坏 JSON → 降级：degraded=true，plainText≤600 字，outline 置空（summaryResult=null）', async () => {
    const base = await start(async (req, res) => {
      await readBody(req);
      writeSse(res, BAD());
    });
    const out = await summarize({ baseUrl: base, model: 'mock', apiKey: 'sk-t3' }, META, 'ALWAYS_BAD\n[00:00]大家好');
    expect(out.degraded).toBe(true);
    expect(out.summaryResult).toBeNull();
    expect(out.plainText).not.toBeNull();
    expect(out.plainText!.length).toBeLessThanOrEqual(600);
    expect(out.plainText).toContain('这不是JSON');
    expect(out.attempts).toBe(2);
  });

  it('④ 请求头确实带 Authorization: Bearer <apiKey>', async () => {
    let auth = '';
    const base = await start(async (req, res) => {
      auth = req.headers.authorization ?? '';
      await readBody(req);
      writeSse(res, validPayload());
    });
    const apiKey = 'ark-t4-secret-key';
    await summarize({ baseUrl: base, model: 'mock', apiKey }, META, '[00:00]大家好');
    expect(auth).toBe(`Bearer ${apiKey}`);
  });

  it('⑤ SSE chunk 跨 TCP 分片（含多字节字符中间断开）能正确重组', async () => {
    const frame =
      `data: ${JSON.stringify({ choices: [{ delta: { content: '半截流水测试🫘' } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '尾段' } }] })}\n\n` +
      'data: [DONE]\n\n';
    const bytes = Buffer.from(frame, 'utf8');
    const base = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 找到第一个多字节字符的中间位置下刀，半个 JSON/半个字符分两次 write
      let cut = 30;
      while (cut < bytes.length && bytes[cut]! < 0x80) cut += 1;
      cut += 1;
      res.write(bytes.subarray(0, cut));
      setTimeout(() => {
        res.write(bytes.subarray(cut));
        res.end();
      }, 20);
    });
    const r = await streamChatCompletion({ baseUrl: base, model: 'mock', apiKey: 'sk-t5' }, [
      { role: 'user', content: 'x' },
    ]);
    expect(r.text).toBe('半截流水测试🫘尾段');
  });

  it('⑥ 非 2xx 错误 body 中含 Key 会被打码，错误只含 status + 前 200 字符', async () => {
    const apiKey = 'ark-t6-abcdef1234567890';
    const base = await start((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `The API key ${apiKey} in the request is invalid` } }));
    });
    const p = streamChatCompletion({ baseUrl: base, model: 'mock', apiKey }, [{ role: 'user', content: 'x' }]);
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmHttpError);
    const httpErr = err as LlmHttpError;
    expect(httpErr.status).toBe(401);
    expect(httpErr.message).not.toContain(apiKey);
    expect(httpErr.body).not.toContain(apiKey);
    expect(httpErr.body).toContain('***');
    expect(httpErr.body.length).toBeLessThanOrEqual(200);
  });

  it('⑦ 服务端不响应 → 超时归类为 LlmNetworkError', async () => {
    const base = await start(async (req) => {
      await readBody(req); // 收下请求但永不响应
    });
    const p = streamChatCompletion({ baseUrl: base, model: 'mock', apiKey: 'sk-t7' }, [{ role: 'user', content: 'x' }], { timeoutMs: 30 });
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect((err as LlmNetworkError).message).toContain('超时');
  });

  it('⑧ resolveConfig：storage 优先；都没有 → null + 可读错误', () => {
    const stored = { baseUrl: 'http://x', model: 'm', apiKey: 'k' };
    expect(resolveConfig(stored).config).toEqual(stored);
    expect(resolveConfig(stored).source).toBe('storage');
    const none = resolveConfig();
    expect(none.config).toBeNull();
    expect(none.source).toBe('none');
    expect(none.error).toBeTruthy();
  });
});

describe('mock-llm-server.mjs（真实脚本）', () => {
  it('⑨ OPTIONS 预检 → 204 且带 CORS 头', async () => {
    const base = await startMockScript();
    const res = await fetch(`${base}/chat/completions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('⑩ BADJSON 首轮坏/二轮好：summarize 经真实脚本两轮通过', async () => {
    const base = await startMockScript();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const out = await summarize({ baseUrl: base, model: 'mock', apiKey: 'sk-mock-e2e' }, META, 'BADJSON\n[00:00]大家好');
    expect(out.degraded).toBe(false);
    expect(out.attempts).toBe(2);
    expect(validateSummary(out.summaryResult)).toEqual([]);
  });
});
