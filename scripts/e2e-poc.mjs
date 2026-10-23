#!/usr/bin/env node
// Phase 0 · 任务 0.5 扩展端到端真机验证（E2E）
//
// 链路：pnpm build（注入 mock LLM 地址）→ 干净临时 user-data-dir
//   → headless Chrome for Testing + --load-extension（branded Chrome 137+ 屏蔽该开关）
//   → 登录态注入（提取器从真实 Chrome 解密取 Cookie → bilibili.com 页 document.cookie 写入）
//   → 导航到真实视频页 → CDP 收集 page+SW console → 校验标记链 + DOM 探针 → 截图留证 → 清理。
//
// 用法：node scripts/e2e-poc.mjs [bvid]        （默认 BV1XynB6EEiM，样本清单内）
// 前置：pnpm install 已跑；真实 Chrome 已登录 B 站；CfT 已就位（.bin/，或 E2E_BROWSER 覆盖）。
//
// 端口全部动态分配（debug=0 → 读 DevToolsActivePort；mock=0 → 解析 stdout），避免与残留进程抢端口。
// 红线：只用样本清单内 BV；临时 profile 用完即删；Cookie/Key 不打印不落盘。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
// branded Chrome 137+ 屏蔽 --load-extension（首版 E2E 的教训），扩展 E2E 一律用
// Chrome for Testing（.bin/，gitignored）。可用 E2E_BROWSER 环境变量覆盖浏览器路径。
const CFT = path.join(ROOT, '.bin', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const CHROME = process.env.E2E_BROWSER || (fs.existsSync(CFT) ? CFT : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const BVID = process.argv[2] || 'BV1XynB6EEiM';
const PAGE_URL = `https://www.bilibili.com/video/${BVID}`;
const TIMEOUT_MS = 120_000;

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  requireExists(CHROME, 'Chrome（或 Chrome for Testing）');
  requireExists(path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), 'mock-llm-server.mjs（poc-llm 交付物）');

  // 1) mock LLM 服务器（CORS 就绪；port 0 动态分配，从 stdout 解析）
  const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mockStdout = '';
  mock.stdout.on('data', (d) => { mockStdout += d; process.stdout.write(`[mock] ${d}`); });
  mock.stderr.on('data', (d) => process.stderr.write(`[mock!] ${d}`));
  const mockPort = await new Promise((res, rej) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = mockStdout.match(/ready port=(\d+)/);
      if (m) { clearInterval(timer); res(Number(m[1])); }
      else if (Date.now() - t0 > 10_000) { clearInterval(timer); rej(new Error(`mock server 启动超时: ${mockStdout.slice(-200)}`)); }
    }, 150);
  });
  await waitHttp(`http://127.0.0.1:${mockPort}/health`, 10_000);
  log('mock LLM server ready on', mockPort);

  // 2) 带 mock 环境重新构建（Key=占位符，绝不入仓库）
  log('rebuilding extension with mock LLM env …');
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.npm-global/bin')}:${process.env.PATH}`,
    POC_LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
    POC_LLM_MODEL: 'mock-seed-lite',
    POC_LLM_API_KEY: 'e2e-mock-key',
  };
  const build = spawnSync('pnpm', ['build'], { cwd: ROOT, env, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`pnpm build 失败:\n${(build.stdout || '') + (build.stderr || '')}`.slice(-2000));
  requireExists(path.join(EXT_DIR, 'manifest.json'), '构建产物 manifest');

  // 3) 干净临时 user-data-dir（登录态稍后注入——不能复制 Cookie 库：
  //    CfT 与 branded Chrome 的 Keychain 密钥不同，互相解不开，等效未登录）
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-poc-e2e-'));
  log('temp profile ready:', profile);

  // 4) headless Chrome for Testing + 扩展 + CDP（debug 端口 0=动态，从 DevToolsActivePort 读回）
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; });
  // 兜底：未捕获异常也要杀子进程删 profile（12:03 事故的教训——孤儿 Chrome 会抢端口毁下一轮）
  process.on('uncaughtException', (e) => {
    console.error('[e2e] UNCAUGHT', e);
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
    try { mock.kill('SIGKILL'); } catch { /* noop */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
    process.exit(1);
  });

  try {
    const debugPort = await waitDebugPort(profile, 30_000);
    const ver = await waitJson(`http://127.0.0.1:${debugPort}/json/version`, 30_000);
    log(`chrome up (${debugPort}):`, ver.Browser);

    // --- CDP 基础设施：自动附加所有 target（含后续新建的 page 与 service worker）---
    const lines = [];
    const pageSessions = new Set(); // page session（截图/探针用）
    const sessionByTarget = new Map(); // targetId → sessionId（导航/Cookie 注入用）
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await onceEvent(ws, 'open');
    let msgId = 0;
    const pending = new Map();
    const cdp = (method, params = {}, sessionId) =>
      new Promise((res) => {
        const id = ++msgId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: `${method} timeout` } }); } }, 30_000);
      });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo: t } = m.params;
        sessionByTarget.set(t.targetId, sessionId);
        cdp('Runtime.enable', {}, sessionId).catch(() => {});
        if (t.type === 'page') {
          cdp('Page.enable', {}, sessionId).catch(() => {});
          pageSessions.add(sessionId);
        }
        log(`attached: ${t.type} ${t.url.slice(0, 80)}`);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map(renderRemote).join(' ');
        lines.push({ t: Date.now(), type: m.params.type, text });
        if (text.includes('[doubao-poc]') || m.params.type === 'error') {
          log(`console:${m.params.type}:`, text.slice(0, 220));
        }
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        const text = `EXCEPTION ${d?.text ?? ''} ${d?.exception?.description ?? ''}`.slice(0, 300);
        lines.push({ t: Date.now(), type: 'exception', text });
        log('exception:', text);
      }
    };
    // 关键：自动附加（含既有与未来 target），否则收不到任何 console（首版 E2E 的教训）
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await sleep(1500); // 等既有 target（含扩展 SW）附加完成

    // 5) 登录态注入（document.cookie 路线）：
    //    CfT 上 Storage/Network 的 Cookie CDP 命令实测挂起（Network.enable 正常），
    //    改为：先开 bilibili.com 页 → Runtime.evaluate 用 document.cookie 写入
    //    （HttpOnly 只挡 JS 读不挡发送；samesite=none+secure 保证扩展 SW 跨站请求也携带）。
    //    Cookie 值经已验证的 CDP 提取器从真实 Chrome 解密取得，仅内存管道，不打印不落盘。
    const extractor = path.join(ROOT, '..', 'scripts', 'poc', 'cdp_cookies.js');
    requireExists(extractor, 'cdp_cookies.js（docs 仓库 scripts/poc，07 报告 G-5 已验证路径）');
    const ex = spawnSync(process.execPath, [extractor], { encoding: 'utf8', timeout: 180_000 });
    if (ex.status !== 0 || !ex.stdout.trim()) {
      throw new Error(`Cookie 提取失败（rc=${ex.status}）：${(ex.stderr || '').slice(-400)}`);
    }
    const jar = JSON.parse(ex.stdout);
    const cookiePairs = Object.entries(jar.cookies || {});
    if (!cookiePairs.some(([n]) => n === 'SESSDATA')) throw new Error('提取结果缺 SESSDATA——真实 Chrome 未登录？');

    const landing = await cdp('Target.createTarget', { url: 'https://www.bilibili.com/' });
    const landingId = landing.result?.targetId;
    let landingSid = null;
    for (let i = 0; i < 40 && !landingSid; i++) {
      await sleep(250);
      landingSid = sessionByTarget.get(landingId) ?? null;
    }
    if (!landingSid) throw new Error('landing 页未 attach');
    await sleep(3000); // 等基本加载完成

    const setExpr =
      '(() => { const cs = ' + JSON.stringify(cookiePairs.map(([n, v]) => [n, String(v)])) + ';' +
      ' for (const [n, v] of cs) document.cookie = n + "=" + v + "; domain=.bilibili.com; path=/; secure; samesite=none";' +
      ' return document.cookie.split(";").filter(s=>s.trim()).length; })()';
    const setRes = await cdp('Runtime.evaluate', { expression: setExpr, returnByValue: true }, landingSid);
    const cookieCount = setRes?.result?.result?.value;
    const readback = await cdp('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true }, landingSid);
    const ok = String(readback?.result?.result?.value ?? '').includes('SESSDATA=');
    log(`登录态注入 ${cookiePairs.length} 个 cookie（document.cookie 回读 ${cookieCount} 条，SESSDATA 可见=${ok}）`);
    if (!ok) throw new Error('document.cookie 写入后回读不到 SESSDATA——注入失败');

    // 6) 同一 tab 导航到视频页（cookie 已在 jar 里）
    const nav = await cdp('Page.navigate', { url: PAGE_URL }, landingSid);
    log('navigate →', PAGE_URL, nav.result?.frameId ? 'ok' : JSON.stringify(nav.error ?? nav.result));

    // 7) 等标记链
    const t0 = Date.now();
    let outcome = 'timeout';
    while (Date.now() - t0 < TIMEOUT_MS) {
      await sleep(500);
      if (lines.some((l) => l.text.includes('E2E CHAIN DONE'))) { outcome = 'done'; break; }
      if (lines.some((l) => l.text.includes('E2E FAIL'))) { outcome = 'fail'; break; }
    }

    // 8) DOM 探针：豆包是否真的注入（不依赖 console 的第二证据）
    let mascotInjected = null;
    const probeSid = [...pageSessions].pop();
    if (probeSid) {
      const r = await cdp('Runtime.evaluate', { expression: '!!document.getElementById("doubao-poc-host")', returnByValue: true }, probeSid);
      mascotInjected = r?.result?.result?.value ?? null;
      log('DOM 探针 doubao-poc-host 存在 =', mascotInjected);
    }

    // 9) 截图与 console 留证
    const shot = path.join(ROOT, 'e2e-artifacts');
    fs.mkdirSync(shot, { recursive: true });
    let shotSaved = 0;
    for (const sid of pageSessions) {
      try {
        const r = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
        if (r?.result?.data) {
          fs.writeFileSync(path.join(shot, `page-${sid.slice(0, 6)}.png`), Buffer.from(r.result.data, 'base64'));
          shotSaved++;
        }
      } catch { /* 非 page session */ }
    }
    fs.writeFileSync(path.join(shot, 'console.json'), JSON.stringify({ outcome, bvid: BVID, url: PAGE_URL, lines }, null, 1));
    log(`console lines: ${lines.length}, screenshots: ${shotSaved}, saved to e2e-artifacts/`);

    // 10) 判定
    const has = (s) => lines.some((l) => l.text.includes(s));
    const verdict = {
      contentInjected: has('content script injected'),
      bvid: has(`bvid = ${BVID}`),
      mascotDomInjected: mascotInjected === true,
      view: has('E2E view ok'),
      subtitle: has('E2E subtitle ok'),
      llm: has('E2E llm ok'),
      chainDone: has('E2E CHAIN DONE'),
      noExplicitFail: !has('E2E FAIL'),
    };
    console.log('\n=== E2E 判定 ===');
    for (const [k, v] of Object.entries(verdict)) console.log(`  ${v ? '✅' : '❌'} ${k}`);
    const pass = Object.values(verdict).every(Boolean);
    console.log(pass ? '\n✅ E2E PASS' : `\n❌ E2E FAIL (outcome=${outcome})`);
    if (!pass) {
      console.log('--- chrome stderr tail ---\n' + chromeErr.slice(-600));
      console.log('--- doubao-poc 相关 console ---\n' + (lines.filter((l) => l.text.includes('[doubao-poc]')).map((l) => `${l.type} ${l.text}`).join('\n') || '（无）'));
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

/** Chrome 以 --remote-debugging-port=0 启动后，把实际端口写进 <profile>/DevToolsActivePort 首行。 */
async function waitDebugPort(profile, ms) {
  const p = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  for (;;) {
    try {
      const first = fs.readFileSync(p, 'utf8').split('\n')[0].trim();
      const port = Number(first);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* 尚未写出 */ }
    if (Date.now() - t0 > ms) throw new Error(`等待 DevToolsActivePort 超时: ${p}`);
    await sleep(250);
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
