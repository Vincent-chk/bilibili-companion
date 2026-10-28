# src/lib/llm

PoC 的 LLM 层：OpenAI-compatible `/chat/completions` SSE 流式客户端 + 豆包结构化摘要。lib 层零 `chrome.*`/`browser.*` 调用（fetch、配置全部参数注入）。

- `client.ts` — `streamChatCompletion`：手写 SSE 行缓冲解析，返回完整文本 + usage + 首 token 延迟；非 2xx → `LlmHttpError`（保留状态码，隐藏服务端错误体，避免回显字幕或凭据），网络/超时 → `LlmNetworkError`。
- `summary.ts` — `buildSummaryMessages` / `parseSummary`（剥围栏+大括号切片兜底）/ `validateSummary` / `summarize`（校验失败带错重发 1 次；字段完整但仅字数或条数偏离要求时保留可用摘要和大纲，纯文本回复可降级展示；截断的 JSON 不作为摘要展示，最多 2 次请求）/ `resolveConfig`（读取运行期配置，缺失时返回可读错误）。
- Key 保存在本机 `chrome.storage.local`，不写入源码、构建产物、诊断日志或同步存储；请求认证头需要发送给用户配置的模型服务。

## 真实火山方舟一键补验

**✅ 补验已完成（2026-10-24，`02-开发方案/10-真实LLM补验报告.md`：真实模式 E2E 40/40）**。关键事实：临时 Key 为 **plan 端点作用域**（baseUrl 用 `…/api/plan/v3`，标准 `/api/v3` 对其 401）；模型须**全 id**（`seed-2.1-lite` → UnsupportedModel）；思考型模型整流慢（全片摘要实测 ~79s），必须注入 `POC_LLM_TIMEOUT_MS`（缺省 60s 会 abort）。

```bash
E2E_REAL_LLM=1 \
POC_LLM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
POC_LLM_MODEL=doubao-seed-2-1-lite-260915 \
POC_LLM_API_KEY=<有效Key> \
POC_LLM_TIMEOUT_MS=300000 \
node scripts/e2e-poc.mjs   # 脚本内部重跑 build，通过 onboarding 填入运行期配置
```

（测试 Key 从进程环境传入临时浏览器的 onboarding，保存在该临时 profile 的本地设置中，测试结束清理；不编译进构建产物。⚠️ ARK 端点 CORS 预检**不放行 Authorization 头**——浏览器端必须经 onboarding 的按 origin 授权（host 权限豁免 CORS）才能调通；headless E2E 弹不出授权窗，以 `--disable-web-security` 模拟授权后语义。详见 10 报告 §1/§3。）

## mock 服务器

`node scripts/mock-llm-server.mjs [port]`（默认 8787；stdout 打 `ready port=<实际端口>`；全响应带 CORS 头、OPTIONS→204；messages 含 `BADJSON` 首轮坏 JSON 二轮合法、含 `ALWAYS_BAD` 恒坏——分别用于验证带错重发与降级）。
