// Phase 0 PoC · background service worker
// 职责（0.1 骨架级）：常驻就绪日志 + 消息路由占位。
// 0.2/0.4 集成后：这里承载 B 站接口调用（host_permissions 下带 Cookie）与 LLM SSE。
export default defineBackground(() => {
  console.log('[doubao-poc] background ready');

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string };
    if (m?.type === 'PING') {
      console.log('[doubao-poc] background PONG');
      return Promise.resolve({ pong: true });
    }
    return undefined; // 未识别的消息交给其它 listener
  });
});
