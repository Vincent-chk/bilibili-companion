// P2.4 · DNR 音频防盗链规则（架构 §3.8 / 07 报告 G-2）：
// bilivideo CDN 是否校验 Referer 取决于调度命中的节点类型（不可预测）——对扩展自身发起的
// 音频请求无条件补 Referer: https://www.bilibili.com/（.com+.cn 双域）。
// 纯函数抽出（任务 2.4）：规则形状可单测；SW 侧 ensureDnrRules 只管幂等落位。
// 仍用动态规则而非静态 JSON：initiator 域=chrome.runtime.id 只有运行时可知（静态写不了），
// 且无 initiator 限定的静态规则会波及页面自身请求（01-架构 §3.8 P2.3 修订论证）。
// aisubtitle 字幕 CDN 不补：auth_key 自鉴权（07 报告三次复证匿名可下），规则只覆盖音频。
export interface DnrRule {
  id: number;
  priority: number;
  condition: {
    urlFilter: string;
    resourceTypes: string[];
    initiatorDomains: string[];
  };
  action: {
    type: 'modifyHeaders';
    requestHeaders: { header: string; operation: string; value: string }[];
  };
}

export const REFERER_VALUE = 'https://www.bilibili.com/';
/** 幂等重建的固定规则 id（updateDynamicRules removeRuleIds 与 addRules 同源）。 */
export const DNR_RULE_IDS = [1, 2] as const;

export function buildRefererRules(runtimeId: string): DnrRule[] {
  return ['bilivideo.com', 'bilivideo.cn'].map((domain, i) => ({
    id: DNR_RULE_IDS[i]!, // 单一来源（审查 N-1）：规则 id 只在 DNR_RULE_IDS 定义
    priority: 1,
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ['xmlhttprequest'],
      initiatorDomains: [runtimeId],
    },
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Referer', operation: 'set', value: REFERER_VALUE }],
    },
  }));
}
