import { defineConfig } from 'wxt';

// manifest 权限按 02-开发方案/01-技术架构设计.md §5（出网白名单四域，F-2/G-3）。
// PoC 阶段不申请 cookies 权限：登录态由浏览器自动携带（host_permissions + credentials）。
export default defineConfig({
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
