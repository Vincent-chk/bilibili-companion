// P2.1 · 会话保留期判定（02-数据模型 §6 伪代码落地 + 架构 §3.7 状态机）：
// INACTIVE → ACTIVE →(结束陪看) GRACE(1h) → EXPIRED_PENDING_CONFIRM →(2.2 确认) 清除 / 稍后提醒。
// 判定不依赖常驻定时器（MV3 SW 会休眠）：比较持久化时间戳，调用方在
// ①SW 启动 ②面板打开（LIST_QUERY）③content 首连（Port onConnect）三时机执行；
// chrome.alarms(30min) 仅兜底唤醒补一次判定（只更新状态，绝不静默删数据）。
// 本模块不碰 chrome API：KV/DB 由调用方注入（扩展=browserKv+CompanionDB，测试=内存版）。
import type { CompanionDB } from '../storage';
import { getSessionPointer, setSessionPointer, type KVStore, type SessionPointer } from '../storage';

/** 「结束陪看」后的数据保留时长（F10：1 小时）。 */
export const RETENTION_MS = 60 * 60 * 1000;

export type RetentionVerdict =
  | { kind: 'FRESH' } // 无 pointer：全新状态（含被清除后）
  | { kind: 'RESTORE' } // ACTIVE（浏览器重开续会话）或 GRACE ≤1h（恢复+继续倒计时）
  | { kind: 'EXPIRE'; pointer: SessionPointer } // GRACE >1h → 置 EXPIRED_PENDING_CONFIRM（pointer 为写回值）
  | { kind: 'HOLD' }; // 已处于待确认/已关闭：维持现状（面板打开=重提醒，2.2 弹窗消费）

/** 保留截止时刻（倒计时数据源；GRACE 态必有 closedAt）。 */
export const retainUntilOf = (p: SessionPointer): number | undefined =>
  p.closedAt !== undefined ? p.closedAt + RETENTION_MS : undefined;

/**
 * 纯判定（02-数据模型 §6）。边界口径：now-closedAt **≤ 1h 恢复**（与伪代码一致），
 * 即恰满 1 小时仍可恢复、超出 1ms 即待确认——F10「误差 ≤1min」以持久化时间戳为唯一事实源。
 */
export function evaluateRetention(pointer: SessionPointer | undefined, now = Date.now()): RetentionVerdict {
  if (!pointer || pointer.state === 'INACTIVE') return { kind: 'FRESH' };
  if (pointer.state === 'ACTIVE') return { kind: 'RESTORE' };
  if (pointer.state === 'GRACE') {
    if (pointer.closedAt === undefined) return { kind: 'RESTORE' }; // 脏数据兜底：无基准不判超期
    return now - pointer.closedAt <= RETENTION_MS
      ? { kind: 'RESTORE' }
      : {
          kind: 'EXPIRE',
          pointer: { ...pointer, state: 'EXPIRED_PENDING_CONFIRM', lastActiveAt: now },
        };
  }
  return { kind: 'HOLD' }; // EXPIRED_PENDING_CONFIRM / CLOSED
}

export interface RetentionResult {
  verdict: RetentionVerdict;
  /** 判定后的当前 pointer（EXPIRE 时为新值；FRESH 时 undefined）。 */
  pointer?: SessionPointer;
}

/**
 * SW 侧应用：读 pointer → 判定 → 超期则写回 pointer 与 sessions 行（状态可见、幂等）。
 * 只改状态不删数据（删除必须经 2.2 清除确认链路）。广播由调用方按需触发。
 * shortcut: pointer(chrome.storage)与 sessions 行(IndexedDB)跨存储不可事务——row 仅供审计、
 * 全库无读方；EXPIRE 幂等（HOLD 不再写），分叉窗口仅存在于两写之间
 */
export async function applyRetention(db: CompanionDB, kv: KVStore, now = Date.now()): Promise<RetentionResult> {
  const pointer = await getSessionPointer(kv);
  const verdict = evaluateRetention(pointer, now);
  if (verdict.kind === 'EXPIRE') {
    await setSessionPointer(kv, verdict.pointer);
    await db.sessions.update(verdict.pointer.sessionId, {
      state: 'EXPIRED_PENDING_CONFIRM',
      lastActiveAt: now, // 与 pointer.lastActiveAt 同步（审查 P2-4：审计行不与事实源分叉）
    });
    return { verdict, pointer: verdict.pointer };
  }
  return { verdict, pointer };
}

/** SESSION_START 闸门（P2.1）：待确认/已关闭期不得开新会话——旧数据须先经 2.2 确认链路
 *  处置，否则静默换 pointer 会把整段旧陪看数据变成永不可见的死数据（F10）。
 *  返回拦截原因；null=可开（新会话或恢复 ACTIVE/GRACE≤1h）。 */
export function sessionStartBlockedReason(p: SessionPointer | undefined): string | null {
  if (p?.state === 'EXPIRED_PENDING_CONFIRM') return 'EXPIRED_CONFIRM';
  if (p?.state === 'CLOSED') return 'CLOSED';
  return null;
}
