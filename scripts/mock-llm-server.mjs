#!/usr/bin/env node
// 独立 mock LLM SSE 服务器（Phase 0 / E2E 用）：node scripts/mock-llm-server.mjs [port]
// 行为：GET /health → 200 ok；POST /chat/completions 需 Bearer 头；
//   messages 含 "BADJSON" → 首轮坏 JSON、重发轮返回合法（验证带错重发）；
//   含 "ALWAYS_BAD" → 恒坏 JSON（验证降级）；否则返回合法 SummaryResult JSON。
// 全响应带 CORS 头（MV3 service worker 跨源 + Authorization 预检），OPTIONS → 204。不写任何文件。
import http from 'node:http';

const port = Number(process.argv[2] ?? 8787);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

const validPayload = () =>
  JSON.stringify({
    // 16 字 ×10=160 字（150-300）；21 字 ×2=42 字（40-80），与 src/lib/llm/summary.ts 的校验口径一致
    summary: '这是一段用于测试的客观视频摘要。'.repeat(10),
    outline: Array.from({ length: 8 }, (_, i) => ({ time: i * 60, text: `第${i + 1}段要点：内容概述` })),
    evaluation: '本豆锐评：节奏尚可但有点水，豆沙含量一般。'.repeat(2),
    rating: 4,
  });
const badPayload = () => '这不是JSON{{{「summary": "oops 截断了';

const rounds = new Map(); // BADJSON 轮次计数（首轮坏、二轮好）
const bump = (k) => {
  const n = (rounds.get(k) ?? 0) + 1;
  rounds.set(k, n);
  return n;
};

function sse(res, text) {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const chunks = text.match(/.{1,40}/gs) ?? []; // ≥5 个 data: chunk
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
      i += 1;
      setTimeout(tick, 10);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 567 } })}\n\n`); // usage 在最后一个 chunk
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  tick();
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method === 'POST' && req.url === '/chat/completions') {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || auth.slice(7).trim() === '') {
      res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"missing or invalid Bearer token"}}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let text = '';
      try {
        text = (JSON.parse(body).messages ?? []).map((m) => m.content ?? '').join('\n');
      } catch {
        text = body;
      }
      if (text.includes('ALWAYS_BAD')) return sse(res, badPayload());
      if (text.includes('BADJSON') && bump('BADJSON') === 1) return sse(res, badPayload());
      sse(res, validPayload());
    });
    return;
  }
  res.writeHead(404, CORS);
  res.end('not found');
});

server.listen(port, () => {
  console.log(`ready port=${server.address().port}`); // E2E 脚本依赖此行
});
