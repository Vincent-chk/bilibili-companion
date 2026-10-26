import { defineConfig } from 'wxt';

// LLM 配置的构建期注入：PoC/E2E 用环境变量带入（如 mock 服务器地址），**API Key 永不写进仓库**。
// 运行期优先级：chrome.storage.local（用户配置）> 这里的构建期注入 > 无配置报可读错误。
const inject = (v: string | undefined, fallback = '') => JSON.stringify(v ?? fallback);

export default defineConfig({
  vite: () => ({
    define: {
      __POC_LLM_BASE_URL__: inject(process.env.POC_LLM_BASE_URL),
      __POC_LLM_MODEL__: inject(process.env.POC_LLM_MODEL),
      __POC_LLM_KEY__: inject(process.env.POC_LLM_API_KEY),
      __POC_LLM_TIMEOUT_MS__: inject(process.env.POC_LLM_TIMEOUT_MS), // 思考型真实模型整流耗时远超默认 60s
    },
  }),
  manifest: {
    name: '豆包陪看助手（PoC）',
    description: 'Phase 0 PoC：B 站视频识别 + 字幕直取 + LLM 摘要 console 打印',
    // alarms：P2.1 保留期判定的 30min 兜底唤醒（架构 §3.7）；webNavigation：P1.9 起 SPA 路由探测（架构 §3.1 主路）；
    // declarativeNetRequest：P2.3 起 ASR 音频请求补 Referer（架构 §3.8，bilivideo.com/.cn 动态规则）
    permissions: ['storage', 'offscreen', 'webNavigation', 'alarms', 'declarativeNetRequest'],
    host_permissions: [
      '*://*.bilibili.com/*',
      '*://*.hdslb.com/*',
      '*://*.bilivideo.com/*',
      '*://*.bilivideo.cn/*',
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
