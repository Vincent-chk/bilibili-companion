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
    },
  }),
  manifest: {
    name: '豆包陪看助手（PoC）',
    description: 'Phase 0 PoC：B 站视频识别 + 字幕直取 + LLM 摘要 console 打印',
    permissions: ['storage'],
    host_permissions: [
      '*://*.bilibili.com/*',
      '*://*.hdslb.com/*',
      '*://*.bilivideo.com/*',
      '*://*.bilivideo.cn/*',
    ],
    // content_scripts 不在此声明：WXT 由 entrypoints/content.ts 的 defineContentScript 生成注册。
  },
});
