// P1.10 · 登录态引导纯逻辑单测：引导卡显隐（未知不显）与气泡决策（F11 未登录激活才弹）。
import { describe, expect, it } from 'vitest';
import { LOGIN_BUBBLE_TEXT, LOGIN_CARD_TEXT, loginBubble, shouldShowLoginCard } from '../src/content/login';

describe('shouldShowLoginCard', () => {
  it('确认未登录 → 显；已登录/未知 → 不显（防瞬时错误轰炸）', () => {
    expect(shouldShowLoginCard(false)).toBe(true);
    expect(shouldShowLoginCard(true)).toBe(false);
    expect(shouldShowLoginCard(null)).toBe(false);
    expect(shouldShowLoginCard(undefined)).toBe(false);
  });
});

describe('loginBubble', () => {
  it('未登录 + 会话激活（F11 未登录激活）→ login', () => {
    expect(loginBubble(false, true, true)).toBe('login');
    expect(loginBubble(false, null, true)).toBe('login');
  });
  it('未登录 + 未激活 → 不弹（常驻开始 CTA 优先）', () => {
    expect(loginBubble(false, true, false)).toBeNull();
    expect(loginBubble(false, null, false)).toBeNull();
  });
  it('未登录→已登录翻转 → welcome（自动恢复的可见反馈）；一直已登录/未知 → 不弹', () => {
    expect(loginBubble(true, false, true)).toBe('welcome');
    expect(loginBubble(true, true, true)).toBeNull();
    expect(loginBubble(true, null, true)).toBeNull();
    expect(loginBubble(null, false, true)).toBeNull();
  });
  it('文案齐备（引导卡含多浏览器说明与登录页 URL）', () => {
    expect(LOGIN_BUBBLE_TEXT.login).toContain('登录');
    expect(LOGIN_BUBBLE_TEXT.welcome).toContain('陪看');
    expect(LOGIN_CARD_TEXT.url).toBe('https://passport.bilibili.com/login');
    expect(LOGIN_CARD_TEXT.title).toContain('本浏览器'); // 架构 §3.9 多浏览器文案口径
    expect(LOGIN_CARD_TEXT.desc).toContain('当前浏览器');
  });
});
