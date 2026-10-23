// P1.1 · KVStore 的扩展实现：chrome.storage.local（WXT 的 browser 全局）。
// 仅在扩展运行时导入（background/offscreen/content）；Node 单测注入内存版，不触碰本文件。
import { browser } from 'wxt/browser';
import type { KVStore } from './index';

export const browserKv: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const o = (await browser.storage.local.get(key)) as Record<string, unknown>;
    return o[key] as T | undefined;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(keys: string | string[]): Promise<void> {
    await browser.storage.local.remove(keys);
  },
};
