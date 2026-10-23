# bilibili-companion（私有源码仓）

「豆包」B 站陪看助手源码。方案文档在上级目录 `../02-开发方案/`（本仓永不公开，D17）。

## Phase 0 PoC 常用命令

```bash
pnpm install          # 依赖（registry 走 npmmirror，见 .npmrc）
pnpm typegen          # 生成 .wxt 类型（clone 后先跑一次）
pnpm compile          # tsc --noEmit
pnpm test             # vitest 单测
pnpm build            # 产物 → .output/chrome-mv3
pnpm dev              # 开发模式（HMR），chrome://extensions 加载 .output/chrome-mv3-dev
```

## 红线（违者不许合入）

- API Key / Cookie 永不入库、不打印（`.gitignore` 已覆盖 `.env*`）。
- 对 B 站接口限速 ≤2 req/s；仅请求调研样本清单内的视频；不调用观看历史接口。
