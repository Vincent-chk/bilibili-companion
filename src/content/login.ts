// P1.10 · 登录态引导纯逻辑（无 DOM/browser 依赖，单测覆盖）：
// 引导卡显隐（null=未知不显，防瞬时错误轰炸）与气泡决策（F11「未登录激活」才弹登录气泡；
// 登录后自动恢复给一次欢迎气泡）。架构 §3.9：同会话仅提示一次由 kind 限频兜底（mascot 'login'）。

/** 面板顶部引导卡：仅「确认未登录」时显；未知（网络/-412）不显。 */
export function shouldShowLoginCard(loggedIn: boolean | null | undefined): boolean {
  return loggedIn === false;
}

export type LoginBubble = 'login' | 'welcome' | null;

/**
 * 气泡决策：
 * - 未登录且会话激活中（F11「未登录激活」）→ 'login'（未激活不弹——常驻开始 CTA 优先）；
 * - 由未登录翻转为已登录 → 'welcome'（登录后自动恢复的可见反馈，架构 §3.9）；
 * - 其余（一直已登录/未知态）→ 不弹。
 */
export function loginBubble(
  loggedIn: boolean | null | undefined,
  prevLoggedIn: boolean | null | undefined,
  sessionActive: boolean,
): LoginBubble {
  if (loggedIn === false) return sessionActive ? 'login' : null;
  if (loggedIn === true && prevLoggedIn === false) return 'welcome';
  return null;
}

export const LOGIN_BUBBLE_TEXT: Record<Exclude<LoginBubble, null>, string> = {
  login: '先登录 B 站我才能记笔记哦',
  welcome: '登录好啦，继续陪看～',
};

/** 引导卡文案（多浏览器现实，架构 §3.9：扩展只认当前浏览器登录态）。 */
export const LOGIN_CARD_TEXT = {
  title: '请在本浏览器登录 B 站',
  desc: '豆包只认当前浏览器的登录态：登录态可能在 Safari/Edge 等其他浏览器，本页浏览器未登录时字幕与摘要不可用。登录后无需其他操作，自动恢复。',
  button: '去登录',
  url: 'https://passport.bilibili.com/login',
};
