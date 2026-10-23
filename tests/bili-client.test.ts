// client.ts 网络部分：注入 fake fetchImpl，不打真实网络。
// 文件名超出任务白名单（白名单只列了三个纯函数测试文件），但"client 至少 3 用例"是硬性要求——已向 lead 报备。
import { describe, expect, it } from 'vitest';
import { BiliApiError, BiliClient, type FetchLike } from '@/lib/bilibili/client';

const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';
const DOC_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Call {
  url: string;
  init?: RequestInit;
}

function makeClient(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  onCookie?: (cookies: Record<string, string>) => void,
): { client: BiliClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  const client = new BiliClient({ fetchImpl, intervalMs: 0, breakerWaitMs: 0, onCookie });
  return { client, calls };
}

describe('BiliClient（fake fetch）', () => {
  it('nav → 派生 WBI mixin key（文档示例 key 对）', async () => {
    const { client, calls } = makeClient((url) => {
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: {
              img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
              sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
            },
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    await expect(client.fetchWbiKeys()).resolves.toBe(DOC_MIXIN_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.bilibili.com/x/web-interface/nav');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(headers['Referer']).toBe('https://www.bilibili.com/');
  });

  it('JSON code != 0 抛 BiliApiError（-101 具名可读），且不重试', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ code: -101, message: '账号未登录' }),
    );
    const err = await client.getView('BV1xrnz6gEVD').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BiliApiError);
    expect((err as BiliApiError).code).toBe(-101);
    expect((err as BiliApiError).message).toContain('未登录');
    expect(calls).toHaveLength(1); // 非 -412 的业务码不重试
  });

  it('has_url=false 时触发 finger/spi 兜底：注入 buvid3/4 后重试且仅重试一次', async () => {
    let playerCalls = 0;
    const cookies: Record<string, string>[] = [];
    const { client, calls } = makeClient((url) => {
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: 0,
          data: {
            wbi_img: {
              img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
              sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
            },
          },
        });
      }
      if (url.includes('/x/frontend/finger/spi')) {
        return jsonResponse({ code: 0, data: { b_3: 'BUVID3_VAL', b_4: 'BUVID4_VAL' } });
      }
      if (url.includes('/x/player/wbi/v2')) {
        playerCalls += 1;
        const subtitleUrl =
          playerCalls === 1 ? '' : '//aisubtitle.hdslb.com/bfs/x?auth_key=abc-0-0123';
        return jsonResponse({
          code: 0,
          data: {
            subtitle: {
              subtitles: [{ lan: 'ai-zh', ai_status: 2, subtitle_url: subtitleUrl }],
              need_login_subtitle: null,
            },
          },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    }, (c) => cookies.push(c));

    await client.fetchWbiKeys();
    const { subtitles, needLoginSubtitle } = await client.getPlayerSubtitles('BV1XynB6EEiM', 123);
    expect(playerCalls).toBe(2); // 仅重试一次
    expect(calls).toHaveLength(4); // nav + player + finger/spi + player
    expect(calls[2]!.url).toContain('/x/frontend/finger/spi');
    expect(cookies).toEqual([{ buvid3: 'BUVID3_VAL', buvid4: 'BUVID4_VAL' }]);
    const retryHeaders = calls[3]!.init!.headers as Record<string, string>;
    expect(retryHeaders['Cookie']).toContain('buvid3=BUVID3_VAL');
    expect(retryHeaders['Cookie']).toContain('buvid4=BUVID4_VAL');
    expect(subtitles[0]!.subtitle_url).toBeTruthy();
    expect(needLoginSubtitle).toBeNull();
    // player 请求必须带 WBI 签名参数
    expect(calls[1]!.url).toContain('w_rid=');
    expect(calls[1]!.url).toContain('wts=');
  });

  it('code -412 熔断后重试 1 次成功', async () => {
    let n = 0;
    const { client, calls } = makeClient(() => {
      n += 1;
      if (n === 1) return jsonResponse({ code: -412, message: '请求被拦截' });
      return jsonResponse({ code: 0, data: { aid: 1, title: 't', duration: 10, pages: [{ cid: 9, page: 1, part: 'p1' }] } });
    });
    const view = await client.getView('BV1wW4y1F7bk');
    expect(calls).toHaveLength(2);
    expect(view.cid).toBe(9);
    expect(view.pages).toEqual([{ cid: 9, page: 1, part: 'p1' }]);
  });

  it('fetchTranscript 匿名直下：补 https 前缀、无 Referer、解析 body', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ body: [{ from: 41.16, to: 42.9, content: '大家好' }] }),
    );
    const cues = await client.fetchTranscript('//aisubtitle.hdslb.com/bfs/x?auth_key=abc-0-0123');
    expect(cues).toEqual([{ from: 41.16, to: 42.9, content: '大家好' }]);
    expect(calls[0]!.url.startsWith('https://aisubtitle.hdslb.com/')).toBe(true);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Referer']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
    expect(calls[0]!.init!.credentials).toBe('omit');
  });
});
