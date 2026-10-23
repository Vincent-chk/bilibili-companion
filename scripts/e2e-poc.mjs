#!/usr/bin/env node
// Phase 0 · 任务 0.5 扩展端到端真机验证（E2E）
//
// 链路：pnpm build（注入 mock LLM 地址）→ 复制登录 Cookie 的临时 user-data-dir
//   → headless Chrome 155 + --load-extension → 打开真实 B 站视频页
//   → CDP 收集 page + service worker 双端 console → 校验标记链 → 截图留证 → 清理。
//
// 用法：node scripts/e2e-poc.mjs [bvid]        （默认 BV1XynB6EEiM，样本清单内）
// 前置：pnpm install 已跑；Chrome 已登录 B 站（复制其加密 Cookie 库，Chrome 自行解密——CDP 路已验证）。
//
// 红线：只用样本清单内 BV；临时 profile 用完即删；不打印任何 Cookie/Key。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOCK_PORT = 8791;
const DEBUG_PORT = 9339;
const BVID = process.argv[2] || 'BV1XynB6EEiM';
const PAGE_URL = `https://www.bilibili.com/video/${BVID}`;
const TIMEOUT_MS = 90_000;

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  requireExists(CHROME, 'Chrome');
  requireExists(path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), 'mock-llm-server.mjs（poc-llm 交付物）');

  // 1) 起 mock LLM 服务器（CORS 就绪，等 poc-llm 交付）
  const mock = spawn('node', [path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), String(MOCK_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`));
  mock.stderr.on('data', (d) => process.stderr.write(`[mock!] ${d}`));
  await waitHttp(`http://127.0.0.1:${MOCK_PORT}/health`, 10_000);
  log('mock LLM server ready on', MOCK_PORT);

  // 2) 带 mock 环境重新构建（Key=占位符，绝不入仓库）
  log('rebuilding extension with mock LLM env …');
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.npm-global/bin')}:${process.env.PATH}`,
    POC_LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    POC_LLM_MODEL: 'mock-seed-lite',
    POC_LLM_API_KEY: 'e2e-mock-key',
  };
  const build = spawnSync('pnpm', ['build'], { cwd: ROOT, env, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`pnpm build 失败:\n${(build.stdout || '') + (build.stderr || '')}`.slice(-2000));
  requireExists(path.join(EXT_DIR, 'manifest.json'), '构建产物 manifest');

  // 3) 临时 user-data-dir：只复制加密 Cookie 库（Chrome 自己解密；用完删除）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-poc-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  const srcCookies = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies');
  requireExists(srcCookies, 'Chrome 登录 Cookie 库');
  fs.copyFileSync(srcCookies, path.join(profile, 'Default', 'Cookies'));
  for (const s of ['-journal', '-wal', '-shm']) {
    if (fs.existsSync(srcCookies + s)) fs.copyFileSync(srcCookies + s, path.join(profile, 'Default', 'Cookies' + s));
  }
  log('temp profile ready (cookies copied, encrypted-at-rest):', profile);

  // 4) headless Chrome + 扩展 + CDP
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });

  try {
    const ver = await waitJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20_000);
    log('chrome up:', ver.Browser);

    const lines = [];
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await onceEvent(ws, 'open');
    let msgId = 0;
    const pending = new Map();
    const sessions = new Set();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') {
        const t = m.params.targetInfo;
        if ((t.type === 'page' && t.url.startsWith('devtools') === false && t.url !== 'about:blank' && t.url.includes('bilibili'))
          || (t.type === 'service_worker' && t.url.includes('background'))) {
          cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        }
      }
      if (m.method === 'Target.attachedToTarget') {
        const sid = m.params.sessionId;
        if (!sessions.has(sid)) {
          sessions.add(sid);
          cdp('Runtime.enable', {}, sid).catch(() => {});
        }
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map(renderRemote).join(' ');
        lines.push({ t: Date.now(), from: m.sessionId?.slice(0, 8), type: m.params.type, text });
        if (m.params.type !== 'log' || text.includes('[doubao-poc]')) log(`console:${m.params.type}:`, text.slice(0, 300));
      }
    };
    const cdp = (method, params = {}, sessionId) => new Promise((res) => {
      const id = ++msgId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    // 打开视频页
    const { result: page } = await cdp('Target.createTarget', { url: PAGE_URL });
    log('opened page target', page.targetId, PAGE_URL);

    // 等标记链
    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < TIMEOUT_MS) {
      await sleep(500);
      if (lines.some((l) => l.text.includes('E2E CHAIN DONE'))) { done = true; break; }
      if (lines.some((l) => l.text.includes('E2E FAIL'))) break;
    }

    // 截图留证（找到 bilibili 页面的 session）
    const shot = path.join(ROOT, 'e2e-artifacts');
    fs.mkdirSync(shot, { recursive: true });
    for (const sid of sessions) {
      try {
        const r = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
        if (r?.result?.data) {
          fs.writeFileSync(path.join(shot, `page-${sid.slice(0, 6)}.png`), Buffer.from(r.result.data, 'base64'));
        }
      } catch { /* 该 session 不是 page */ }
    }
    fs.writeFileSync(path.join(shot, 'console.json'), JSON.stringify(lines, null, 1));
    log(`console lines captured: ${lines.length}, saved to e2e-artifacts/`);

    // 判定
    const has = (s) => lines.some((l) => l.text.includes(s));
    const verdict = {
      contentInjected: has('content script injected'),
      bvid: has(`bvid = ${BVID}`),
      view: has('E2E view ok'),
      subtitle: has('E2E subtitle ok'),
      llm: has('E2E llm ok'),
      chainDone: has('E2E CHAIN DONE'),
      fail: has('E2E FAIL'),
    };
    console.log('\n=== E2E 判定 ===');
    for (const [k, v] of Object.entries(verdict)) console.log(`  ${v ? '✅' : '❌'} ${k}`);
    const pass = verdict.contentInjected && verdict.bvid && verdict.view && verdict.subtitle && verdict.llm && verdict.chainDone && !verdict.fail;
    console.log(pass ? '\n✅ E2E PASS' : '\n❌ E2E FAIL');
    if (!pass) {
      console.log('--- chrome stderr tail ---\n' + chromeErr.slice(-800));
      console.log('--- 最后 20 条 console ---\n' + lines.slice(-20).map((l) => `${l.type} ${l.text}`).join('\n'));
    }
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { chrome.kill('SIGTERM'); } catch { /* noop */ }
    await sleep(1200);
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
    try { mock.kill('SIGTERM'); } catch { /* noop */ }
    fs.rmSync(profile, { recursive: true, force: true });
    log('cleanup done (temp profile removed:', !fs.existsSync(profile), ')');
  }
}

function renderRemote(r) {
  if (r?.value !== undefined) return typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  if (r?.description) return r.description;
  return r?.type ?? '';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onceEvent = (em, name) => new Promise((res, rej) => {
  em.addEventListener(name, res, { once: true });
  em.addEventListener('error', rej, { once: true });
});
function requireExists(p, what) { if (!fs.existsSync(p)) throw new Error(`缺少 ${what}: ${p}`); }
async function waitJson(url, ms) { const r = await waitHttp(url, ms); return r.json(); }
async function waitHttp(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* retry */ }
    if (Date.now() - t0 > ms) throw new Error(`等待超时: ${url}`);
    await sleep(300);
  }
}

main().catch((e) => { console.error('[e2e] FATAL', e); process.exitCode = 1; });
