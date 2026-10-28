export interface UpdateRecord { checkedAt: number; latest?: string; revision?: number }
export interface UpdateStore {
  get(): Promise<UpdateRecord | undefined>;
  set(value: UpdateRecord): Promise<void>;
}
export interface UpdateOptions { now?: number; paused?: boolean; fetchImpl?: typeof fetch; signal?: AbortSignal }

const RELEASES_API = 'https://api.github.com/repos/Vincent-chk/bilibili-companion/releases/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    if (!/^v?\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) return null;
    const numbers = value.replace(/^v/, '').split('.').map(Number);
    return numbers.every(n => Number.isSafeInteger(n) && n <= 65535) ? numbers : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

export async function checkForUpdate(store: UpdateStore, current: string, options: UpdateOptions = {}): Promise<string | null> {
  if (options.paused || options.signal?.aborted) return null;
  const now = options.now ?? Date.now();
  const cached = await store.get();
  if (options.signal?.aborted) return null;
  let latest = cached?.latest;
  if (!cached || now < cached.checkedAt || now - cached.checkedAt >= CHECK_INTERVAL_MS) {
    try {
      const response = await (options.fetchImpl ?? fetch.bind(globalThis))(RELEASES_API, {
        credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = await response.json() as { tag_name?: unknown };
        latest = typeof data.tag_name === 'string' ? data.tag_name : undefined;
      }
    } catch {
      // 离线、404 或限流时保持上次结果，不打扰用户。
    }
    if (options.signal?.aborted) return null;
    await store.set({ checkedAt: now, revision: (cached?.revision ?? 0) + 1, ...(latest ? { latest } : {}) });
  }
  return latest && isNewerVersion(latest, current) ? latest : null;
}
