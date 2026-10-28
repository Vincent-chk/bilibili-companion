# 豆包 B 站陪看助手

这是一个本地优先的浏览器扩展：陪你浏览 B 站视频，并通过你自己配置的大模型服务生成摘要和分段解读。观看记录和配置保存在本机；字幕内容会发送给你配置的模型服务。正式版本与发布材料仍在验收中。

项目自行编写的源码采用 [MIT 许可证](LICENSE)。第三方代码、素材和商标适用各自的权利与许可，第三方软件版权与许可见 [THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt)。

使用前请阅读 [安装与使用](docs/安装与使用.md) 和 [隐私说明](PRIVACY.md)。发布者操作见 [Chrome 应用商店发布操作手册](docs/Chrome应用商店发布操作手册.md)。

## 开发命令

```bash
pnpm install          # 依赖（registry 走 npmmirror，见 .npmrc）
pnpm typegen          # 生成 .wxt 类型（clone 后先跑一次）
pnpm compile          # tsc --noEmit
pnpm test             # vitest 单测
pnpm build            # 产物 → .output/chrome-mv3
pnpm dev              # 开发模式（HMR），chrome://extensions 加载 .output/chrome-mv3-dev
```

## 隔离浏览器测试

先执行 `pnpm build`，然后安装 Playwright 的 Chromium（`pnpm exec playwright install chromium`）并运行 `pnpm test:e2e`。测试使用临时浏览器资料、本地 HTTPS 模拟服务、模拟视频和测试密钥；需要本机 `openssl`。也可用 `E2E_BROWSER` 指向 Chrome for Testing、`E2E_EXTENSION_DIR` 指向已构建的扩展目录。测试覆盖情况以验收记录为准，不能代替真实 B 站或非开发者验收。

## 红线（违者不许合入）

- API Key / Cookie 永不入库、不打印（`.gitignore` 已覆盖 `.env*`）。
- 对 B 站接口限速 ≤2 req/s；人工调研使用已确认的样本视频；不调用观看历史接口。正常使用时，扩展处理用户当前打开的视频，不限于调研样本。

## Windows 自动化验收

[GitHub Actions 配置](.github/workflows/phase3-windows.yml) 为现有私有仓准备了 Windows + Chrome for Testing 的非 ASR 回归：安装依赖、类型检查、单测、打包和浏览器 fixtures。单个任务最多运行 30 分钟，不使用真实模型凭据，工件保留 3 天。原生授权 UI、macOS 强杀测试和两小时长测分开验收；此任务不能证明 Edge 或 Windows 的全部人工体验。

Windows 验证按需求方 2026-10-27 的决定留待后续，追踪 [Issue #2](https://github.com/Vincent-chk/bilibili-companion/issues/2)。本轮未推送或运行 CI；配置仅保留手动触发，后续执行前再确认额度或预算。
