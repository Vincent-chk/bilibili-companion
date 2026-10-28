import { defineConfig } from 'wxt';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 测试可调整超时；端点与密钥只通过运行期设置提供，绝不编译进产物。
const inject = (v: string | undefined, fallback = '') => JSON.stringify(v ?? fallback);

export default defineConfig({
  hooks: {
    'build:done': async (wxt) => {
      await copyFile(resolve(wxt.config.root, 'LICENSE'), resolve(wxt.config.outDir, 'LICENSE'));
    },
  },
  vite: () => ({
    define: {
      __POC_LLM_TIMEOUT_MS__: inject(process.env.POC_LLM_TIMEOUT_MS), // 思考型真实模型整流耗时远超默认 60s
    },
  }),
  manifest: {
    name: '豆包陪看助手',
    description: '陪你观看 B 站视频，生成摘要、点评和分段解读。',
    minimum_chrome_version: '155', // 与项目验收基线一致，避免旧版浏览器静默安装后无法通信。
    icons: { 128: 'mascot/mascot-icon-128.png' },
    // alarms：P2.1 保留期判定的 30min 兜底唤醒（架构 §3.7）；webNavigation：P1.9 起 SPA 路由探测（架构 §3.1 主路）；
    // declarativeNetRequest：P2.3 起 ASR 音频请求补 Referer（架构 §3.8，bilivideo.com/.cn 动态规则）
    permissions: ['storage', 'offscreen', 'webNavigation', 'alarms', 'declarativeNetRequest'],
    host_permissions: [
      '*://*.bilibili.com/*',
      '*://*.hdslb.com/*',
      '*://*.bilivideo.com/*',
      '*://*.bilivideo.cn/*',
      'https://api.github.com/*',
      // 火山方舟 LLM 端点（ark.cn-beijing.volces.com）：错误响应不带 CORS 头 +
      // SW 内 permissions.request 丢手势弹窗必失败 → 直接静态授权豁免 CORS（补验报告 T-9）。
      '*://*.volces.com/*',
    ],
    // P1.7：用户 LLM/ASR 端点按 origin 动态授权（onboarding 保存时申请，绝不静默通配）
    optional_host_permissions: ['*://*/*'],
    // P1.5：mascot 立绘/头像在 content script 的 Shadow DOM <img> 中加载，须 web 可访问
    web_accessible_resources: [{ resources: ['mascot/*'], matches: ['*://www.bilibili.com/*'] }],
    // content_scripts 不在此声明：WXT 由 entrypoints/content.ts 的 defineContentScript 生成注册。
  },
});
