import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

declare const chrome: { storage: { local: { get(key: string): Promise<{ sessionPointer?: Record<string, unknown>; settings?: { paused?: boolean; llm?: { apiKey?: string }; asr?: unknown } }>; set(value: Record<string, unknown>): Promise<void> } }; runtime: { id: string }; declarativeNetRequest: { updateSessionRules(value: unknown): Promise<void>; getSessionRules(): Promise<{id:number}[]> } };

let context: BrowserContext;
let profile: string;
let fixtureServer: Server;
let modelRequests: { method: string; body: string; authorization: string; cookie: string }[];
let githubRequests: number;
let githubGate: Promise<void> | null;
let releaseGithub: (() => void) | null;
let modelStarts: number;
let modelDisconnected: boolean;
let modelEchoSensitive: boolean;
let modelTruncatedJson: boolean;
let modelSensitiveResponses: number;
let modelGate: Promise<void> | null;
let releaseModel: (() => void) | null;
let biliRequestTimes: number[];
let subtitleLang: string;
let audioRequests: number;
let asrSocketRequests: number;
let asrAudioFrames: number;
let asrFinalFrames: number;
let longAsrInputSeconds: number;
let asrLastAudioAt: number;
let asrMaxAudioGapMs: number;
let asrPacketTimeoutFixture: boolean;
let asrResultGate: Promise<void> | null;
let releaseAsrResult: (() => void) | null;
let mockAsrUpload: boolean;
let asrFixtureText: string;
let noSubtitleFixture: boolean;
let whitespaceSubtitleFixture: boolean;
let playurlRequests: number;
let audioFetches: number;
let audioGate: Promise<void> | null;
let releaseAudio: (() => void) | null;
let riskOnNextPlayer: boolean;
let riskReturnedAt: number;
let longFixture: { duration: number; count: number; dense: boolean } | null;
let longSummaryAttempts: number;
const tailMarker = "结尾独有事实：最终方案采用海水储能";
let segmentStarts: number;
let segmentGate: Promise<void> | null;
let releaseSegment: (() => void) | null;
let viewGate: Promise<void> | null;
let releaseView: (() => void) | null;
let delayedViewStarted: boolean;
const videoUrl = 'https://www.bilibili.com/video/BV1XynB6EEiM';
const summary = '这是一段用于测试的客观视频摘要。'.repeat(10);
const evaluation = '本豆锐评：节奏尚可但有点水，豆沙含量一般。'.repeat(2);
const simulatedModelDisconnect = new Error('fixture 模拟模型连接中断');
const echoedSubtitle = '模拟字幕第 3 句';
const echoedCookie = 'SESSDATA=fake-only-privacy-cookie';
const echoedKey = 'example-secret-1234';

async function activateForVideo(page: Page, threshold = '5'): Promise<void> {
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#set-threshold').fill(threshold);
  await expect(page.locator('#th-val')).toHaveText(`${threshold} 秒`);
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '豆包' })).toBeVisible();
}

function silentWav(): Buffer {
  const length = Math.round(8000 * (longAsrInputSeconds || 20));
  const wav = Buffer.alloc(44 + length, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36);
  wav.writeUInt32LE(length, 40);
  return wav;
}

function fixtureResponse(address: string, method: string, requestBody: string, authorization: string, cookie: string, range = ''): { status: number; contentType: string; body: string | Buffer; headers?: Record<string, string> } {
  const url = new URL(address);
  if (url.hostname === 'www.bilibili.com' && (url.pathname === '/' || /^\/video\/BV[\da-zA-Z]{10}\/?$/.test(url.pathname))) return { status: 200, contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>测试页面</title><body>测试页面<video controls muted src="/fixture.wav"></video></body></html>' };
  if (url.href === 'https://www.bilibili.com/fixture.wav') {
    const wav = silentWav();
    const requested = range.match(/^bytes=(\d+)-(\d*)$/);
    const start = requested ? Number(requested[1]) : 0;
    const end = requested?.[2] ? Math.min(Number(requested[2]), wav.length - 1) : wav.length - 1;
    if (start > end) return { status: 416, contentType: 'audio/wav', body: '', headers: { 'content-range': `bytes */${wav.length}` } };
    const body = wav.subarray(start, end + 1);
    return { status: requested ? 206 : 200, contentType: 'audio/wav', body, headers: {
      'accept-ranges': 'bytes', 'content-length': String(body.length),
      ...(requested ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}),
    } };
  }
  if (url.hostname === 'api.bilibili.com') {
    biliRequestTimes.push(Date.now());
    if (url.pathname === '/x/player/wbi/v2' && riskOnNextPlayer) {
      riskOnNextPlayer = false;
      riskReturnedAt = Date.now();
      return { status: 200, contentType: 'application/json', body: '{"code":-412}' };
    }
    let data: unknown;
    if (url.pathname === '/x/web-interface/nav') data = { isLogin: true, wbi_img: { img_url: 'https://i.test/abcdefghijklmnopqrstuvwxyz123456.png', sub_url: 'https://i.test/0123456789abcdefghijklmnopqrstuv.png' } };
    else if (url.pathname === '/x/web-interface/view') data = { aid: 1, title: '测试视频', duration: longFixture?.duration ?? 20, owner: { name: '测试作者' }, pages: [{ cid: 100, page: 1, part: '测试', duration: longFixture?.duration ?? 20 }] };
    else if (url.pathname === '/x/player/wbi/v2') data = { subtitle: { subtitles: noSubtitleFixture && !whitespaceSubtitleFixture ? [] : [{ lan: subtitleLang, subtitle_url: 'https://i0.hdslb.com/fixture.json' }] } };
    else if (url.pathname === '/x/player/wbi/playurl' && noSubtitleFixture) data = { dash: { audio: [{ id: 30216, bandwidth: 64000, baseUrl:'https://upos-sz-test.bilivideo.com/fixture.m4a', backupUrl:[] }] } };
    else return { status: 404, contentType: 'text/plain', body: 'unknown fixture' };
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data }) };
  }
  if (url.href === 'https://i0.hdslb.com/fixture.json' && longFixture) return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: Array.from({ length: longFixture.count }, (_, i) => ({ from: i * (longFixture!.duration - 2) / longFixture!.count, to: (i + 1) * (longFixture!.duration - 2) / longFixture!.count, content: i === longFixture!.count - 1 ? tailMarker : `字幕第${i}句，` + '本段讨论能源方案与实验结果。'.repeat(longFixture!.dense ? 8 : 1) })) }) };
  if (url.href === 'https://i0.hdslb.com/fixture.json' && whitespaceSubtitleFixture) return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: [{from:0,to:1,content:'　 \n'}] }) };
  if (url.href === 'https://i0.hdslb.com/fixture.json') return { status: 200, contentType: 'application/json', body: JSON.stringify({ body: Array.from({ length: 8 }, (_, i) => ({ from: i * 2, to: i * 2 + 1, content: `模拟字幕第 ${i + 1} 句` })) }) };
  if (url.href === 'https://api.github.com/repos/Vincent-chk/bilibili-companion/releases/latest') return { status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v1.1.0' }) };
  if (url.href === 'https://model.example/v1/chat/completions') {
    modelRequests.push({ method, body: requestBody, authorization, cookie });
    if (method === 'POST' && authorization === 'Bearer invalid-key') return { status: 401, contentType: 'application/json', body: '{"error":"invalid key"}' };
    const input = JSON.parse(requestBody || '{}');
    if (method === 'POST' && input.stream) {
      if (modelEchoSensitive) {
        modelSensitiveResponses++;
        return { status: 500, contentType: 'application/json', body: JSON.stringify({ error: `${echoedSubtitle} ${echoedCookie} ${echoedKey}` }) };
      }
      if (modelTruncatedJson) {
        const content = '{"summary":"这是模型生成的摘要","outline":[{"time":9,"text":"要点"},';
        return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` };
      }
      if (longFixture) {
        const prompt = JSON.stringify(input.messages);
        let content: string;
        if (prompt.includes('视频字幕片段分析器')) {
          const lines = input.messages[1].content.split('\n').filter((line: string) => /^\[\d+:\d+\]/.test(line));
          content = [lines[0], lines[Math.floor(lines.length / 2)], lines.at(-1)].join('\n');
        } else if (prompt.includes('分段解读')) content = prompt.includes(tailMarker) ? tailMarker + '。结尾内容已参与本段分析。' : '本段讨论能源方案与实验结果。';
        else {
          longSummaryAttempts++;
          const times = longSummaryAttempts === 1 ? (longFixture.duration === 520 ? [0,5,12,17,25,35,43,55,72,102] : [0, 10, 50, 76, 150, 467]) : [0, .2, .4, .6, .8, .9].map(n => Math.floor(n * longFixture!.duration));
          content = JSON.stringify({ summary: summary + (prompt.includes(tailMarker) ? tailMarker : ''), outline: times.map((time, i) => ({ time, text: `全片章节 ${i + 1}` })), evaluation, rating: 4 });
        }
        return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` };
      }
      const content = JSON.stringify(input.messages).includes('分段解读')
        ? '本段模拟解读，围绕字幕内容解释这一部分的要点。'
        : JSON.stringify({ summary, outline: Array.from({ length: 6 }, (_, i) => ({ time: i === 5 ? 14 : i * 2, text: `要点 ${i + 1}` })), evaluation, rating: 4 });
      return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n` };
    }
    return { status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  }
  return { status: 404, contentType: 'text/plain', body: 'unknown fixture' };
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };

async function getFixture(address: string, method: string, body: string, authorization: string, cookie: string, range = '') {
  const url = new URL(address);
  if (url.hostname === 'api.bilibili.com' && url.pathname === '/x/web-interface/view' && url.searchParams.get('bvid') === 'BV0000000001' && viewGate) {
    delayedViewStarted = true;
    await viewGate;
  }
  if (url.hostname === 'api.bilibili.com' && url.pathname.includes('/playurl')) { audioRequests++; playurlRequests++; }
  if (/(^|\.)bilivideo\.(com|cn)$/.test(url.hostname)) {
    audioRequests++; audioFetches++;
    if (audioGate) await audioGate;
    if (noSubtitleFixture) return {status:200,contentType:'audio/wav',body:silentWav()};
  }
  if (address === 'https://api.github.com/repos/Vincent-chk/bilibili-companion/releases/latest') {
    githubRequests++;
    if (githubRequests === 1 && githubGate) await githubGate;
  }
  if (address === 'https://model.example/v1/chat/completions' && method === 'POST' && JSON.parse(body || '{}').stream) {
    modelStarts++;
    if (modelDisconnected) throw simulatedModelDisconnect;
    if (modelStarts === 1 && modelGate) await modelGate;
    if (body.includes('分段解读')) {
      segmentStarts++;
      if (segmentStarts === 1 && segmentGate) await segmentGate;
    }
  }
  return fixtureResponse(address, method, body, authorization, cookie, range);
}

test.beforeEach(async ({}, testInfo) => {
  profile = await mkdtemp(join(tmpdir(), 'doubao-playwright-'));
  modelRequests = [];
  githubRequests = 0;
  releaseGithub = null;
  githubGate = testInfo.title.includes('暂停再恢复') ? new Promise<void>(resolve => { releaseGithub = resolve; }) : null;
  modelStarts = 0;
  modelDisconnected = false;
  modelEchoSensitive = false;
  modelTruncatedJson = false;
  modelSensitiveResponses = 0;
  releaseModel = null;
  modelGate = /暂停时不再启动排队|快速暂停恢复|异常退出恢复/.test(testInfo.title) ? new Promise<void>(resolve => { releaseModel = resolve; }) : null;
  biliRequestTimes = [];
  subtitleLang = testInfo.title.includes('人工字幕优先') ? 'zh-CN' : 'ai-zh';
  audioRequests = 0;
  asrSocketRequests = 0;
  asrAudioFrames = 0;
  asrFinalFrames = 0;
  longAsrInputSeconds = 0;
  asrLastAudioAt = 0;
  asrMaxAudioGapMs = 0;
  asrPacketTimeoutFixture = testInfo.title.includes('等包超时');
  releaseAsrResult = null;
  asrResultGate = testInfo.title.includes('等待回复时') ? new Promise<void>(resolve=>{releaseAsrResult=resolve;}) : null;
  mockAsrUpload = testInfo.title.includes('实际语音上传');
  asrFixtureText = '模拟识别语音';
  whitespaceSubtitleFixture = testInfo.title.includes('空白字幕自动识别');
  noSubtitleFixture = /双标签自动|双标签同时确认|自动无字幕|旧待确认|空白字幕自动识别/.test(testInfo.title);
  playurlRequests = 0;
  audioFetches = 0;
  releaseAudio = null;
  audioGate = noSubtitleFixture ? new Promise<void>(resolve=>{releaseAudio=resolve;}) : null;
  riskOnNextPlayer = testInfo.title.includes('全局风控');
  riskReturnedAt = 0;
  longFixture = testInfo.title.includes('模拟长视频') ? (testInfo.title.includes('8分钟') ? { duration: 520, count: 243, dense: false } : testInfo.title.includes('41分钟') ? { duration: 2466, count: 1200, dense: true } : { duration: 1272, count: 587, dense: false }) : null;
  longSummaryAttempts = 0;
  segmentStarts = 0;
  releaseSegment = null;
  segmentGate = testInfo.title.includes('结束后停止排队预取') ? new Promise<void>(resolve => { releaseSegment = resolve; }) : null;
  releaseView = null;
  viewGate = testInfo.title.includes('切换视频后详情跟随') ? new Promise<void>(resolve => { releaseView = resolve; }) : null;
  delayedViewStarted = false;
  const key = join(profile, 'fixture-key.pem');
  const cert = join(profile, 'fixture-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=fixture.test', '-days', '1'], { stdio: 'ignore' });
  fixtureServer = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', async () => {
      try {
        const result = await getFixture(`https://${req.headers.host}${req.url}`, req.method ?? 'GET', Buffer.concat(chunks).toString(), req.headers.authorization ?? '', req.headers.cookie ?? '', req.headers.range ?? '');
        res.writeHead(result.status, { ...cors, 'content-type': result.contentType, ...result.headers });
        res.end(result.body);
      } catch (error) {
        if (error !== simulatedModelDisconnect) throw error;
        res.destroy(); // offscreen/SW 可能不经 Playwright route：由本地 HTTPS 服务断开连接
      }
    });
  });
  fixtureServer.on('upgrade', (req, socket) => {
    if ((req.headers.host ?? '').startsWith('openspeech.bytedance.com')) asrSocketRequests++;
    if (!mockAsrUpload || !(req.headers.host ?? '').startsWith('openspeech.bytedance.com')) { socket.destroy(); return; }
    const accept=createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const respond=(final:boolean,body:unknown)=>{
      const json=Buffer.from(JSON.stringify(body)),frame=Buffer.alloc(8+json.length);
      frame.set([0x11,final?0x92:0x90,0x10,0]);frame.writeUInt32BE(json.length,4);json.copy(frame,8);
      const head=frame.length<126?Buffer.from([0x82,frame.length]):Buffer.from([0x82,126,frame.length>>8,frame.length&255]);socket.write(Buffer.concat([head,frame]));
    };
    let buffered=Buffer.alloc(0);
    socket.on('data',(chunk:Buffer)=>{
      buffered=Buffer.concat([buffered,chunk]);
      while(buffered.length>=2){
        const opcode=buffered[0]!&15,masked=!!(buffered[1]!&128);let len=buffered[1]!&127,offset=2;
        if(len===126){if(buffered.length<4)return;len=buffered.readUInt16BE(2);offset=4;}
        if(len===127){if(buffered.length<10)return;const n=buffered.readBigUInt64BE(2);if(n>BigInt(1024*1024)){socket.destroy();return;}len=Number(n);offset=10;}
        const maskSize=masked?4:0;if(buffered.length<offset+maskSize+len)return;
        const mask=buffered.subarray(offset,offset+maskSize);offset+=maskSize;const payload=Buffer.from(buffered.subarray(offset,offset+len));buffered=buffered.subarray(offset+len);
        if(masked)for(let i=0;i<payload.length;i++)payload[i]=payload[i]!^mask[i%4]!;
        if(opcode===8){socket.end();return;}if(opcode!==2||payload.length<2)continue;
        const type=payload[1]!>>4;
        if(type===1)respond(false,{});
        if(type===2){
          const now=Date.now();if(asrLastAudioAt)asrMaxAudioGapMs=Math.max(asrMaxAudioGapMs,now-asrLastAudioAt);asrLastAudioAt=now;
          asrAudioFrames++;
          if(asrPacketTimeoutFixture && asrAudioFrames===1){const frame=Buffer.alloc(12);frame.set([0x11,0xf0,0,0]);frame.writeUInt32BE(45000081,4);socket.write(Buffer.concat([Buffer.from([0x82,frame.length]),frame]));}
          else if(payload[1]!&2){asrFinalFrames++;const reply=()=>respond(true,{audio_info:{duration:Math.round((longAsrInputSeconds||20)*1000)},result:{text:asrFixtureText,utterances:asrFixtureText?[{text:asrFixtureText,start_time:0,end_time:1000,definite:true,words:[{text:asrFixtureText,start_time:0,end_time:1000}]}]:[]}});if(asrResultGate)void asrResultGate.then(reply);else reply();}
          else if(longAsrInputSeconds)respond(false,{result:{text:'测试'.repeat(Math.min(asrAudioFrames,2000))}});
        }
      }
    });
  });
  await new Promise<void>(resolveServer => fixtureServer.listen(0, '127.0.0.1', resolveServer));
  const port = (fixtureServer.address() as AddressInfo).port;
  const extension = resolve(process.env.E2E_EXTENSION_DIR ?? '.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_BROWSER,
    ...(process.env.E2E_BROWSER ? {} : { channel: 'chromium' }),
    headless: process.env.E2E_HEADED !== '1',
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
      '--no-proxy-server', '--ignore-certificate-errors',
    ],
  });
  if (process.env.E2E_HEADED !== '1') {
    const isCompanion = (w: Worker) => w.url().startsWith('chrome-extension://') && w.evaluate(() => {
      const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
      return runtime.getManifest().name === '豆包陪看助手';
    }).catch(() => false);
    const workers = context.serviceWorkers();
    const names = await Promise.all(workers.map(isCompanion));
    const worker = workers.find((_, i) => names[i]) ?? await context.waitForEvent('serviceworker', { predicate: isCompanion, timeout: 15_000 });
    await worker.evaluate(() => {
      const target = globalThis as unknown as { chrome: { permissions: { request(value: { origins: string[] }): Promise<boolean> } }; permissionRequests: string[][] };
      target.permissionRequests = [];
      const permissions = target.chrome.permissions;
      permissions.request = async value => { target.permissionRequests.push(value.origins); return false; }; // 仅模拟原生授权被拒，模型 fixture 允许 CORS；真实授权另测。
    });
  }
  await context.route(/^https?:\/\//, async route => {
    const request = route.request();
    try {
      const result = await getFixture(request.url(), request.method(), request.postData() ?? '', request.headers()['authorization'] ?? '', request.headers()['cookie'] ?? '', request.headers()['range'] ?? '');
      return route.fulfill({ ...result, headers: { ...cors, ...result.headers } }).catch(() => {}); // 暂停可能已中止这次请求
    } catch (error) {
      if (error !== simulatedModelDisconnect) throw error;
      await route.abort('connectionreset');
    }
  });
});

test('模拟模型连接后能激活，设置页不显示完整密钥', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-test').click();
  await expect(page.locator('#ob-test-status')).toContainText('连接成功');
  const request = modelRequests.find(r => r.method === 'POST');
  expect(request?.authorization).toBe('Bearer example-secret-1234');
  expect(request?.body).not.toContain('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('#panel')).toHaveClass(/open/);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#th-val')).toHaveText('10 秒');
  await expect(page.locator('#sec-llm input[data-k="apiKey"]')).toHaveValue('***************1234');
  await page.locator('[data-test="sec-llm"]').click();
  await expect(page.locator('[data-status="sec-llm"]')).toContainText('连接成功');
  await page.locator('#sec-llm input[data-k="modelId"]').fill('another-model');
  await expect(page.locator('[data-status="sec-llm"]')).toBeHidden();
  await page.locator('[data-test="sec-llm"]').click();
  await expect(page.locator('[data-status="sec-llm"]')).toContainText('连接成功');
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-settings.png') });
});

test('有新正式版本时在面板中显示固定发布页链接', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  const update = page.getByRole('link', { name: /v1\.1\.0/ });
  await expect(update).toBeVisible();
  await expect(update).toHaveAttribute('href', 'https://github.com/Vincent-chk/bilibili-companion/releases/latest');
});

test('暂停再恢复时取消旧版本检查并重新检查', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => githubRequests).toBe(1);
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#sw-pause')).toBeChecked();
  await expect(page.locator('#p-status')).toContainText('已暂停');
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#sw-pause')).not.toBeChecked();
  await expect(page.locator('#p-status')).not.toContainText('已暂停');
  releaseGithub?.();
  await expect.poll(() => githubRequests, { timeout: 10_000 }).toBe(2);
  await expect(page.getByRole('link', { name: /v1\.1\.0/ })).toBeVisible();
});

test.afterEach(async ({}, testInfo) => {
  releaseGithub?.();
  releaseModel?.();
  releaseSegment?.();
  releaseAudio?.();
  releaseAsrResult?.();
  let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  try {
  if (testInfo.status !== testInfo.expectedStatus && context) {
    await Promise.race([(async () => {
    const page = context.pages().find(p => p.url().startsWith('https://www.bilibili.com/'));
    const worker = context.serviceWorkers().find(w => w.url().endsWith('/background.js'));
    const state = await page?.evaluate(() => {
      const v = document.querySelector('video');
      return { visibility: document.visibilityState, video: v && { time: v.currentTime, paused: v.paused, ended: v.ended, ready: v.readyState, duration: v.duration } };
    }).catch(() => null);
    const database = await worker?.evaluate(async () => {
      const values = await chrome.storage.local.get('sessionPointer');
      const data = await new Promise((resolveData, reject) => {
        const open = indexedDB.open('doubao-companion');open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(['visits', 'jobs']);
          const visits = tx.objectStore('visits').getAll();const jobs = tx.objectStore('jobs').getAll();
          tx.oncomplete = () => { open.result.close();resolveData({ visits: visits.result, jobs: jobs.result }); };tx.onerror = () => reject(tx.error);
        };
      });
      return { pointer: values.sessionPointer, data };
    }).catch(() => null);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(testInfo.outputPath('failure-state.json'), JSON.stringify({ state, database, modelStarts, segmentStarts }, null, 2));
    await page?.screenshot({ path: testInfo.outputPath('failure.png'), timeout: 3000 }).catch(() => {});
    })(), new Promise<void>(resolve => { diagnosticTimer = setTimeout(resolve, 5000); })]);
  }
  } finally {
  clearTimeout(diagnosticTimer);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([context?.close(), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 10_000); })]);
  } finally {
    clearTimeout(closeTimer);
    try {
      if (fixtureServer) {
        fixtureServer.closeAllConnections();
        await new Promise<void>(resolveServer => fixtureServer.close(() => resolveServer()));
      }
    } finally {
      if (profile) await rm(profile, { recursive: true, force: true });
    }
  }
  }
});

test('首次激活必须填写 LLM 配置，取消后仍未激活', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
  await page.locator('#ob-save').click();
  await expect(page.locator('#ob-llm .field.has-err')).toHaveCount(3);
  await page.locator('#ob-cancel').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await page.locator('#mascot').click();
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('页面地址中的敏感查询参数不进入扩展日志', async () => {
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', message => { if (message.text().includes('[doubao')) logs.push(message.text()); });
  await page.goto('https://www.bilibili.com/?access_token=test-only-url-secret', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => logs.some(line => line.includes('content script injected'))).toBe(true);
  await page.evaluate(() => history.pushState({}, '', '/video/BV1XynB6EEiM?access_token=test-only-route-secret'));
  await expect.poll(() => logs.some(line => line.includes('route-changed'))).toBe(true);
  expect(logs.join('\n')).not.toContain('test-only-url-secret');
  expect(logs.join('\n')).not.toContain('test-only-route-secret');
});

test('豆包默认贴边缩小，不拦截推荐，悬停和键盘聚焦时展开', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.id = 'recommendation-test';
    link.href = '#recommendation';
    link.textContent = '推荐视频';
    link.style.cssText = 'position:fixed;left:889px;top:588px;width:141px;height:80px;z-index:1';
    link.addEventListener('click', event => { event.preventDefault(); link.dataset.clicked = 'yes'; });
    document.body.appendChild(link);
  });
  const mascot = page.getByRole('button', { name: '豆包' });
  await expect(mascot).toBeVisible();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeLessThanOrEqual(56);
  const collapsed = await mascot.boundingBox();
  if (!collapsed) throw new Error('豆包没有可交互区域');
  expect(collapsed.width).toBeGreaterThanOrEqual(40);
  expect(collapsed.height).toBeGreaterThanOrEqual(40);
  expect(collapsed.height).toBeLessThanOrEqual(56);
  expect(collapsed.x < 60 || collapsed.x + collapsed.width > 1220).toBe(true);
  const start = page.locator('#btn-start');
  await expect(start).toBeVisible();
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(24);
  await page.locator('#recommendation-test').click();
  await expect(page.locator('#recommendation-test')).toHaveAttribute('data-clicked', 'yes');
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await mascot.hover();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(145);
  await page.mouse.move(700, 100);
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeLessThanOrEqual(56);
  await mascot.focus();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(145);
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('提示气泡紧贴豆包并在左右贴边、悬停和聚焦时对准人物', async () => {
  test.setTimeout(45_000);
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  for (const scenario of [
    { label: 'left', width: 1280, x: 0, y: 0.8 },
    { label: 'right', width: 1280, x: 1, y: 0.8 },
    { label: 'narrow', width: 240, x: 1, y: 0.8 },
    { label: 'top-left', width: 1280, x: 0, y: 0 },
  ]) {
    await worker.evaluate(async ({ x, y }) => chrome.storage.local.set({ mascotPos: { x, y } }), scenario);
    const page = await context.newPage();
    await page.setViewportSize({ width: scenario.width, height: 600 });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
    const mascot = page.locator('#mascot');
    const bubble = page.locator('#mascot-bubble');
    const button = page.locator('#btn-start');
    await expect(button).toBeVisible();
    await page.mouse.move(Math.floor(scenario.width / 2), 10);
    await page.waitForTimeout(350); // 等气泡入场动画结束后测量
    const check = async (expectedWidth: number) => {
      const result = await bubble.evaluate(el => {
        const bubbleRect = el.getBoundingClientRect();
        const mascotRect = el.parentElement!.querySelector('#mascot')!.getBoundingClientRect();
        const style = getComputedStyle(el, '::after');
        const arrowWidth = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
        const left = style.left === 'auto' ? bubbleRect.width - parseFloat(style.right) - arrowWidth : parseFloat(style.left);
        const transform = style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41;
        return { bubble: { left: bubbleRect.left, right: bubbleRect.right, top: bubbleRect.top, bottom: bubbleRect.bottom }, mascot: { left: mascotRect.left, width: mascotRect.width, top: mascotRect.top }, arrowX: bubbleRect.left + left + arrowWidth / 2 + transform };
      });
      expect(result.mascot.width).toBeCloseTo(expectedWidth, 0);
      expect(result.mascot.top - result.bubble.bottom).toBeCloseTo(10, 0);
      expect(result.arrowX).toBeCloseTo(result.mascot.left + result.mascot.width / 2, 0);
      expect(result.bubble.left).toBeGreaterThanOrEqual(0);
      expect(result.bubble.right).toBeLessThanOrEqual(scenario.width);
      expect(result.bubble.top).toBeGreaterThanOrEqual(0);
    };
    await check(48);
    await page.screenshot({ path: test.info().outputPath(`${scenario.label}-collapsed.png`), animations: 'disabled' });
    await mascot.hover();
    await check(150);
    await page.screenshot({ path: test.info().outputPath(`${scenario.label}-hover.png`), animations: 'disabled' });
    const expandedButton = await button.boundingBox();
    if (!expandedButton) throw new Error('展开时气泡按钮不可见');
    await page.mouse.move(expandedButton.x + expandedButton.width / 2, expandedButton.y + expandedButton.height / 2, { steps: 20 });
    expect(await button.evaluate(el => el.matches(':hover'))).toBe(true);
    await page.waitForTimeout(350);
    await check(150);
    await page.mouse.move(Math.floor(scenario.width / 2), 10);
    await mascot.focus();
    await check(150);
    await page.screenshot({ path: test.info().outputPath(`${scenario.label}-focus.png`), animations: 'disabled' });
    await mascot.blur();
    await page.mouse.move(Math.floor(scenario.width / 2), 10);
    await expect.poll(async () => (await mascot.boundingBox())?.width).toBe(48);
    await button.hover();
    await page.waitForTimeout(350);
    await check(48);
    await page.mouse.move(Math.floor(scenario.width / 2), 10);
    await mascot.hover();
    const originalButton = await button.boundingBox();
    if (!originalButton) throw new Error('展开时气泡按钮不可见');
    const bx = originalButton.x + originalButton.width / 2;
    const by = originalButton.y + originalButton.height / 2;
    await page.mouse.move(bx, by, { steps: 20 });
    expect(await button.evaluate(el => el.matches(':hover'))).toBe(true);
    await page.mouse.click(bx, by);
    await expect(page.locator('#modal-root')).toHaveClass(/show/);
    await page.close();
  }
});

test('结束陪看后的睡眠气泡贴近右侧缩小人物', async () => {
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  await worker.evaluate(() => chrome.storage.local.set({ mascotPos: { x: 1, y: 0.8 } }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await activateForVideo(page);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-end').click();
  const bubble = page.locator('#mascot-bubble');
  await expect(bubble).toContainText('数据帮你留着哦', { timeout: 5000 });
  await page.locator('#btn-close').click();
  await page.mouse.move(600, 100);
  await expect(page.locator('#mascot')).toHaveClass(/st-sleep/);
  const mascot = await page.locator('#mascot').boundingBox();
  const b = await bubble.boundingBox();
  if (!mascot || !b) throw new Error('豆包或睡眠气泡不可见');
  expect(mascot.width).toBe(48);
  expect(mascot.y - (b.y + b.height)).toBeCloseTo(10, 0);
  await page.screenshot({ path: test.info().outputPath('sleep-bubble.png'), animations: 'disabled' });
});

test('键盘从展开人物移到气泡按钮时布局稳定且可以激活', async () => {
  const page = await context.newPage();
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  const mascot = page.locator('#mascot');
  const button = page.locator('#btn-start');
  await expect(button).toBeVisible();
  await page.mouse.move(600, 100);
  await mascot.focus();
  expect((await mascot.boundingBox())?.width).toBe(150);
  await page.locator('#mascot-bubble').evaluate(el => Promise.allSettled(el.getAnimations().map(animation => animation.finished)));
  const before = await button.boundingBox();
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  expect((await mascot.boundingBox())?.width).toBe(150);
  // 入场动画可能仍在结束，允许不足 2px 的亚像素变化；错误收起会移动约 102px。
  expect(Math.abs((await button.boundingBox())!.y - before!.y)).toBeLessThan(2);
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('拖到右侧后保留位置，重新加载仍可展开且提示不出屏', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  const mascot = page.getByRole('button', { name: '豆包' });
  await expect(mascot).toBeVisible();
  await mascot.hover();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(145);
  const box = await mascot.boundingBox();
  if (!box) throw new Error('豆包没有可交互区域');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1200, 550, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await page.mouse.move(700, 100);
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeLessThanOrEqual(56);
  await expect.poll(async () => (await mascot.boundingBox())?.x ?? 0).toBeGreaterThan(1100);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await mascot.boundingBox())?.x ?? 0).toBeGreaterThan(1100);
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeLessThanOrEqual(56);
  const start = await page.locator('#btn-start').boundingBox();
  if (!start) throw new Error('开始陪看提示不可见');
  expect(start.x).toBeGreaterThanOrEqual(0);
  expect(start.x + start.width).toBeLessThanOrEqual(1280);
  await mascot.hover();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(145);
  const expanded = await mascot.boundingBox();
  if (!expanded) throw new Error('豆包没有展开');
  expect(expanded.x + expanded.width).toBeLessThanOrEqual(1280);
});

test('旧版本保存的位置在窗口变化后仍按原坐标恢复', async () => {
  const workers = context.serviceWorkers();
  const matches = await Promise.all(workers.map(worker => worker.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, index) => matches[index]);
  if (!worker) throw new Error('未找到豆包扩展后台');
  await worker.evaluate(() => chrome.storage.local.set({ mascotPos: { x: 0.5, y: 0.5 } }));
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  const wrap = page.locator('#mascot-wrap');
  await expect.poll(async () => (await wrap.boundingBox())?.x ?? -1).toBeCloseTo(640, 0);
  expect((await wrap.boundingBox())?.y).toBeCloseTo(400, 0);
  await page.setViewportSize({ width: 900, height: 700 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await wrap.boundingBox())?.x ?? -1).toBeCloseTo(450, 0);
  expect((await wrap.boundingBox())?.y).toBeCloseTo(350, 0);
  const mascot = page.getByRole('button', { name: '豆包' });
  const collapsed = await mascot.boundingBox();
  if (!collapsed) throw new Error('已恢复位置的豆包不可见');
  expect(collapsed.width).toBeLessThanOrEqual(56);
  await mascot.hover();
  await expect.poll(async () => (await mascot.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(145);
});

test('矮窗口中豆包仍在可见区域并可打开配置', async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 220 });
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  const mascot = page.getByRole('button', { name: '豆包' });
  await expect(mascot).toBeVisible();
  const box = await mascot.boundingBox();
  if (!box) throw new Error('豆包没有可交互区域');
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(220);
  await mascot.click();
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('键盘用户能找到豆包入口并打开配置', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  const mascot = page.getByRole('button', { name: '豆包' });
  await expect(mascot).toBeVisible();
  await mascot.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
  await page.locator('#ob-cancel').click();
  await mascot.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('拖动豆包不会误打开配置，随后点击仍可打开', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  const mascot = page.getByRole('button', { name: '豆包' });
  await expect(mascot).toBeVisible();
  const box = await mascot.boundingBox();
  if (!box) throw new Error('豆包没有可交互区域');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 50, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await mascot.click();
  await expect(page.locator('#modal-root')).toHaveClass(/show/);
});

test('结束陪看后继续播放不会自动生成摘要', async () => {
  const page = await context.newPage();
  await activateForVideo(page);
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item')).toHaveCount(1);
  await page.locator('#btn-end').click();
  await expect(page.locator('#btn-resume')).toBeVisible();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.waitForTimeout(6500);
  expect(modelRequests.filter(r => r.body.includes('"stream":true'))).toHaveLength(0);
  await expect(page.locator('.v-item')).toContainText('未生成');
});

test('另一标签页结束陪看后，切回的豆包和面板显示结束状态', async () => {
  const first = await context.newPage();
  await activateForVideo(first);
  await first.getByRole('button', { name: '豆包' }).click();
  await expect(first.locator('#btn-end')).toBeVisible();
  const second = await context.newPage();
  await second.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await expect(second.locator('#mascot')).toHaveClass(/st-happy/);
  await second.getByRole('button', { name: '豆包' }).click();
  await expect(second.locator('.v-item')).toHaveCount(1);
  await second.locator('.v-item').click();
  await expect(second.locator('#d-summary')).toBeVisible();
  await second.locator('#btn-end').click();
  await expect(second.locator('#btn-resume')).toBeVisible();
  await first.bringToFront();
  await expect(first.locator('#mascot')).toHaveClass(/st-sleep/);
  await expect(first.locator('#btn-resume')).toBeVisible();
});

test('截断模型输出和旧版损坏摘要不会把 JSON 当成摘要展示', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page);
  modelTruncatedJson = true;
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.badge-failed')).toHaveCount(1, { timeout: 25_000 });
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText('摘要生成不完整', { timeout: 20_000 });
  await expect(page.locator('#d-summary')).not.toContainText('"summary"');
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  await worker.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['summaries', 'jobs'], 'readwrite');
      const summaries = tx.objectStore('summaries');
      const rows = summaries.getAll();
      rows.onsuccess = () => {
        for (const row of rows.result) summaries.put({ ...row, status: 'done', summary: '{"summary":"旧摘要","outline":[', outline: [], evaluation: '' });
      };
      const jobs = tx.objectStore('jobs');
      const jobRows = jobs.getAll();
      jobRows.onsuccess = () => { for (const job of jobRows.result) jobs.put({ ...job, status: 'done' }); };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.locator('#d-back').click();
  await expect(page.locator('.badge-failed')).toHaveCount(1);
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText('摘要生成不完整');
  await expect(page.locator('#d-summary')).not.toContainText('"summary"');
});

test('暂停后在同一视频恢复能够继续累计并生成', async () => {
  const page = await context.newPage();
  await activateForVideo(page);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).toContainText('已暂停');
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.waitForTimeout(1500);
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).not.toContainText('已暂停');
  await page.locator('#s-back').click();
  await expect(page.locator('.v-item')).toContainText('已总结', { timeout: 15_000 });
});

test('暂停时不再启动排队模型任务，恢复后继续', async () => {
  test.setTimeout(75_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => modelStarts, { timeout: 15_000 }).toBe(1);
  await page.goto('https://www.bilibili.com/video/BV1DUnB61ErU', { waitUntil: 'domcontentloaded' });
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.waitForTimeout(6500);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).toContainText('已暂停');
  await expect(page.locator('#toast-root')).toContainText('当前任务继续完成');
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-paused.png') });
  releaseModel?.();
  await page.locator('#s-back').click();
  await expect(page.locator('.badge-summarized')).toHaveCount(1, { timeout: 10_000 });
  await page.waitForTimeout(1000);
  expect(modelStarts).toBe(1);
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).not.toContainText('已暂停');
  await page.locator('#s-back').click();
  await expect(page.locator('.badge-summarized')).toHaveCount(2, { timeout: 25_000 });
});

test('结束后停止排队预取，恢复陪看后继续', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => segmentStarts, { timeout: 20_000 }).toBe(1);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-end').click();
  await expect(page.locator('#btn-resume')).toBeVisible();
  releaseSegment?.();
  await page.waitForTimeout(1800);
  expect(segmentStarts).toBe(1);
  await page.locator('#btn-resume').click();
  await expect.poll(() => segmentStarts, { timeout: 15_000 }).toBe(6);
});

test('快速暂停恢复按保存顺序生效且当前任务可完成', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => modelStarts, { timeout: 15_000 }).toBe(1);
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').evaluate((input: HTMLInputElement) => { input.click(); input.click(); });
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.paused)).toBe(false);
  releaseModel?.();
  await page.locator('#s-back').click();
  await expect(page.locator('.badge-summarized')).toHaveCount(1, { timeout: 20_000 });
});

test('旧监听器迟到的暂停回复不会销毁恢复后的监听器', async () => {
  test.setTimeout(45_000);
  const page = await context.newPage();
  await activateForVideo(page);
  const session = await context.newCDPSession(page);
  let worldId = 0;
  session.on('Runtime.executionContextCreated', ({ context: world }) => {
    if (world.name === '豆包陪看助手') worldId = world.id;
  });
  await session.send('Runtime.enable');
  expect(worldId).toBeGreaterThan(0);
  const patch = await session.send('Runtime.evaluate', {
    contextId: worldId,
    expression: `(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.__heldTick = false;
      globalThis.__laterTicks = 0;
      chrome.runtime.sendMessage = (...args) => {
        if (args[0]?.type === 'WATCH_TICK') {
          if (!globalThis.__heldTick) {
            globalThis.__heldTick = true;
            return original(...args).then(() => new Promise(resolve => {
              globalThis.__releaseTick = () => resolve({ ok: false, reason: 'paused' });
            }));
          }
          globalThis.__laterTicks++;
        }
        return original(...args);
      };
    })()`,
  });
  expect(patch.exceptionDetails).toBeUndefined();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await session.send('Runtime.evaluate', { contextId: worldId, expression: '!!globalThis.__releaseTick', returnByValue: true })).result.value).toBe(true);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).toContainText('已暂停');
  await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__laterTicks = 0' });
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).not.toContainText('已暂停');
  await expect.poll(async () => (await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__laterTicks', returnByValue: true })).result.value).toBeGreaterThan(0);
  await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__releaseTick()' });
  await page.locator('#s-back').click();
  await expect(page.locator('.badge-summarized')).toHaveCount(1, { timeout: 15_000 });
});

test('刷新前后的有效观看时长累计触发摘要', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page, '10');
  const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
  const isCompanion = await Promise.all(workers.map(w => w.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, i) => isCompanion[i]);
  if (!worker) throw new Error('未找到本项目的扩展后台');
  await expect.poll(() => worker.evaluate(async () => {
    const value = await chrome.storage.local.get('settings');
    return (value.settings as { triggerSeconds?: number } | undefined)?.triggerSeconds;
  })).toBe(10);
  const readRows = () => worker.evaluate(() => new Promise<{
    visits: { videoKey: string; watchedSeconds: number; triggered: number; watchedByTracker?: Record<string, number> }[];
    summaries: { videoKey: string; status: string }[];
    jobs: { videoKey: string; type: string; status: string }[];
  }>((resolveRows, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(['visits', 'summaries', 'jobs']);
      const visits = tx.objectStore('visits').getAll();
      const summaries = tx.objectStore('summaries').getAll();
      const jobs = tx.objectStore('jobs').getAll();
      tx.oncomplete = () => { open.result.close(); resolveRows({ visits: visits.result, summaries: summaries.result, jobs: jobs.result }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await readRows()).visits[0]?.watchedSeconds ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  const beforeReload = await readRows();
  expect(beforeReload.visits).toHaveLength(1);
  const initialVisit = beforeReload.visits[0];
  if (!initialVisit) throw new Error('刷新前未找到观看记录');
  expect(initialVisit.watchedSeconds).toBeGreaterThanOrEqual(4);
  expect(initialVisit.watchedSeconds).toBeLessThanOrEqual(6);
  expect(initialVisit.triggered).toBe(0);
  const beforeWatchIds = Object.keys(initialVisit.watchedByTracker ?? {});
  expect(beforeWatchIds.length).toBeGreaterThan(0);
  expect(beforeReload.summaries).toHaveLength(0);
  expect(beforeReload.jobs).toHaveLength(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '豆包' })).toBeVisible();
  expect((await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings as { triggerSeconds?: number } | undefined))?.triggerSeconds).toBe(10);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => {
    const visit = (await readRows()).visits[0];
    return Boolean(visit && visit.watchedSeconds >= 10 && visit.triggered === 1 && Object.keys(visit.watchedByTracker ?? {}).some(id => !beforeWatchIds.includes(id)));
  }, { timeout: 18_000 }).toBe(true);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(async () => (await readRows()).summaries.filter(row => row.status === 'done').length, { timeout: 15_000 }).toBe(1);
  const afterReload = await readRows();
  expect(afterReload.visits).toHaveLength(1);
  expect(afterReload.summaries).toHaveLength(1);
  const visit = afterReload.visits[0];
  const completed = afterReload.summaries[0];
  if (!visit || !completed) throw new Error('刷新后观看记录或摘要缺失');
  expect(completed.videoKey).toBe(visit.videoKey);
  expect(afterReload.jobs.filter(job => job.type === 'SUMMARIZE' && job.videoKey === visit.videoKey)).toHaveLength(1);
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item')).toContainText('已总结', { timeout: 10_000 });
});

test('跨监听器累计到门槛时立即暂停，补报触发唯一摘要', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page, '5');
  const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
  const matches = await Promise.all(workers.map(w => w.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, i) => matches[i]);
  if (!worker) throw new Error('未找到豆包扩展后台');
  await expect.poll(() => worker.evaluate(async () => {
    const settings = (await chrome.storage.local.get('settings')).settings as { triggerSeconds?: number } | undefined;
    return settings?.triggerSeconds;
  })).toBe(5);

  const targetKey = 'BV1DUnB61ErU:100';
  const session = await context.newCDPSession(page);
  let worldId = 0;
  session.on('Runtime.executionContextCreated', ({ context: world }) => {
    if (world.name === '豆包陪看助手') worldId = world.id;
  });
  await session.send('Runtime.enable');
  expect(worldId).toBeGreaterThan(0);
  // 固定扩展隔离世界的时钟，再通过 SPA 路由创建新监听器，使普通 tick 始终处于节流窗口。
  const setup = await session.send('Runtime.evaluate', {
    contextId: worldId,
    expression: `(() => {
      const now = Date.now(); Date.now = () => now;
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.__targetTicks = [];
      chrome.runtime.sendMessage = (...args) => {
        const m = args[0];
        if (m?.type === 'WATCH_TICK' && m.videoKey === '${targetKey}') {
          globalThis.__targetTicks.push({ watchId: m.watchId, seconds: m.watchedSeconds });
          if (m.watchedSeconds >= 1 && !globalThis.__releaseFinalTick) {
            return new Promise(resolve => { globalThis.__releaseFinalTick = () => resolve(original(...args)); });
          }
        }
        return original(...args);
      };
    })()`,
  });
  expect(setup.exceptionDetails).toBeUndefined();
  await page.evaluate(() => history.pushState({}, '', '/video/BV1DUnB61ErU'));
  const rows = () => worker.evaluate(() => new Promise<{
    visits: { id: number; videoKey: string; watchedSeconds: number; watchedByTracker?: Record<string, number>; triggered: number }[];
    jobs: { type: string; videoKey: string; status: string }[];
    summaries: { videoKey: string; status: string }[];
  }>((resolveRows, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(['visits', 'jobs', 'summaries']);
      const visits = tx.objectStore('visits').getAll();
      const jobs = tx.objectStore('jobs').getAll();
      const summaries = tx.objectStore('summaries').getAll();
      tx.oncomplete = () => { open.result.close(); resolveRows({ visits: visits.result, jobs: jobs.result, summaries: summaries.result }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await expect.poll(async () => (await rows()).visits.some(v => v.videoKey === targetKey)).toBe(true);
  // 派发初始媒体事件，只用于确认新监听器已绑定且它的零值 tick 已送达。
  await expect.poll(async () => {
    await page.locator('video').evaluate(video => video.dispatchEvent(new Event('timeupdate')));
    const result = await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__targetTicks.length', returnByValue: true });
    return result.result.value as number;
  }).toBeGreaterThan(0);
  const initial = await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__targetTicks[0]', returnByValue: true });
  const watchId = (initial.result.value as { watchId: string; seconds: number }).watchId;
  expect(watchId).toBeTruthy();
  await expect.poll(async () => (await rows()).visits.find(v => v.videoKey === targetKey)?.watchedByTracker?.[watchId]).toBe(0);
  // 模拟前一监听器已持久化 4 秒，当前监听器从零开始，测试不依赖真实账号或真实视频。
  await worker.evaluate((key) => new Promise<void>((resolveSeed, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('visits', 'readwrite');
      const store = tx.objectStore('visits');
      const request = store.getAll();
      request.onsuccess = () => {
        const visit = request.result.find((v: { videoKey: string }) => v.videoKey === key);
        if (!visit) { tx.abort(); return; }
        store.put({ ...visit, watchedSeconds: 4, watchedByTracker: { ...visit.watchedByTracker, 'previous-watch': 4 }, triggered: 0 });
      };
      tx.oncomplete = () => { open.result.close(); resolveSeed(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('找不到观看记录'));
    };
  }), targetKey);
  expect((await rows()).visits.find(v => v.videoKey === targetKey)?.watchedSeconds).toBe(4);

  await page.locator('video').evaluate(async (video: HTMLVideoElement) => {
    let first: number | null = null;
    const onTime = () => {
      if (first === null) first = video.currentTime;
      else if (video.currentTime - first >= 1.2) {
        video.removeEventListener('timeupdate', onTime);
        setTimeout(() => video.pause(), 0); // 当前 timeupdate 先交给扩展监听器
      }
    };
    video.addEventListener('timeupdate', onTime);
    await video.play();
  });
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await session.send('Runtime.evaluate', {
    contextId: worldId, expression: 'typeof globalThis.__releaseFinalTick === "function"', returnByValue: true,
  })).result.value, { timeout: 5000 }).toBe(true);
  const beforeRelease = await rows();
  expect(beforeRelease.visits.find(v => v.videoKey === targetKey)?.watchedSeconds).toBe(4);
  expect(beforeRelease.jobs.filter(j => j.videoKey === targetKey && j.type === 'SUMMARIZE')).toHaveLength(0);
  const ticks = await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__targetTicks', returnByValue: true });
  expect(ticks.result.value).toEqual([expect.objectContaining({ watchId, seconds: 0 }), expect.objectContaining({ watchId, seconds: 1 })]);
  await session.send('Runtime.evaluate', { contextId: worldId, expression: 'globalThis.__releaseFinalTick()' });
  await expect.poll(async () => (await rows()).summaries.filter(s => s.videoKey === targetKey && s.status === 'done').length, { timeout: 20_000 }).toBe(1);
  const completed = await rows();
  const visit = completed.visits.find(v => v.videoKey === targetKey);
  expect(visit?.watchedSeconds).toBe(5);
  expect(visit?.triggered).toBe(1);
  expect(completed.jobs.filter(j => j.videoKey === targetKey && j.type === 'SUMMARIZE')).toHaveLength(1);
  expect(completed.summaries.filter(s => s.videoKey === targetKey)).toHaveLength(1);
});

test('合成可见性事件时视频继续播放，隐藏期间不计观看', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await activateForVideo(page, '120');
  const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
  const matches = await Promise.all(workers.map(w => w.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, i) => matches[i]);
  if (!worker) throw new Error('未找到本项目的扩展后台');
  await expect.poll(() => worker.evaluate(async () => {
    const value = await chrome.storage.local.get('settings');
    return (value.settings as { triggerSeconds?: number } | undefined)?.triggerSeconds;
  })).toBe(120);
  const watchedSeconds = () => worker.evaluate(() => new Promise<number>((resolveRows, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('visits');
      const visits = tx.objectStore('visits').getAll();
      tx.oncomplete = () => {
        open.result.close();
        const visit = visits.result.find((row: { videoKey: string }) => row.videoKey === 'BV1XynB6EEiM:100');
        resolveRows(visit?.watchedSeconds ?? 0);
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
  const media = () => page.locator('video').evaluate((video: HTMLVideoElement) => ({
    time: video.currentTime, paused: video.paused, ended: video.ended,
  }));

  // Chrome 受测环境切换标签时未实际产生 hidden；仅在扩展隔离世界合成状态和事件，
  // 验证现有监听器接线与计时，不代表真实标签页或系统前后台切换已验收。
  const session = await context.newCDPSession(page);
  let worldId = 0;
  session.on('Runtime.executionContextCreated', ({ context: world }) => {
    if (world.name === '豆包陪看助手') worldId = world.id;
  });
  await session.send('Runtime.enable');
  expect(worldId).toBeGreaterThan(0);
  const setup = await session.send('Runtime.evaluate', {
    contextId: worldId,
    expression: `(() => {
      globalThis.__syntheticVisibility = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => globalThis.__syntheticVisibility,
      });
      return document.visibilityState;
    })()`,
    returnByValue: true,
  });
  expect(setup.exceptionDetails).toBeUndefined();
  expect(setup.result.value).toBe('visible');
  const sendVisibility = async (state: 'hidden' | 'visible') => {
    const result = await session.send('Runtime.evaluate', {
      contextId: worldId,
      expression: `(() => {
        globalThis.__syntheticVisibility = '${state}';
        document.dispatchEvent(new Event('visibilitychange'));
        return document.visibilityState;
      })()`,
      returnByValue: true,
    });
    expect(result.exceptionDetails).toBeUndefined();
    expect(result.result.value).toBe(state);
  };

  await page.bringToFront();
  await page.locator('video').evaluate((video: HTMLVideoElement) => video.play());
  await expect.poll(watchedSeconds, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await sendVisibility('hidden');
  const hiddenAt = await media();
  expect(hiddenAt.paused).toBe(false);
  expect(hiddenAt.ended).toBe(false);
  // 等实际媒体进度推进，允许切换前已发出的最后一次上报落库，再测后台期间的变化。
  await expect.poll(async () => (await media()).time, { timeout: 10_000 }).toBeGreaterThanOrEqual(hiddenAt.time + 2);
  const hiddenBaseline = await watchedSeconds();
  await expect.poll(async () => (await media()).time, { timeout: 10_000 }).toBeGreaterThanOrEqual(hiddenAt.time + 5);
  const stillHidden = await media();
  expect(stillHidden.paused).toBe(false);
  expect(stillHidden.ended).toBe(false);
  expect(await watchedSeconds()).toBe(hiddenBaseline);

  await sendVisibility('visible');
  await expect.poll(watchedSeconds, { timeout: 10_000 }).toBeGreaterThan(hiddenBaseline);
  expect(modelStarts).toBe(0); // 阈值为 120 秒，测试不应触发模型。
});

test('激活前观看的时间不计入激活后的阈值', async () => {
  const page = await context.newPage();
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.local.set({ settings: { triggerSeconds: 5 } }));
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-start')).toBeVisible();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.waitForTimeout(6500);
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await page.waitForTimeout(3500);
  expect(modelRequests.some(r => JSON.parse(r.body || '{}').stream === true)).toBe(false);
});

test('模拟全局风控冷却60秒期间不再请求并自动恢复', async () => {
  test.setTimeout(110_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => riskReturnedAt, { timeout: 15_000 }).toBeGreaterThan(0);
  const before = biliRequestTimes.length;
  const other = await context.newPage();
  await other.goto('https://www.bilibili.com/video/BV1DUnB61ErU');
  await expect(other.getByRole('button', { name: '豆包' })).toBeVisible();
  await other.waitForTimeout(2000);
  expect(biliRequestTimes).toHaveLength(before);
  await page.bringToFront();
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item').first()).toContainText('已总结', { timeout: 85_000 });
  const resumed = biliRequestTimes.filter(at => at > riskReturnedAt);
  expect(resumed.length).toBeGreaterThan(0);
  expect(Math.min(...resumed) - riskReturnedAt).toBeGreaterThanOrEqual(60_000);
});

test('模拟模型连接中断时任务挂起，合成 online 后恢复', async () => {
  test.setTimeout(75_000);
  const page = await context.newPage();
  await activateForVideo(page, '5');
  const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
  const matches = await Promise.all(workers.map(w => w.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, i) => matches[i]);
  if (!worker) throw new Error('未找到本项目的扩展后台');
  await expect.poll(() => worker.evaluate(async () => {
    const value = await chrome.storage.local.get('settings');
    return (value.settings as { triggerSeconds?: number } | undefined)?.triggerSeconds;
  })).toBe(5);
  const readRows = () => worker.evaluate(() => new Promise<{
    jobs: { id: string; type: string; status: string; retries: number }[];
    summaries: { status: string }[];
  }>((resolveRows, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(['jobs', 'summaries']);
      const jobs = tx.objectStore('jobs').getAll();
      const summaries = tx.objectStore('summaries').getAll();
      tx.oncomplete = () => { open.result.close(); resolveRows({ jobs: jobs.result, summaries: summaries.result }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  modelDisconnected = true;
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => modelStarts, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await readRows()).jobs.find(j => j.type === 'SUMMARIZE')?.status, { timeout: 15_000 }).toBe('pending');
  const waiting = (await readRows()).jobs.filter(j => j.type === 'SUMMARIZE');
  expect(waiting).toHaveLength(1);
  expect(waiting[0]?.retries).toBe(0);
  const jobId = waiting[0]?.id;
  await page.getByRole('button', { name: '豆包' }).click(); // LIST_QUERY 可能主动尝试一次续跑
  await expect(page.locator('.v-item .badge')).toContainText('生成中');
  await page.waitForTimeout(1200);
  const attemptsWhileDisconnected = modelStarts;
  await page.waitForTimeout(1500);
  expect(modelStarts).toBe(attemptsWhileDisconnected); // 断连不应导致自动热循环
  expect((await readRows()).jobs.find(j => j.id === jobId)?.status).toBe('pending');
  modelDisconnected = false;
  // 只验证 SW 在线事件处理；这不是系统 Wi-Fi 断开或浏览器自动派发事件的证据。
  await worker.evaluate(() => globalThis.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await readRows()).jobs.find(j => j.id === jobId)?.status, { timeout: 20_000 }).toBe('done');
  const recovered = await readRows();
  expect(recovered.jobs.filter(j => j.type === 'SUMMARIZE')).toHaveLength(1);
  expect(recovered.jobs.find(j => j.id === jobId)?.retries).toBe(0);
  expect(recovered.summaries.filter(s => s.status === 'done')).toHaveLength(1);
  await expect(page.locator('.v-item .badge')).toContainText('已总结');
});

test('模型 500 回显敏感内容时错误和后台日志不泄露原文', async () => {
  test.setTimeout(75_000);
  const page = await context.newPage();
  await activateForVideo(page, '5');
  const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
  const matches = await Promise.all(workers.map(w => w.evaluate(() => {
    const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
    return runtime.getManifest().name === '豆包陪看助手';
  }).catch(() => false)));
  const worker = workers.find((_, i) => matches[i]);
  if (!worker) throw new Error('未找到本项目的扩展后台');
  const backgroundLogs: string[] = [];
  worker.on('console', message => { backgroundLogs.push(message.text()); });
  await expect.poll(() => worker.evaluate(async () => {
    const value = await chrome.storage.local.get('settings');
    return (value.settings as { triggerSeconds?: number } | undefined)?.triggerSeconds;
  })).toBe(5);
  const readErrors = () => worker.evaluate(() => new Promise<{
    jobs: { type: string; status: string; error?: { code: string; msg: string } }[];
    summaries: { status: string; error?: { code: string; msg: string } }[];
  }>((resolveRows, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(['jobs', 'summaries']);
      const jobs = tx.objectStore('jobs').getAll();
      const summaries = tx.objectStore('summaries').getAll();
      tx.oncomplete = () => {
        open.result.close();
        resolveRows({
          jobs: jobs.result.map(({ type, status, error }: { type: string; status: string; error?: { code: string; msg: string } }) => ({ type, status, error })),
          summaries: summaries.result.map(({ status, error }: { status: string; error?: { code: string; msg: string } }) => ({ status, error })),
        });
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
  modelEchoSensitive = true;
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => modelSensitiveResponses, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await readErrors()).jobs.find(j => j.type === 'SUMMARIZE')?.status, { timeout: 20_000 }).toBe('failed');
  await expect.poll(() => backgroundLogs.some(line => line.includes('LLM_HTTP') && line.includes('500'))).toBe(true);
  expect(modelRequests.some(request => request.body.includes(echoedSubtitle))).toBe(true);
  const rows = await readErrors();
  const job = rows.jobs.find(j => j.type === 'SUMMARIZE');
  const failedSummary = rows.summaries.find(s => s.status === 'failed');
  expect(job?.error?.code).toBe('LLM_HTTP');
  expect(job?.error?.msg).toContain('500');
  expect(failedSummary?.error?.code).toBe('LLM_HTTP');
  expect(failedSummary?.error?.msg).toContain('500');
  const diagnostics = JSON.stringify({ jobs: rows.jobs, summaries: rows.summaries, logs: backgroundLogs });
  for (const value of [echoedSubtitle, echoedCookie, echoedKey]) expect(diagnostics).not.toContain(value);
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item .badge')).toContainText('解析失败');
  // 点击失败条目会启动新的重试；此处只核对失败提示，不混入另一轮网络状态。
  const visibleError = await page.locator('.v-item .badge').innerText();
  for (const value of [echoedSubtitle, echoedCookie, echoedKey]) expect(visibleError).not.toContain(value);
  modelEchoSensitive = false; // 模拟服务恢复，用户点击失败条目重试
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText(summary, { timeout: 25_000 });
  const afterRetry = JSON.stringify({ rows: await readErrors(), backgroundLogs, detail: await page.locator('#d-summary').innerText() });
  for (const value of [echoedSubtitle, echoedCookie, echoedKey]) expect(afterRetry).not.toContain(value);
});

test('模拟 Key 无效后能进入设置修复并重试摘要', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('invalid-key');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#set-threshold').fill('5');
  await expect(page.locator('#th-val')).toHaveText('5 秒');
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item')).toContainText('解析失败', { timeout: 25_000 });
  await page.locator('.v-item').click();
  await expect(page.locator('#d-gosettings')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#d-summary')).toContainText('Key 无效');
  await page.locator('#d-gosettings').click();
  await page.locator('#sec-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('[data-save="sec-llm"]').click();
  await expect(page.locator('#toast-root')).toContainText('已保存');
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.llm?.apiKey)).toBe('example-secret-1234');
  await page.locator('#s-back').click();
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText(summary, { timeout: 25_000 });
});

test('模拟字幕摘要、分段缓存和超期清除确认', async () => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/, { timeout: process.env.E2E_HEADED === '1' ? 150_000 : 5000 });
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('#set-threshold').fill('5');
  await expect(page.locator('#th-val')).toHaveText('5 秒');
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.cookie = 'SESSDATA=test-only-cookie; path=/'; });
  await expect(page.locator('#mascot')).toBeVisible();
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  const badge = page.locator('.v-item .badge');
  await expect(badge).toHaveText(/已总结|解析失败/, { timeout: 25_000 });
  if ((await badge.innerText()).includes('解析失败')) {
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    const failures = await worker?.evaluate(() => new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open('doubao-companion');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result.transaction('jobs').objectStore('jobs').getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result.map((job: { status: string; error?: unknown }) => ({ status: job.status, error: job.error })));
      };
    }));
    throw new Error(`模拟摘要任务失败: ${JSON.stringify(failures)}`);
  }
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-list.png') });
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText(summary);
  await expect(page.locator('.d-outline li')).toHaveCount(6);
  const payload = modelRequests.find(r => r.body.includes('模拟字幕'))?.body;
  expect(payload).toBeTruthy();
  expect(payload).not.toContain('example-secret-1234');
  expect(payload).not.toContain('test-only-cookie');
  expect(modelRequests.find(r => r.body === payload)?.cookie).not.toContain('test-only-cookie');
  await page.locator('.seg-btn').first().click();
  await expect(page.locator('.seg-note').first()).toContainText('本段模拟解读');
  await expect.poll(() => modelRequests.filter(r => r.body.includes('分段解读')).length, { timeout: 15_000 }).toBe(6);
  const before = modelRequests.length;
  await page.locator('.seg-btn').first().click();
  await page.locator('.seg-btn').first().click();
  await expect(page.locator('.seg-note').first()).toContainText('本段模拟解读');
  await page.waitForTimeout(500);
  expect(modelRequests).toHaveLength(before);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-detail.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('#doubao-ui-root')).toHaveClass(/dark/);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-dark.png') });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('fixture-narrow.png') });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('#d-back').click();
  await page.locator('#btn-end').click();
  await expect(page.locator('#btn-resume')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('#btn-resume')).toBeVisible();
  await expect(page.locator('.v-item')).toContainText('测试视频');
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  await worker.evaluate(async () => {
    const { sessionPointer } = await chrome.storage.local.get('sessionPointer');
    await chrome.storage.local.set({ sessionPointer: { ...sessionPointer, closedAt: Date.now() - 2 * 60 * 60 * 1000 } });
  });
  await page.locator('#btn-close').click();
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('#modal-root')).toHaveAttribute('data-owner', 'expired-confirm');
  await page.locator('#wipe-later').click();
  await expect(page.locator('.v-item')).toContainText('测试视频');
  await page.locator('#btn-close').click();
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('#modal-root')).toHaveAttribute('data-owner', 'expired-confirm');
  await page.locator('#wipe-now').click();
  await expect(page.locator('.v-item')).toHaveCount(0);
  await page.locator('#btn-settings').click();
  await expect(page.locator('#sec-llm input[data-k="apiKey"]')).toHaveValue('***************1234');
});

// 稳定性测试需显式运行；smoke 仅验证测试器，short 是独立的多视频密集回归，不代表两小时长测。
test.describe('长时间稳定性', () => {
  test.skip(process.env.E2E_STABILITY !== '1', '设置 E2E_STABILITY=1 后单独运行');
  test('连续陪看多视频，队列完整且内存增长受控', async () => {
    const smoke = process.env.E2E_STABILITY_SMOKE === '1';
    const short = !smoke && process.env.E2E_STABILITY_SHORT === '1';
    const mode = smoke ? 'smoke' : short ? 'short' : 'full';
    const count = smoke ? 4 : short ? 21 : 24;
    const duration = smoke ? 120_000 : short ? 15 * 60 * 1000 : 2 * 60 * 60 * 1000;
    test.setTimeout(duration + 5 * 60 * 1000);
    const page = await context.newPage();
    const browser = context.browser();
    if (!browser) throw new Error('无法取得测试浏览器');
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const browserPid = processInfo.find(p => p.type === 'browser')?.id;
    if (!browserPid) throw new Error('无法确定本次测试浏览器 PID');
    const crashes: string[] = [];
    const extensionTargets = new Set<string>();
    cdp.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.url.startsWith('chrome-extension://')) extensionTargets.add(targetInfo.targetId);
    });
    cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
      if (targetInfo.url.startsWith('chrome-extension://')) extensionTargets.add(targetInfo.targetId);
    });
    cdp.on('Target.targetCrashed', ({ targetId }) => { if (extensionTargets.has(targetId)) crashes.push(targetId); });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    page.on('crash', () => crashes.push('video-page'));
    await activateForVideo(page, '20');
    const startedAt = Date.now();
    const samples: { elapsedMs: number; videos: number; extensionRssMB: number; extensionProcesses: number; pageHeapMB: number; media: { time: number; paused: boolean; visibility: string; playedSeconds: number } }[] = [];
    const pageCdp = await context.newCDPSession(page);
    await pageCdp.send('Performance.enable');
    const evidenceFile = test.info().outputPath('stability.json');
    const { writeFile, appendFile } = await import('node:fs/promises');
    const progressFile = test.info().outputPath('progress.jsonl');
    const sample = async (videos: number) => {
      if (process.platform !== 'darwin') throw new Error('本轮 RSS 采集仅实现 macOS，其他系统不得填假值');
      const lines = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n');
      const rows = lines.map(line => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: +m[1]!, parent: +m[2]!, rss: +m[3]!, command: m[4]! } : null;
      }).filter((row): row is NonNullable<typeof row> => row !== null);
      const descendants = new Set([browserPid]);
      let oldSize = 0;
      while (oldSize !== descendants.size) {
        oldSize = descendants.size;
        for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
      }
      const extensions = rows.filter(row => descendants.has(row.pid) && row.command.includes('--extension-process'));
      if (!extensions.length) throw new Error('未识别到本实例的扩展进程，不能用 0MB 代替');
      const { metrics } = await pageCdp.send('Performance.getMetrics');
      const heap = metrics.find(m => m.name === 'JSHeapUsedSize')?.value;
      if (heap === undefined) throw new Error('无法取得页面 JS heap');
      const value = {
        elapsedMs: Date.now() - startedAt, videos,
        extensionRssMB: extensions.reduce((total, row) => total + row.rss, 0) / 1024,
        extensionProcesses: extensions.length,
        pageHeapMB: heap / 1024 / 1024,
        media: await page.locator('video').evaluate((v: HTMLVideoElement & { fixturePlayedSeconds?: number }) => ({ time: v.currentTime, paused: v.paused, visibility: document.visibilityState, playedSeconds: v.fixturePlayedSeconds ?? 0 })),
      };
      const previous = samples.at(-1);
      const gap = value.elapsedMs - (previous?.elapsedMs ?? 0);
      samples.push(value);
      if (gap > 90_000) {
        await writeFile(evidenceFile, JSON.stringify({ status: 'environment-interrupted', mode, startedAt, gapMs: gap, samples, crashes }, null, 2));
        throw new Error(`连续采样中断 ${gap}ms，不能计作本轮连续运行通过；检查系统睡眠或测试进程暂停`);
      }
      expect(value.media.visibility).toBe('visible');
      expect(value.media.paused).toBe(false);
      if (previous?.videos === videos && gap > 1000) expect(value.media.playedSeconds).toBeGreaterThan(previous.media.playedSeconds);
      await appendFile(progressFile, `${JSON.stringify(value)}\n`);
      await writeFile(evidenceFile, JSON.stringify({ status: 'running', mode, startedAt, expectedDurationMs: duration, expectedVideos: count, samples, crashes }, null, 2));
      console.log(`stability ${JSON.stringify(value)}`);
    };
    for (let i = 0; i < count; i++) {
      const url = i === 0 ? videoUrl : `https://www.bilibili.com/video/BV${String(i).padStart(10, '0')}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('video').evaluate(async (v: HTMLVideoElement & { fixturePlayedSeconds?: number }) => {
        v.loop = true;v.fixturePlayedSeconds = 0;
        let previous = v.currentTime;
        v.addEventListener('timeupdate', () => {
          const delta = v.currentTime - previous;
          v.fixturePlayedSeconds! += delta >= 0 ? delta : v.duration - previous + v.currentTime;
          previous = v.currentTime;
        });
        await v.play();
      });
      await page.getByRole('button', { name: '豆包' }).click();
      await expect(page.locator('.badge-summarized')).toHaveCount(i + 1, { timeout: 45_000 });
      await expect.poll(() => segmentStarts, { timeout: 20_000 }).toBe((i + 1) * 6);
      await sample(i + 1);
      while (Date.now() < startedAt + (i + 1) * duration / count) {
        await page.waitForTimeout(Math.min(30_000, startedAt + (i + 1) * duration / count - Date.now()));
        await sample(i + 1);
      }
      expect(crashes).toEqual([]);
    }
    const workers = context.serviceWorkers().filter(w => w.url().startsWith('chrome-extension://'));
    const isCompanion = await Promise.all(workers.map(w => w.evaluate(() => {
      const runtime = (globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } } }).chrome.runtime;
      return runtime.getManifest().name === '豆包陪看助手';
    }).catch(() => false)));
    const worker = workers.find((_, i) => isCompanion[i]);
    if (!worker) throw new Error('未找到本项目的扩展后台，不能核对其他扩展的数据');
    const rows = await worker.evaluate(() => new Promise<{ visits: { videoKey: string }[]; summaries: { status: string }[]; jobs: { status: string; type: string; videoKey: string }[] }>((resolveRows, reject) => {
      const open = indexedDB.open('doubao-companion');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const transaction = open.result.transaction(['visits', 'summaries', 'jobs']);
        const visits = transaction.objectStore('visits').getAll();
        const summaries = transaction.objectStore('summaries').getAll();
        const jobs = transaction.objectStore('jobs').getAll();
        transaction.oncomplete = () => { open.result.close(); resolveRows({ visits: visits.result, summaries: summaries.result, jobs: jobs.result }); };
        transaction.onerror = () => reject(transaction.error);
      };
    }));
    expect(rows.visits).toHaveLength(count);
    expect(new Set(rows.visits.map(row => row.videoKey)).size).toBe(count);
    expect(rows.summaries.filter(row => row.status === 'done')).toHaveLength(count);
    expect(rows.jobs).toHaveLength(count * 7);
    expect(rows.jobs.filter(row => row.status !== 'done')).toEqual([]);
    const growthMB = samples.at(-1)!.extensionRssMB - samples[0]!.extensionRssMB;
    const peakExtensionRssMB = Math.max(...samples.map(row => row.extensionRssMB));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(duration);
    expect(growthMB).toBeLessThan(30);
    if (!smoke) expect(samples.find(row => row.videos === 10)!.extensionRssMB).toBeLessThanOrEqual(120);
    await writeFile(evidenceFile, JSON.stringify({
      status: 'finished', mode, startedAt, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt,
      expectedVideos: count, visits: rows.visits.length, summaries: rows.summaries.length, jobs: rows.jobs.length,
      growthMB, peakExtensionRssMB, samples, crashes,
      memoryScope: '本测试浏览器的所有 extension-process RSS 上界，可能包含 CfT 内置扩展；pageHeap 单独记录',
    }, null, 2));
  });
});


test('六视频列表按最近观看排序，短看不生成且没有重复条目', async () => {
  test.setTimeout(120_000);
  const page = await context.newPage();
  await activateForVideo(page);
  const bvids = ['BV1XynB6EEiM', ...Array.from({ length: 5 }, (_, i) => `BV${String(i + 1).padStart(10, '0')}`)];
  for (const [i, bvid] of bvids.entries()) {
    await page.goto(`https://www.bilibili.com/video/${bvid}`, { waitUntil: 'domcontentloaded' });
    await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
    await page.getByRole('button', { name: '豆包' }).click();
    await expect(page.locator('.v-item')).toHaveCount(i + 1);
    if (i % 2 === 0) await expect(page.locator('.v-item').first()).toContainText('已总结', { timeout: 20_000 });
    else await page.waitForTimeout(1800);
    await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  }
  const order = await page.locator('.v-item').evaluateAll(rows => rows.map(row => row.getAttribute('data-video-key')));
  expect(order).toEqual([...bvids].reverse().map(bvid => `${bvid}:100`));
  await expect(page.locator('.badge-summarized')).toHaveCount(3);
  await expect(page.locator('.badge-ungenerated')).toHaveCount(3);
  await expect.poll(() => segmentStarts, { timeout: 15_000 }).toBe(18);
  expect(modelRequests.filter(r => r.body.includes('"stream":true') && !r.body.includes('分段解读'))).toHaveLength(3);
  for (let i = 0; i < 5; i++) {
    await page.locator('#btn-close').click();
    await page.getByRole('button', { name: '豆包' }).click();
    await expect(page.locator('.v-item')).toHaveCount(6);
  }
});

test('复制摘要完整，同页和已有标签页跳转正确，新页携带时间参数', async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.badge-summarized')).toHaveCount(1, { timeout: 20_000 });
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('.v-item').click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.bilibili.com' });
  await page.locator('#d-copy').click();
  await expect(page.locator('#toast-root')).toContainText('摘要已复制');
  // Headless Chromium 使用独立的内存剪贴板；这里验证真实 Clipboard API，不模拟 writeText。
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(summary);
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0)).toBeGreaterThan(8);
  await page.locator('.ol-row').nth(4).locator('.ot').click();
  await expect(page.locator('#toast-root')).toContainText('已跳转到 00:08');
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(8, 1);
  await page.locator('.seg-btn').first().click();
  await expect(page.locator('.seg-note').first()).toContainText('本段模拟解读');
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(8, 1);

  const home = await context.newPage();
  await home.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await expect(home.locator('#mascot')).toHaveClass(/st-happy/);
  await home.getByRole('button', { name: '豆包' }).click();
  await home.locator('.v-item').click();
  await home.locator('.ol-row').nth(1).locator('.ot').click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2, 1);
  await page.close();
  await home.bringToFront();
  const newPage = context.waitForEvent('page');
  await home.locator('.ol-row').nth(3).locator('.ot').click();
  const target = await newPage;
  await expect(target).toHaveURL(/\/video\/BV1XynB6EEiM\/\?t=6$/);
  await expect(target.locator('video')).toBeVisible();
  // 新标签页的实际播放器起播依赖 B 站自身 t 参数，此处只证明扩展传参正确。
});

test('切换视频后详情跟随，迟到的解析不关闭用户主动打开的历史详情', async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.badge-summarized')).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => segmentStarts, { timeout: 15_000 }).toBe(6);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.pause());
  await page.locator('.v-item').click();
  await expect(page.locator('#d-video-context')).toBeVisible();
  await expect(page.locator('#d-video-context')).toHaveText('当前播放的视频');

  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).toContainText('已暂停');
  await page.locator('#s-back').click();
  await page.locator('.v-item').click();
  const before = { modelStarts, audioRequests, asrSocketRequests };

  // 模拟 B 站自动连播的 SPA 路由变化；暂停收集时不会返回 VIDEO_ENTER。
  await page.evaluate(() => history.pushState({}, '', '/video/BV0000000001?spm_id_from=333.788.player.switch'));
  await expect(page.locator('.v-item')).toHaveCount(1);
  await expect(page.locator('#d-video-context')).toHaveCount(0);

  // 手动打开旧视频后恢复收集，推迟新视频元数据，确保用户的选择先发生。
  await page.locator('.v-item').click();
  await expect(page.locator('#d-video-context')).toContainText('不是当前播放的视频');
  await page.locator('#btn-settings').click();
  await page.locator('#sw-pause').locator('..').click();
  await page.locator('#s-back').click();
  await expect.poll(() => delayedViewStarted).toBe(true);
  await page.locator('.v-item').click();
  await expect(page.locator('#d-video-context')).toBeVisible();
  releaseView?.();
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'))!;
  await expect.poll(() => worker.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('doubao-companion');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('visits').objectStore('visits').getAll();
      request.onsuccess = () => { open.result.close(); resolve(request.result.some((row: {videoKey: string}) => row.videoKey === 'BV0000000001:100')); };
      request.onerror = () => reject(request.error);
    };
  }))).toBe(true);
  await page.waitForTimeout(500); // 等待 VIDEO_ENTER 响应在内容脚本落地
  await expect(page.locator('#d-video-context')).toContainText('不是当前播放的视频');
  await expect(page.locator('#d-video-context')).toBeVisible();
  expect({ modelStarts, audioRequests, asrSocketRequests }).toEqual(before);
});


for (const round of [1, 2, 3]) {
  test(`异常退出恢复 ${round}/3：结束后恢复陪看并继续原任务`, async () => {
    test.skip(process.platform !== 'darwin', '强杀与进程归属采集当前仅实现 macOS');
    test.setTimeout(90_000);
    const page = await context.newPage();
    await activateForVideo(page);
    await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
    await expect.poll(() => modelStarts, { timeout: 20_000 }).toBe(1);
    const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
    if (!worker) throw new Error('扩展后台未启动');
    const workerUrl = worker.url();
    const before = await worker.evaluate(async () => {
      const { sessionPointer } = await chrome.storage.local.get('sessionPointer');
      const jobs = await new Promise<{ id: string; status: string; type: string }[]>((resolveJobs, reject) => {
        const open = indexedDB.open('doubao-companion');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction('jobs').objectStore('jobs').getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => { open.result.close(); resolveJobs(request.result); };
        };
      });
      return { sessionId: sessionPointer?.sessionId, job: jobs.find(job => job.type === 'SUMMARIZE') };
    });
    expect(before.job?.status).toBe('running');
    if (round === 1) {
      // 模拟退出前用户主动发起的任务：浏览器重启后不应因旧优先级自行续跑。
      await worker.evaluate(async id => {
        await new Promise<void>((resolveUpdate, reject) => {
          const open = indexedDB.open('doubao-companion');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('jobs', 'readwrite');
            const store = tx.objectStore('jobs');
            const get = store.get(id);
            get.onsuccess = () => store.put({ ...get.result, prio: -1 });
            tx.oncomplete = () => { open.result.close(); resolveUpdate(); };
            tx.onerror = () => reject(tx.error);
          };
        });
      }, before.job!.id);
    }
    const browser = context.browser();
    if (!browser) throw new Error('无法取得测试浏览器');
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const pid = processInfo.find(row => row.type === 'browser')?.id;
    if (!pid) throw new Error('无法确定本实例 PID');
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    expect(command).toContain(`--user-data-dir=${profile}`);
    const closed = context.waitForEvent('close');
    process.kill(pid, 'SIGKILL');
    await closed;
    releaseModel?.();
    modelGate = null;
    const port = (fixtureServer.address() as AddressInfo).port;
    const extension = resolve(process.env.E2E_EXTENSION_DIR ?? '.output/chrome-mv3');
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.E2E_BROWSER,
      ...(process.env.E2E_BROWSER ? {} : { channel: 'chromium' }), headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
        '--no-proxy-server', '--ignore-certificate-errors'],
    });
    const restored = await context.newPage();
    await restored.goto(videoUrl, { waitUntil: 'domcontentloaded' });
    await expect(restored.locator('#mascot')).toHaveClass(/st-sleep/);
    await restored.getByRole('button', { name: '豆包' }).click();
    await expect(restored.locator('#btn-resume')).toBeVisible();
    expect(modelStarts).toBe(1);
    if (round === 1) {
      // 已结束但仍在保留期：用户主动点开等待中的摘要，可以单独继续该任务。
      await restored.locator('.v-item').click();
      await expect(restored.locator('#d-summary')).toContainText(summary, { timeout: 25_000 });
      expect(modelStarts).toBeGreaterThan(1);
      await restored.locator('#d-back').click();
    }
    await restored.locator('#btn-resume').click();
    await expect(restored.locator('#mascot')).toHaveClass(/st-happy/);
    await expect(restored.locator('.badge-summarized')).toHaveCount(1, { timeout: 25_000 });
    const newWorker = context.serviceWorkers().find(w => w.url() === workerUrl);
    if (!newWorker) throw new Error('同扩展后台没有恢复');
    const after = await newWorker.evaluate(async () => {
      const { sessionPointer } = await chrome.storage.local.get('sessionPointer');
      const { settings } = await chrome.storage.local.get('settings');
      const data = await new Promise<{ jobs: { id: string; type: string; status: string }[]; visits: unknown[]; sessions: unknown[] }>((resolveData, reject) => {
        const open = indexedDB.open('doubao-companion');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction(['jobs', 'visits', 'sessions']);
          const jobs = transaction.objectStore('jobs').getAll();
          const visits = transaction.objectStore('visits').getAll();
          const sessions = transaction.objectStore('sessions').getAll();
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => { open.result.close(); resolveData({ jobs: jobs.result, visits: visits.result, sessions: sessions.result }); };
        };
      });
      return { sessionId: sessionPointer?.sessionId, keyPreserved: settings?.llm?.apiKey === 'example-secret-1234', ...data };
    });
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.keyPreserved).toBe(true);
    expect(after.visits).toHaveLength(1);
    expect(after.sessions).toHaveLength(1);
    expect(after.jobs.filter(job => job.type === 'SUMMARIZE')).toEqual([expect.objectContaining({ id: before.job!.id, status: 'done' })]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(test.info().outputPath('recovery.json'), JSON.stringify({ round, sessionPreserved: after.sessionId === before.sessionId, keyPreserved: after.keyPreserved, visits: after.visits.length, sessions: after.sessions.length, summaryJobPreserved: true }, null, 2));
  });
}

test('自定义模型端点保存后获得对应域名的运行时权限', async () => {
  test.skip(process.env.E2E_HEADED !== '1', '原生授权专项需 E2E_HEADED=1，普通业务回归模拟拒绝');
  test.setTimeout(180_000);
  const page = await context.newPage();
  const initialWorker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await initialWorker.evaluate(() => {
    const target = globalThis as unknown as { chrome: { permissions: { request(value: { origins: string[] }): Promise<boolean> } }; permissionCalls: unknown[] };
    target.permissionCalls = [];
    const original = target.chrome.permissions.request.bind(target.chrome.permissions);
    target.chrome.permissions.request = async value => {
      try { const result = await original(value); target.permissionCalls.push({ origins: value.origins, result }); return result; }
      catch (error) { target.permissionCalls.push({ origins: value.origins, error: String(error) }); throw error; }
    };
  });
  await activateForVideo(page);
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  const granted = await worker.evaluate(async () => {
    const permissions = (globalThis as unknown as { chrome: { permissions: { contains(value: { origins: string[] }): Promise<boolean> } } }).chrome.permissions;
    return permissions.contains({ origins: ['https://model.example/*'] });
  });
  const calls = await worker.evaluate(() => (globalThis as unknown as { permissionCalls: unknown[] }).permissionCalls);
  console.log('permission-calls', calls);
  expect(granted).toBe(true);
  expect(calls).toEqual([{ origins: ['https://model.example/*'], result: true }]);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(test.info().outputPath('native-permission.json'), JSON.stringify({ granted, calls, mode: 'headed actual browser permissions API' }, null, 2));
  if (process.env.E2E_UI_REVIEW === '1') await page.waitForTimeout(60_000);
});


test('拒绝模型域名授权后保存仍有明确提示', async () => {
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-start').click();
  await page.locator('#ob-llm input[data-k="baseUrl"]').fill('https://model.example/v1');
  await page.locator('#ob-llm input[data-k="modelId"]').fill('mock-model');
  await page.locator('#ob-llm input[data-k="apiKey"]').fill('example-secret-1234');
  await page.locator('#ob-save').click();
  await expect(page.locator('#modal-root')).not.toHaveClass(/show/);
  await expect(page.locator('#toast-root')).toContainText('未获授权');
  await expect(page.locator('#mascot')).toHaveClass(/st-happy/);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  await page.locator('[data-save="sec-llm"]').click();
  await expect(page.locator('#toast-root')).toContainText('未获授权');
});


test('设置页配置不完整时先提示，不请求无用域权限', async () => {
  const page = await context.newPage();
  await activateForVideo(page);
  await page.getByRole('button', { name: '豆包' }).click();
  await page.locator('#btn-settings').click();
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://'));
  if (!worker) throw new Error('扩展后台未启动');
  const countBefore = await worker.evaluate(() => (globalThis as unknown as { permissionRequests: string[][] }).permissionRequests.length);
  await page.locator('#sec-llm input[data-k="baseUrl"]').fill('https://unused.example/v1');
  await page.locator('#sec-llm input[data-k="modelId"]').fill('');
  await page.locator('[data-test="sec-llm"]').click();
  await expect(page.locator('[data-status="sec-llm"]')).toContainText('完整填写');
  await page.locator('[data-save="sec-llm"]').click();
  await expect(page.locator('[data-status="sec-llm"]')).toContainText('完整填写');
  expect(await worker.evaluate(() => (globalThis as unknown as { permissionRequests: string[][] }).permissionRequests.length)).toBe(countBefore);
  expect(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.llm?.apiKey)).toBe('example-secret-1234');
});

test('关闭并重启浏览器后，未结束会话进入一小时保留期', async () => {
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  const closedEstimate = Date.now() - 10_000;
  await worker.evaluate(async at => {
    await chrome.storage.local.set({
      sessionPointer: { sessionId: 'browser-restart-fixture', state: 'ACTIVE', startedAt: at - 1000, lastActiveAt: at },
      browserHeartbeat: { sessionId: 'browser-restart-fixture', at },
    });
  }, closedEstimate);
  await context.close();
  const port = (fixtureServer.address() as AddressInfo).port;
  const extension = resolve(process.env.E2E_EXTENSION_DIR ?? '.output/chrome-mv3');
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_BROWSER,
    ...(process.env.E2E_BROWSER ? {} : { channel: 'chromium' }), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,
      '--no-proxy-server', '--ignore-certificate-errors'],
  });
  const restoredWorker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await expect.poll(async () => (await restoredWorker.evaluate(() => chrome.storage.local.get('sessionPointer'))).sessionPointer).toMatchObject({
    state: 'GRACE', closedAt: closedEstimate,
  });
});

test('扩展后台休眠重启时保留正在陪看的状态', async () => {
  const worker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  const now = Date.now();
  await worker.evaluate(async at => {
    await chrome.storage.local.set({ sessionPointer: { sessionId: 'worker-restart-fixture', state: 'ACTIVE', startedAt: at, lastActiveAt: at } });
  }, now);
  const browser = context.browser();
  if (!browser) throw new Error('无法取得测试浏览器');
  const cdp = await browser.newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(info => info.type === 'service_worker' && info.url === worker.url());
  if (!target) throw new Error('没有找到扩展后台');
  await cdp.send('Target.closeTarget', { targetId: target.targetId });
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });
  const restoredWorker = context.serviceWorkers().find(w => w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await expect.poll(async () => (await restoredWorker.evaluate(() => chrome.storage.local.get('sessionPointer'))).sessionPointer).toMatchObject({
    sessionId: 'worker-restart-fixture', state: 'ACTIVE',
  });
});


for (const minutes of [8, 21, 41]) test(`模拟长视频${minutes}分钟：完整字幕、大纲补全和末段解读`, async () => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await activateForVideo(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => v.play());
  await page.getByRole('button', { name: '豆包' }).click();
  await expect(page.locator('.v-item .badge')).toHaveText('✓ 已总结', { timeout: 45_000 });
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText(tailMarker);
  await expect(page.locator('.d-outline li')).toHaveCount(6);
  expect(longSummaryAttempts).toBe(2); // 首次只覆盖开头，必须纠正后才能完成
  const lastTime = Math.floor(longFixture!.duration * .9);
  await expect(page.locator('.d-outline li').last()).toContainText(`${String(Math.floor(lastTime / 60)).padStart(2, '0')}:${String(lastTime % 60).padStart(2, '0')}`);
  await expect(page.locator('.d-transcript summary')).toContainText(`共 ${longFixture!.count} 条`);
  await expect(page.locator('.d-transcript summary')).toContainText('前 200 条');
  await page.locator('.seg-btn').last().click();
  await expect(page.locator('.seg-note').last()).toContainText(tailMarker, { timeout: 45_000 });
  await expect(page.locator('.seg-note').last()).not.toContainText('已截断');
  expect(modelRequests.some(r => r.body.includes(tailMarker))).toBe(true);
  if (minutes === 41) expect(modelRequests.filter(r => r.body.includes('视频字幕片段分析器')).length).toBeGreaterThan(2);
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`long-${minutes}-tail.png`) });
});

test('空白字幕自动识别实际语音上传一次', async () => {
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await page.getByRole('button',{name:'豆包'}).click();
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  await expect(page.locator('.v-item .badge')).toContainText('已总结',{timeout:20_000});
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);
});

test('自动无字幕极短语音实际语音上传后保留原文且不生成虚构摘要', async () => {
  test.setTimeout(60_000);
  asrFixtureText='今天下雨了';
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await page.getByRole('button',{name:'豆包'}).click();
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  await expect(page.locator('.v-item .badge')).toContainText('内容不足',{timeout:20_000});
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText('内容不足');
  await expect(page.locator('.d-transcript')).toContainText('今天下雨了');
  await expect(page.locator('#btn-asr-ok')).toHaveCount(0);
  await expect(page.locator('.asr-local-progress')).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);expect(modelStarts).toBe(0);
});

test('自动无字幕静音实际语音上传后说明无语音且不继续调用模型', async () => {
  test.setTimeout(60_000);
  asrFixtureText='';
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await page.getByRole('button',{name:'豆包'}).click();
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  await expect(page.locator('.v-item .badge')).toContainText('内容不足',{timeout:20_000});
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText('未识别到可用语音');
  await expect(page.locator('#btn-asr-ok')).toHaveCount(0);
  await expect(page.locator('.d-transcript')).toHaveCount(0);
  await expect(page.locator('.asr-local-progress')).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);expect(modelStarts).toBe(0);
});

test('自动无字幕长音频实际语音上传时服务收到全部分包和唯一末包', async () => {
  test.setTimeout(90_000);
  longAsrInputSeconds=775.252625;
  longFixture={duration:776,count:1,dense:false};
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:50_000}).toBe(1);
  expect(asrAudioFrames).toBe(Math.ceil(longAsrInputSeconds*16000*2/6400));
  expect(asrSocketRequests).toBe(1);
  expect(asrMaxAudioGapMs).toBeLessThan(8000);
  console.log('LONG_ASR_FIXTURE '+JSON.stringify({audioSeconds:longAsrInputSeconds,audioFrames:asrAudioFrames,finalFrames:asrFinalFrames,maxAudioGapMs:asrMaxAudioGapMs}));
});

test('自动无字幕实际语音上传遇到等包超时时明确提示且不自动重发', async () => {
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await page.getByRole('button',{name:'豆包'}).click();
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText('等待音频包超时',{timeout:20_000});
  await expect(page.locator('#d-summary')).toContainText('可能再次消耗额度');
  await page.waitForTimeout(3000);
  expect(asrSocketRequests).toBe(1);expect(audioFetches).toBe(1);
});

test('双标签自动无字幕视频只启动一个语音任务与音轨下载', async () => {
  test.setTimeout(60_000);
  const first=await context.newPage();await activateForVideo(first);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');
    await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});
    c.permissions.contains=async()=>true;
  });
  const second=await context.newPage();await second.goto(videoUrl,{waitUntil:'domcontentloaded'});
  await Promise.all([first.locator('video').evaluate((v:HTMLVideoElement)=>v.play()),second.locator('video').evaluate((v:HTMLVideoElement)=>v.play())]);
  await Promise.all([first.getByRole('button',{name:'豆包'}).click(),second.getByRole('button',{name:'豆包'}).click()]);
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);
  await expect(first.locator('.v-item .badge')).toContainText('生成中');
  const jobs=await worker.evaluate(()=>new Promise<any[]>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const tx=o.result.transaction('jobs'),r=tx.objectStore('jobs').getAll();r.onsuccess=()=>{resolve(r.result);o.result.close()};r.onerror=()=>reject(r.error)}}));
  const asrJobs=jobs.filter(j=>j.type==='ASR_SUMMARIZE');
  expect(asrJobs).toHaveLength(1);expect(asrJobs[0].status).toBe('running');
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(0);
});

test('双标签自动无字幕实际语音上传只发生一次', async () => {
  test.setTimeout(60_000);
  const first=await context.newPage();await activateForVideo(first);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  const second=await context.newPage();await second.goto(videoUrl,{waitUntil:'domcontentloaded'});
  await Promise.all([first.locator('video').evaluate((v:HTMLVideoElement)=>v.play()),second.locator('video').evaluate((v:HTMLVideoElement)=>v.play())]);
  await Promise.all([first.getByRole('button',{name:'豆包'}).click(),second.getByRole('button',{name:'豆包'}).click()]);
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  await expect.poll(async()=>worker.evaluate(()=>new Promise<string[]>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const tx=o.result.transaction('jobs'),r=tx.objectStore('jobs').getAll();r.onsuccess=()=>{resolve(r.result.filter((j:any)=>j.type==='ASR_SUMMARIZE').map((j:any)=>j.status));o.result.close()};r.onerror=()=>reject(r.error)}})),{timeout:20_000}).toEqual(['done']);
  await expect(first.locator('.v-item .badge')).toContainText('已总结');
  expect(asrSocketRequests).toBe(1);expect(asrAudioFrames).toBeGreaterThan(1);expect(asrFinalFrames).toBe(1);expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);
});

test('自动无字幕实际语音上传等待回复时关闭视频页面后仍完成后台任务', async () => {
  test.setTimeout(70_000);
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  const observer=await context.newPage();await observer.goto('about:blank');
  await page.close();releaseAsrResult?.();
  await expect.poll(async()=>worker.evaluate(()=>new Promise<string[]>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const tx=o.result.transaction('jobs'),r=tx.objectStore('jobs').getAll();r.onsuccess=()=>{resolve(r.result.filter((j:any)=>j.type==='ASR_SUMMARIZE').map((j:any)=>j.status));o.result.close()};r.onerror=()=>reject(r.error)}})),{timeout:20_000}).toEqual(['done']);
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);
});

test('自动无字幕实际语音上传等待回复时后台重启不重复上传', async () => {
  test.setTimeout(70_000);
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  const inspector=await context.newPage();await inspector.goto(`chrome-extension://${new URL(worker.url()).hostname}/manifest.json`);
  expect(await inspector.evaluate(()=>typeof (globalThis as any).chrome.runtime?.sendMessage)).toBe('function');
  const browser=context.browser();if(!browser)throw new Error('无法取得测试浏览器');
  const cdp=await browser.newBrowserCDPSession();const targets=await cdp.send('Target.getTargets');
  const target=targets.targetInfos.find(info=>info.type==='service_worker'&&info.url===worker.url());if(!target)throw new Error('没有找到扩展后台');
  await worker.evaluate(()=>{(globalThis as any).__asrRestartProbe=true});
  const stopped=await cdp.send('Target.closeTarget',{targetId:target.targetId});
  await inspector.evaluate(()=>(globalThis as any).chrome.runtime.sendMessage({type:'LIST_QUERY'}));
  const live=context.serviceWorkers().find(w=>w.url()===worker.url());
  if(!live)throw new Error('没有找到重新启动的扩展后台');
  const marker=await live.evaluate(()=>(globalThis as any).__asrRestartProbe??null);
  console.log('ASR_RESTART_DIAG',JSON.stringify({stopped,workerCount:context.serviceWorkers().length,marker}));
  expect(stopped.success).toBe(true);
  expect(marker).toBeNull();
  releaseAsrResult?.();
  await expect.poll(async()=>inspector.evaluate(()=>new Promise<string[]>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const tx=o.result.transaction('jobs'),r=tx.objectStore('jobs').getAll();r.onsuccess=()=>{resolve(r.result.filter((j:any)=>j.type==='ASR_SUMMARIZE').map((j:any)=>j.status));o.result.close()};r.onerror=()=>reject(r.error)}})),{timeout:20_000}).toEqual(['done']);
  expect(playurlRequests).toBe(1);expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);expect(asrFinalFrames).toBe(1);
});

for(const scenario of [{name:'缺配置',configured:false},{name:'缺授权',configured:true}]) test(`自动无字幕${scenario.name}时显示设置入口且不上传`,async()=>{
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page);
  if(scenario.configured){const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>false;});}
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await page.getByRole('button',{name:'豆包'}).click();
  await expect(page.locator('.v-item .badge')).toContainText('待处理',{timeout:25_000});await page.locator('.v-item').click();
  await expect(page.locator('#asr-setup')).toHaveText(scenario.configured?'去设置授权':'配置 ASR',{timeout:10_000});
  expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);
});

test('自动无字幕暂停期间不启动，恢复后才自动识别',async()=>{
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;});
  await page.getByRole('button',{name:'豆包'}).click();await page.locator('#btn-settings').click();await page.locator('#sw-pause').locator('..').click();
  await expect(page.locator('#p-status')).toContainText('已暂停');await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await page.waitForTimeout(6500);expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);
  await page.locator('#sw-pause').locator('..').click();await expect(page.locator('#p-status')).not.toContainText('已暂停');
  await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);expect(playurlRequests).toBe(1);
});

for(const scenario of [
  {name:'安全旧记录实际语音上传',kind:'safe'},
  {name:'历史失败保留',kind:'failed'},
  {name:'明确拒绝保留',kind:'declined'},
  {name:'已有转写保留',kind:'transcript'},
] as const) test(`旧待确认${scenario.name}：打开详情按安全状态处理`,async()=>{
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page,'120');
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(async kind=>{
    const c=(globalThis as any).chrome;const local=await c.storage.local.get(['settings','sessionPointer']);
    await c.storage.local.set({settings:{...local.settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fixture-key'}}});c.permissions.contains=async()=>true;
    const sessionId=local.sessionPointer.sessionId,key='BV1XynB6EEiM:100',now=Date.now();
    await new Promise<void>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result;const tx=db.transaction(['videos','transcripts','summaries','jobs','visits'],'readwrite');
      const visit=tx.objectStore('visits').openCursor();visit.onsuccess=()=>{const cursor=visit.result;if(cursor){if(cursor.value.videoKey===key&&cursor.value.sessionId===sessionId)cursor.update({...cursor.value,triggered:1,watchedSeconds:120});cursor.continue();}};
      tx.objectStore('videos').put({key,bvid:'BV1XynB6EEiM',cid:100,aid:1,title:'测试视频',cover:'',owner:'测试作者',duration:20,page:1,fetchedAt:now});
      tx.objectStore('summaries').put({key:`${key}:mock-model`,videoKey:key,source:'asr',modelId:'mock-model',persona:'spicy',status:'need_asr',summary:'',outline:[],evaluation:'',rating:0,createdAt:now,...(kind==='declined'?{error:{code:'ASR_DECLINED',msg:'已选择暂不处理'}}:{})});
      tx.objectStore('jobs').put({id:'legacy-subtitle',sessionId,videoKey:key,type:'SUMMARIZE',status:'need_confirm',progress:0,retries:0,createdAt:now,updatedAt:now});
      if(kind==='failed')tx.objectStore('jobs').put({id:'legacy-asr',sessionId,videoKey:key,type:'ASR_SUMMARIZE',status:'failed',error:{code:'ASR_INTERRUPTED',msg:'状态不明'},progress:0,retries:0,createdAt:now,updatedAt:now});
      if(kind==='transcript')tx.objectStore('transcripts').put({key,source:'asr',lan:'asr',cues:[{from:0,to:1,text:'旧转写'}],charCount:3,cachedAt:now,asrComplete:false});
      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
    }});
  },scenario.kind);
  await page.getByRole('button',{name:'豆包'}).click();await expect(page.locator('.v-item')).toHaveCount(1);await page.locator('.v-item').click();
  if(scenario.kind==='safe'){
    await expect(page.locator('#d-summary')).not.toContainText('请确认是否调用');
    await expect.poll(()=>audioFetches,{timeout:25_000}).toBe(1);releaseAudio?.();
    await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);expect(asrSocketRequests).toBe(1);
  }else{
    await expect(page.locator('#d-summary')).toContainText('调用 ASR');
    await page.waitForTimeout(2500);expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);
  }
});

test('自动无字幕兼容 ASR 静音结果多次打开不重排任务',async()=>{
  test.setTimeout(60_000);
  const page=await context.newPage();await activateForVideo(page,'120');
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;const local=await c.storage.local.get(['settings','sessionPointer']);const sessionId=local.sessionPointer.sessionId,key='BV1XynB6EEiM:100',now=Date.now();
    await c.storage.local.set({settings:{...local.settings,asr:{provider:'openai-compatible',baseUrl:'https://model.example/v1',modelId:'mock-asr',apiKey:'fake-asr-key'}}});c.permissions.contains=async()=>true;
    await new Promise<void>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction(['summaries','jobs','visits'],'readwrite');
      const visit=tx.objectStore('visits').openCursor();visit.onsuccess=()=>{const cursor=visit.result;if(cursor){if(cursor.value.videoKey===key&&cursor.value.sessionId===sessionId)cursor.update({...cursor.value,triggered:1,watchedSeconds:120});cursor.continue();}};
      tx.objectStore('summaries').put({key:`${key}:mock-model`,videoKey:key,source:'asr',modelId:'mock-model',persona:'spicy',status:'failed',error:{code:'LOW_CONTENT',msg:'未识别到可用语音'},summary:'',outline:[],evaluation:'',rating:0,createdAt:now});
      tx.objectStore('jobs').put({id:'completed-asr',sessionId,videoKey:key,type:'ASR_SUMMARIZE',status:'failed',error:{code:'LOW_CONTENT',msg:'未识别到可用语音'},progress:0,retries:0,createdAt:now,updatedAt:now});
      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
    }});
  });
  await page.getByRole('button',{name:'豆包'}).click();await expect(page.locator('.v-item')).toHaveCount(1);
  for(let i=0;i<2;i++){
    await page.locator('.v-item').click();await expect(page.locator('#d-summary')).toContainText('未识别到可用语音',{timeout:10000});
    await page.locator('#d-back').click();
  }
  await page.waitForTimeout(2000);
  const rows=await worker.evaluate(()=>new Promise<{jobs:any[];summaries:any[]}>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction(['jobs','summaries']),jobs=tx.objectStore('jobs').getAll(),summaries=tx.objectStore('summaries').getAll();tx.oncomplete=()=>{resolve({jobs:jobs.result,summaries:summaries.result});db.close();};tx.onerror=()=>reject(tx.error);};}));
  expect(rows.jobs).toHaveLength(1);expect(rows.jobs[0]).toMatchObject({type:'ASR_SUMMARIZE',status:'failed',error:{code:'LOW_CONTENT'}});
  expect(rows.summaries[0]).toMatchObject({status:'failed',error:{code:'LOW_CONTENT'}});expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);expect(modelStarts).toBe(0);
});

for (const kind of [{name:'人工字幕优先',source:'manual_sub',label:'人工字幕'}, {name:'AI 字幕优先',source:'ai_sub',label:'AI字幕'}]) test(`${kind.name}时只生成字幕摘要，不请求音频或语音识别`, async () => {
  test.setTimeout(45_000);
  const page=await context.newPage();
  await activateForVideo(page);
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;
    const {settings}=await c.storage.local.get('settings');
    await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fake-asr-key'}}});
    c.permissions.contains=async()=>true; // 只模拟已授权，若误触发音频请求仍由夹具计数
  });
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  await page.getByRole('button',{name:'豆包'}).click();
  await expect(page.locator('.v-item .badge')).toHaveText('✓ 已总结',{timeout:25_000});
  await expect(page.locator('.v-item')).toContainText(kind.label);
  await page.locator('.v-item').click();
  await expect(page.locator('#d-summary')).toContainText(summary);
  const rows=await worker.evaluate(()=>new Promise<{summaries:any[];jobs:any[]}>((resolve,reject)=>{
    const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{
      const tx=o.result.transaction(['summaries','jobs']);const a=tx.objectStore('summaries').getAll(),b=tx.objectStore('jobs').getAll();
      tx.oncomplete=()=>{resolve({summaries:a.result,jobs:b.result});o.result.close();};tx.onerror=()=>reject(tx.error);
    };
  }));
  expect(rows.summaries.some(x=>x.status==='done'&&x.source===kind.source)).toBe(true);
  expect(rows.jobs.filter(x=>x.type==='ASR_SUMMARIZE')).toHaveLength(0);
  expect(audioRequests).toBe(0);
  expect(asrSocketRequests).toBe(0);
});

test('豆包语音设置可选服务类型，保存后不暴露密钥并保留预设', async () => {
  const page = await context.newPage();
  await activateForVideo(page);
  await page.getByRole('button', {name:'豆包'}).click();
  await page.locator('#btn-settings').click();
  await page.locator('#asr-provider').selectOption('doubao-agent-plan');
  await expect(page.locator('#sec-asr [data-f="baseUrl"]')).toBeHidden();
  await page.locator('#sec-asr input[data-k="apiKey"]').fill('fixture-doubao-secret');
  await page.locator('[data-save="sec-asr"]').click();
  await expect(page.locator('#sec-asr input[data-k="apiKey"]')).not.toHaveValue('fixture-doubao-secret');
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  const settings=await worker.evaluate(async()=> (await chrome.storage.local.get('settings')).settings as unknown as {asr:{provider:string;modelId:string;apiKey:string}});
  expect(settings.asr).toEqual(expect.objectContaining({provider:'doubao-agent-plan',modelId:'doubao-seed-asr-2.0',apiKey:'fixture-doubao-secret'}));
  expect(await page.locator('#view-settings').innerText()).not.toContain('fixture-doubao-secret');
  await page.locator('#clear-asr-config').click();
  await expect.poll(async()=> (await worker.evaluate(()=>chrome.storage.local.get('settings'))).settings?.asr).toBeUndefined();
});

test('后台异常退出后重新启动会清理残留的豆包认证规则', async () => {
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[78],addRules:[{
      id:78,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'X-Api-Key',operation:'set',value:'fake-key-for-cleanup'}]},
      condition:{urlFilter:'|wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream|',initiatorDomains:[chrome.runtime.id],resourceTypes:['websocket']},
    }]});
  });
  expect(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(true);
  const cdp=await context.browser()!.newBrowserCDPSession();
  const targets=await cdp.send('Target.getTargets');
  const target=targets.targetInfos.find(info=>info.type==='service_worker' && info.url===worker.url());
  if(!target) throw new Error('没有找到扩展后台');
  await cdp.send('Target.closeTarget',{targetId:target.targetId});
  const page=await context.newPage(); await page.goto('https://www.bilibili.com/',{waitUntil:'domcontentloaded'});
  const restored=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await expect.poll(async()=>await restored.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(false);
});

test('浏览器重启后不会保留豆包临时认证规则', async () => {
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await worker.evaluate(async()=>{await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[78],addRules:[{id:78,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'X-Api-Key',operation:'set',value:'fake-key-for-restart'}]},condition:{urlFilter:'|wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream|',initiatorDomains:[chrome.runtime.id],resourceTypes:['websocket']}}]})});
  expect(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(true);
  await context.close();
  const port=(fixtureServer.address() as AddressInfo).port, extension=resolve(process.env.E2E_EXTENSION_DIR ?? '.output/chrome-mv3');
  context=await chromium.launchPersistentContext(profile,{executablePath:process.env.E2E_BROWSER,...(process.env.E2E_BROWSER?{}:{channel:'chromium'}),headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE localhost, EXCLUDE 127.0.0.1`,'--no-proxy-server','--ignore-certificate-errors']});
  const restored=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ?? await context.waitForEvent('serviceworker');
  await expect.poll(async()=>await restored.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(false);
});

test('清除数据时会删除正在使用的临时语音认证规则', async () => {
  const page=await context.newPage();await activateForVideo(page);await page.getByRole('button',{name:'豆包'}).click();await page.locator('#btn-settings').click();
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await worker.evaluate(async()=>{await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[78],addRules:[{id:78,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'X-Api-Key',operation:'set',value:'fake-key-for-wipe'}]},condition:{urlFilter:'|wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream|',initiatorDomains:[chrome.runtime.id],resourceTypes:['websocket']}}]})});
  expect(await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(true);
  await page.locator('#btn-clear').click();await page.locator('#wipe-now').click();
  await expect.poll(async()=>await worker.evaluate(async()=> (await chrome.declarativeNetRequest.getSessionRules()).some(r=>r.id===78))).toBe(false);
});

test('ASR 未完成时显示已处理范围和局部要点，不展示全片大纲与评分', async () => {
  const page=await context.newPage();
  await activateForVideo(page,'120');
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(()=>new Promise<void>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const tx=o.result.transaction('summaries','readwrite');tx.objectStore('summaries').put({key:'BV1XynB6EEiM:100:mock-model',videoKey:'BV1XynB6EEiM:100',source:'asr',modelId:'mock-model',persona:'spicy',status:'need_asr',summary:'',outline:[{time:0,text:'不可显示的全片大纲'}],evaluation:'不可显示的全片点评',rating:5,createdAt:Date.now(),asrProgress:{processedUntil:15,targetDuration:20,status:'partial',parts:[{from:0,to:15,text:'已确认的局部要点'}],unconfirmed:[{from:15,to:20,text:'未确认原文 <img src=x>'}],warning:'后续内容未完成'}});tx.oncomplete=()=>{o.result.close();resolve()};tx.onerror=()=>reject(tx.error)}}));
  await page.getByRole('button',{name:'豆包'}).click();
  await expect(page.locator('.v-item')).toHaveCount(1);
  await page.locator('.v-item').click();
  await expect(page.locator('.asr-local-progress')).toContainText('局部要点（非全片结论）');
  await expect(page.locator('.asr-local-progress')).toContainText('已解析至 00:15 / 00:20 · 未完成');
  await expect(page.locator('.asr-local-progress')).toContainText('已确认的局部要点');
  await expect(page.locator('.asr-local-progress')).toContainText('后续内容未完成');
  await expect(page.locator('.asr-unconfirmed')).toContainText('未确认原文，时间不可用于跳转');
  await expect(page.locator('.asr-unconfirmed')).toContainText('未确认原文 <img src=x>');
  await expect(page.locator('.asr-unconfirmed [data-sec], .asr-unconfirmed a, .asr-unconfirmed button, .asr-unconfirmed img')).toHaveCount(0);
  await expect(page.locator('#view-list')).not.toContainText('不可显示的全片大纲');
  await expect(page.locator('#view-list')).not.toContainText('不可显示的全片点评');
});
test('已完成转写的摘要失败后界面重试复用文字和局部要点', async () => {
  const page=await context.newPage();await activateForVideo(page,'120');
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;const local=await c.storage.local.get(['settings','sessionPointer']);
    await c.storage.local.set({settings:{...local.settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fixture-key'}}});
    c.permissions.contains=async()=>true;
    const sessionId=local.sessionPointer.sessionId;const key='BV1XynB6EEiM:100';const now=Date.now();
    await new Promise<void>((resolve,reject)=>{const open=indexedDB.open('doubao-companion');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction(['videos','transcripts','summaries'],'readwrite');
      tx.objectStore('videos').put({key,bvid:'BV1XynB6EEiM',cid:100,aid:1,title:'测试视频',cover:'',owner:'测试作者',duration:20,page:1,fetchedAt:now});
      tx.objectStore('transcripts').put({key,source:'asr',lan:'asr',cues:[{from:1,to:3,text:'已经识别的完整语音内容'}],charCount:12,cachedAt:now,asrComplete:true,asrDuration:20});
      tx.objectStore('summaries').put({key:`${key}:mock-model`,videoKey:key,source:'asr',modelId:'mock-model',persona:'spicy',status:'need_asr',summary:'',outline:[],evaluation:'',rating:0,createdAt:now,error:{code:'ASR_SUMMARY_FAILED',msg:'摘要生成未完成'},asrProgress:{sessionId,processedUntil:20,targetDuration:20,status:'partial',parts:[{from:0,to:20,text:'已缓存的局部要点'}]}});
      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
    }});
  });
  await page.getByRole('button',{name:'豆包'}).click();await expect(page.locator('.v-item')).toHaveCount(1);await page.locator('.v-item').click();
  await expect(page.locator('.asr-local-progress')).toContainText('已缓存的局部要点');
  await expect(page.locator('#btn-asr-ok')).toHaveText('继续处理');
  await expect(page.locator('#d-summary')).toContainText('缓存');
  await page.locator('#btn-asr-ok').click();
  await expect(page.locator('#d-summary')).not.toContainText('摘要生成未完成',{timeout:15000});
  await expect.poll(async()=>worker.evaluate(()=>new Promise<string>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('summaries').objectStore('summaries').get('BV1XynB6EEiM:100:mock-model');q.onsuccess=()=>{o.result.close();resolve(q.result?.status??'missing')}}})),{timeout:15000}).toBe('done');
  expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);expect(modelRequests.filter(r=>r.method==='POST'&&!r.body.includes('分段解读'))).toHaveLength(1);
  expect(await worker.evaluate(()=>new Promise<string>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('summaries').objectStore('summaries').get('BV1XynB6EEiM:100:mock-model');q.onsuccess=()=>{o.result.close();resolve(q.result?.asrProgress?.parts?.[0]?.text??'missing')}}}))).toBe('已缓存的局部要点');
});

test('完整 ASR 转写按句翻页并可查看视频末尾', async () => {
  const page=await context.newPage();await activateForVideo(page,'120');
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(()=>new Promise<void>((resolve,reject)=>{
    const key='BV1XynB6EEiM:100',now=Date.now();
    const utterances=Array.from({length:273},(_,i)=>{const startMs=i*2800,endMs=startMs+1000,text=`测试句${i}`;return {text,startMs,endMs,definite:true,words:[{text,startMs,endMs}]};});
    const cues=utterances.map(u=>({from:u.startMs/1000,to:u.endMs/1000,text:u.text}));
    const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction(['videos','transcripts','summaries'],'readwrite');
      tx.objectStore('videos').put({key,bvid:'BV1XynB6EEiM',cid:100,aid:1,title:'测试视频',cover:'',owner:'测试作者',duration:776,page:1,fetchedAt:now});
      tx.objectStore('transcripts').put({key,source:'asr',lan:'asr',cues,charCount:1000,cachedAt:now,asrComplete:true,asrDuration:775,asrParts:[{start:0,end:775,whole:true,serviceDurationMs:775000,cues,result:{text:utterances.map(u=>u.text).join(''),utterances}}]});
      tx.objectStore('summaries').put({key:`${key}:mock-model`,videoKey:key,source:'asr',modelId:'mock-model',persona:'spicy',status:'done',summary:'完整摘要',outline:[],evaluation:'',rating:0,createdAt:now});
      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
    };
  }));
  await page.getByRole('button',{name:'豆包'}).click();await expect(page.locator('.v-item')).toHaveCount(1);await page.locator('.v-item').click();
  await page.locator('.d-transcript summary').click();
  await expect(page.locator('.d-transcript')).toContainText('第 1 / 2 页');
  await expect(page.locator('.d-transcript')).toContainText('测试句199');
  await page.locator('#tr-next').click();
  await expect(page.locator('.d-transcript')).toContainText('第 2 / 2 页');
  await expect(page.locator('.d-transcript')).toContainText('测试句272');
  await expect(page.locator('.tr-line').last()).toHaveAttribute('data-sec','761');
  await page.locator('#tr-prev').click();
  await expect(page.locator('.d-transcript')).toHaveAttribute('open','');
  await expect(page.locator('.d-transcript')).toContainText('测试句0');
  expect(audioRequests).toBe(0);expect(asrSocketRequests).toBe(0);
});

test('冲突恢复双标签同时确认实际语音上传一次，摘要失败后复用候选并保留旧结果', async () => {
  test.setTimeout(90_000);
  const first=await context.newPage();await activateForVideo(first,'120');
  await first.locator('video').evaluate((v:HTMLVideoElement)=>v.play());
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'))!;
  await expect.poll(async()=>worker.evaluate(()=>new Promise<number>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const q=o.result.transaction('visits').objectStore('visits').count();q.onsuccess=()=>{o.result.close();resolve(q.result)}}}))).toBeGreaterThan(0);
  await worker.evaluate(async()=>{
    const c=(globalThis as any).chrome;const {settings}=await c.storage.local.get('settings');
    await c.storage.local.set({settings:{...settings,asr:{provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKey:'fixture-key'}}});c.permissions.contains=async()=>true;
    await new Promise<void>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction(['videos','transcripts','summaries'],'readwrite'),key='BV1XynB6EEiM:100',now=Date.now();const words=[{text:'温度5度',startMs:1000,endMs:2000}],cues=[{from:1,to:2,text:'温度5度'}];
      tx.objectStore('videos').put({key,bvid:'BV1XynB6EEiM',cid:100,aid:1,title:'测试视频',cover:'',owner:'测试作者',duration:20,page:1,fetchedAt:now});
      tx.objectStore('transcripts').put({key,source:'asr',lan:'asr',cues,charCount:4,cachedAt:now,asrComplete:true,asrDuration:20,asrParts:[{start:0,end:20,whole:true,serviceDurationMs:20000,cues,result:{text:'温度+5度',utterances:[{text:'温度+5度',startMs:1000,endMs:2000,definite:true,words}]}}]});
      tx.objectStore('summaries').put({key:`${key}:mock-model`,videoKey:key,source:'asr',modelId:'mock-model',persona:'spicy',status:'done',summary:'应保留的旧摘要',outline:[{time:1,text:'旧大纲'}],evaluation:'',rating:0,createdAt:now});tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);};});
  });
  const second=await context.newPage();await second.goto(videoUrl,{waitUntil:'domcontentloaded'});
  for(const page of [first,second]){await page.getByRole('button',{name:'豆包'}).click();await expect(page.locator('.v-item')).toHaveCount(1);await page.locator('.v-item').click();await expect(page.locator('#d-summary')).toContainText('应保留的旧摘要');await expect(page.locator('.asr-recovery')).toContainText('确认重新识别');await expect(page.locator('.d-outline')).toHaveCount(0);}
  expect(audioFetches).toBe(0);expect(asrSocketRequests).toBe(0);
  modelDisconnected=true;
  await Promise.all([first.locator('#asr-recovery-confirm').click(),second.locator('#asr-recovery-confirm').click()]);
  await expect.poll(()=>audioFetches,{timeout:15_000}).toBe(1);releaseAudio?.();
  await expect.poll(()=>asrFinalFrames,{timeout:20_000}).toBe(1);
  const rows=()=>worker.evaluate(()=>new Promise<{jobs:any[];summary:any;transcript:any}>((resolve,reject)=>{const o=indexedDB.open('doubao-companion');o.onerror=()=>reject(o.error);o.onsuccess=()=>{const db=o.result,tx=db.transaction(['jobs','summaries','transcripts']),a=tx.objectStore('jobs').getAll(),b=tx.objectStore('summaries').get('BV1XynB6EEiM:100:mock-model'),c=tx.objectStore('transcripts').get('BV1XynB6EEiM:100');tx.oncomplete=()=>{resolve({jobs:a.result,summary:b.result,transcript:c.result});db.close()};tx.onerror=()=>reject(tx.error)}}));
  await expect.poll(async()=>{const r=await rows();return r.jobs.find((j:any)=>j.type==='ASR_SUMMARIZE')?.status},{timeout:25_000}).toBe('failed');
  const failed=await rows();expect(failed.summary.summary).toBe('应保留的旧摘要');expect(failed.transcript.asrParts[0].result.text).toBe('温度+5度');expect(failed.jobs.filter((j:any)=>j.type==='ASR_SUMMARIZE')).toHaveLength(1);expect(failed.jobs.find((j:any)=>j.type==='ASR_SUMMARIZE').recovery.candidate.asrComplete).toBe(true);
  await expect(first.locator('.asr-recovery')).toContainText('确认继续汇总',{timeout:10_000});expect(asrSocketRequests).toBe(1);expect(audioFetches).toBe(1);
  modelDisconnected=false;await first.locator('#asr-recovery-confirm').click();
  await expect.poll(async()=>{const r=await rows();return r.summary.summary},{timeout:25_000}).toBe(summary);
  const done=await rows();expect(done.transcript.asrParts[0].result.text).toBe('模拟识别语音');expect(audioFetches).toBe(1);expect(asrSocketRequests).toBe(1);await expect(first.locator('#d-summary')).toContainText(summary,{timeout:10_000});
});
