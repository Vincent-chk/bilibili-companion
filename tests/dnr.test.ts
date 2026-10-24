// P2.4 · DNR 规则形状单测（lib/dnr 纯函数）：
// 双域覆盖 / initiator 限定扩展自身 / modifyHeaders 形状（DNR 三连坑的回归锚：
// resourceTypes 枚举 xmlhttprequest、modifyHeaders 属性 requestHeaders）。
import { describe, expect, it } from 'vitest';
import { buildRefererRules, DNR_RULE_IDS, REFERER_VALUE } from '../src/lib/dnr';

describe('buildRefererRules（P2.4 DNR 音频防盗链）', () => {
  const rules = buildRefererRules('fake-extension-id');

  it('双域各一条：bilivideo.com / bilivideo.cn（MCDN 节点为 .cn，PoC F-2）', () => {
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.condition.urlFilter).sort()).toEqual(['||bilivideo.cn^', '||bilivideo.com^']);
  });

  it('initiator 限定为扩展自身 id——静态规则写不了运行时 id 且无限定会波及页面请求', () => {
    for (const r of rules) {
      expect(r.condition.initiatorDomains).toEqual(['fake-extension-id']);
    }
    expect(buildRefererRules('another-id')[0]!.condition.initiatorDomains).toEqual(['another-id']);
  });

  it('modifyHeaders 形状：requestHeaders（非 setRequestHeaders）+ Referer set（DNR 三连坑回归）', () => {
    for (const r of rules) {
      expect(r.action.type).toBe('modifyHeaders');
      expect(r.action.requestHeaders).toEqual([{ header: 'Referer', operation: 'set', value: REFERER_VALUE }]);
    }
  });

  it('resourceTypes 枚举值 xmlhttprequest（E2E 实测坑：非 xmlhttp_request）', () => {
    for (const r of rules) expect(r.condition.resourceTypes).toEqual(['xmlhttprequest']);
  });

  it('规则 id 稳定（幂等重建 removeRuleIds 与 addRules 同源，不产生规则堆积）', () => {
    expect(rules.map((r) => r.id)).toEqual([...DNR_RULE_IDS]);
    expect(rules.every((r) => r.priority === 1)).toBe(true);
  });
});
