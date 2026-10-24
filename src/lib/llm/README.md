# src/lib/llm

PoC 的 LLM 层：OpenAI-compatible `/chat/completions` SSE 流式客户端 + 豆包结构化摘要。lib 层零 `chrome.*`/`browser.*` 调用（fetch、配置全部参数注入）。

- `client.ts` — `streamChatCompletion`：手写 SSE 行缓冲解析，返回完整文本 + usage + 首 token 延迟；非 2xx → `LlmHttpError(status, 打码 body)`，网络/超时 → `LlmNetworkError`。
- `summary.ts` — `buildSummaryMessages` / `parseSummary`（剥围栏+大括号切片兜底）/ `validateSummary` / `summarize`（校验失败带错重发 1 次 → 再失败降级纯文本前 600 字、outline 置空，最多 2 次请求）/ `resolveConfig`（storage 三件套 → 构建期注入 → null+可读错误）。
- Key 安全红线：**不落盘、不入库、不打印**（错误信息只含 status 与剔除 Key 后的 body 前 200 字符）。

## 真实火山方舟一键补验

**✅ 补验已完成（2026-10-24，`02-开发方案/10-真实LLM补验报告.md`：真实模式 E2E 40/40）**。关键事实：临时 Key 为 **plan 端点作用域**（baseUrl 用 `…/api/plan/v3`，标准 `/api/v3` 对其 401）；模型须**全 id**（`seed-2.1-lite` → UnsupportedModel）；思考型模型整流慢（全片摘要实测 ~79s），必须注入 `POC_LLM_TIMEOUT_MS`（缺省 60s 会 abort）。

```bash
E2E_REAL_LLM=1 \
POC_LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
POC_LLM_MODEL=doubao-seed-2-1-lite-260915 \
POC_LLM_API_KEY=<有效Key> \
POC_LLM_TIMEOUT_MS=300000 \
node scripts/e2e-poc.mjs   # 脚本内部会以同一 env 重跑 pnpm build
```

（Key 只进进程 env，不入仓库；运行期优先读 chrome.storage.local 的 llm 三件套，均无则 `resolveConfig` 返回可读错误。⚠️ ARK 端点 CORS 预检**不放行 Authorization 头**——浏览器端必须经 onboarding 的按 origin 授权（host 权限豁免 CORS）才能调通；headless E2E 弹不出授权窗，以 `--disable-web-security` 模拟授权后语义。详见 10 报告 §1/§3。）

## mock 服务器

`node scripts/mock-llm-server.mjs [port]`（默认 8787；stdout 打 `ready port=<实际端口>`；全响应带 CORS 头、OPTIONS→204；messages 含 `BADJSON` 首轮坏 JSON 二轮合法、含 `ALWAYS_BAD` 恒坏——分别用于验证带错重发与降级）。
