# src/lib/llm

PoC 的 LLM 层：OpenAI-compatible `/chat/completions` SSE 流式客户端 + 豆包结构化摘要。lib 层零 `chrome.*`/`browser.*` 调用（fetch、配置全部参数注入）。

- `client.ts` — `streamChatCompletion`：手写 SSE 行缓冲解析，返回完整文本 + usage + 首 token 延迟；非 2xx → `LlmHttpError(status, 打码 body)`，网络/超时 → `LlmNetworkError`。
- `summary.ts` — `buildSummaryMessages` / `parseSummary`（剥围栏+大括号切片兜底）/ `validateSummary` / `summarize`（校验失败带错重发 1 次 → 再失败降级纯文本前 600 字、outline 置空，最多 2 次请求）/ `resolveConfig`（storage 三件套 → 构建期注入 → null+可读错误）。
- Key 安全红线：**不落盘、不入库、不打印**（错误信息只含 status 与剔除 Key 后的 body 前 200 字符）。

## 真实火山方舟一键补验

```bash
POC_LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/v3 \
POC_LLM_MODEL=doubao-seed-2-1-lite-260915 \
POC_LLM_API_KEY=<有效Key> pnpm build
```

（模型 id 以需求方给定为准；Key 只进构建环境变量，不进仓库；运行期优先读 chrome.storage.local 的 llm 三件套，均无则 `resolveConfig` 返回可读错误。07 报告 §9.1：当前 Key 被服务端判 401，换有效 Key 重新 build 即真验。）

## mock 服务器

`node scripts/mock-llm-server.mjs [port]`（默认 8787；stdout 打 `ready port=<实际端口>`；全响应带 CORS 头、OPTIONS→204；messages 含 `BADJSON` 首轮坏 JSON 二轮合法、含 `ALWAYS_BAD` 恒坏——分别用于验证带错重发与降级）。
