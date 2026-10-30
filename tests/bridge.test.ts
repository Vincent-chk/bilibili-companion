import { afterEach, expect, it, vi } from 'vitest';
import { Bridge } from '../src/content/bridge';

const runtime = vi.hoisted(() => ({ connect: vi.fn(), sendMessage: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('默认桥接使用 WXT 的扩展 API，Chrome 没有全局 browser 时仍可通信', async () => {
  vi.stubGlobal('browser', undefined);
  let onMessage: (message: unknown) => void = () => {};
  runtime.connect.mockReturnValue({
    onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    onDisconnect: { addListener: () => {} },
  });
  runtime.sendMessage.mockResolvedValue({ ok: true });
  const events: unknown[] = [];
  const bridge = new Bridge(event => events.push(event), { setTimeout: vi.fn() as unknown as typeof setTimeout });
  bridge.connect();
  onMessage({ type: 'SESSION_STATE', state: 'INACTIVE' });
  expect(events).toEqual([{ type: 'SESSION_STATE', state: 'INACTIVE' }]);
  expect(await bridge.request({ type: 'SESSION_START' })).toEqual({ ok: true });
});

it('连接失败后默认计时器以全局上下文调用并安排重连', () => {
  let scheduled = false;
  vi.stubGlobal('setTimeout', function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    scheduled = true;
    return 1;
  });
  const bridge = new Bridge(() => {}, { connectPort: () => { throw new Error('disconnected'); } });
  expect(() => bridge.connect()).not.toThrow();
  expect(scheduled).toBe(true);
});

it('页面恢复时补查会话状态，弥补后台标签页漏掉的广播', async () => {
  const events: unknown[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const bridge = new Bridge(event => events.push(event), {
    connectPort: () => ({
      onMessage: { addListener: listener => { listeners.push(listener); } },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {}, disconnect: () => {},
    }),
  });
  bridge.connect();
  await bridge.syncState();
  expect(listeners).toHaveLength(2);
  listeners[1]!({ type: 'SESSION_STATE', state: 'GRACE', retainUntil: 12345 });
  expect(events).toContainEqual({ type: 'SESSION_STATE', state: 'GRACE', retainUntil: 12345 });
});

it('页面恢复重连后，旧连接迟到的消息不能覆盖新会话状态', async () => {
  const listeners: ((event: unknown) => void)[] = [];
  const events: unknown[] = [];
  const bridge = new Bridge(event => events.push(event), {
    connectPort: () => ({
      onMessage: { addListener: listener => { listeners.push(listener); } },
      onDisconnect: { addListener: () => {} },
      postMessage: () => {}, disconnect: () => {},
    }),
  });
  bridge.connect();
  await bridge.syncState();
  expect(listeners).toHaveLength(2);
  listeners[1]!({ type: 'SESSION_STATE', state: 'GRACE' });
  listeners[0]!({ type: 'SESSION_STATE', state: 'ACTIVE' });
  expect(events.filter((event: any) => event.type === 'SESSION_STATE')).toEqual([{ type: 'SESSION_STATE', state: 'GRACE' }]);
});

it('Port 断开时同步读取 lastError 并保留可恢复断线的重连', () => {
 let disconnect!:()=>void;const scheduled=vi.fn();let reads=0;
 Object.defineProperty(runtime,'lastError',{configurable:true,get(){reads++;return {message:'channel closed'};}});
 const bridge=new Bridge(()=>{},{connectPort:()=>({onMessage:{addListener:()=>{}},onDisconnect:{addListener:fn=>{disconnect=fn;}},postMessage:()=>{}}),setTimeout:scheduled as unknown as typeof setTimeout});
 bridge.connect();disconnect();expect(reads).toBe(1);expect(scheduled).toHaveBeenCalledOnce();
 delete (runtime as {lastError?:unknown}).lastError;
});

it('扩展上下文失效时停止重连并通知用户刷新', () => {
 const scheduled=vi.fn();const events:unknown[]=[];
 const bridge=new Bridge(event=>events.push(event),{connectPort:()=>{throw new Error('Extension context invalidated.');},setTimeout:scheduled as unknown as typeof setTimeout});
 bridge.connect();bridge.syncState();expect(scheduled).not.toHaveBeenCalled();expect(events).toEqual([{type:'EXTENSION_RELOAD_REQUIRED'}]);
});
