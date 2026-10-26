#!/usr/bin/env node
// 扩展端到端真机验证（E2E）· Phase 0 任务 0.5 建立，P1.4 起驱动真实触发链
//
// 链路：pnpm build（注入 mock LLM 地址）→ 干净临时 user-data-dir
//   → headless Chrome for Testing + --load-extension（branded Chrome 137+ 屏蔽该开关）
//   → 登录态注入（提取器从真实 Chrome 解密取 Cookie → bilibili.com 页 document.cookie 写入）
//   → SW 注入 sessionPointer+低阈值 → reload → 页面 muted play() 让 watcher 真实累计 5s
//   → TRIGGER_SUMMARY → pipeline → offscreen 全链（lib/summarize/chain）
//   → CDP 收集 page+SW+offscreen console → 标记链 + DOM 探针 + IndexedDB 终态断言 → 截图留证 → 清理。
//
// 用法：node scripts/e2e-poc.mjs [bvid]        （默认 BV1XynB6EEiM，样本清单内）
//   真实 LLM 补验模式（08 报告 §7）：E2E_REAL_LLM=1 POC_LLM_BASE_URL=… POC_LLM_MODEL=…
//   POC_LLM_API_KEY=… [POC_LLM_TIMEOUT_MS=300000] node scripts/e2e-poc.mjs
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
// P2.3 ASR 探针样本：无字幕视频（基线清单，07 报告 §6.1；可用 ASR_BVID 覆盖）
const ASR_BVID = process.env.ASR_BVID || 'BV1B5JY66E1X';
const PAGE_URL = `https://www.bilibili.com/video/${BVID}`;
// 真实 LLM 补验模式：跳过 mock server，POC_LLM_* 直打真实端点（Key 仅经进程 env，不打印不落盘不入仓库）
const REAL = process.env.E2E_REAL_LLM === '1';
if (REAL) {
  for (const k of ['POC_LLM_BASE_URL', 'POC_LLM_MODEL', 'POC_LLM_API_KEY']) {
    if (!process.env[k]) throw new Error(`E2E_REAL_LLM=1 需要环境变量 ${k}`);
  }
}
let llmCfg = REAL
  ? { baseUrl: process.env.POC_LLM_BASE_URL, modelId: process.env.POC_LLM_MODEL, apiKey: process.env.POC_LLM_API_KEY }
  : null; // mock 模式待端口分配后填
// 思考型真实模型的全片摘要整流可远超 120s（SW 看门狗 600s 内的注入超时兜底）
const TIMEOUT_MS = REAL ? 300_000 : 120_000;

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function main() {
  requireExists(CHROME, 'Chrome（或 Chrome for Testing）');

  // 1) mock LLM 服务器（CORS 就绪；port 0 动态分配，从 stdout 解析）——真实模式跳过
  let mock = null;
  let mock2 = null; // P2.6 断网探针：杀 mock 后原端口重启的实例（finally 须一并回收）
  let mockCfg = null; // REAL 混合模式：mock 常开仅供 ASR 转写/测试钩子，LLM 走真实端点
  {
    requireExists(path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), 'mock-llm-server.mjs（poc-llm 交付物）');
    mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), '0'], {
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
    mockCfg = { baseUrl: `http://127.0.0.1:${mockPort}`, modelId: 'mock-asr-model', apiKey: 'e2e-mock-asr-key' };
    if (!REAL) llmCfg = { baseUrl: mockCfg.baseUrl, modelId: 'mock-seed-lite', apiKey: 'e2e-mock-key' };
  }
  if (REAL) {
    log('REAL LLM mode:', llmCfg.baseUrl, llmCfg.modelId, `(Key 不打印，长度 ${llmCfg.apiKey.length})`); // 审查 P2-2：前缀也不打，红线零例外
  }

  // 2) 带 LLM 环境重新构建（Key 只进构建 env，绝不入仓库）
  log(`rebuilding extension with ${REAL ? 'REAL' : 'mock'} LLM env …`);
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.npm-global/bin')}:${process.env.PATH}`,
    POC_LLM_BASE_URL: llmCfg.baseUrl,
    POC_LLM_MODEL: llmCfg.modelId,
    POC_LLM_API_KEY: llmCfg.apiKey,
    ...(REAL ? { POC_LLM_TIMEOUT_MS: process.env.POC_LLM_TIMEOUT_MS || '300000' } : {}),
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
    // 真实模式关 web 安全，模拟「optional host 权限已授予」后的网络语义：headless 弹不出
    // permissions.request 对话框会被自动拒（实测 granted=0 denied=1），而真实 ARK 端点 CORS
    // 预检不放行 Authorization 头——真实浏览器用户在 onboarding 批准授权后 fetch 即豁免 CORS。
    ...(REAL ? ['--disable-web-security'] : []),
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
    try { mock?.kill('SIGKILL'); } catch { /* noop */ }
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
    const attachedTargets = []; // P1.8：记录所有 attach 的 target URL（新标签页分支探针用）
    let swSessionId = null; // 扩展 background SW 的 session（storage 注入用，SW 重启自动更新）
    // F12/3.5 前移切片：扩展自身出网审计面 = SW + offscreen（chrome-extension:// target）的
    // Network.requestWillBeSent 全量收集，收口判 host 白名单（页面自身流量不属扩展出网，不采）
    const netSessions = new Set();
    const netUrls = [];
    // P2.4 头级验证：requestId → URL / requestId → 实发请求头（extraInfo 与 requestWillBeSent 乱序到达，两 map 事后关联）
    const reqUrlById = new Map();
    const extraHeadersById = new Map();
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
    // 视觉验收命名截图（终验留证：关键屏幕逐张归档到 e2e-artifacts/visual-*.png）
    const shotNamed = async (sid, name) => {
      try {
        const r = await cdp('Page.captureScreenshot', { format: 'png' }, sid);
        if (r?.result?.data) fs.writeFileSync(path.join(ROOT, 'e2e-artifacts', name), Buffer.from(r.result.data, 'base64'));
      } catch { /* 截图失败不阻断流程 */ }
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo: t } = m.params;
        sessionByTarget.set(t.targetId, sessionId);
        attachedTargets.push({ type: t.type, url: t.url, targetId: t.targetId, at: Date.now() });
        if (t.type === 'service_worker' && t.url.includes('background')) swSessionId = sessionId; // SW 可能重启，始终取最新
        cdp('Runtime.enable', {}, sessionId).catch(() => {});
        // 扩展出网审计面：SW（chrome-extension:// URL）+ offscreen 文档——后者 attach 时
        // targetInfo.url 常为空且 type='other'（P2.4 实测：按 URL 过滤会漏掉 offscreen 的
        // 音频/LLM 请求，出网审计与 DNR 头级验证全部失明），故 type='other' 一并纳入。
        // offscreen 的 host 都在白名单（bilivideo/LLM 端点），不会误伤 networkWhitelist 判定。
        if (t.url.startsWith('chrome-extension://') || t.type === 'other') {
          netSessions.add(sessionId); // SW 重启/offscreen 重建会带新 session 进来
          cdp('Network.enable', {}, sessionId).catch(() => {}); // T-3：Network.enable 在 CfT 正常（挂起的是 Cookie 命令）
        }
        if (t.type === 'page') {
          cdp('Page.enable', {}, sessionId).catch(() => {});
          pageSessions.add(sessionId);
        }
        log(`attached: ${t.type} ${t.url.slice(0, 80)}`);
        return;
      }
      if (m.method === 'Network.requestWillBeSent' && netSessions.has(m.sessionId)) {
        const u = m.params?.request?.url;
        if (u) netUrls.push(u);
        // P2.4 头级验证：bilivideo 音频请求的 requestId → URL（extraInfo 不带 URL，靠此关联）。
        // 键含 sessionId：requestId 只在单 target 内唯一，跨 target 撞号会错配 URL↔头（审查 N-2）
        if (u) reqUrlById.set(`${m.sessionId}:${m.params?.requestId}`, u);
        return;
      }
      // P2.4 DNR 头级验证：extraInfo 携带网络栈实际发送的请求头（含 DNR 改写后的值）——
      // 与 requestWillBeSent 的 requestId 关联，判定时核对 bilivideo 请求的 Referer。
      // responseReceivedExtraInfo 同样带实发请求头，作第二来源兜（两事件必达其一）。
      if ((m.method === 'Network.requestWillBeSentExtraInfo' || m.method === 'Network.responseReceivedExtraInfo') && netSessions.has(m.sessionId)) {
        const rid = `${m.sessionId}:${m.params?.requestId}`;
        const headers = m.params?.headers;
        if (m.params?.requestId && headers) {
          const prev = extraHeadersById.get(rid) ?? {};
          extraHeadersById.set(rid, { ...prev, ...headers });
        }
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map(renderRemote).join(' ');
        lines.push({ t: Date.now(), type: m.params.type, text });
        if (text.includes('[doubao') || m.params.type === 'error') {
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

    // 5.1) 登录态预检（快速失败）：提取的 Cookie 直调 nav 确认仍有效——否则跑到中途才以
    //      「未登录链路/自动恢复」交织的形式失败，难归因（验收记录 §5：E2E 依赖真实登录态风险的收口）
    {
      const navChk = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          cookie: cookiePairs.map(([n, v]) => `${n}=${v}`).join('; '),
          referer: 'https://www.bilibili.com/',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      }).then((r) => r.json()).catch((e) => ({ code: -1, message: String(e).slice(0, 100) }));
      if (navChk?.data?.isLogin !== true) {
        throw new Error(`登录态预检失败（nav code=${navChk?.code} ${navChk?.message ?? ''}）：真实 Chrome 的 B 站登录态已失效——请在 Chrome 重新登录 bilibili.com 后重跑`);
      }
      log('登录态预检通过（nav isLogin=true）');
    }

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
    // P1.10：先跑「未登录」全链路（激活→触发→NEED_LOGIN 失败→引导卡），触发失败后再注入 Cookie 验自动恢复
    const injectCookies = async () => {
      const setRes = await cdp('Runtime.evaluate', { expression: setExpr, returnByValue: true }, landingSid);
      const cookieCount = setRes?.result?.result?.value;
      const readback = await cdp('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true }, landingSid);
      const okRead = String(readback?.result?.result?.value ?? '').includes('SESSDATA=');
      log(`登录态注入 ${cookiePairs.length} 个 cookie（document.cookie 回读 ${cookieCount} 条，SESSDATA 可见=${okRead}）`);
      if (!okRead) throw new Error('document.cookie 写入后回读不到 SESSDATA——注入失败');
    };

    // 6) 同一 tab 导航到视频页（此时未登录）
    const nav = await cdp('Page.navigate', { url: PAGE_URL }, landingSid);
    log('navigate →', PAGE_URL, nav.result?.frameId ? 'ok' : JSON.stringify(nav.error ?? nav.result));

    // 7) 驱动真实链（P1.7 起为完全真实用户路径，含 onboarding 配置门槛）：
    //    SW 只注入 5s 阈值（不注入 LLM 配置——走真实 onboarding 填写）
    //    → reload → 点「▶ 开始陪看」→ NEED_ONBOARDING → onboarding 弹窗
    //    → 空保存标红 → 填 mock LLM → 测试连接（mock server 探活）→ 保存并激活
    //    → SESSION_START 建会话 → WATCH_TICK 惰性补建 visit → 播放 5s → 触发 → offscreen → 落库
    for (let i = 0; i < 40 && !swSessionId; i++) { await sleep(250); }
    if (!swSessionId) throw new Error('扩展 service worker 未 attach——扩展未加载？');
    const setStorageRes = await cdp('Runtime.evaluate', {
      expression: `chrome.storage.local.set({settings:{triggerSeconds:5}})`,
      awaitPromise: true, returnByValue: true,
    }, swSessionId);
    log('settings 注入（仅阈值，LLM 留给 onboarding 真实填写）:', JSON.stringify(setStorageRes?.result?.result?.value ?? 'void'));

    await cdp('Page.navigate', { url: PAGE_URL }, landingSid);
    // 等注入 + 暂停 autoplay 改为轮询：B 站页面在高频访问限流下加载可 >5s（mock5/6 实测注入迟到
    // 致固定 sleep(4000) 后无 btn-start）。P1.10 语义不变：video 元素一出现即暂停——否则激活前
    // 累积的观看时长会让 tick sweep 在激活瞬间触发 job，NEED_LOGIN 失败气泡覆盖登录气泡（run C 教训）
    const pauseExpr = `(() => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); if (!v) return 'no-video'; v.pause(); return 'paused@' + Math.floor(v.currentTime); })()`;
    const startClickExpr = `(() => {
          const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
          const btn = sr?.getElementById('btn-start');
          if (!btn) return 'no-btn';
          btn.click();
          return 'clicked';
        })()`;

    // 7.4) P1.7 onboarding：点「▶ 开始陪看」→ 未配置 LLM → 强制弹窗
    let onboardingProbe = {};
    let loginBubbleSeen = ''; // P1.10 登录气泡采样结果（7.4 保存点击后采样窗）
    {
      let startClicked = '';
      for (let i = 0; i < 60 && startClicked !== 'clicked'; i++) {
        await sleep(500);
        await cdp('Runtime.evaluate', { expression: pauseExpr, returnByValue: true }, landingSid).catch(() => {});
        const startRes = await cdp('Runtime.evaluate', { expression: startClickExpr, returnByValue: true }, landingSid);
        startClicked = String(startRes?.result?.result?.value ?? 'eval-error');
      }
      if (startClicked !== 'clicked') {
        throw new Error(`「开始陪看」气泡按钮未找到（${startClicked}）——豆包未进入未激活引导态？`);
      }
      log('「开始陪看」点击成功（注入等待轮询）');
      await sleep(1000); // SESSION_START → NEED_ONBOARDING → 弹窗渲染
      const modalOpen = await cdp('Runtime.evaluate', {
        expression: `(() => {
          const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
          return JSON.stringify({ shown: sr?.getElementById('modal-root')?.classList.contains('show') ?? false,
            hasSave: !!sr?.getElementById('ob-save'), hasTest: !!sr?.getElementById('ob-test'),
            ttsDisabled: !!sr?.querySelector('.m-step.step-disabled') });
        })()`,
        returnByValue: true,
      }, landingSid);
      try { onboardingProbe.modal = JSON.parse(modalOpen?.result?.result?.value); } catch { onboardingProbe.modal = null; }
      log('P1.7 弹窗探针:', JSON.stringify(onboardingProbe.modal));
      await shotNamed(landingSid, 'visual-onboarding-modal.png'); // 视觉验收：onboarding 弹窗（S1）

      // 空保存 → 三项标红 + 不落任何配置
      await cdp('Runtime.evaluate', { expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("ob-save").click()', returnByValue: true }, landingSid);
      await sleep(600);
      const redRes = await cdp('Runtime.evaluate', {
        expression: `(() => {
          const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
          return JSON.stringify({ redCount: sr.querySelectorAll('#ob-llm .field.has-err').length,
            redInputs: sr.querySelectorAll('#ob-llm input.err').length });
        })()`,
        returnByValue: true,
      }, landingSid);
      try { onboardingProbe.red = JSON.parse(redRes?.result?.result?.value); } catch { onboardingProbe.red = null; }
      const noCfg = await cdp('Runtime.evaluate', {
        expression: `(async () => { const s = await chrome.storage.local.get(['settings','onboarded']); return JSON.stringify({ llm: !!s.settings?.llm, onboarded: s.onboarded === true }); })()`,
        awaitPromise: true, returnByValue: true,
      }, swSessionId);
      try { onboardingProbe.noCfg = JSON.parse(noCfg?.result?.result?.value); } catch { onboardingProbe.noCfg = null; }
      log('P1.7 空保存标红探针:', JSON.stringify({ red: onboardingProbe.red, noCfg: onboardingProbe.noCfg }));

      // 填入 LLM 三件套（mock/真实同一表单路径；Key 只进表达式字符串，不打印）→ 测试连接 → 保存并激活
      const fillExpr = `(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          const set = (k, v) => { sr.querySelector('#ob-llm input[data-k="' + k + '"]').value = v; };
          set('baseUrl', ${JSON.stringify(llmCfg.baseUrl)});
          set('modelId', ${JSON.stringify(llmCfg.modelId)});
          set('apiKey', ${JSON.stringify(llmCfg.apiKey)});
          return 'filled';
        })()`;
      await cdp('Runtime.evaluate', { expression: fillExpr, returnByValue: true }, landingSid);
      // userGesture:true——CDP 合成点击默认无用户激活，permissions.request（LLM origin 授权）会被拒；
      // ARK 等端点 CORS 预检不放行 Authorization 头，无 host 权限的 fetch 一律 Failed to fetch
      await cdp('Runtime.evaluate', { expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("ob-test").click()', returnByValue: true, userGesture: true }, landingSid);
      // TEST_CONNECTION 往返：mock 秒回；真实思考型模型对 ping 也先 reasoning（实测 ~14s，端超时 35s）→ 轮询结果文案
      for (let i = 0; i < (REAL ? 80 : 10); i++) {
        await sleep(500);
        const testRes = await cdp('Runtime.evaluate', {
          expression: `document.getElementById('doubao-ui-root').shadowRoot.getElementById('ob-test-status')?.textContent ?? ''`,
          returnByValue: true,
        }, landingSid);
        onboardingProbe.testStatus = String(testRes?.result?.result?.value ?? '');
        if (/成功|失败|无效|超时|HTTP|余额|端点|配置/.test(onboardingProbe.testStatus)) break;
      }
      log('P1.7 测试连接探针:', onboardingProbe.testStatus);

      // P1.10：装气泡文本流记录器（MutationObserver）——登录气泡会被随后的 SUMMARY_FAILED
      // 气泡覆盖，DOM 采样有竞争；记录流取证则与覆盖无关（run B/C 教训）
      await cdp('Runtime.evaluate', {
        expression: `(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          const b = sr.getElementById('mascot-bubble');
          window.__bubbleLog = [];
          new MutationObserver(() => { window.__bubbleLog.push(b.textContent ?? ''); }).observe(b, { childList: true, characterData: true, subtree: true });
          return 'obs';
        })()`,
        returnByValue: true,
      }, landingSid);

      await cdp('Runtime.evaluate', { expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("ob-save").click()', returnByValue: true, userGesture: true }, landingSid);
      await sleep(600); // SETTINGS_SAVE + SESSION_START + 广播收尾
    }

    // 7.5) P1.6/P1.7 激活终态：配置已落 + 会话 ACTIVE + happy 切图 + 气泡文案
    let sessionProbe = {};
    {
      // 登录气泡取证：轮询气泡文本流（含打字机中间态），命中即止
      for (let i = 0; i < 12 && !loginBubbleSeen; i++) {
        const seen = await cdp('Runtime.evaluate', {
          expression: `(() => (window.__bubbleLog || []).join('|'))()`,
          returnByValue: true,
        }, landingSid);
        const all = String(seen?.result?.result?.value ?? '');
        if (all.includes('先登录 B 站')) loginBubbleSeen = '先登录 B 站我才能记笔记哦';
        else await sleep(250);
      }
      sessionProbe.loginBubble = loginBubbleSeen;
      const st = await cdp('Runtime.evaluate', {
        expression: `(async () => { const s = await chrome.storage.local.get(['sessionPointer','settings','onboarded']); return JSON.stringify({ pointer: s.sessionPointer ?? null, modelId: s.settings?.llm?.modelId ?? null, onboarded: s.onboarded === true }); })()`,
        awaitPromise: true, returnByValue: true,
      }, swSessionId);
      try { sessionProbe.pointer = JSON.parse(st?.result?.result?.value); } catch { sessionProbe.pointer = null; }
      const dom = await cdp('Runtime.evaluate', {
        expression: `(() => {
          const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
          return JSON.stringify({ img: sr?.getElementById('mascot-img')?.getAttribute('src') ?? '', bubble: (sr?.getElementById('mascot-bubble')?.textContent ?? '').slice(0, 30),
            modalClosed: !(sr?.getElementById('modal-root')?.classList.contains('show') ?? false) });
        })()`,
        returnByValue: true,
      }, landingSid);
      try { sessionProbe.dom = JSON.parse(dom?.result?.result?.value); } catch { sessionProbe.dom = null; }
      log('P1.7 激活终态探针:', JSON.stringify(sessionProbe));
    }

    const playExpr = `(async () => {
      const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
      if (!v) return 'no-video';
      v.muted = true;
      try { await v.play(); return 'ok paused=' + v.paused + ' t=' + Math.floor(v.currentTime); } catch (e) { return 'rejected:' + e.name; }
    })()`;
    let playResult = 'unset';
    for (let i = 0; i < 12; i++) {
      const r = await cdp('Runtime.evaluate', { expression: playExpr, awaitPromise: true, returnByValue: true }, landingSid);
      playResult = String(r?.result?.result?.value ?? r?.result?.exceptionDetails?.text ?? 'eval-error');
      log(`play attempt ${i + 1}:`, playResult.slice(0, 60));
      if (playResult.startsWith('ok paused=false')) break;
      await sleep(1500);
    }
    if (!playResult.startsWith('ok paused=false')) throw new Error(`视频未能静音播放（${playResult}）——watcher 无法累计有效观看`);

    // 8) 等真实链标记：watcher 触发 → job 排队 → offscreen 执行 → 终态
    //    P1.10 起首轮为「未登录」：预期先 failed（NEED_LOGIN），8.2 注入 Cookie 后再等 done
    const t0 = Date.now();
    let outcome = 'timeout';
    while (Date.now() - t0 < TIMEOUT_MS) {
      await sleep(500);
      const done = lines.some((l) => l.text.includes('job SUMMARIZE') && l.text.includes('→ done'));
      const failed = lines.some((l) => l.text.includes('job SUMMARIZE') && l.text.includes('→ failed'));
      if (done) { outcome = 'done'; break; }
      if (failed) { outcome = 'fail'; break; }
    }

    // 8.2) P1.10 未登录全链路：红徽章(NEED_LOGIN)+引导卡+详情错误文案 → 注入 Cookie →
    //      重开面板强制复核 → 翻转广播（卡隐藏+welcome 气泡）→ NEED_LOGIN job 自动重排 → done
    let loginProbe = null;
    let cookieLineIdx = 0;
    if (outcome === 'fail') {
      const evL = async (expression) => {
        const rr = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, landingSid);
        try { return JSON.parse(rr?.result?.result?.value); } catch { return null; }
      };
      await cdp('Runtime.evaluate', { expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("mascot").click()', returnByValue: true }, landingSid);
      await sleep(1500); // LOGIN_CHECK force 往返 + 引导卡渲染 + LIST_QUERY
      // 等自动重试轮跑完（徽章落「解析失败」再探，避免探到 retry 中的「生成中」）
      let card1 = null;
      for (let i = 0; i < 40 && !String(card1?.badge ?? '').includes('解析失败'); i++) {
        card1 = await evL(`(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          const card = sr.getElementById('login-card');
          return JSON.stringify({ shown: !!card && !card.classList.contains('hidden'),
            title: card?.querySelector('b')?.textContent ?? '', hasBtn: !!card?.querySelector('#btn-login'),
            badge: sr.querySelector('.v-item .badge')?.textContent ?? '' });
        })()`);
        if (!String(card1?.badge ?? '').includes('解析失败')) await sleep(500);
      }
      await evL(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('.v-item')?.click()`);
      // 详情错误文案轮询（retry 在途时详情可能还是流式阶段文案）
      let failDetail = null;
      for (let i = 0; i < 30 && !String(failDetail?.errText ?? '').includes('需要登录'); i++) {
        failDetail = await evL(`(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          return JSON.stringify({ errText: sr.getElementById('d-summary')?.textContent ?? '' });
        })()`);
        if (!String(failDetail?.errText ?? '').includes('需要登录')) await sleep(500);
      }
      await shotNamed(landingSid, 'visual-login-card.png'); // 视觉验收：未登录引导卡+红徽章+详情错误文案（F11）
      await evL(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('d-back')?.click()`);
      await sleep(400);
      await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, returnByValue: true }, landingSid);
      await sleep(400);

      await injectCookies();
      cookieLineIdx = lines.length; // 此前的 '→ failed' 属预期（未登录轮），noExplicitFail 从其后算
      await cdp('Runtime.evaluate', { expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("mascot").click()', returnByValue: true }, landingSid);
      await sleep(1500); // 面板打开 force 复核 → 翻转广播 + 自动重排
      const card2 = await evL(`(() => {
        const sr = document.getElementById('doubao-ui-root').shadowRoot;
        const card = sr.getElementById('login-card');
        const b = sr.getElementById('mascot-bubble');
        return JSON.stringify({ hidden: !card || card.classList.contains('hidden'),
          welcome: (b?.textContent ?? '').includes('登录好啦') });
      })()`);
      const t1 = Date.now();
      let recovered = false;
      while (Date.now() - t1 < TIMEOUT_MS) {
        await sleep(500);
        if (lines.some((l) => l.text.includes('job SUMMARIZE') && l.text.includes('→ done'))) { recovered = true; break; }
      }
      // 徽章轮询到「已总结」（SUMMARY_DONE → 300ms 节流刷新 + LIST_QUERY 往返有延迟）
      let badge2 = null;
      for (let i = 0; i < 20 && !String(badge2?.badge ?? '').includes('已总结'); i++) {
        badge2 = await evL(`(() => { const sr = document.getElementById('doubao-ui-root').shadowRoot; return JSON.stringify({ badge: sr.querySelector('.v-item .badge')?.textContent ?? '' }); })()`);
        if (!String(badge2?.badge ?? '').includes('已总结')) await sleep(300);
      }
      await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, returnByValue: true }, landingSid);
      await sleep(400);
      loginProbe = { card1, failDetail, card2, badge2, recovered,
        hasRequeueLog: lines.some((l) => l.text.includes('login restored: requeued')) };
      log('P1.10 未登录→自动恢复探针:', JSON.stringify(loginProbe));
      outcome = recovered ? 'done' : 'timeout';
    }

    // 8.5) DB 级终态断言：offscreen 链写入的 summaries 行（SW 与 offscreen 同源同库）
    let dbSummary = null;
    if (swSessionId) {
      const dbExpr = `(async () => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const rows = await new Promise((res) => { const q = db.transaction('summaries','readonly').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result); });
        const jobs = await new Promise((res) => { const q = db.transaction('jobs','readonly').objectStore('jobs').getAll(); q.onsuccess = () => res(q.result); });
        return JSON.stringify({ summaries: rows.map((r) => ({ key: r.key, status: r.status, chars: (r.summary||'').length })), jobs: jobs.map((j) => ({ status: j.status, stage: j.stage, progress: j.progress })) });
      })()`;
      const r = await cdp('Runtime.evaluate', { expression: dbExpr, awaitPromise: true, returnByValue: true }, swSessionId);
      try { dbSummary = JSON.parse(r?.result?.result?.value); } catch { dbSummary = null; }
      log('IndexedDB 终态:', JSON.stringify(dbSummary));
    }

    // 8) DOM 探针：共享 UI root 是否注入 + 面板全链（P1.5：豆包点击 → 列表 → 详情）+ P1.6 豆包交互
    let uiProbe = null;
    let mascotProbe = null;
    let seekProbe = null; // P1.8：同页/跨页/新标签 seek 探针
    let p19Probe = null; // P1.9：浮层七准则探针（overlay/全屏/闲时/输入聚焦/跟随）
    let regenProbe = null; // 2.7a：【重新生成】REGENERATE 探针
    let retentionProbe = null; // P2.1：保留期判定探针（GRACE 倒计时/59min 恢复/超期 EXPIRED）
    let wipeProbe = null; // P2.2：F10 清除链路探针（超期弹窗/稍后提醒重弹/立即清除/手动清除）
    let asrProbe = null; // P2.3：F6 ASR 确认流探针（need_asr 卡片/未配置引导/三段进度/done ASR转写）
    let dnrProbe = null; // P2.4：DNR 头级验证探针（bilivideo 实发 Referer + getDynamicRules 形状审计）
    let settingsProbe = null; // P2.5：设置页探针（视图/打码/2.7b 人设联动/阈值/暂停/气泡/清 Key/隐藏+清除迁移）
    let errProbe = null; // P2.6：错误态探针（Key 无效全链/断网挂起续跑）
    let errProbeStartIdx = 0; // noExplicitFail 截止线（错误态探针预期产生 failed 终态）
    const probeSid = landingSid; // P1.8 起固定主页面 session（后续会新建标签页，pop() 会误取）
    // 共享 eval 助手（P1.8 探针前移：同页 seek 与 8.7 豆包交互共用）
    const evalIn = async (sid, expression) => {
      const rr = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      try { return JSON.parse(rr?.result?.result?.value); } catch { return null; }
    };
    if (probeSid) {
      const pageEval = (expression) => evalIn(probeSid, expression);
      const swEval = async (expression) => {
        const rr = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, swSessionId);
        try { return JSON.parse(rr?.result?.result?.value); } catch { return null; }
      };
      let r = await cdp('Runtime.evaluate', { expression: '!!document.getElementById("doubao-ui-root")', returnByValue: true }, probeSid);
      const uiRootInjected = r?.result?.result?.value === true;
      log('DOM 探针 doubao-ui-root 存在 =', uiRootInjected);

      if (uiRootInjected) {
        // 点击豆包 → 面板开（shadow root 内真实 click 事件）
        await cdp('Runtime.evaluate', {
          expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("mascot").click()',
          returnByValue: true,
        }, probeSid);
        await sleep(1200); // LIST_QUERY 往返 + 渲染
        r = await cdp('Runtime.evaluate', {
          expression: `(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const items = [...sr.querySelectorAll('.v-item')];
            return JSON.stringify({
              open: sr.getElementById('panel')?.classList.contains('open') ?? false,
              count: items.length,
              badge: items[0]?.querySelector('.badge')?.textContent ?? '',
              title: (items[0]?.querySelector('.v-name')?.textContent ?? '').slice(0, 40),
              pct: items[0]?.querySelector('.v-pct')?.textContent ?? '',
              src: (items[0]?.textContent ?? '').includes('来源：'),
            });
          })()`,
          returnByValue: true,
        }, probeSid);
        let list = {};
        try { list = JSON.parse(r?.result?.result?.value); } catch { /* 保持空 */ }
        log('面板列表探针:', JSON.stringify(list));
        await shotNamed(probeSid, 'visual-panel-list.png'); // 视觉验收：陪看列表（S4）

        if (list.count >= 1) {
          await cdp('Runtime.evaluate', {
            expression: 'document.getElementById("doubao-ui-root").shadowRoot.querySelector(".v-item").click()',
            returnByValue: true,
          }, probeSid);
          await sleep(1200); // SUMMARY_OPEN 往返 + 详情渲染
          r = await cdp('Runtime.evaluate', {
            expression: `(() => {
              const sr = document.getElementById('doubao-ui-root').shadowRoot;
              const summaryLen = (sr.getElementById('d-summary')?.textContent ?? '').trim().length;
              return JSON.stringify({
                summaryLen,
                outlineRows: sr.querySelectorAll('.d-outline li').length,
                mascotSay: sr.querySelector('.mascot-say-text')?.textContent?.slice(0, 30) ?? '',
                stars: sr.querySelector('.mascot-stars')?.textContent ?? '',
                transcriptRows: sr.querySelectorAll('.tr-line').length,
                transcriptLabel: sr.querySelector('.d-transcript summary')?.textContent ?? '',
                srcBadge: sr.querySelector('.src-badge')?.textContent ?? '',
              });
            })()`,
            returnByValue: true,
          }, probeSid);
          try { uiProbe = { list, detail: JSON.parse(r?.result?.result?.value) }; } catch { uiProbe = { list }; }
          log('面板详情探针:', JSON.stringify(uiProbe.detail ?? null));
          await shotNamed(probeSid, 'visual-panel-detail.png'); // 视觉验收：摘要详情（S5）

          // 8.65) P1.8 同页 seek：点大纲条目 → 本页 <video>.currentTime 跳转 + toast；转写行同行为（F5/F7）
          const seekClick = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            const lis = [...sr.querySelectorAll('.d-outline li[data-sec]')];
            if (!v || !lis.length) return JSON.stringify({ err: 'no-video-or-outline' });
            const target = lis.filter((li) => +li.getAttribute('data-sec') <= v.duration - 2).pop() ?? lis[0];
            const sec = +target.getAttribute('data-sec');
            target.click();
            return JSON.stringify({ sec });
          })()`);
          await sleep(900);
          const seekAfter = await pageEval(`(() => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ t: v ? +v.currentTime.toFixed(1) : -1,
              toasts: [...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? ''),
              panelOpen: sr.getElementById('panel')?.classList.contains('open') ?? false });
          })()`);
          const trClick = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const line = sr.querySelector('.tr-line[data-sec]');
            if (!line) return JSON.stringify({ err: 'no-tr-line' });
            const sec = +line.getAttribute('data-sec');
            line.click();
            return JSON.stringify({ sec });
          })()`);
          await sleep(900);
          const trAfter = await pageEval(`(() => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ t: v ? +v.currentTime.toFixed(1) : -1,
              toasts: [...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? '') });
          })()`);
          seekProbe = { outline: seekClick, after: seekAfter, tr: trClick, trAfter };
          log('P1.8 同页 seek 探针:', JSON.stringify(seekProbe));

          // 8.66) P1.11 F13 分段解读：【AI 解读】内联流式→done；收起再展开=缓存零请求；按钮点击不 seek
          //       F13 提速：摘要 done 后分段已静默预取（offscreenSegPreClick≥1 为证）；
          //       零请求不变量按 seg=1 单段计数（其他段的预取可能同时在跑，总数口径不再适用）
          await pageEval(`(() => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); if (v) v.pause(); })()`);
          const segJobLinesAll = () => lines.filter((l) => / seg=\d+$/.test(l.text.trim())).length;
          const segJobLinesOf = (n) => lines.filter((l) => l.text.trim().endsWith(`seg=${n}`)).length;
          const offscreenSegPreClick = segJobLinesAll();
          const segBefore = await pageEval(`(() => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ t: v ? +v.currentTime.toFixed(1) : -1, btns: sr.querySelectorAll('.seg-btn').length });
          })()`);
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('.seg-btn[data-seg="1"]')?.click()`);
          let segNote = null;
          for (let i = 0; i < (REAL ? 800 : 40) && !(segNote && !segNote.hidden && !segNote.spinner && (segNote.text ?? '').length > 10); i++) {
            await sleep(300);
            segNote = await pageEval(`(() => {
              const sr = document.getElementById('doubao-ui-root').shadowRoot;
              const n = sr.querySelector('[data-segnote="1"]');
              return JSON.stringify({ hidden: n?.classList.contains('hidden') ?? true, text: n?.textContent ?? '',
                spinner: !!n?.querySelector('.spinner') });
            })()`);
          }
          const segAfter = await pageEval(`(() => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            return JSON.stringify({ t: v ? +v.currentTime.toFixed(1) : -1 });
          })()`);
          const offscreenSegBefore = segJobLinesOf(1);
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('.seg-btn[data-seg="1"]')?.click()`);
          await sleep(400);
          const segCollapsed = await pageEval(`(() => { const n = document.getElementById('doubao-ui-root').shadowRoot.querySelector('[data-segnote="1"]'); return JSON.stringify({ hidden: n?.classList.contains('hidden') ?? true }); })()`);
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('.seg-btn[data-seg="1"]')?.click()`);
          await sleep(800);
          const segReopened = await pageEval(`(() => { const n = document.getElementById('doubao-ui-root').shadowRoot.querySelector('[data-segnote="1"]'); return JSON.stringify({ hidden: n?.classList.contains('hidden') ?? true, text: n?.textContent ?? '' }); })()`);
          const offscreenSegAfter = segJobLinesOf(1);
          const segDb = await swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const rows = await new Promise((res) => { const q = db.transaction('summaries','readonly').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result); });
            const row = rows.find((x) => String(x.key || '').includes('${BVID}'));
            return JSON.stringify(row?.segmentNotes ?? null);
          })()`);
          seekProbe = { ...seekProbe, segment: { segBefore, segNote, segAfter, segCollapsed, segReopened, offscreenSegPreClick, offscreenSegBefore, offscreenSegAfter, segDb } };
          log('P1.11 分段解读探针:', JSON.stringify(seekProbe.segment));
          // 视觉验收：分段解读内联注记卡展开态（S10）——注记卡滚到视口中央后截图
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('[data-segnote="1"]')?.scrollIntoView({ block: 'center' })`);
          await sleep(300);
          await shotNamed(probeSid, 'visual-segment-note.png');

          // 8.67) 2.7a【重新生成】：详情点击 → REGENERATE 强制重跑 → 第 2 次摘要 job →
          //       done 整行覆盖（createdAt 更新）+ 分段注记随新大纲清空（缓存失效策略）
          const regenDb = () => swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const rows = await new Promise((res) => { const q = db.transaction('summaries','readonly').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result); });
            const row = rows.find((x) => String(x.key || '').includes('${BVID}'));
            const notes = row?.segmentNotes ?? {};
            const ks = Object.keys(notes);
            // F13 提速：regen 整行替换清空旧注记后，预取可能立即重灌新注记——判定改为「无早于新行的陈旧注记」
            const minCreated = ks.length ? Math.min(...ks.map((k) => notes[k]?.createdAt ?? 0)) : 0;
            return JSON.stringify({ createdAt: row?.createdAt ?? 0, status: row?.status ?? '', notes: ks.length, noteMinCreated: minCreated });
          })()`);
          const regenBefore = await regenDb();
          const regenSumBefore = lines.filter((l) => l.text.includes('offscreen run job') && !l.text.includes('seg=')).length;
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('d-regen')?.click()`);
          let regenDone = false;
          for (let i = 0; i < (REAL ? 800 : 80) && !regenDone; i++) {
            await sleep(500);
            regenDone = lines.some((l) => l.text.includes('job REGENERATE') && l.text.includes('→ done'));
          }
          const regenAfter = await regenDb();
          const regenSumAfter = lines.filter((l) => l.text.includes('offscreen run job') && !l.text.includes('seg=')).length;
          // 审查 P2-9：面板确已用新内容重渲染（SUMMARY_DONE→#openDetail 链路），不只 DB+console
          await sleep(1500);
          const regenUi = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ sumLen: (sr.getElementById('d-summary')?.textContent ?? '').trim().length,
              outline: sr.querySelectorAll('.d-outline li[data-sec]').length,
              notes: sr.querySelectorAll('.seg-note:not(.hidden)').length });
          })()`);
          regenProbe = { regenDone, before: regenBefore, after: regenAfter, sumBefore: regenSumBefore, sumAfter: regenSumAfter, regenUi };
          log('2.7a 重新生成探针:', JSON.stringify(regenProbe));
        } else {
          uiProbe = { list };
        }

        // 8.7) P1.6 豆包交互：Esc 关面板 → 拖拽（不误触面板）→ 位置持久化 → reload 还原 → 结束陪看

        // 关面板（Esc），模拟 60px 拖拽：pointerdown(mascot) → pointermove/up(document)
        await cdp('Runtime.evaluate', {
          expression: `document.getElementById('doubao-ui-root').shadowRoot.getElementById('view-list').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})) || 'esc'`,
          returnByValue: true,
        }, probeSid).catch(() => {});
        await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, returnByValue: true }, probeSid).catch(() => {});
        await sleep(400);
        const dragBefore = await pageEval(`(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          const m = sr.getElementById('mascot');
          const wrap = sr.getElementById('mascot-wrap');
          const r = m.getBoundingClientRect();
          const x0 = r.left + 40, y0 = r.top + 40;
          const before = { left: wrap.offsetLeft, top: wrap.offsetTop };
          m.dispatchEvent(new PointerEvent('pointerdown', { clientX: x0, clientY: y0, bubbles: true }));
          document.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + 60, clientY: y0 + 20, bubbles: true }));
          document.dispatchEvent(new PointerEvent('pointerup', { clientX: x0 + 60, clientY: y0 + 20, bubbles: true }));
          return JSON.stringify({ before, vw: window.innerWidth, vh: window.innerHeight });
        })()`);
        await sleep(450); // P1.9 贴边 200ms 过渡收敛后再读位置
        const dragAfter = await pageEval(`(() => {
          const sr = document.getElementById('doubao-ui-root').shadowRoot;
          const wrap = sr.getElementById('mascot-wrap');
          return JSON.stringify({ after: { left: wrap.offsetLeft, top: wrap.offsetTop },
            panelOpenAfterDrag: sr.getElementById('panel').classList.contains('open') });
        })()`);
        const dragRes = { ...dragBefore, ...dragAfter };
        await sleep(500); // storage.set 异步落盘
        const savedPos = await swEval(`(async () => JSON.stringify((await chrome.storage.local.get('mascotPos')).mascotPos ?? null))()`);
        log('P1.6 拖拽探针:', JSON.stringify({ dragRes, savedPos }));

        // reload：mascotPos 相对坐标还原（±5px 容差，按实际视口钳位还原）
        await cdp('Page.navigate', { url: PAGE_URL }, probeSid);
        await sleep(4000);
        const restored = await pageEval(`(() => {
          const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
          if (!sr) return JSON.stringify({ err: 'no-root' });
          const wrap = sr.getElementById('mascot-wrap');
          return JSON.stringify({ left: wrap.offsetLeft, top: wrap.offsetTop, vw: window.innerWidth, vh: window.innerHeight,
            img: sr.getElementById('mascot-img')?.getAttribute('src') ?? '' });
        })()`);
        const expectLeft = savedPos && dragRes ? Math.min(Math.max(4, savedPos.x * dragRes.vw), dragRes.vw - 178) : null;
        const posRestored = !!(
          restored && savedPos && expectLeft !== null &&
          Math.abs(restored.left - expectLeft) <= 5
        );
        log('P1.6 位置还原探针:', JSON.stringify({ restored, expectLeft, posRestored }));

        // 结束陪看：开面板 → 头部「⏻ 结束陪看」→ GRACE + sleep 切图 + 「恢复陪看」按钮
        await cdp('Runtime.evaluate', {
          expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("mascot").click()',
          returnByValue: true,
        }, probeSid);
        await sleep(1000);
        await cdp('Runtime.evaluate', {
          expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("btn-end")?.click()',
          returnByValue: true,
        }, probeSid);
        // 轮询等 GRACE 落盘（固定 sleep 在 SW 繁忙时会抢在写入前读到 ACTIVE——F13 双通道后 SW 更忙，实测 flake）
        let endPointer = null;
        for (let i = 0; i < 20 && endPointer?.state !== 'GRACE'; i++) {
          await sleep(300);
          endPointer = await swEval(`(async () => JSON.stringify((await chrome.storage.local.get('sessionPointer')).sessionPointer ?? null))()`);
        }
        // 徽章/按钮随面板异步 refresh 重排——轮询至 resumeBtn 就位（上限 ~3s）
        let endDom = null;
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          endDom = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
            if (!sr) return null;
            return JSON.stringify({ img: sr.getElementById('mascot-img')?.getAttribute('src') ?? '',
              resumeBtn: !!sr.getElementById('btn-resume') });
          })()`);
          if (endDom?.resumeBtn) break;
        }
        const endProbe = { pointer: endPointer, dom: endDom };
        log('P1.6 结束陪看探针:', JSON.stringify(endProbe));

        // 8.8) 审查 P1 回归探针：
        //  a) 旧气泡 hide 计时器不得掐死新气泡——GRACE 后 4.2s 内恢复，新「开始陪看」气泡须活过旧计时时刻
        //  b) 真鼠标拖拽（CDP Input，产生原生 pointer+click）不得双触发点击（面板保持关闭）
        let bubbleSurvivesResume = null;
        if (endProbe?.pointer?.state === 'GRACE') {
          await sleep(1000); // 轮询版 endProbe 更快收敛——补回原节奏（resume≈T_end+2s），观察窗须落在旧 hide 计时（+4.2s）后、新气泡 hide（T_resume+4.2s）前
          await cdp('Runtime.evaluate', {
            expression: 'document.getElementById("doubao-ui-root").shadowRoot.getElementById("btn-resume")?.click()',
            returnByValue: true,
          }, probeSid);
          // 观察窗：旧 GRACE 气泡 hide 计时（T_end+4.2s）已过、新「开始陪看」气泡自身 hide（T_resume+4.2s≈T_end+5.8s）未到
          await sleep(3600); // 落在 T_end+5.1s 左右（resume 在 T_end+1.5s 附近）
          const bubbleProbe = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
            const b = sr?.getElementById('mascot-bubble');
            return JSON.stringify({ hidden: b?.classList.contains('hidden') ?? true, text: (b?.textContent ?? '').slice(0, 20) });
          })()`);
          const act = await swEval(`(async () => JSON.stringify((await chrome.storage.local.get('sessionPointer')).sessionPointer?.state ?? null))()`);
          bubbleSurvivesResume = bubbleProbe?.hidden === false && String(bubbleProbe?.text ?? '').includes('开始陪看') && act === 'ACTIVE';
          log('P1.6 恢复气泡存活探针:', JSON.stringify({ bubbleProbe, act, bubbleSurvivesResume }));
        }

        // b) 真鼠标拖拽：Input 域原生事件（含 click 派发）→ 面板不得开（P1-2 回归）
        let realMouseDrag = null;
        let realMouseSnap = null; // P1.9 准则#1：真鼠标拖拽松手后贴右边
        {
          await cdp('Input.enable', {}, probeSid).catch(() => {});
          await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, returnByValue: true }, probeSid).catch(() => {});
          await sleep(400);
          const geo = await pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const r = sr.getElementById('mascot').getBoundingClientRect();
            return JSON.stringify({ x: r.left + 75, y: r.top + 75, left0: sr.getElementById('mascot-wrap').offsetLeft,
              vw: window.innerWidth });
          })()`);
          if (geo) {
            // P1.9 起拖拽会贴边：目标按视口宽计算（vw/4，审查 P2-6①：固定 -400 只在窄视口过中线），
            // 自右边缘向左拖过中线 → 应吸左边缘（x=4），位移断言为「换边」
            const tx = Math.round(geo.vw * 0.25);
            await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 }, probeSid);
            await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx, y: geo.y + 30, button: 'left' }, probeSid);
            await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: geo.y + 30, button: 'left', clickCount: 1 }, probeSid);
            await sleep(800);
            const after = await pageEval(`(() => {
              const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
              return JSON.stringify({ panelOpen: sr?.getElementById('panel')?.classList.contains('open') ?? null,
                left: sr?.getElementById('mascot-wrap')?.offsetLeft ?? null, vw: window.innerWidth });
            })()`);
            realMouseDrag = after?.panelOpen === false && after?.left !== geo.left0;
            realMouseSnap = after?.left !== null && Math.abs(after.left - 4) <= 2; // 吸左边缘
            log('P1.6 真鼠标拖拽探针:', JSON.stringify({ geo, after, realMouseDrag, realMouseSnap }));
          }
        }

        mascotProbe = {
          startActive: sessionProbe?.pointer?.pointer?.state === 'ACTIVE',
          startHappyImg: String(sessionProbe?.dom?.img ?? '').includes('mascot-happy'),
          dragMovedNotToggled: !!dragRes && dragRes.panelOpenAfterDrag === false && dragRes.after.left > dragRes.before.left,
          posPersisted: !!savedPos && !!dragRes && Math.abs(savedPos.x * dragRes.vw - dragRes.after.left) <= 5,
          posRestored,
          endGrace: endProbe?.pointer?.state === 'GRACE',
          endSleepImg: String(endProbe?.dom?.img ?? '').includes('mascot-sleep'),
          endResumeBtn: endProbe?.dom?.resumeBtn === true,
          bubbleSurvivesResume: bubbleSurvivesResume === true,
          realMouseDragNoToggle: realMouseDrag === true,
          // P1.9 准则#1：合成拖拽与真鼠标拖拽松手后均吸附右边缘（x = vw-178），纵坐标保持拖拽值
          snapEdgeDrag:
            !!dragRes &&
            Math.abs(dragRes.after.left - (dragRes.vw - 178)) <= 2 &&
            dragRes.after.top === dragRes.before.top + 20 &&
            realMouseSnap === true,
        };
        log('P1.6 豆包判定项:', JSON.stringify(mascotProbe));

        // 8.9) P1.8 跨标签页：tab2（首页）开面板进详情点大纲 → background 聚焦 tab1 + 广播 SEEK_TO → tab1 播放器跳转
        {
          const t2 = await cdp('Target.createTarget', { url: 'https://www.bilibili.com/' });
          const tab2TargetId = t2.result?.targetId;
          let tab2Sid = null;
          for (let i = 0; i < 40 && !tab2Sid; i++) { await sleep(250); tab2Sid = sessionByTarget.get(tab2TargetId) ?? null; }
          if (!tab2Sid) throw new Error('tab2 未 attach——跨标签页 seek 无法验证');
          await sleep(3500); // content 注入 + bridge 连接 + SESSION_STATE 回放
          const eval2 = (expression) => evalIn(tab2Sid, expression);

          // 自愈式驱动：轮询等面板开/列表渲染/详情就绪；首轮点击若落在 SESSION_STATE 回放前
          // （走 onStartClick 分支不开面板）则回放到达后补点一次——消时序 flake（run2 教训）
          const tab2State = () => eval2(`(() => {
            const sr = document.getElementById('doubao-ui-root')?.shadowRoot;
            return JSON.stringify({ open: sr?.getElementById('panel')?.classList.contains('open') ?? false,
              items: sr?.querySelectorAll('.v-item').length ?? 0,
              dBack: !!sr?.getElementById('d-back'),
              secs: [...(sr?.querySelectorAll('.d-outline li') ?? [])].map((x) => x.getAttribute('data-sec')),
              status: sr?.getElementById('p-status')?.textContent ?? '' });
          })()`);
          const waitState = async (pred, ms) => {
            const t0 = Date.now();
            let st = null;
            for (;;) {
              st = await tab2State();
              if (st && pred(st)) return st;
              if (Date.now() - t0 > ms) return st;
              await sleep(300);
            }
          };
          await eval2(`document.getElementById('doubao-ui-root')?.shadowRoot?.getElementById('mascot')?.click()`);
          let stOpen = await waitState((s) => s.open, 2500);
          if (!stOpen?.open) {
            await eval2(`document.getElementById('doubao-ui-root')?.shadowRoot?.getElementById('mascot')?.click()`);
            stOpen = await waitState((s) => s.open, 3000);
          }
          const stList = await waitState((s) => s.items > 0, 3000);
          const tab2AfterOpen = { open: stOpen?.open ?? false, items: stList?.items ?? 0, status: stList?.status ?? '' };
          await eval2(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('.v-item')?.click()`);
          const tab2AfterItem = await waitState((s) => s.dBack, 3000);
          const li60 = await eval2(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            // 真实模型的大纲时间戳不固定（mock 恒为 0/60/120…）：取第 2 条 li，目标秒读其 data-sec
            const lis = [...sr.querySelectorAll('.d-outline li[data-sec]')];
            const li = lis[1] ?? lis[0];
            if (!li) return JSON.stringify({ err: 'no-li', secs: lis.map((x) => x.getAttribute('data-sec')) });
            const sec = Number(li.getAttribute('data-sec')) || 0;
            li.click();
            return JSON.stringify({ clicked: true, sec });
          })()`);
          if (li60?.err) log('P1.8 tab2 诊断:', JSON.stringify({ tab2AfterOpen, tab2AfterItem }));
          await sleep(1500); // SEEK_TO 往返 + 聚焦切换 + 目标页 seek
          const tab1After = await pageEval(`(() => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ t: v ? +v.currentTime.toFixed(1) : -1, vis: document.visibilityState,
              toasts: [...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? '') });
          })()`);
          const tab2After = await eval2(`JSON.stringify({ vis: document.visibilityState })`);
          seekProbe = { ...(seekProbe ?? {}), crossTab: { li60, tab1After, tab2After, tab2AfterOpen, tab2AfterItem } };
          log('P1.8 跨标签页聚焦探针:', JSON.stringify(seekProbe.crossTab));

          // 8.95) P1.8 新标签页分支：tab1 离开视频页 → 无匹配标签页 → tabs.create 带 t= 参数直达
          await cdp('Page.navigate', { url: 'https://www.bilibili.com/' }, probeSid);
          // 轮询等 tab1 导航 commit（审查 P2-4a：固定 sleep 慢了会让 tabs.query 仍见视频页 → 误走 focus-tab）
          for (let i = 0; i < 24; i++) {
            const urls = await swEval(`(async () => JSON.stringify((await chrome.tabs.query({})).map((t) => t.url ?? '')))()`);
            if (Array.isArray(urls) && !urls.some((u) => u.includes(`/video/${BVID}`))) break;
            await sleep(250);
          }
          const attachedBefore = attachedTargets.length;
          const ntClick = await eval2(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            // 同 crossTab：取第 3 条 li（mock=120），目标秒动态读取
            const lis = [...sr.querySelectorAll('.d-outline li[data-sec]')];
            const li = lis[2] ?? lis[1] ?? lis[0];
            if (!li) return JSON.stringify({ err: 'no-li' });
            const sec = Number(li.getAttribute('data-sec')) || 0;
            li.click();
            return JSON.stringify({ clicked: true, sec });
          })()`);
          await sleep(1500);
          const tab2Toast = await eval2(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify([...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? ''));
          })()`);
          // 轮询等新 target attach（审查 P2-4b：attach 时刻 url 快照 + 固定 sleep 改带超时轮询）
          let created = null;
          for (let i = 0; i < 24 && !created; i++) {
            await sleep(250);
            created = attachedTargets.slice(attachedBefore).find(
              (t) => t.type === 'page' && t.url.includes(`/video/${BVID}`) && t.url.includes(`t=${ntClick?.sec ?? '\u2205'}`),
            ) ?? null;
          }
          seekProbe = { ...seekProbe, newTab: { click: ntClick, createdUrl: created?.url ?? null, tab2Toast } };
          log('P1.8 新标签页探针:', JSON.stringify(seekProbe.newTab));

          // 8.97) P1.9 浮层七准则探针：overlay 不推挤 / 全屏迁移 / 闲时半透明 / 输入聚焦抑制 / 上下文跟随
          let p19 = {};
          {
            // tab3 = 新标签页分支直达的视频页（overlay + 全屏探针载体）
            const tab3Sid = created?.targetId ? (sessionByTarget.get(created.targetId) ?? null) : null;
            if (tab3Sid) {
              const eval3 = (expression) => evalIn(tab3Sid, expression);
              await sleep(2500); // 等 tab3 页面与播放器容器就绪
              // (a) 准则#2 overlay 不推挤：面板开合前后页面布局度量一致
              const metrics = `(() => JSON.stringify({ sw: document.body.scrollWidth, bw: document.body.clientWidth,
                px: Math.round(document.querySelector('.bpx-player-container')?.getBoundingClientRect().x ?? -1) }))()`;
              const mClosed = await eval3(metrics);
              await eval3(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot').click()`);
              await sleep(900);
              const mOpen = await eval3(metrics);
              p19 = { ...p19, overlayNoPush: { mClosed, mOpen } };
              log('P1.9 overlay 不推挤探针:', JSON.stringify(p19.overlayNoPush));

              // (b) 准则#3 全屏避让：播放器容器全屏 → Shadow 宿主迁入其子树；退出 → 迁回 documentElement
              const rect = await eval3(`(() => {
                const r = document.querySelector('.bpx-player-container')?.getBoundingClientRect();
                return JSON.stringify(r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null);
              })()`);
              if (rect) {
                await cdp('Input.enable', {}, tab3Sid).catch(() => {});
                // 真手势（requestFullscreen 需 transient activation）；点播放器中心=播放/暂停切换，无副作用
                await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, tab3Sid);
                await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, tab3Sid);
                const fsReq = await eval3(`(async () => {
                  const el = document.querySelector('.bpx-player-container');
                  if (!el) return JSON.stringify({ err: 'no-player' });
                  try { await el.requestFullscreen(); return JSON.stringify({ ok: true }); }
                  catch (e) { return JSON.stringify({ err: String((e && e.name) ?? e) }); }
                })()`);
                await sleep(800);
                const fsState = await eval3(`(() => {
                  const host = document.getElementById('doubao-ui-root');
                  return JSON.stringify({ fs: !!document.fullscreenElement,
                    parentCls: String(host.parentElement?.className ?? host.parentElement?.tagName ?? ''),
                    mascotVisible: !!host.shadowRoot.getElementById('mascot-wrap').getBoundingClientRect().width });
                })()`);
                await shotNamed(tab3Sid, 'visual-fullscreen.png'); // 视觉验收：全屏态豆包/面板迁入播放器层
                await eval3(`(async () => { if (document.fullscreenElement) await document.exitFullscreen(); })()`);
                await sleep(800);
                const fsBack = await eval3(`(() => {
                  const host = document.getElementById('doubao-ui-root');
                  return JSON.stringify({ fs: !!document.fullscreenElement, back: host.parentElement === document.documentElement });
                })()`);
                p19 = { ...p19, fullscreen: { fsReq, fsState, fsBack } };
                log('P1.9 全屏避让探针:', JSON.stringify(p19.fullscreen));
              }
            } else {
              log('P1.9 探针：tab3 session 未得，overlay/全屏跳过');
            }

            // (c) 准则#1 闲时半透明：tab2 超 5s 无交互 → idle-dim；pointerenter 唤醒
            let dim = null;
            for (let i = 0; i < 24 && !dim?.dim; i++) {
              dim = await eval2(`(() => JSON.stringify({ dim: document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot-wrap').classList.contains('idle-dim') }))()`);
              if (!dim?.dim) await sleep(300);
            }
            await eval2(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot-wrap').dispatchEvent(new PointerEvent('pointerenter'))`);
            await sleep(200);
            const woke = await eval2(`(() => JSON.stringify({ dim: document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot-wrap').classList.contains('idle-dim') }))()`);
            p19 = { ...p19, idleDim: { dimmed: dim?.dim === true, wokeAfterHover: woke?.dim === false } };
            log('P1.9 闲时半透明探针:', JSON.stringify(p19.idleDim));

            // (d) 准则#3 输入聚焦不弹：聚焦搜索框 → 结束陪看的气泡被抑制；blur 后恢复陪看气泡正常
            const focused = await eval2(`(() => {
              const inp = document.querySelector('.nav-search-input') || document.querySelector('#nav-searchform input') || document.querySelector('input');
              if (!inp) return JSON.stringify({ err: 'no-input' });
              inp.focus();
              return JSON.stringify({ focused: document.activeElement === inp });
            })()`);
            await eval2(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('btn-end')?.click()`);
            await sleep(1200); // SESSION_END 广播 + setSessionState(GRACE) 的 say 应被抑制
            const suppressed = await eval2(`(() => JSON.stringify({ bubbleHidden: document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot-bubble').classList.contains('hidden') }))()`);
            await eval2(`(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()`);
            await eval2(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('btn-resume')?.click()`);
            await sleep(1200);
            const resumedBubble = await eval2(`(() => {
              const b = document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot-bubble');
              return JSON.stringify({ hidden: b.classList.contains('hidden'), text: (b.textContent ?? '').slice(0, 12) });
            })()`);
            p19 = { ...p19, inputFocus: { focused, suppressed, resumedBubble } };
            log('P1.9 输入聚焦抑制探针:', JSON.stringify(p19.inputFocus));

            // (e) 准则#5 上下文自动跟随：tab1 面板开着时 SPA 切另一视频 → 列表刷新新视频置顶（零生成副作用）
            await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot').click()`);
            await sleep(900); // tab1 面板开（列表态）
            await pageEval(`history.pushState({}, '', '/video/BV1DUnB61ErU/')`);
            // 轮询等跟随刷新（审查 P2-6②：固定 sleep 覆盖不了慢网下 view 真取 + LIST_QUERY 往返）
            let follow = null;
            for (let i = 0; i < 24 && !String(follow?.firstKey ?? '').startsWith('BV1DUnB61ErU:'); i++) {
              await sleep(300);
              follow = await pageEval(`(() => {
                const sr = document.getElementById('doubao-ui-root').shadowRoot;
                const first = sr.querySelector('.v-item');
                return JSON.stringify({ open: sr.getElementById('panel').classList.contains('open'),
                  firstKey: first?.getAttribute('data-video-key') ?? '', count: sr.querySelectorAll('.v-item').length });
              })()`);
            }
            p19 = { ...p19, follow };
            log('P1.9 上下文跟随探针:', JSON.stringify(p19.follow));
          }
          p19Probe = p19;
        }

        // 8.98) P2.1 保留期判定：结束陪看 → GRACE 倒计时（保留至 HH:MM + #cd 秒级走动）
        //   → warp -30min 重开面板仍 GRACE（59min 内恢复+倒计时续算，F10）
        //   → warp -2h 重开面板 → EXPIRED_PENDING_CONFIRM（状态文案+无开始/恢复按钮+数据仍在+豆包可开面板）
        //   时间 warp = 直写 sessionPointer.closedAt（与 DEV_RETENTION_WARP 消息等价的存储层操作，
        //   判定路径完全一致：重开面板走 LIST_QUERY → evaluateRetention）
        {
          const panelState = () => pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const st = sr.getElementById('p-status');
            return JSON.stringify({ open: sr.getElementById('panel').classList.contains('open'),
              status: st?.textContent ?? '', hasCd: !!sr.getElementById('cd'),
              cd: sr.getElementById('cd')?.textContent ?? null,
              resumeBtn: !!sr.getElementById('btn-resume'), startBtn: !!sr.getElementById('btn-start2'),
              items: sr.querySelectorAll('.v-item').length,
              toasts: [...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? '') });
          })()`);
          const getPtr = () => swEval(`(async () => JSON.stringify((await chrome.storage.local.get('sessionPointer')).sessionPointer ?? null))()`);
          const warp = (backMs) => swEval(`(async () => {
            const p = (await chrome.storage.local.get('sessionPointer')).sessionPointer;
            if (!p) return 'no-pointer';
            p.closedAt = Date.now() - ${backMs};
            await chrome.storage.local.set({ sessionPointer: p });
            return 'warped';
          })()`);
          const setPanel = async (wantOpen) => {
            const st = await panelState();
            if (st && st.open !== wantOpen) {
              await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot').click()`);
              await sleep(700);
            }
          };

          // a) ACTIVE → 点「结束陪看」→ GRACE：toast（保留 1 小时口径）+ 倒计时挂载 + retainUntil 数学
          await setPanel(true);
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('btn-end')?.click()`);
          await sleep(1100);
          const graceDom = await panelState();
          const gracePtr = await getPtr();
          // 倒计时秒级走动：轮询观察（隐藏标签页的 setTimeout 会被 Chrome 节流，固定 1.3s 窗口会 flake）
          let cdAfter = graceDom;
          for (let i = 0; i < 14 && cdAfter?.cd === graceDom?.cd; i++) {
            await sleep(500);
            cdAfter = await panelState();
          }
          const graceMath = gracePtr?.closedAt !== undefined && Date.now() - gracePtr.closedAt < 10_000;
          log('P2.1 GRACE 探针:', JSON.stringify({ graceDom, gracePtr: { state: gracePtr?.state, closedAt: gracePtr?.closedAt }, cdAfter: cdAfter?.cd, graceMath }));

          // b) warp -30min → 重开面板：仍 GRACE（59min<1h 恢复）+ 倒计时续算（≈30min 量级）
          await warp(30 * 60_000);
          await setPanel(false);
          await setPanel(true);
          await sleep(900);
          const midDom = await panelState();
          const midPtr = await getPtr();
          log('P2.1 warp-30min 探针:', JSON.stringify({ midDom: { status: midDom?.status, cd: midDom?.cd, items: midDom?.items }, midPtr: midPtr?.state }));

          // c) warp -2h → 重开面板：EXPIRED_PENDING_CONFIRM（文案+无开始/恢复按钮+数据仍在+豆包可开面板）
          await warp(2 * 3600_000);
          await setPanel(false);
          await setPanel(true);
          await sleep(900);
          const expDom = await panelState();
          const expPtr = await getPtr();
          // EXPIRED 态点豆包身体=开面板（处置入口可达，P2.1 点击路由修复）
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot').click()`);
          await sleep(400);
          const expPanelClosed = await panelState();
          await pageEval(`document.getElementById('doubao-ui-root').shadowRoot.getElementById('mascot').click()`);
          await sleep(700);
          const expPanelReopen = await panelState();
          retentionProbe = {
            grace: {
              state: gracePtr?.state === 'GRACE',
              toast: (graceDom?.toasts ?? []).some((t) => t.includes('保留 1 小时')),
              hasCountdown: graceDom?.hasCd === true,
              cdTicking: typeof graceDom?.cd === 'string' && typeof cdAfter?.cd === 'string' && graceDom.cd !== cdAfter.cd,
              closedAtFresh: graceMath,
            },
            restoreUnder1h: {
              state: midPtr?.state === 'GRACE',
              statusHasRetain: (midDom?.status ?? '').includes('保留至'),
              cdResumed: /^00:[23]\d:\d\d$/.test(midDom?.cd ?? ''), // warp -30min → 剩 ≈29–30min
              itemsKept: (midDom?.items ?? 0) >= 1,
            },
            expiredOver1h: {
              state: expPtr?.state === 'EXPIRED_PENDING_CONFIRM',
              statusText: (expDom?.status ?? '').includes('已超保留期'),
              noStartNoResume: expDom?.startBtn === false && expDom?.resumeBtn === false,
              itemsStillThere: (expDom?.items ?? 0) >= 1, // 判定只改状态不删数据（F10：不静默删）
              mascotTogglesPanel: expPanelClosed?.open === false && expPanelReopen?.open === true,
            },
          };
          log('P2.1 判定项:', JSON.stringify(retentionProbe));
          await shotNamed(probeSid, 'visual-retention-expired.png');
        }

        // 8.99) P2.2 F10 清除链路：超期确认弹窗（打开面板即弹）→ 稍后提醒（重开再弹）→
        //   立即清除（六表 0 行 + pointer 移除 + settings/onboarded 保留 + 面板回未激活空态）
        //   → 手动清除入口（🗑：取消不动作 / 确认清除同上）
        {
          const modalState = () => pageEval(`(() => {
            const mr = document.getElementById('doubao-ui-root').shadowRoot.getElementById('modal-root');
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            return JSON.stringify({ shown: mr.classList.contains('show'), owner: mr.dataset.owner ?? '',
              title: mr.querySelector('h2')?.textContent ?? '', desc: mr.querySelector('.modal-head p')?.textContent ?? '',
              hasLater: !!mr.querySelector('#wipe-later'), hasNow: !!mr.querySelector('#wipe-now'),
              panelStatus: sr.getElementById('p-status')?.textContent ?? '', items: sr.querySelectorAll('.v-item').length,
              empty: !!sr.querySelector('.empty-mascot'), startBtn: !!sr.getElementById('btn-start2'),
              toasts: [...sr.querySelectorAll('#toast-root .toast')].map((x) => x.textContent ?? '') });
          })()`);
          const dbCounts = () => swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const names = ['sessions','videos','visits','transcripts','summaries','jobs'];
            const counts = {};
            for (const n of names) counts[n] = await new Promise((res) => { const q = db.transaction(n,'readonly').objectStore(n).count(); q.onsuccess = () => res(q.result); });
            const st = await chrome.storage.local.get(['sessionPointer','onboarded','settings']);
            return JSON.stringify({ counts, pointer: st.sessionPointer ?? null, onboarded: st.onboarded ?? null, hasSettings: !!st.settings });
          })()`);
          const click = (sel) => pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('${sel}')?.click()`);

          // a) 超期确认弹窗：P2.1 探针最后一次重开面板已触发（EXPIRED 态开面板即弹）
          await sleep(600);
          const m1 = await modalState();
          await shotNamed(probeSid, 'visual-wipe-modal.png');

          // b) 稍后提醒 → 弹窗关 + toast；重开面板 → 再弹（F10-④ 同一浏览器会话重提醒）；数据仍在（表级断言）
          await click('#wipe-later');
          await sleep(500);
          const afterLater = await modalState();
          const ptrLater = await swEval(`(async () => JSON.stringify((await chrome.storage.local.get('sessionPointer')).sessionPointer ?? null))()`);
          const keepDb = await dbCounts();
          await click('#mascot'); // 关面板
          await sleep(400);
          await click('#mascot'); // 重开 → EXPIRED 态开面板应再弹
          await sleep(800);
          const reopen = await modalState();

          // c) 【立即清除】（审查 P1-1 回归：生成中清除不复活）——mock 模式先武装慢 LLM（挂 9s），
          //    在超期弹窗仍展示时经 DOM 直点发起 REGENERATE（旧 done 摘要在库），job 进入 running
          //    后点弹窗【立即清除】→ wipe 应掐死在途 offscreen 执行体；随后观察 10s 无孤儿写入。
          let midFlight = null;
          {
            if (!REAL) await fetch(`${llmCfg.baseUrl}/__test/slow?count=1&ms=9000`).catch(() => {}); // REAL：真实 LLM 全链 ~80s 天然挂窗，无需钩子
            const jobsState = () => swEval(`(async () => {
              const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
              const rows = await new Promise((res) => { const q = db.transaction('jobs','readonly').objectStore('jobs').getAll(); q.onsuccess = () => res(q.result); });
              return JSON.stringify(rows.map((j) => ({ type: j.type, status: j.status })));
            })()`);
            await click('.v-item'); // 进详情（EXPIRED 态数据仍在，直点 DOM 不受弹窗遮罩影响）
            let dRegen = false;
            for (let i = 0; i < 12 && !dRegen; i++) { await sleep(300); dRegen = await pageEval(`!!document.getElementById('doubao-ui-root').shadowRoot.getElementById('d-regen')`); }
            if (dRegen) await click('#d-regen');
            let running = null;
            for (let i = 0; i < 30 && !(running ?? []).some((j) => j.status === 'running' || j.status === 'pending'); i++) {
              await sleep(300);
              running = await jobsState();
            }
            const jobSeen = (running ?? []).some((j) => j.status === 'running' || j.status === 'pending');
            if (jobSeen) {
              await click('#wipe-now'); // 清除确认弹窗仍展示——生成中按下立即清除
              await sleep(1600);
              const midWipeDb = await dbCounts();
              await sleep(REAL ? 125_000 : 9_500); // 挂窗结束（REAL=真实应答落地后）：修复缺失时执行体会在此后落孤儿行
              const lateDb = await dbCounts();
              midFlight = { jobSeen: true,
                wipedClean: midWipeDb && Object.values(midWipeDb.counts ?? {}).every((n) => n === 0),
                noResurrect: lateDb && Object.values(lateDb.counts ?? {}).every((n) => n === 0) && lateDb.pointer === null };
              log('P2.2 生成中清除回归:', JSON.stringify(midFlight));
            } else {
              midFlight = { jobSeen: false, wipedClean: null, noResurrect: null };
              log('P2.2 生成中清除回归：job 未观察到（降级为直接清除路径）');
            }
          }

          // P2.5：手动清除入口已迁设置页（P2.2 列表头 🗑 移除）——齿轮→危险操作→【立即清除全部数据】
          const wipeEntry = async () => { await click('#btn-settings'); await sleep(700); await click('#btn-clear'); await sleep(400); };

          // c2) 立即清除（或上面回归路径已清除）→ 六表 0 行 + pointer 移除 + settings/onboarded 保留 + 未激活空态
          const wipeNeeded = !midFlight?.wipedClean;
          if (wipeNeeded) {
            if (!(await modalState())?.shown) { await wipeEntry(); }
            await click('#wipe-now');
            await sleep(1400);
          }
          const afterWipe = await modalState();
          const wipeDb = await dbCounts();

          // d) 手动清除（🗑 列表头入口）：新会话 → 取消（不动作）→ 确认（清除）
          await click('#btn-start2');
          await sleep(1000);
          const activeState = await modalState();
          await wipeEntry();
          await sleep(300);
          const mCancel = await modalState();
          await click('#wipe-later'); // 取消
          await sleep(500);
          const afterCancel = await modalState();
          await wipeEntry();
          await click('#wipe-now');
          await sleep(1400);
          const afterManual = await modalState();
          const manualDb = await dbCounts();

          wipeProbe = {
            expiredModal: {
              shown: m1?.shown === true,
              owner: m1?.owner === 'expired-confirm',
              copy:
                (m1?.title ?? '').includes('已超过保留时间') &&
                (m1?.desc ?? '').includes('超过 1 小时') &&
                (m1?.desc ?? '').includes('列表、摘要与转写') &&
                m1?.hasLater === true &&
                m1?.hasNow === true,
            },
            laterRemindReprompts: {
              closed: afterLater?.shown === false,
              toast: (afterLater?.toasts ?? []).some((t) => t.includes('稍后再提醒')),
              dataKept: ptrLater?.state === 'EXPIRED_PENDING_CONFIRM' && keepDb && Object.values(keepDb.counts ?? {}).some((n) => n > 0),
              reprompts: reopen?.shown === true && reopen?.owner === 'expired-confirm',
            },
            wipeMidFlightNoResurrect: (midFlight?.jobSeen === true && midFlight?.wipedClean === true && midFlight?.noResurrect === true),
            wipeConfirmClears: {
              uiReset: afterWipe?.shown === false && (afterWipe?.panelStatus ?? '').includes('未激活') && afterWipe?.items === 0 && afterWipe?.empty === true && afterWipe?.startBtn === true,
              dbEmpty: wipeDb && Object.values(wipeDb.counts ?? {}).every((n) => n === 0),
              pointerGone: wipeDb?.pointer === null,
              settingsKept: wipeDb?.onboarded === true && wipeDb?.hasSettings === true,
            },
            manualWipeDoubleConfirm: {
              startsActive: (activeState?.panelStatus ?? '').includes('陪看中'),
              cancelNoop: mCancel?.shown === true && (mCancel?.title ?? '').includes('清除全部陪看数据') && afterCancel?.shown === false && (afterCancel?.panelStatus ?? '').includes('陪看中'),
              confirmWipes:
                (afterManual?.panelStatus ?? '').includes('未激活') &&
                manualDb && Object.values(manualDb.counts ?? {}).every((n) => n === 0) &&
                manualDb?.pointer === null && manualDb?.onboarded === true && manualDb?.hasSettings === true,
            },
          };
          log('P2.2 判定项:', JSON.stringify(wipeProbe));
          // 封堵 tick sweep 竞态（git log 同款教训族）：wipe 后 P2.3 重启会话时，若探针页 BVID 仍在播放，
          // 累计 watchedSeconds 首 tick 即过阈 → sweep 合法重跑摘要并置 visit.triggered=1，
          // 破坏 d) 阈值滑杆前提（5s 扫幂等失效）。P2.2 收口统一暂停，d) 导航后自行 playMuted
          await pageEval(`(() => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); if (v) v.pause(); return 'paused'; })()`).catch(() => {});
        }

        // 8.995) P2.3 F6 ASR 确认流（mock/REAL 混合均执行：REAL=真实音频+mock 转写+真实 LLM）：无字幕视频 → 触发 → need_asr 橙标
        //   → 卡片文案逐字 → 未配置点【调用 ASR 解析】→ onboarding ASR 补配模式（LLM 沿用）
        //   → 填 mock ASR 保存 → 回卡片再点确认 → 真实 playurl+音频下载（DNR 补 Referer）
        //   → mock /audio/transcriptions（verbose_json）→ mock LLM → done（来源=ASR转写）
        {
          const ASR_PAGE = `https://www.bilibili.com/video/${ASR_BVID}/`;
          const panelJson = (expr) => pageEval(`(() => {
            const sr = document.getElementById('doubao-ui-root').shadowRoot;
            const first = sr.querySelector('.v-item');
            ${expr}
            return JSON.stringify(ret);
          })()`);
          const asrModal = () => pageEval(`(() => {
            const mr = document.getElementById('doubao-ui-root').shadowRoot.getElementById('modal-root');
            return JSON.stringify({ shown: mr.classList.contains('show'),
              title: mr.querySelector('h2')?.textContent ?? '', hasLlmStep: !!mr.querySelector('#ob-llm'),
              hasAsrStep: !!mr.querySelector('#ob-asr'), hasSave: !!mr.querySelector('#ob-save') });
          })()`);
          const pclick = (sel) => pageEval(`document.getElementById('doubao-ui-root').shadowRoot.querySelector('${sel}')?.click()`);

          // a) 新会话（P2.2 收尾已回未激活）→ 导航无字幕视频页 → 静音播放
          await pclick('#btn-start2');
          await sleep(900);
          await cdp('Page.navigate', { url: ASR_PAGE }, probeSid);
          await cdp('Page.bringToFront', {}, probeSid).catch(() => {}); // 有效观看=前台+播放中：tab1 此前被 tab2/tab3 顶到后台
          let uiReady = false;
          for (let i = 0; i < 40 && !uiReady; i++) {
            await sleep(500);
            uiReady = await pageEval(`!!document.getElementById('doubao-ui-root')?.shadowRoot?.getElementById('mascot')`);
          }
          // 面板随导航重置为关：开面板等 need_asr 徽章（5s 阈值真实触发 → 无轨 → need_confirm）
          await pclick('#mascot');
          await sleep(800);
          const playExpr2 = `(async () => {
            const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video');
            if (!v) return JSON.stringify({ err: 'no-video' });
            v.muted = true;
            try { await v.play(); return JSON.stringify({ ok: true, paused: v.paused }); } catch (e) { return JSON.stringify({ err: String(e.name ?? e) }); }
          })()`;
          let played = false;
          for (let i = 0; i < 12 && !played; i++) {
            const r = await pageEval(`(async () => ${playExpr2})()`);
            played = r?.ok === true && r?.paused === false;
            log(`ASR play attempt ${i + 1}:`, JSON.stringify(r));
            if (!played) await sleep(1500);
          }
          let nosubBadge = null;
          for (let i = 0; i < 120 && !(nosubBadge?.badge ?? '').includes('无字幕'); i++) {
            await sleep(500);
            nosubBadge = await panelJson(`const b = first?.querySelector('.badge'); const ret = { badge: b?.textContent ?? '', key: first?.getAttribute('data-video-key') ?? '' };`);
          }
          // 反自动播劫持封堵（git log 同款教训：93s 短视频在 ~50s 确认输入序列内 ended →
          // B 站自动播推荐换页，后续卡片/徽章全读错视频）：need_confirm 已达，此后零观看依赖 → 暂停
          await pageEval(`(() => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); if (v) v.pause(); return 'paused'; })()`).catch(() => {});
          await shotNamed(probeSid, 'visual-asr-need-confirm.png');

          // b) 点条目 → 详情 ASR 确认卡（文案逐字 F6-①）+【调用 ASR 解析】【暂不】
          await pclick('.v-item');
          let asrCard = null;
          for (let i = 0; i < 16 && !(asrCard?.text ?? '').includes('调用 ASR'); i++) {
            await sleep(400);
            asrCard = await pageEval(`(() => {
              const sr = document.getElementById('doubao-ui-root').shadowRoot;
              const s = sr.getElementById('d-summary');
              return JSON.stringify({ text: s?.textContent ?? '', hasOk: !!sr.getElementById('btn-asr-ok'), hasNo: !!sr.getElementById('btn-asr-no'), hint: (s?.textContent ?? '').includes('25MB') });
            })()`);
          }

          // c) 未配置 → 点【调用 ASR 解析】→ onboarding ASR 补配模式（无 LLM 步、有 ASR 步）
          await pclick('#btn-asr-ok');
          let obAsr = null;
          for (let i = 0; i < 12 && !(obAsr?.shown); i++) {
            await sleep(400);
            obAsr = await asrModal();
          }
          // d) 填 mock ASR → 保存（asr-only 载荷：SW 沿用已存 LLM）→ 模态关闭
          if (obAsr?.shown) {
            await pageEval(`(() => {
              const sec = document.getElementById('doubao-ui-root').shadowRoot.getElementById('ob-asr');
              const set = (k, v) => { const i = sec.querySelector(\`input[data-k="\${k}"]\`); if (i) i.value = v; };
              set('baseUrl', ${JSON.stringify(mockCfg.baseUrl)}); // ASR 转写恒走 mock（本轮无真实 ASR Key）
              set('modelId', 'mock-asr-model');
              set('apiKey', 'e2e-mock-asr-key');
            })()`);
            await pclick('#ob-save');
            await sleep(1200);
          }
          const afterSave = await asrModal();

          // e) 回到卡片（详情仍在）再点确认 → 三段进度动画 → done ASR转写。
          //    mock 全链 ~3s：阶段文案是转瞬动画，轮询断言「至少一个阶段文案被观测到」
          //    （下载音频/语音转写/整理要点/撰写摘要），不要求逐一捕获。
          let stageSeen = false;
          const stageSamples = [];
          if (!afterSave?.shown) {
            await pclick('#btn-asr-ok');
            for (let i = 0; i < 40 && !stageSeen; i++) {
              await sleep(300);
              const st = await pageEval(`(() => {
                const sr = document.getElementById('doubao-ui-root').shadowRoot;
                const t = sr.getElementById('d-summary')?.textContent ?? '';
                return JSON.stringify({ stage: t.includes('下载音频') || t.includes('语音转写') || t.includes('整理要点') || t.includes('撰写摘要'),
                  sample: t.slice(0, 40), inDetail: !!sr.getElementById('d-back') });
              })()`);
              if (stageSamples.length < 6) stageSamples.push(st?.sample ?? '');
              stageSeen = st?.stage === true;
            }
            log('ASR 阶段观测样本:', JSON.stringify(stageSamples));
          }
          // REAL 修复（本轮审查）：确认已入队后播放与任务无关——seek 中段+暂停，
          // 防 93s 音乐视频在 ~60s 真实 LLM 链内 ended→B 站自动播把详情页/当前视频位劫持（连带 P2.5-b 前置）
          await pageEval(`(async () => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); try { if (v && Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 2; } catch (e) {} try { v?.pause(); } catch (e) {} return 'ok'; })()`).catch(() => {});
          // done 判定以详情视图为准：面板此刻在详情页（点过确认卡），列表徽章 DOM 不在文档中；
          // done 后 SUMMARY_DONE 广播重开详情 → 来源徽章 ASR转写 + 成品摘要就位
          let asrDetail = null;
          for (let i = 0; i < (REAL ? 300 : 60) && !(asrDetail?.srcBadge ?? '').includes('ASR转写'); i++) { // REAL：ASR 文本→真实 LLM 摘要 ~90s
            await sleep(500);
            asrDetail = await pageEval(`(() => {
              const sr = document.getElementById('doubao-ui-root').shadowRoot;
              return JSON.stringify({ srcBadge: sr.querySelector('.src-badge')?.textContent ?? '',
                sumLen: (sr.getElementById('d-summary')?.textContent ?? '').length });
            })()`);
          }
          const asrDb = await swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const trs = await new Promise((res) => { const q = db.transaction('transcripts','readonly').objectStore('transcripts').getAll(); q.onsuccess = () => res(q.result); });
            const sums = await new Promise((res) => { const q = db.transaction('summaries','readonly').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result); });
            return JSON.stringify({ transcripts: trs.map((t) => ({ source: t.source, cues: t.cues.length })),
              summaries: sums.map((s) => ({ status: s.status, source: s.source })) });
          })()`);
          await shotNamed(probeSid, 'visual-asr-done.png');
          const asrStats = await fetch(`${mockCfg.baseUrl}/__test/asr-stats`).then((r) => r.json()).catch(() => null);
          asrProbe = {
            audioBytes: asrStats?.bytes ?? 0,
            needConfirmBadge: played && (nosubBadge?.badge ?? '').includes('无字幕') && !!(nosubBadge?.key ?? '').startsWith(ASR_BVID),
            confirmCardCopy: (asrCard?.text ?? '').includes('该视频文字信息较少，请确认是否调用 ASR 做进一步解析？') && asrCard?.hasOk === true && asrCard?.hasNo === true,
            needConfigOnboarding: obAsr?.shown === true && obAsr?.hasLlmStep === false && obAsr?.hasAsrStep === true && obAsr?.title.includes('补配 ASR') === true,
            saveAsrThenRun:
              afterSave?.shown === false &&
              stageSeen === true &&
              (asrDetail?.srcBadge ?? '').includes('ASR转写') &&
              (asrDetail?.sumLen ?? 0) > 100 &&
              (asrDb?.transcripts ?? []).some((t) => t.source === 'asr' && t.cues > 0) &&
              (asrDb?.summaries ?? []).some((s) => s.status === 'done' && s.source === 'asr'),
          };
          log('P2.3 判定项:', JSON.stringify(asrProbe));

          // P2.4 DNR 头级验证（验收记录 §3 N-10 记账项收口）：
          // ① ASR 链真实下载的 bilivideo 音频请求（offscreen 发起），网络栈实发头 Referer 必须
          //    等于 DNR 注入值（extraInfo 与 requestWillBeSent 乱序到达，事后按 requestId 关联）；
          // ② SW getDynamicRules 形状审计（双域 / initiator=runtime.id / xmlhttprequest / modifyHeaders）。
          const biliAudioReqs = [...reqUrlById.entries()].filter(([, u]) => {
            try { return /(^|\.)bilivideo\.(com|cn)$/.test(new URL(u).hostname); } catch { return false; }
          });
          const refererOf = (rid) => {
            const hd = extraHeadersById.get(rid) ?? {};
            const ent = Object.entries(hd).find(([k]) => k.toLowerCase() === 'referer');
            return ent ? String(ent[1]) : null;
          };
          const dnrRules = await swEval(`(async () => {
            const rules = await chrome.declarativeNetRequest.getDynamicRules();
            return JSON.stringify({ runtimeId: chrome.runtime.id, rules: rules.map((r) => ({
              id: r.id, urlFilter: r.condition.urlFilter, initiator: r.condition.initiatorDomains,
              types: r.condition.resourceTypes, headers: r.action.requestHeaders })) });
          })()`);
          dnrProbe = {
            audioReqCount: biliAudioReqs.length,
            referers: biliAudioReqs.map(([rid, u]) => ({ host: new URL(u).hostname, referer: refererOf(rid) })),
            headerOk: biliAudioReqs.length > 0 && biliAudioReqs.every(([rid]) => refererOf(rid) === 'https://www.bilibili.com/'),
            ruleShapeOk:
              !!dnrRules &&
              dnrRules.rules?.length === 2 &&
              dnrRules.rules.every(
                (r) =>
                  (r.urlFilter === '||bilivideo.com^' || r.urlFilter === '||bilivideo.cn^') &&
                  r.initiator?.[0] === dnrRules.runtimeId &&
                  r.types?.length === 1 && r.types[0] === 'xmlhttprequest' &&
                  r.headers?.length === 1 && r.headers[0].header === 'Referer' && r.headers[0].operation === 'set',
              ),
          };
          log('P2.4 判定项:', JSON.stringify(dnrProbe));

          // ============================================================
          // 8.996) P2.5 设置页完整版探针：
          //   基础视图+Key 打码+测试连接哨兵+保存不改 Key / 人设切换联动询问(2.7b+F8) /
          //   阈值滑杆真实生效（F2：60s 不触发→5s 触发）/ 暂停陪看（F12：零采集零请求）/
          //   气泡开关 / 清空 LLM Key（F9：确认→门槛回锁）/ 隐藏豆包+手动清除迁移设置页
          // ============================================================
          const srOf = (expr) => pageEval(`(() => { const sr = document.getElementById('doubao-ui-root').shadowRoot; ${expr} })()`);
          const swStore = () => swEval(`(async () => { const s = await chrome.storage.local.get(['settings','onboarded']); return JSON.stringify({ settings: s.settings ?? null, onboarded: s.onboarded === true }); })()`);
          const jobsOf = (vk) => swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const js = await new Promise((res) => { const q = db.transaction('jobs','readonly').objectStore('jobs').getAll(); q.onsuccess = () => res(q.result); });
            const sm = await new Promise((res) => { const q = db.transaction('summaries','readonly').objectStore('summaries').getAll(); q.onsuccess = () => res(q.result); });
            return JSON.stringify({ jobs: js.filter((j) => String(j.videoKey).startsWith(${JSON.stringify(vk + ':')}) && j.type !== 'SEGMENT_ANALYZE').length,
              // F13 预取：SEGMENT_ANALYZE 行不计入——pause/threshold 探针语义=「零摘要类生成」，
              // 预取行是此前摘要 done 的合法留存产物，与本轮采集/触发无关
              sum: sm.filter((x) => String(x.videoKey).startsWith(${JSON.stringify(vk + ':')})).sort((a, b) => a.createdAt - b.createdAt).map((s) => ({ status: s.status, persona: s.persona, createdAt: s.createdAt })) });
          })()`);
          const visitsFor = (vk) => swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const vs = await new Promise((res) => { const q = db.transaction('visits','readonly').objectStore('visits').getAll(); q.onsuccess = () => res(q.result); });
            return JSON.stringify(vs.filter((v) => String(v.videoKey).startsWith(${JSON.stringify(vk + ':')})).length); })()`);

          // ---- a) 设置视图基础 + Key 打码 + 测试连接（打码哨兵）+ 保存不改 Key ----
          await pageEval(`(async () => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); try { if (v && Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 2; } catch (e) {} try { v?.pause(); } catch (e) {} return 'paused'; })()`).catch(() => {}); // seek 中段+pause：挡 ended→B 站自动播推荐（p26b/p26d 实测 flake 源）
          await pclick('#btn-settings');
          await sleep(900);
          const stDom = await srOf(`return JSON.stringify({
            shown: !sr.getElementById('view-settings')?.classList.contains('hidden'),
            listHidden: sr.getElementById('view-list')?.classList.contains('hidden') === true,
            llmTag: sr.querySelector('#sec-llm .set-tag')?.textContent ?? '',
            asrTag: sr.querySelector('#sec-asr .set-tag')?.textContent ?? '',
            ttsDisabled: !!sr.querySelector('#sec-tts.set-disabled input[disabled]'),
            sliderVal: sr.getElementById('set-threshold')?.value ?? '',
            pills: [...sr.querySelectorAll('.persona-pill')].map((p) => p.getAttribute('data-persona')),
            sws: ['sw-bubbles','sw-hide','sw-pause'].map((id) => !!sr.getElementById(id)),
            danger: !!sr.getElementById('btn-clear'),
            llmKey: sr.querySelector('#sec-llm input[data-k="apiKey"]')?.value ?? '',
            asrKey: sr.querySelector('#sec-asr input[data-k="apiKey"]')?.value ?? '',
          })`);
          await shotNamed(probeSid, 'visual-settings.png'); // 视觉验收：设置页全貌（模型三区/滑杆/人设/开关/危险区）——审查时误挂清除后，现移回设置视图打开时
          const maskOk = (v, key) => v === '****' + String(key).slice(-4); // 审查（REAL 轮）：mock 两 Key 同尾缀系巧合，各字段须比自己的 Key
          await pclick('[data-test="sec-llm"]');
          let testOk = false;
          for (let i = 0; i < (REAL ? 60 : 20) && !testOk; i++) {
            await sleep(400);
            const t = await srOf(`return JSON.stringify({ t: sr.querySelector('[data-status="sec-llm"]')?.textContent ?? '' })`);
            testOk = String(t?.t ?? '').includes('连接成功');
          }
          await pclick('[data-save="sec-llm"]');
          await sleep(1000);
          const storeAfterSave = await swStore();

          // ---- b) 人设切换联动询问（2.7b+F8）：当前视频=ASR 页，已有 done 点评 ----
          const sumBefore = (await jobsOf(ASR_BVID)) ?? {};
          await srOf(`(() => { const p = [...sr.querySelectorAll('.persona-pill')].find((x) => x.getAttribute('data-persona') === 'gentle'); p?.click(); })()`);
          let regenModal = false;
          for (let i = 0; i < 12 && !regenModal; i++) {
            await sleep(400);
            const m = await srOf(`return JSON.stringify({ shown: sr.getElementById('modal-root')?.classList.contains('show'), owner: sr.getElementById('modal-root')?.dataset.owner ?? '' })`);
            regenModal = m?.shown === true && m?.owner === 'persona-regen';
          }
          await pclick('#pr-yes');
          let regenDone = false;
          let sumAfterPersona = null;
          for (let i = 0; i < (REAL ? 300 : 60) && !regenDone; i++) {
            await sleep(500);
            sumAfterPersona = (await jobsOf(ASR_BVID)) ?? {};
            const last = (sumAfterPersona?.sum ?? []).slice(-1)[0];
            regenDone = last?.status === 'done' && last?.persona === 'gentle' && last?.createdAt > (sumBefore?.sum ?? []).slice(-1)[0]?.createdAt;
          }
          const regenUi0 = await srOf(`return JSON.stringify({ sumLen: (sr.getElementById('d-summary')?.textContent ?? '').length, inDetail: !!sr.getElementById('d-back') })`);
          const storePersona = await swStore();

          // ---- c) 暂停陪看（F12）：主视频先暂停进入（应零 visit/零请求/状态行提示）----
          await pclick('#d-back');
          await sleep(600);
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const c = sr.getElementById('sw-pause'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(900);
          const pausedStore = await swStore();
          const pausedStatus = await srOf(`return JSON.stringify({ t: sr.getElementById('p-status')?.textContent ?? '' })`);
          const viewReqBefore = netUrls.filter((u) => u.includes('/x/web-interface/view')).length;
          await cdp('Page.navigate', { url: `${PAGE_URL}?p2=paused` }, probeSid);
          await sleep(3000);
          // F13 口径：wipe 后会话重启时 tick sweep 可能已合法重跑 BVID 摘要（F2「先看后激活」兜底，
          // done/visit 行留存）——暂停门禁语义=「窗口内零新增采集」，按增量判定而非绝对零
          const baseVisitsC = Number((await visitsFor(BVID)) ?? 0);
          const baseJobsC = Number(((await jobsOf(BVID)) ?? {}).jobs ?? 0);
          const playMuted = `(async () => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); if (!v) return 'no-video'; v.muted = true; try { await v.play(); } catch (e) {} return 'ok'; })()`;
          await pageEval(`(async () => ${playMuted})()`).catch(() => {});
          await cdp('Page.bringToFront', {}, probeSid).catch(() => {});
          await sleep(20000); // 暂停窗口：>20s 有效观看（若采集未停会累计并跨过 20s 阈值）
          const pausedVisits = await visitsFor(BVID);
          const pausedJobs = (await jobsOf(BVID)) ?? {};
          const pausedNoGrowth = Number(pausedVisits ?? -1) === baseVisitsC && Number(pausedJobs?.jobs ?? -1) === baseJobsC;
          const viewReqAfter = netUrls.filter((u) => u.includes('/x/web-interface/view')).length;
          await pclick('#mascot'); // 导航后面板已关：先开面板（ACTIVE=开合面板）
          await sleep(700);
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const c = sr.getElementById('sw-pause'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(900);
          const unpausedStore = await swStore();

          // ---- d) 阈值滑杆真实生效（F2）：60s 不触发 → 5s 触发 ----
          // 滑杆拨 60 必须在导航前：watcher 在 VIDEO_ENTER 时快照阈值（实时生效口径=
          // 影响之后进入的视频与 SW tick sweep，不追溯正在播放的会话——c) 尾部设置视图仍开着）
          await srOf(`(() => { const s = sr.getElementById('set-threshold'); s.value = '60'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(1500);
          const th60Store = await swStore();
          await cdp('Page.navigate', { url: PAGE_URL }, probeSid);
          await sleep(3000);
          await pageEval(`(async () => ${playMuted})()`).catch(() => {});
          await cdp('Page.bringToFront', {}, probeSid).catch(() => {});
          // 等真实进入（VIDEO_ENTER 成功 → visit 建立，阈值 60 已随应答下发 watcher）
          let entered = 0;
          for (let i = 0; i < 30 && entered === 0; i++) {
            await sleep(500);
            entered = Number(await visitsFor(BVID) ?? 0);
          }
          const baseJobs60 = Number(((await jobsOf(BVID)) ?? {}).jobs ?? 0);
          await sleep(20000); // 阈值 60 窗口：累计 ~20s 不应触发（若按旧值 5/20 会触发）
          const th60Jobs = (await jobsOf(BVID)) ?? {};
          const th60NoTrigger = Number(th60Jobs?.jobs ?? -1) === baseJobs60;
          const th5LogBase = lines.length; // 此刻阈值仍 60（sweep 不可能已响）——拨 5 后的 queued/done 日志窗口基线
          // 滑杆拨到 5 → watch tick 幂等阈值扫描应立即触发（watchedSeconds 已 >5）
          await pclick('#mascot'); // 导航后面板已关：先开面板
          await sleep(700);
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const s = sr.getElementById('set-threshold'); s.value = '5'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(800);
          await pclick('#s-back');
          let th5Queued = false;
          for (let i = 0; i < 30 && !th5Queued; i++) {
            await sleep(500);
            th5Queued = lines.slice(th5LogBase).some((l) => l.text.includes(`summary job queued`) && l.text.includes(BVID));
          }
          let th5Done = false;
          for (let i = 0; i < (REAL ? 300 : 60) && !th5Done; i++) {
            await sleep(500);
            // sweep 可能命中 done 缓存短路（零 LLM、不新增 summary 行）——以 job 行终态为触发证据
            th5Done = lines.slice(th5LogBase).some((l) => l.text.includes('job SUMMARIZE') && l.text.includes(BVID) && l.text.includes('→ done'));
          }
          log('P2.5 d) 阈值子项:', JSON.stringify({ th60: th60Store?.settings?.triggerSeconds, baseJobs60, th60Jobs: th60Jobs?.jobs, th60NoTrigger, th5Queued, th5Done }));
          // 阈值恢复 20（后续探针的默认口径）
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const s = sr.getElementById('set-threshold'); s.value = '20'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

          // ---- e) 气泡开关：关→结束陪看不弹「先睡一觉」；开→恢复陪看弹「开始陪看」 ----
          await srOf(`(() => { const c = sr.getElementById('sw-bubbles'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(800);
          const bubblesOffStore = await swStore();
          await pclick('#s-back');
          await sleep(600);
          // 等旧气泡自然消失（d 的 done 气泡挂 9s，不等待会污染「关闭后不再出现」断言）
          for (let i = 0; i < 24; i++) {
            const b = await srOf(`return JSON.stringify({ hidden: sr.getElementById('mascot-bubble')?.classList.contains('hidden') })`);
            if (b?.hidden === true) break;
            await sleep(500);
          }
          await pclick('#btn-end');
          await sleep(2600);
          const bubbleSuppressed = await srOf(`return JSON.stringify({ hidden: sr.getElementById('mascot-bubble')?.classList.contains('hidden'), focus: document.activeElement?.tagName + ':' + (document.activeElement?.type ?? '') })`);
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const c = sr.getElementById('sw-bubbles'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(800);
          await pclick('#s-back');
          await sleep(600);
          await pclick('#btn-resume');
          await sleep(2600);
          const bubbleResumed = await srOf(`return JSON.stringify({ hidden: sr.getElementById('mascot-bubble')?.classList.contains('hidden'), text: sr.getElementById('mascot-bubble')?.textContent ?? '', focus: document.activeElement?.tagName + ':' + (document.activeElement?.type ?? '') })`);

          // ---- f) 清空 LLM Key（F9）：确认弹窗→门槛回锁；重配 LLM→恢复 ----
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const i = sr.querySelector('#sec-llm input[data-k="apiKey"]'); i.value = ''; })()`);
          await pclick('[data-save="sec-llm"]');
          await sleep(800);
          const clearModal = await srOf(`return JSON.stringify({ shown: sr.getElementById('modal-root')?.classList.contains('show'), owner: sr.getElementById('modal-root')?.dataset.owner ?? '' })`);
          await pclick('#llm-clear-yes');
          await sleep(1200);
          const clearedStore = await swStore();
          const clearedPointer = await swEval(`(async () => { const s = await chrome.storage.local.get('sessionPointer'); return JSON.stringify(s.sessionPointer?.state ?? 'none'); })()`);
          // 重配 LLM（明文经表单→SW，onboarded 恢复）→ 恢复陪看
          await srOf(`(() => {
            const sec = sr.getElementById('sec-llm');
            const set = (k, v) => { const i = sec.querySelector('input[data-k="' + k + '"]'); if (i) i.value = v; };
            set('baseUrl', ${JSON.stringify(llmCfg.baseUrl)}); set('modelId', ${JSON.stringify(llmCfg.modelId)}); set('apiKey', ${JSON.stringify(llmCfg.apiKey)});
          })()`);
          await pclick('[data-save="sec-llm"]');
          await sleep(1200);
          const reconfigured = await swStore();
          // 审查 P1-1 回归：ASR 全空保存=显式清除（哨兵解析曾把空 Key 还原成旧 Key 致路径死亡）
          await srOf(`(() => {
            const sec = sr.getElementById('sec-asr');
            sec.querySelectorAll('input[data-k]').forEach((i) => { i.value = ''; });
          })()`);
          await pclick('[data-save="sec-asr"]');
          await sleep(1200);
          const asrClearedStore = await swStore();

          // ---- g) 隐藏豆包 + 手动清除迁移设置页（危险操作 + Esc + INACTIVE 自动解除隐藏） ----
          await srOf(`(() => { const c = sr.getElementById('sw-hide'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          await sleep(500);
          const wrapHidden = await srOf(`return JSON.stringify({ hidden: sr.getElementById('mascot-wrap')?.classList.contains('hidden') })`);
          await pclick('#btn-clear');
          await sleep(600);
          await cdp('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`, returnByValue: true }, probeSid).catch(() => {});
          await sleep(600);
          const escClosed = await srOf(`return JSON.stringify({ shown: sr.getElementById('modal-root')?.classList.contains('show') })`);
          await pclick('#btn-clear');
          await sleep(600);
          await pclick('#wipe-later');
          await sleep(800);
          const cancelNoop = await swEval(`(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const q = await new Promise((res) => { const x = db.transaction('visits','readonly').objectStore('visits').count(); x.onsuccess = () => res(x.result); }); return JSON.stringify(q); })()`);
          await pclick('#btn-clear');
          await sleep(600);
          await pclick('#wipe-now');
          await sleep(1500);
          const wipedFinal = await swEval(`(async () => {
            const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
            const names = ['visits','summaries','transcripts','videos','jobs','sessions'];
            const counts = {};
            for (const n of names) counts[n] = await new Promise((res) => { const x = db.transaction(n,'readonly').objectStore(n).count(); x.onsuccess = () => res(x.result); });
            const s = await chrome.storage.local.get(['settings','sessionPointer']);
            return JSON.stringify({ counts, pointer: s.sessionPointer ?? null, hasLlm: !!s.settings?.llm?.apiKey });
          })()`);
          const wrapUnhidden = await srOf(`return JSON.stringify({ hidden: sr.getElementById('mascot-wrap')?.classList.contains('hidden') })`);
          // 审查 P1-2 回归：清除后视图容器必须回收（列表可见/设置隐藏/未激活空态），不得滞留陈旧设置
          const containerReset = await srOf(`return JSON.stringify({
            listHidden: sr.getElementById('view-list')?.classList.contains('hidden'),
            settingsHidden: sr.getElementById('view-settings')?.classList.contains('hidden'),
            status: sr.getElementById('p-status')?.textContent ?? '' })`);
          await shotNamed(probeSid, 'visual-post-wipe.png'); // 视觉验收：清除后容器回收（未激活空态，审查 P1-2 回归留证）

          const stDomObj = stDom ?? {};
          settingsProbe = {
            // a) 视图与打码
            viewRendered: stDomObj.shown === true && stDomObj.listHidden === true && stDomObj.ttsDisabled === true && stDomObj.danger === true,
            modelTags: (stDomObj.llmTag ?? '').includes('已配置') && (stDomObj.asrTag ?? '').includes('已配置'),
            keyMasked: maskOk(stDomObj.llmKey, llmCfg.apiKey) && maskOk(stDomObj.asrKey, 'e2e-mock-asr-key'),
            prefsPresent: (stDomObj.pills ?? []).join() === 'spicy,gentle,academic' && stDomObj.sws.every(Boolean) && stDomObj.sliderVal === '5',
            testConnMaskedKey: testOk,
            saveKeepsKey: storeAfterSave?.settings?.llm?.apiKey === llmCfg.apiKey,
            // b) 2.7b 人设联动
            personaPromptAndRegen: regenModal === true && regenDone === true && (regenUi0?.sumLen ?? 0) > 50 && regenUi0?.inDetail === true && storePersona?.settings?.persona === 'gentle',
            // c) 暂停陪看
            pauseBlocksCollection:
              pausedStore?.settings?.paused === true &&
              String(pausedStatus?.t ?? '').includes('已暂停') &&
              pausedNoGrowth === true &&
              viewReqAfter === viewReqBefore &&
              unpausedStore?.settings?.paused !== true,
            // d) 阈值滑杆（F2）
            thresholdSliderLive:
              th60Store?.settings?.triggerSeconds === 60 &&
              th60NoTrigger === true &&
              th5Queued === true && th5Done === true,
            // e) 气泡开关
            bubblesToggle:
              bubblesOffStore?.settings?.bubbles === false &&
              bubbleSuppressed?.hidden === true &&
              !String(bubbleSuppressed?.text ?? '').includes('先睡') && // 结束陪看的 say 被抑制（非旧气泡残留）
              bubbleResumed?.hidden === false,
            // f) 清空 LLM Key（F9）
            llmClearGates:
              clearModal?.shown === true && clearModal?.owner === 'llm-clear' &&
              clearedStore?.settings?.llm === undefined && clearedStore?.onboarded === false &&
              (clearedPointer ?? '').includes('GRACE') &&
              reconfigured?.settings?.llm?.apiKey === llmCfg.apiKey && reconfigured?.onboarded === true &&
              asrClearedStore?.settings?.asr === undefined, // P1-1：全空保存显式清除 ASR（含旧 Key）
            // g) 隐藏豆包 + 手动清除迁移 + Esc + INACTIVE 解除隐藏
            hideMascotAndWipe:
              wrapHidden?.hidden === true &&
              escClosed?.shown === false &&
              Number(cancelNoop ?? 0) > 0 &&
              Object.values(wipedFinal?.counts ?? {}).every((n) => n === 0) &&
              wipedFinal?.pointer === null &&
              wipedFinal?.hasLlm === true &&
              wrapUnhidden?.hidden === false &&
              containerReset?.listHidden === false && containerReset?.settingsHidden === true &&
              String(containerReset?.status ?? '').includes('未激活'),
          };
          log('P2.5 llmClear 子值:', JSON.stringify({
            clearModal, clearedLlm: clearedStore?.settings?.llm, onboarded: clearedStore?.onboarded,
            pointer: clearedPointer, reLlm: reconfigured?.settings?.llm?.apiKey, reOnboarded: reconfigured?.onboarded,
            asrAfterClear: asrClearedStore?.settings?.asr }));
          log('P2.5 判定项:', JSON.stringify(settingsProbe));

          // ============================================================
          // 8.997) P2.6 错误态探针：
          //   Key 无效全链（F9/F11：坏 Key 首摘要→红徽章+详情 Key 无效+【去设置】+气泡→
          //   修复→点击重试→徽章转绿）/ 断网挂起续跑（F11：offline→wait 挂起不轰炸→
          //   恢复→续跑 done）
          // ============================================================
          errProbeStartIdx = lines.length; // noExplicitFail 判定在此段前截止（错误态探针预期产生 failed）
          // a) 坏 Key 全链：先配错 Key（此刻仍在未激活态）→ 开始陪看 → 仍在播的主视频 watcher
          //    阈值 sweep 立即入队 → 坏 Key 401 → failed(KEY_INVALID)（无需重新观看 20s——
          //    sweep 以 DB watchedSeconds 为权威，P2.5-d 起累计早已超阈值）
          await pclick('#btn-settings');
          await sleep(700);
          await srOf(`(() => { const i = sr.querySelector('#sec-llm input[data-k="apiKey"]'); i.value = 'e2e-bad-key'; })()`);
          await pclick('[data-save="sec-llm"]');
          await sleep(1000);
          await pclick('#s-back');
          await sleep(600);
          await pclick('#btn-start2');
          let badKeyFailed = false;
          for (let i = 0; i < 60 && !badKeyFailed; i++) {
            await sleep(500);
            const j = (await jobsOf(BVID)) ?? {};
            badKeyFailed = (j?.sum ?? []).some((x) => x.status === 'failed');
          }
          // b) 列表红徽章 + 详情「Key 无效」+【去设置】+ 气泡
          await pageEval(`(async () => { const v = document.querySelector('.bpx-player-video-area video') || document.querySelector('video'); try { if (v && Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration / 2; } catch (e) {} try { v?.pause(); } catch (e) {} return 'paused'; })()`).catch(() => {}); // 同 P2.5：防 ended 自动播
          await pclick('#mascot');
          await sleep(400);
          await pclick('#mascot');
          await sleep(1200);
          const failBadge = await srOf(`return JSON.stringify({ badge: sr.querySelector(".v-item[data-video-key^='${BVID}:'] .badge")?.textContent ?? '' })`);
          await srOf(`sr.querySelector(".v-item[data-video-key^='${BVID}:']")?.click()`);
          await sleep(1200);
          const failDetail = await srOf(`return JSON.stringify({
            err: sr.getElementById('d-summary')?.textContent ?? '',
            goSettings: !!sr.getElementById('d-gosettings') })`);
          await srOf(`sr.getElementById('d-gosettings')?.scrollIntoView({ block: 'center' })`); // 截图须含失败卡与按钮（面板 .p-body 独立滚动，视口 413px 会截断）
          await sleep(400);
          await shotNamed(probeSid, 'visual-key-invalid.png'); // 视觉验收：解析失败详情+【去设置】入口
          let keyBubble = '';
          for (let i = 0; i < 8; i++) {
            const b = await srOf(`return JSON.stringify({ t: sr.getElementById('mascot-bubble')?.textContent ?? '' })`);
            keyBubble = b?.t ?? '';
            if (keyBubble.includes('Key 无效')) break;
            await sleep(400);
          }
          // c) 【去设置】直达 → 修复 Key → 回列表点击重试 → 徽章转绿（F11 重试由用户发起）
          await pclick('#d-gosettings');
          await sleep(900);
          const settingsFromFail = await srOf(`return JSON.stringify({ shown: !sr.getElementById('view-settings')?.classList.contains('hidden') })`);
          await srOf(`(() => { const i = sr.querySelector('#sec-llm input[data-k="apiKey"]'); i.value = ${JSON.stringify(llmCfg.apiKey)}; })()`);
          await pclick('[data-save="sec-llm"]');
          await sleep(1000);
          await pclick('#s-back');
          await sleep(700);
          await srOf(`sr.querySelector(".v-item[data-video-key^='${BVID}:']")?.click()`); // retry:1 → failed 摘要重入队
          let retryDone = false;
          for (let i = 0; i < (REAL ? 300 : 60) && !retryDone; i++) {
            await sleep(500);
            const j = (await jobsOf(BVID)) ?? {};
            retryDone = (j?.sum ?? []).some((x) => x.status === 'done');
          }
          await pclick('#d-back'); // 回列表读徽章（F11：重试成功后徽章转绿）
          await sleep(900);
          const greenBadge = await srOf(`return JSON.stringify({ badge: sr.querySelector(".v-item[data-video-key^='${BVID}:'] .badge")?.textContent ?? '' })`);

          log('P2.6 keyInvalid 子项:', JSON.stringify({ badKeyFailed, failBadge: failBadge?.badge, failErr: (failDetail?.err ?? '').slice(0, 40), goSettings: failDetail?.goSettings, keyBubble: keyBubble.slice(0, 24), settingsShown: settingsFromFail?.shown, retryDone, greenBadge: greenBadge?.badge }));
          // d) 断网挂起续跑（F11）：杀掉 mock LLM 服务器（端点不可达=确定性断网；CDP
          //    emulateNetworkConditions 实测对 offscreen 文档的 fetch 不生效）→ REGENERATE
          //    → LLM_NETWORK → wait 挂起（pending 不轰炸）→ 原端口重启 mock → 面板 LIST_QUERY
          //    机会性 drain → done
          await pclick('#d-back');
          await sleep(700);
          let mockPort0 = 0;
          if (REAL) {
            // 真实端点不可杀：经设置页把 LLM baseUrl 换成死端口（apiKey 不动=哨兵保留真 Key）=等价断网
            await pclick('#btn-settings'); await sleep(700);
            await srOf(`(() => { const i = sr.querySelector('#sec-llm input[data-k="baseUrl"]'); i.value = 'http://127.0.0.1:9'; })()`);
            await pclick('[data-save="sec-llm"]'); await sleep(800);
            await pclick('#s-back'); await sleep(600);
            log('P2.6 REAL: LLM baseUrl → 127.0.0.1:9（死端口）= 确定性断网');
          } else {
          mockPort0 = Number(new URL(llmCfg.baseUrl).port);
          mock.kill('SIGKILL');
          await sleep(600);
          log(`P2.6 mock LLM killed (port ${mockPort0}) = 确定性断网`);
          }
          await srOf(`sr.querySelector(".v-item[data-video-key^='${BVID}:']")?.click()`);
          await sleep(1000);
          await pclick('#d-regen'); // 用户显式重生成 → offscreen fetch mock → 网络失败 → wait
          let waitedPending = false;
          let waitLogSeen = false;
          let oldDoneKept = false; // 审查 P2-4：挂起期间旧 done 行保留（2.7a force 失败不覆盖语义）
          for (let i = 0; i < 20 && !waitedPending; i++) {
            await sleep(400);
            const j = (await jobsOf(BVID)) ?? {};
            oldDoneKept = oldDoneKept || (j?.sum ?? []).some((x) => x.status === 'done');
            const rows = await swEval(`(async () => {
              const db = await new Promise((res, rej) => { const r = indexedDB.open('doubao-companion'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
              const js = await new Promise((res) => { const q = db.transaction('jobs','readonly').objectStore('jobs').getAll(); q.onsuccess = () => res(q.result); });
              return JSON.stringify(js.filter((x) => String(x.videoKey).startsWith(${JSON.stringify(BVID + ':')})).map((x) => ({ status: x.status, type: x.type })));
            })()`);
            const pendingJob = (rows ?? []).some((x) => x.status === 'pending' && x.type === 'REGENERATE');
            waitLogSeen = lines.slice(errProbeStartIdx).some((l) => l.text.includes('waits for network'));
            waitedPending = pendingJob && !lines.slice(errProbeStartIdx).some((l) => l.text.includes('job REGENERATE') && l.text.includes('→ failed')); // 收紧到 SW 迁移行：offscreen 回声（type=REGENERATE → failed）非终态
          }
          await pclick('#d-back'); // 回列表才能读徽章（详情态列表 DOM 不在文档）
          await sleep(800);
          const waitBadge = await srOf(`return JSON.stringify({ badge: sr.querySelector(".v-item[data-video-key^='${BVID}:'] .badge")?.textContent ?? '' })`);
          await shotNamed(probeSid, 'visual-offline-wait.png'); // 视觉验收：断网挂起=徽章保持生成中（不轰炸）
          // 恢复网络：mock 按原端口重启 / REAL 换回真实 baseUrl + 面板开关触发 LIST_QUERY drain
          if (REAL) {
            await pclick('#btn-settings'); await sleep(700);
            await srOf(`(() => { const i = sr.querySelector('#sec-llm input[data-k="baseUrl"]'); i.value = ${JSON.stringify(llmCfg.baseUrl)}; })()`);
            await pclick('[data-save="sec-llm"]'); await sleep(800);
            await pclick('#s-back'); await sleep(600);
            log('P2.6 REAL: baseUrl 已恢复真实端点（网络恢复等价）');
          } else {
          mock2 = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm-server.mjs'), String(mockPort0)], { stdio: ['ignore', 'pipe', 'pipe'] });
          mock2.stderr?.on('data', (d) => process.stderr.write(`[mock2!] ${d}`));
          await waitHttp(`http://127.0.0.1:${mockPort0}/health`, 10_000);
          log('P2.6 mock LLM restarted (网络恢复)');
          }
          await pclick('#mascot'); // 关面板
          await sleep(400);
          await pclick('#mascot'); // 开面板 → LIST_QUERY → drainUnlessPaused
          let resumedDone = false;
          for (let i = 0; i < (REAL ? 300 : 60) && !resumedDone; i++) {
            await sleep(500);
            const j = (await jobsOf(BVID)) ?? {};
            const rows = j?.sum ?? [];
            const first = rows[0] ?? {};
            resumedDone = rows.length >= 1 && first.status === 'done' && lines.slice(errProbeStartIdx).some((l) => l.text.includes('job REGENERATE') && l.text.includes('→ done'));
          }

          errProbe = {
            keyInvalidFullLoop:
              badKeyFailed === true &&
              (failBadge?.badge ?? '').includes('解析失败') &&
              (failDetail?.err ?? '').includes('Key 无效') &&
              failDetail?.goSettings === true &&
              keyBubble.includes('Key 无效') &&
              settingsFromFail?.shown === true &&
              retryDone === true &&
              (greenBadge?.badge ?? '').includes('已总结'),
            offlineWaitResume:
              waitLogSeen === true &&
              waitedPending === true &&
              oldDoneKept === true &&
              (waitBadge?.badge ?? '').includes('生成中') &&
              resumedDone === true,
          };
          log('P2.6 判定项:', JSON.stringify(errProbe));
        }
      }
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
    // 真实 LLM 补验指标（报告 10 数据源）+ 出网审计汇总 + route-changed 原始计数（验收记录 §5.4 观察项）
    const llmMetrics = lines.filter((l) => l.text.includes('[doubao] llm ')).map((l) => l.text);
    const netHosts = [...new Set(netUrls.map((u) => { try { return new URL(u).hostname; } catch { return String(u).slice(0, 80); } }))];
    const routeChangedCount = lines.filter((l) => l.text.includes('[doubao-poc] route-changed')).length;
    log(`出网审计: ${netUrls.length} 请求, hosts=${JSON.stringify(netHosts)}; route-changed 原始计数=${routeChangedCount}; llm 指标 ${llmMetrics.length} 条`);
    fs.writeFileSync(path.join(shot, 'console.json'), JSON.stringify({ outcome, realMode: REAL, bvid: BVID, url: PAGE_URL, llmModel: llmCfg.modelId, llmMetrics, netHosts, netRequestCount: netUrls.length, routeChangedCount, dbSummary, uiProbe, mascotProbe, onboardingProbe, seekProbe, regenProbe, p19: p19Probe, loginProbe, sessionProbe, retentionProbe, wipeProbe, asrProbe, dnrProbe, settingsProbe, errProbe, lines }, null, 1));
    log(`console lines: ${lines.length}, screenshots: ${shotSaved}, saved to e2e-artifacts/`);

    // 10) 判定（真实链标记：onboarding → 激活 → watcher 触发 → offscreen → DB 落库 → 面板 → P1.6 豆包交互）
    const has = (s) => lines.some((l) => l.text.includes(s));
    // 分段注记文本断言：mock 模式断言模拟文案；真实模式只断言有实质内容（模型输出不预设）
    const segTextOk = (t) => (REAL ? String(t ?? '').trim().length > 10 : String(t ?? '').includes('本段为分段解读的模拟纯文本输出'));
    const verdict = {
      contentInjected: has('content script injected'),
      bvid: has(`bvid = ${BVID}`),
      uiRootInjected: uiProbe !== null,
      onboardingModalOpens: onboardingProbe?.modal?.shown === true && onboardingProbe?.modal?.hasSave === true && onboardingProbe?.modal?.ttsDisabled === true,
      onboardingValidationRed: onboardingProbe?.red?.redCount === 3 && onboardingProbe?.red?.redInputs === 3 && onboardingProbe?.noCfg?.llm === false && onboardingProbe?.noCfg?.onboarded === false,
      onboardingTestConnectionOk: String(onboardingProbe?.testStatus ?? '').includes('连接成功'),
      onboardingSaveActivates:
        sessionProbe?.pointer?.modelId === llmCfg.modelId &&
        sessionProbe?.pointer?.onboarded === true &&
        sessionProbe?.pointer?.pointer?.state === 'ACTIVE' &&
        sessionProbe?.dom?.modalClosed === true &&
        /mascot-(happy|note)\.png/.test(String(sessionProbe?.dom?.img ?? '')), // 保存→激活即反应（视频已在播时触发先到=note，同为正确行为）
      sessionStartHappy: /mascot-(happy|note)\.png/.test(String(sessionProbe?.dom?.img ?? '')), // 激活/触发 → happy/note 切图
      // P1.10 未登录引导与自动恢复（F11）：登录气泡 / 引导卡+红徽章 / 详情错误文案 / 登录后卡隐藏+重排+转绿+welcome
      loginBubbleNotLogged: String(sessionProbe?.loginBubble ?? '').includes('先登录 B 站'),
      loginCardAndFailBadge:
        loginProbe?.card1?.shown === true &&
        loginProbe?.card1?.hasBtn === true &&
        String(loginProbe?.card1?.title ?? '').includes('请在本浏览器登录') &&
        String(loginProbe?.card1?.badge ?? '').includes('解析失败'),
      loginFailReason: String(loginProbe?.failDetail?.errText ?? '').includes('需要登录'),
      loginAutoRecover:
        loginProbe?.card2?.hidden === true &&
        loginProbe?.card2?.welcome === true &&
        loginProbe?.recovered === true &&
        loginProbe?.hasRequeueLog === true &&
        String(loginProbe?.badge2?.badge ?? '').includes('已总结'),
      visitTriggered: has('summary job queued'), // watcher 5s 真实触发（visit 由 WATCH_TICK 惰性补建）
      offscreenRun: has('offscreen run job'), // offscreen 执行体真的跑了
      chainDone: lines.some((l) => l.text.includes('job SUMMARIZE') && l.text.includes('→ done')),
      dbSummaryDone: Array.isArray(dbSummary?.summaries) && dbSummary.summaries.some((s) => s.status === 'done'),
      panelListRendered: (uiProbe?.list?.count ?? 0) >= 1 && String(uiProbe?.list?.badge ?? '').includes('已总结'),
      panelDetailRendered:
        (uiProbe?.detail?.summaryLen ?? 0) > 0 &&
        (uiProbe?.detail?.outlineRows ?? 0) >= 1 &&
        !!uiProbe?.detail?.mascotSay &&
        (uiProbe?.detail?.transcriptRows ?? 0) >= 1 &&
        String(uiProbe?.detail?.srcBadge ?? '').length > 0,
      mascotDragNoToggle: mascotProbe?.dragMovedNotToggled === true, // 拖拽移动且不误触面板
      mascotPosPersisted: mascotProbe?.posPersisted === true && mascotProbe?.posRestored === true, // 相对坐标落盘 + reload 还原
      sessionEndGrace: mascotProbe?.endGrace === true && mascotProbe?.endSleepImg === true && mascotProbe?.endResumeBtn === true,
      bubbleSurvivesResume: mascotProbe?.bubbleSurvivesResume === true, // 旧 hide 计时器不掐死新气泡（审查 P1-1 回归）
      realMouseDragNoToggle: mascotProbe?.realMouseDragNoToggle === true, // 真鼠标拖拽含原生 click 不双触发（审查 P1-2 回归）
      // P1.11 F13：内联流式→done 文本 / 收起再展开缓存零请求（offscreen seg job 数不增）/ 按钮点击不 seek / DB 注记 done
      segmentNoteStreamDone:
        seekProbe?.segment?.segNote?.hidden === false &&
        segTextOk(seekProbe?.segment?.segNote?.text),
      segmentCacheZeroRequest:
        seekProbe?.segment?.segCollapsed?.hidden === true &&
        seekProbe?.segment?.segReopened?.hidden === false &&
        segTextOk(seekProbe?.segment?.segReopened?.text) &&
        seekProbe?.segment?.offscreenSegBefore === 1 &&
        seekProbe?.segment?.offscreenSegAfter === 1,
      segmentSeekIndependent:
        Math.abs((seekProbe?.segment?.segAfter?.t ?? -99) - (seekProbe?.segment?.segBefore?.t ?? -99)) <= 1 &&
        (seekProbe?.segment?.segBefore?.btns ?? 0) >= 6,
      segmentDbNote: seekProbe?.segment?.segDb?.['1']?.status === 'done',
      // F13 提速：静默预取——首次点击前已有 seg job 静默跑完（旧按需模型此计数恒 0）
      segmentSilentPrefetch: (seekProbe?.segment?.offscreenSegPreClick ?? 0) >= 1,
      // P1.8：同页大纲 seek（±3s + toast + 面板不关）/ 转写行 seek / 跨标签页聚焦 seek / 新标签页 t= 直达
      seekOutlineSameTab:
        typeof seekProbe?.outline?.sec === 'number' &&
        Math.abs((seekProbe?.after?.t ?? -99) - seekProbe.outline.sec) <= 3 &&
        (seekProbe?.after?.toasts ?? []).some((x) => x.includes('已跳转到')) &&
        seekProbe?.after?.panelOpen === true,
      seekTranscriptLine:
        typeof seekProbe?.tr?.sec === 'number' &&
        Math.abs((seekProbe?.trAfter?.t ?? -99) - seekProbe.tr.sec) <= 3,
      seekCrossTabFocus:
        seekProbe?.crossTab?.li60?.clicked === true &&
        Math.abs((seekProbe?.crossTab?.tab1After?.t ?? -99) - (seekProbe?.crossTab?.li60?.sec ?? NaN)) <= 3 &&
        seekProbe?.crossTab?.tab1After?.vis === 'visible' &&
        seekProbe?.crossTab?.tab2After?.vis === 'hidden',
      seekNewTab:
        seekProbe?.newTab?.click?.clicked === true &&
        String(seekProbe?.newTab?.createdUrl ?? '').includes(`t=${seekProbe?.newTab?.click?.sec ?? '\u2205'}`) &&
        (seekProbe?.newTab?.tab2Toast ?? []).some((x) => x.includes('新标签页')),
      // P1.9 七准则：贴边收起（合成+真鼠标拖拽均吸右边）/ overlay 不推挤 / 全屏迁移 / 闲时半透明+唤醒 / 输入聚焦抑制 / 上下文跟随
      snapEdgeDrag: mascotProbe?.snapEdgeDrag === true,
      // overlay 不推挤：只比布局承重指标（clientWidth+播放器 x）——body.scrollWidth 会被 B 站
      // 页面自身的弹幕/懒加载内容瞬时改变（mock4 实测 1080→1100 而 bw/px 纹丝不动），不是浮层信号
      overlayNoPush:
        !!p19Probe?.overlayNoPush &&
        p19Probe.overlayNoPush.mClosed?.bw === p19Probe.overlayNoPush.mOpen?.bw &&
        p19Probe.overlayNoPush.mClosed?.px === p19Probe.overlayNoPush.mOpen?.px,
      fullscreenMigration:
        p19Probe?.fullscreen?.fsReq?.ok === true &&
        p19Probe?.fullscreen?.fsState?.fs === true &&
        String(p19Probe?.fullscreen?.fsState?.parentCls ?? '').includes('bpx-player-container') &&
        p19Probe?.fullscreen?.fsState?.mascotVisible === true &&
        p19Probe?.fullscreen?.fsBack?.back === true,
      idleDimAndWake: p19Probe?.idleDim?.dimmed === true && p19Probe?.idleDim?.wokeAfterHover === true,
      inputFocusSuppress:
        p19Probe?.inputFocus?.focused?.focused === true &&
        p19Probe?.inputFocus?.suppressed?.bubbleHidden === true &&
        p19Probe?.inputFocus?.resumedBubble?.hidden === false,
      contextFollowList:
        String(p19Probe?.follow?.firstKey ?? '').startsWith('BV1DUnB61ErU:') &&
        p19Probe?.follow?.open === true &&
        (p19Probe?.follow?.count ?? 0) >= 2,
      // F12/3.5 前移切片：扩展自身（SW+offscreen）出网 host 全在白名单（B 站系 + LLM 端点）；
      // 127.0.0.1 两模式均放行（REAL 混合：mock ASR 端点+断网探针死端口=本机合法流量；外部 host 仍零豁口）
      networkWhitelist: netUrls.length > 0 && netUrls.every((u) => {
        try {
          const h = new URL(u).hostname;
          return h === '127.0.0.1' ||
            /(^|\.)(bilibili\.com|hdslb\.com|bilivideo\.com|bilivideo\.cn)$/.test(h) ||
            h === new URL(llmCfg.baseUrl).hostname;
        } catch { return false; }
      }),
      // 2.7a【重新生成】：REGENERATE 强制重跑 → 第 2 次摘要 job → done 覆盖（createdAt 更新）+ 旧分段注记清空
      //（F13 提速：清空后预取可能立即重灌——不变量=不存在早于新行的陈旧注记，而非计数恒 0）
      regenerateRoundtrip:
        regenProbe?.regenDone === true &&
        regenProbe?.sumAfter === regenProbe?.sumBefore + 1 &&
        (regenProbe?.after?.createdAt ?? 0) > (regenProbe?.before?.createdAt ?? 0) &&
        regenProbe?.after?.status === 'done' &&
        ((regenProbe?.after?.notes ?? 1) === 0 || (regenProbe?.after?.noteMinCreated ?? 0) >= (regenProbe?.after?.createdAt ?? 1)) &&
        (regenProbe?.regenUi?.sumLen ?? 0) > 50 && // 审查 P2-9：面板已用新摘要重渲染
        (regenProbe?.regenUi?.outline ?? 0) >= 6 && // 新大纲就位（Schema 6–12 条）
        regenProbe?.regenUi?.notes === 0, // 无残留展开注记卡
      // P2.1 保留期（F10）：GRACE 倒计时（toast+挂载+秒级走动+closedAt 基准）/ 59min 内恢复续算 /
      // 超 1h → EXPIRED_PENDING_CONFIRM（文案+无开始/恢复按钮+数据不删+豆包仍可开面板）
      retentionGraceCountdown:
        retentionProbe?.grace?.state === true &&
        retentionProbe?.grace?.toast === true &&
        retentionProbe?.grace?.hasCountdown === true &&
        retentionProbe?.grace?.cdTicking === true &&
        retentionProbe?.grace?.closedAtFresh === true,
      retentionRestoreUnder1h:
        retentionProbe?.restoreUnder1h?.state === true &&
        retentionProbe?.restoreUnder1h?.statusHasRetain === true &&
        retentionProbe?.restoreUnder1h?.cdResumed === true &&
        retentionProbe?.restoreUnder1h?.itemsKept === true,
      retentionExpiredOver1h:
        retentionProbe?.expiredOver1h?.state === true &&
        retentionProbe?.expiredOver1h?.statusText === true &&
        retentionProbe?.expiredOver1h?.noStartNoResume === true &&
        retentionProbe?.expiredOver1h?.itemsStillThere === true &&
        retentionProbe?.expiredOver1h?.mascotTogglesPanel === true,
      // P2.2 F10 清除链路：超期弹窗文案+双按钮 / 稍后提醒重弹+数据保留 / 立即清除六表+pointer+settings 保留 / 手动入口二次确认
      expiredConfirmModal:
        wipeProbe?.expiredModal?.shown === true &&
        wipeProbe?.expiredModal?.owner === true &&
        wipeProbe?.expiredModal?.copy === true,
      laterRemindReprompts:
        wipeProbe?.laterRemindReprompts?.closed === true &&
        wipeProbe?.laterRemindReprompts?.toast === true &&
        wipeProbe?.laterRemindReprompts?.dataKept === true &&
        wipeProbe?.laterRemindReprompts?.reprompts === true,
      // 审查 P1-1 回归：生成中（慢 LLM 挂窗）手动/超期清除 → 在途执行体被掐死，10s 观察窗无孤儿写入
      wipeMidFlightNoResurrect: wipeProbe?.wipeMidFlightNoResurrect === true,
      wipeConfirmClears:
        wipeProbe?.wipeConfirmClears?.uiReset === true &&
        wipeProbe?.wipeConfirmClears?.dbEmpty === true &&
        wipeProbe?.wipeConfirmClears?.pointerGone === true &&
        wipeProbe?.wipeConfirmClears?.settingsKept === true,
      manualWipeDoubleConfirm:
        wipeProbe?.manualWipeDoubleConfirm?.startsActive === true &&
        wipeProbe?.manualWipeDoubleConfirm?.cancelNoop === true &&
        wipeProbe?.manualWipeDoubleConfirm?.confirmWipes === true,
      // P2.3 F6 ASR 确认流（mock）：need_asr 橙标 / 卡片文案逐字 / 未配置→ASR 补配 onboarding / 确认后三段进度→done ASR转写
      asrNeedConfirmBadge: asrProbe?.needConfirmBadge === true,
      asrConfirmCardCopy: asrProbe?.confirmCardCopy === true,
      asrNeedConfigOnboarding: asrProbe?.needConfigOnboarding === true,
      asrSaveAsrThenRun: (asrProbe?.saveAsrThenRun === true && (asrProbe?.audioBytes ?? 0) > 100_000), // 审查 N-10：真实音频体量进判定（multipart ≥100KB）
      asrDnrRulesEnsured: has('dnr rules ensured: 2'),
      // P2.4 头级验证：bilivideo 音频请求实发 Referer=DNR 注入值 + getDynamicRules 形状审计
      //（真实模式不跑 ASR 链无音频请求，以日志判定项兜——与 asrNeedConfirmBadge 同口径）
      dnrRefererHeader: dnrProbe?.headerOk === true,
      dnrRulesShapeAudited: dnrProbe?.ruleShapeOk === true,
      // P2.5 设置页：视图+打码+测试连接哨兵+保存不改 Key / 2.7b 人设联动重生成 /
      // 暂停零采集零请求 / 阈值滑杆真实生效 / 气泡开关 / 清空 Key 门槛回锁 / 隐藏豆包+手动清除迁移
      settingsViewRendered: settingsProbe?.viewRendered === true,
      settingsKeyMasked: (settingsProbe?.keyMasked === true && settingsProbe?.saveKeepsKey === true && settingsProbe?.testConnMaskedKey === true),
      settingsPersonaRegen: settingsProbe?.personaPromptAndRegen === true,
      settingsPauseBlocks: settingsProbe?.pauseBlocksCollection === true,
      settingsThresholdLive: settingsProbe?.thresholdSliderLive === true,
      settingsBubblesToggle: settingsProbe?.bubblesToggle === true,
      settingsLlmClearGates: settingsProbe?.llmClearGates === true,
      settingsHideAndWipe: settingsProbe?.hideMascotAndWipe === true,
      // P2.6 错误态：Key 无效全链（红徽章/详情+去设置/气泡/修复重试转绿）+ 断网挂起续跑
      keyInvalidFullLoop: errProbe?.keyInvalidFullLoop === true,
      offlineWaitResume: errProbe?.offlineWaitResume === true,
      // P2.6 起：错误态探针段（errProbeStartIdx 起）预期制造 failed 终态——非预期失败判定截止到该段前
      // F13 预取：SEGMENT_ANALYZE 失败属预期可恢复路径（STALE 作废重跑/NO_CUES/清Key期 NO_LLM_CONFIG），
      // SW 迁移行（job SEGMENT_ANALYZE → failed）与 offscreen 完成行（type=SEGMENT_ANALYZE）都排除
      noExplicitFail: !lines.slice(cookieLineIdx, errProbeStartIdx || lines.length).some((l) => (l.text.includes('[doubao]') && l.text.includes('→ failed') && !l.text.includes('job SEGMENT_ANALYZE') && !l.text.includes('type=SEGMENT_ANALYZE')) || l.text.includes('E2E FAIL')),
    };
    console.log('\n=== E2E 判定 ===');
    for (const [k, v] of Object.entries(verdict)) console.log(`  ${v ? '✅' : '❌'} ${k}`);
    const pass = Object.values(verdict).every(Boolean);
    console.log(pass ? '\n✅ E2E PASS' : `\n❌ E2E FAIL (outcome=${outcome})`);
    if (!pass) {
      console.log('--- chrome stderr tail ---\n' + chromeErr.slice(-600));
      console.log('--- doubao 相关 console ---\n' + (lines.filter((l) => l.text.includes('[doubao')).map((l) => `${l.type} ${l.text}`).join('\n') || '（无）'));
    }
    process.exitCode = pass ? 0 : 1;
  } finally {
    try { chrome.kill('SIGTERM'); } catch { /* noop */ }
    await sleep(1200);
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
    try { mock?.kill('SIGTERM'); } catch { /* noop */ }
    try { mock2?.kill('SIGTERM'); } catch { /* noop */ } // P2.6 重启的 mock 实例（不杀会拖住进程）
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
