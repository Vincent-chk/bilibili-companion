// P1.6 · 豆包纯逻辑单测：会话态→表情映射、拖拽阈值/位置钳位、视口相对坐标往返、打字机节奏。
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_MS,
  MASCOT_H,
  MASCOT_WRAP_W,
  clampMascotPos,
  defaultMascotPos,
  fromRelative,
  isDragMoved,
  mascotStateForSession,
  toRelative,
  typeDelay,
} from '../src/content/mascot/logic';

describe('会话态 → 表情映射', () => {
  it('GRACE/待确认/已关闭 → sleep（结束陪看睡觉）', () => {
    expect(mascotStateForSession('GRACE')).toBe('sleep');
    expect(mascotStateForSession('EXPIRED_PENDING_CONFIRM')).toBe('sleep');
    expect(mascotStateForSession('CLOSED')).toBe('sleep');
  });
  it('INACTIVE → idle（待机）', () => {
    expect(mascotStateForSession('INACTIVE')).toBe('idle');
  });
  it('ACTIVE → null（维持最近一次事件表情）', () => {
    expect(mascotStateForSession('ACTIVE')).toBeNull();
  });
});

describe('拖拽阈值与点击误触（F3）', () => {
  it('位移 ≤4px 视为点击', () => {
    expect(isDragMoved(3, 3)).toBe(false);
    expect(isDragMoved(0, 0)).toBe(false);
  });
  it('位移 >4px 任一轴即拖拽', () => {
    expect(isDragMoved(5, 0)).toBe(true);
    expect(isDragMoved(0, -5)).toBe(true);
  });
});

describe('位置钳位与默认位', () => {
  it('上边界 170（头顶气泡不出视口）、四周留白', () => {
    const p = clampMascotPos(0, 0, 1440, 900);
    expect(p.y).toBe(170);
    expect(p.x).toBe(4);
    const q = clampMascotPos(2000, 2000, 1440, 900);
    expect(q.x).toBe(1440 - MASCOT_WRAP_W - 8);
    expect(q.y).toBe(900 - MASCOT_H - 10);
  });
  it('正常值原样通过', () => {
    expect(clampMascotPos(800, 600, 1440, 900)).toEqual({ x: 800, y: 600 });
  });
  it('默认位在右下区、y≥170', () => {
    const p = defaultMascotPos(1440, 900);
    expect(p.x).toBeGreaterThan(1440 - 500);
    expect(p.y).toBeGreaterThanOrEqual(170);
  });
});

describe('视口相对坐标（02-数据模型 §2 mascotPos）', () => {
  it('往返：绝对→相对→绝对（同视口）误差 <1px', () => {
    const rel = toRelative(800, 600, 1440, 900);
    expect(rel.x).toBeCloseTo(800 / 1440, 3);
    const back = fromRelative(rel, 1440, 900);
    expect(back.x).toBeCloseTo(800, 0);
    expect(back.y).toBeCloseTo(600, 0);
  });
  it('窗口缩放按比例还原（1440→1920 宽）', () => {
    const rel = toRelative(720, 450, 1440, 900);
    const restored = fromRelative(rel, 1920, 900);
    expect(restored.x).toBeCloseTo(960, 0);
  });
  it('还原后再钳位：超大相对值不越界', () => {
    const p = fromRelative({ x: 0.99, y: 0.99 }, 1000, 700);
    expect(p.x).toBeLessThanOrEqual(1000 - MASCOT_WRAP_W - 8);
    expect(p.y).toBeLessThanOrEqual(700 - MASCOT_H - 10);
  });
});

describe('打字机节奏与气泡驻留', () => {
  it('每字间隔钳位 6–40ms', () => {
    expect(typeDelay('短', 1200)).toBe(40); // 1200/1 超上限
    expect(typeDelay('很长的气泡文本'.repeat(50), 1200)).toBe(6); // 低于下限
    expect(typeDelay('豆包在记笔记', 60)).toBe(10); // 60/6
  });
  it('气泡默认 5s 消失（F3）', () => {
    expect(BUBBLE_MS).toBe(5000);
  });
});
