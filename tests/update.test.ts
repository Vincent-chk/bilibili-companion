import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate, isNewerVersion } from '../src/lib/update';

describe('版本更新提示', () => {
  it('只比较正式版数字，忽略预发布和非法标签', () => {
    expect(isNewerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('v1.0.0-beta', '0.9.0')).toBe(false);
    expect(isNewerVersion('untrusted', '1.0.0')).toBe(false);
  });

  it('只访问固定发布地址，不带浏览器 Cookie，24 小时内复用结果', async () => {
    let record: { checkedAt: number; latest?: string } | undefined;
    const store = { get: async () => record, set: async (v: typeof record) => { record = v; } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ tag_name: 'v1.2.0' }), { status: 200 }));
    expect(await checkForUpdate(store, '1.0.0', { now: 100_000_000, fetchImpl: fetcher })).toBe('v1.2.0');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/Vincent-chk/bilibili-companion/releases/latest');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(await checkForUpdate(store, '1.0.0', { now: 100_001_000, fetchImpl: fetcher })).toBe('v1.2.0');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('暂停时不发送请求；请求失败不会抛出或反复请求', async () => {
    let record: { checkedAt: number; latest?: string } | undefined;
    const store = { get: async () => record, set: async (v: typeof record) => { record = v; } };
    const fetcher = vi.fn(async () => { throw new Error('offline'); });
    expect(await checkForUpdate(store, '1.0.0', { now: 100_000_000, fetchImpl: fetcher, paused: true })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await checkForUpdate(store, '1.0.0', { now: 100_000_000, fetchImpl: fetcher })).toBeNull();
    expect(await checkForUpdate(store, '1.0.0', { now: 100_000_001, fetchImpl: fetcher })).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('暂停取消在途检查后不记录已检查，恢复时可以重新检查', async () => {
    let record: { checkedAt: number; latest?: string } | undefined;
    const store = { get: async () => record, set: async (v: typeof record) => { record = v; } };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const fetcher = vi.fn(async () => { await pending; return new Response(JSON.stringify({ tag_name: 'v1.2.0' })); });
    const controller = new AbortController();
    const check = checkForUpdate(store, '1.0.0', { now: 100_000_000, fetchImpl: fetcher, signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    finish();
    expect(await check).toBeNull();
    expect(record).toBeUndefined();
    expect(await checkForUpdate(store, '1.0.0', { now: 100_000_001, fetchImpl: fetcher })).toBe('v1.2.0');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('每次完成检查递增版本状态序号，缓存复用不递增', async () => {
    let record: { checkedAt: number; latest?: string; revision?: number } | undefined;
    const store = { get: async () => record, set: async (v: typeof record) => { record = v; } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v1.2.0' })));
    await checkForUpdate(store, '1.0.0', { now: 100_000_000, fetchImpl: fetcher });
    expect(record?.revision).toBe(1);
    await checkForUpdate(store, '1.0.0', { now: 100_001_000, fetchImpl: fetcher });
    expect(record?.revision).toBe(1);
    await checkForUpdate(store, '1.0.0', { now: 200_000_000, fetchImpl: fetcher });
    expect(record?.revision).toBe(2);
  });
});
