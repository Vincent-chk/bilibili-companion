// P1.6 · 豆包纯逻辑单测：会话态→表情映射、拖拽阈值/位置钳位、视口相对坐标往返、打字机节奏。
// P1.9 · 浮层七准则纯逻辑：贴边吸附、闲时/限频常量、输入聚焦判定、全屏迁移判定。
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_MS,
  BUBBLE_RATE_WINDOW_MS,
  IDLE_DIM_MS,
  MASCOT_H,
  MASCOT_WRAP_W,
  bubbleThrottled,
  clampMascotPos,
  defaultMascotPos,
  fromRelative,
  fullscreenHostParent,
  isDragMoved,
  isTypingTarget,
  mascotStateForSession,
  snapToEdge,
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

describe('P1.9 准则#1 贴边吸附', () => {
  it('中心在视口左半 → 吸左边 4px；右半 → 吸右边钳位界', () => {
    expect(snapToEdge(100, 400, 1440, 900)).toEqual({ x: 4, y: 400 });
    expect(snapToEdge(1000, 400, 1440, 900)).toEqual({ x: 1440 - MASCOT_WRAP_W - 8, y: 400 });
  });
  it('纵坐标经钳位（头顶气泡不出视口）', () => {
    expect(snapToEdge(1000, 10, 1440, 900).y).toBe(170);
  });
  it('闲时半透明窗口 5s（准则#1）', () => {
    expect(IDLE_DIM_MS).toBe(5000);
  });
});

describe('P1.9 准则#4 同类气泡限频', () => {
  it('窗口 10min；从未出现不跳', () => {
    expect(BUBBLE_RATE_WINDOW_MS).toBe(600_000);
    expect(bubbleThrottled(undefined, 1_000_000)).toBe(false);
  });
  it('窗口内重复 → 跳；窗口外 → 不跳', () => {
    expect(bubbleThrottled(1_000_000, 1_599_999)).toBe(true);
    expect(bubbleThrottled(1_000_000, 1_600_000)).toBe(false);
  });
});

describe('P1.9 准则#3 输入聚焦不弹气泡', () => {
  it('INPUT/TEXTAREA/contentEditable 判定为输入态', () => {
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });
  it('普通元素/空焦点不是输入态', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
  it('Shadow DOM 内输入（本扩展 onboarding/设置）逐层下钻命中', () => {
    expect(isTypingTarget({ tagName: 'DIV', shadowRoot: { activeElement: { tagName: 'INPUT' } } })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', shadowRoot: { activeElement: { tagName: 'SPAN' } } })).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV', shadowRoot: null })).toBe(false);
  });
});

describe('P1.9 准则#3 全屏迁移判定', () => {
  const docEl = {} as Element;
  const hostInFs = { parentElement: docEl } as unknown as Element;
  const fsEl = { contains: (n: Element) => n === hostInFs } as unknown as Element;
  it('全屏元素不含宿主 → 迁入全屏元素', () => {
    const other = { parentElement: docEl } as unknown as Element;
    expect(fullscreenHostParent(fsEl, other, docEl)).toBe(fsEl);
  });
  it('全屏元素已含宿主 → 不迁移', () => {
    expect(fullscreenHostParent(fsEl, hostInFs, docEl)).toBeNull();
  });
  it('退出全屏：宿主已在 documentElement 下 → 不迁移；挂在别处 → 迁回', () => {
    const inDoc = { parentElement: docEl } as unknown as Element;
    expect(fullscreenHostParent(null, inDoc, docEl)).toBeNull();
    const inPlayer = { parentElement: {} as Element } as unknown as Element;
    expect(fullscreenHostParent(null, inPlayer, docEl)).toBe(docEl);
  });
  it('宿主无父节点（未挂载）→ 不迁移（审查 P2-7 补分支）', () => {
    const orphan = { parentElement: null } as unknown as Element;
    expect(fullscreenHostParent(null, orphan, docEl)).toBeNull();
  });
  it('原生 <video> 全屏 → 改挂其父（fallback content 不渲染，审查 P2-2）', () => {
    const parent = { contains: () => false } as unknown as Element;
    const video = { tagName: 'VIDEO', parentElement: parent, contains: () => false } as unknown as Element;
    const other = { parentElement: docEl } as unknown as Element;
    expect(fullscreenHostParent(video, other, docEl)).toBe(parent);
    const videoNoParent = { tagName: 'VIDEO', parentElement: null, contains: () => false } as unknown as Element;
    expect(fullscreenHostParent(videoNoParent, other, docEl)).toBeNull();
  });
});
