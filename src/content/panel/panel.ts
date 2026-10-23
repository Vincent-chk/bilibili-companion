// P1.5 · 陪看面板（content script Shadow DOM 内，原型 renderList/renderDetail 移植）：
// 列表（封面/进度/五态徽章）· 详情（摘要流式/大纲/豆包说/转写节选）· 空态。
// 数据：LIST_QUERY（列表快照）/ SUMMARY_OPEN（按需生成或取缓存 + 详情载荷）；
// 推送：SUMMARY_PROGRESS(deltaText 流式打字) / SUMMARY_DONE|FAILED|NEED_ASR|UPDATED（终态刷新）。
// 大纲点击 seek 是任务 1.8（SEEK_TO），本版时间戳仅展示；【重新生成】随 REGENERATE 任务后续接入。
import { browser } from 'wxt/browser';
import type { Bridge, UiEvent } from '../bridge';
import { esc, toast, type DoubaoUi } from '../ui/root';
import {
  BADGE_HTML,
  SOURCE_LABEL,
  STAGE_LABEL,
  excerptOf,
  extractStreamingSummary,
  fmtSec,
  isJobActive,
  relativeTimeLabel,
  sortListItems,
  starsHtml,
  toListItemVM,
  type ListQueryItem,
  type ListItemVM,
  type SummaryOpenResponse,
  type TranscriptExcerpt,
} from './view-models';

export interface ListQueryResponse {
  ok: boolean;
  items: ListQueryItem[];
  sessionState: string;
  triggerSeconds: number;
}

export interface PanelDeps {
  ui: DoubaoUi;
  bridge: Bridge;
  /** 会话操作（P1.6）：开始/恢复 与 结束——流程由 content 侧持有（含 onboarding 门槛）。 */
  onSessionStart: () => void;
  onSessionEnd: () => void;
  /** 测试可注入的定时器。 */
  setTimeout?: typeof setTimeout;
}

export class PanelController {
  #open = false;
  #view: 'list' | 'detail' = 'list';
  #detailKey: string | null = null;
  #items: ListItemVM[] = [];
  #triggerSeconds = 20;
  #sessionState = 'INACTIVE';
  /** 当前详情的流式累计（LLM 原始 JSON token 流）。 */
  #stream: { videoKey: string; acc: string; stage?: string } | null = null;
  #refreshTimer: unknown = null;

  readonly #setTimeout: (cb: () => void, ms?: number) => unknown;

  constructor(private readonly deps: PanelDeps) {
    this.#setTimeout =
      deps.setTimeout ?? ((cb: () => void, ms?: number) => {
        setTimeout(cb, ms);
      });
    deps.ui.root.ownerDocument.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#open && !this.#modalShown()) this.close();
    });
  }

  #modalShown(): boolean {
    return this.deps.ui.root.getElementById('modal-root')?.classList.contains('show') ?? false;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    this.#open ? this.close() : this.open();
  }

  open(): void {
    this.#open = true;
    this.deps.ui.root.getElementById('panel')?.classList.add('open');
    void this.refresh();
  }

  close(): void {
    this.#open = false;
    this.deps.ui.root.getElementById('panel')?.classList.remove('open');
  }

  /** LIST_QUERY → 渲染当前视图。 */
  async refresh(): Promise<void> {
    try {
      const r = await this.deps.bridge.request<ListQueryResponse>({ type: 'LIST_QUERY' });
      if (!r?.ok) return;
      this.#items = sortListItems((r.items ?? []).map(toListItemVM));
      this.#sessionState = r.sessionState ?? 'INACTIVE';
      this.#triggerSeconds = r.triggerSeconds ?? 20;
      this.#renderStatus();
      if (this.#view === 'list') this.#renderList();
    } catch {
      /* SW 未就绪等瞬时错误：面板下次打开/事件到达时再刷 */
    }
  }

  #renderStatus(): void {
    const el = this.deps.ui.root.getElementById('p-status');
    const acts = this.deps.ui.root.getElementById('p-head-actions');
    if (!el) return;
    acts?.classList.toggle('hidden', false);
    if (this.#sessionState === 'ACTIVE') {
      el.innerHTML = '<span class="dot-live"></span> 陪看中 · 仅记录本次激活期间看过的视频';
      this.#renderActions(acts, '<button class="btn btn-ghost" id="btn-end" style="flex:1">⏻ 结束陪看</button>', () =>
        this.deps.onSessionEnd(),
      );
    } else if (this.#sessionState === 'GRACE') {
      el.innerHTML = '<span class="countdown-pill">⏳ 陪看已结束 · 数据保留中</span>';
      this.#renderActions(acts, '<button class="btn btn-primary" id="btn-resume" style="flex:1">▶ 恢复陪看</button>', () =>
        this.deps.onSessionStart(),
      );
    } else {
      el.textContent = '未激活 · 点豆包「开始陪看」';
      this.#renderActions(acts, '<button class="btn btn-primary" id="btn-start2" style="flex:1">▶ 开始陪看</button>', () =>
        this.deps.onSessionStart(),
      );
    }
  }

  #renderActions(acts: HTMLElement | null, html: string, onClick: () => void): void {
    if (!acts) return;
    acts.innerHTML = html;
    acts.firstElementChild?.addEventListener('click', () => onClick());
  }

  // ---- 列表 ----

  #renderList(): void {
    const box = this.deps.ui.root.getElementById('view-list');
    if (!box) return;
    const head = `<div class="list-head"><b>本次陪看 · ${this.#items.length} 个视频</b><span>点击条目查看摘要</span></div>`;
    if (this.#items.length === 0) {
      box.innerHTML = `${head}<div class="d-sec" style="text-align:center;padding:36px 16px;color:#9499a0;font-size:13px"><img class="empty-mascot" src="${browser.runtime.getURL('/mascot/mascot-idle.png')}" alt=""><br>还没有陪看记录<br>点击豆包「开始陪看」，<br>播放超过 ${this.#triggerSeconds} 秒我就会记笔记</div>`;
      return;
    }
    box.innerHTML =
      head +
      this.#items
        .map((it) => {
          const badge = BADGE_HTML[it.badge];
          const spinner = it.badge === 'generating' ? '<span class="spinner"></span>' : '';
          const srcLabel = it.source ? `来源：${SOURCE_LABEL[it.source]}` : '&nbsp;';
          return `<div class="v-item" data-video-key="${esc(it.videoKey)}">
            <div class="v-item-top">
              <div class="v-cover"><img src="${esc(it.cover)}" referrerpolicy="no-referrer" alt=""><span class="dur">${fmtSec(it.durationSec)}</span></div>
              <div class="v-info">
                <div class="v-name">${esc(it.title)}</div>
                <div class="v-sub">${esc(it.owner)} · ${relativeTimeLabel(it.lastSeenAt)}</div>
                <div class="v-prog-row"><div class="v-prog"><i style="width:${it.progressPct}%"></i></div><span class="v-pct">${it.progressPct >= 100 ? '看完' : `${it.progressPct}%`}</span></div>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:9px">
              <span style="font-size:11px;color:#9499a0">${srcLabel}</span>
              <span class="badge badge-${it.badge}">${spinner}${badge}</span>
            </div>
          </div>`;
        })
        .join('');
    this.#bindCoverFallback(box);
    box.querySelectorAll<HTMLElement>('.v-item').forEach((el) => {
      el.addEventListener('click', () => void this.#onItemClick(el.getAttribute('data-video-key')!));
    });
  }

  /** 封面加载失败 → 渐变占位块（不用内联 onerror，规避页面 CSP 限制内联句柄）。 */
  #bindCoverFallback(scope: ParentNode): void {
    scope.querySelectorAll<HTMLImageElement>('.v-cover img').forEach((img) => {
      img.addEventListener('error', () => {
        const fb = this.deps.ui.root.ownerDocument.createElement('div');
        fb.className = 'cover-fallback';
        fb.textContent = '🫘';
        img.replaceWith(fb);
      });
    });
  }

  async #onItemClick(videoKey: string): Promise<void> {
    const item = this.#items.find((i) => i.videoKey === videoKey);
    if (!item) return;
    if (item.badge === 'nosub') {
      // ASR 确认卡是任务 2.3（F6）；先提示文案本身
      toast(this.deps.ui, '该视频文字信息较少，ASR 解析确认流将在后续版本接入');
      return;
    }
    // 已总结 → 直接取缓存；生成中/未生成/失败 → SUMMARY_OPEN（无缓存时按需建 job）→ 流式详情
    await this.#openDetail(videoKey);
  }

  // ---- 详情 ----

  async #openDetail(videoKey: string): Promise<void> {
    try {
      const r = await this.deps.bridge.request<SummaryOpenResponse>({ type: 'SUMMARY_OPEN', videoKey });
      if (!r?.ok || !r.item) {
        toast(this.deps.ui, '打开摘要失败，稍后再试');
        return;
      }
      this.#view = 'detail';
      this.#detailKey = videoKey;
      // 任务在跑 → 进入流式模式（重置累计）；否则直接渲染成品
      this.#stream = isJobActive(r.item.job) && r.item.job?.status !== 'need_confirm' ? { videoKey, acc: '' } : null;
      this.#renderDetail(r.item, r.transcript);
    } catch {
      toast(this.deps.ui, '打开摘要失败，稍后再试');
    }
  }

  #backToList(): void {
    this.#view = 'list';
    this.#detailKey = null;
    this.#stream = null;
    void this.refresh();
  }

  #renderDetail(item: ListQueryItem, transcript?: TranscriptExcerpt): void {
    const root = this.deps.ui.root;
    const box = root.getElementById('view-list');
    if (!box) return;
    const v = item.video;
    const s = item.summary;
    const streaming = this.#stream !== null;
    const title = v?.title ?? item.visit.videoKey;
    const srcBadge = s && s.status === 'done' ? `<span class="src-badge src-${s.source === 'manual_sub' ? 'manual' : s.source === 'asr' ? 'asr' : 'ai'}">${SOURCE_LABEL[s.source]}</span>` : '';
    const pct = Math.max(0, Math.min(100, Math.round(item.visit.progressPct)));
    const pctLabel = pct >= 100 ? '结尾' : `${pct}%`;

    // 摘要区：流式（阶段文案 + 已抽取文本 + 光标）/ 成品 / 失败 / 待确认
    let summaryHtml: string;
    if (streaming) {
      const partial = extractStreamingSummary(this.#stream?.acc ?? '');
      const stage = STAGE_LABEL[this.#stream?.stage ?? ''] ?? '豆包正在记笔记…';
      summaryHtml = partial
        ? `${esc(partial)}<span class="caret"></span>`
        : `<div class="d-summary-empty"><span class="spinner"></span>${stage}</div>`;
    } else if (s?.status === 'done' && s.summary) {
      summaryHtml = esc(s.summary);
    } else if (s?.status === 'need_asr') {
      summaryHtml = '<div class="d-summary-empty">该视频文字信息较少，请确认是否调用 ASR 做进一步解析？</div>';
    } else if (s?.status === 'failed') {
      summaryHtml = `<div class="d-summary-empty" style="color:#dc2626">解析失败：${esc(s.error?.msg ?? '未知错误')}</div>`;
    } else {
      summaryHtml = '<div class="d-summary-empty">还没有摘要</div>';
    }

    const outlineHtml = (s?.outline ?? [])
      .map((o) => `<li><span class="ot">${fmtSec(o.time)}</span><span>${esc(o.text)}</span></li>`)
      .join('');
    const sayHtml =
      s?.status === 'done' && s.evaluation
        ? `<div class="d-sec mascot-card"><h3>🫘 豆包说</h3><div class="mascot-say">
            <div class="mascot-say-avatar"><img src="${browser.runtime.getURL('/mascot/mascot-avatar.png')}" alt="豆包"></div>
            <div class="mascot-say-body"><div class="mascot-stars">${starsHtml(s.rating)}</div><div class="mascot-say-text">${esc(s.evaluation)}</div></div>
          </div></div>`
        : '';
    const trHtml = transcript
      ? `<details class="d-sec d-transcript"><summary>📄 转写节选（共 ${transcript.total} 条${transcript.total > transcript.cues.length ? `，前 ${transcript.cues.length} 条` : ''}）</summary>${transcript.cues
          .map((c) => `<div class="tr-line"><span class="tt">[${fmtSec(c.from)}]</span><span>${esc(c.text)}</span></div>`)
          .join('')}</details>`
      : '';

    box.innerHTML =
      `<div class="d-head"><button class="d-back" id="d-back" title="返回列表">←</button><b>视频摘要</b></div>` +
      `<div class="d-cover"><img src="${esc(v?.cover ?? '')}" referrerpolicy="no-referrer" alt=""><span class="dur">${fmtSec(v?.duration ?? 0)}</span></div>` +
      `<div class="d-title">${esc(title)}</div>` +
      `<div class="d-meta"><span>${esc(v?.owner ?? '')}</span><span>·</span><span>看到 ${pctLabel}</span>${srcBadge}</div>` +
      `<div class="d-sec"><h3>📝 摘要</h3><div class="d-summary" id="d-summary">${summaryHtml}</div></div>` +
      (outlineHtml ? `<div class="d-sec"><h3>🧭 要点大纲</h3><ul class="d-outline">${outlineHtml}</ul></div>` : '') +
      sayHtml +
      trHtml +
      `<div class="d-foot"><button class="btn btn-primary" id="d-copy">⧉ 复制摘要</button></div>`;

    root.getElementById('d-back')?.addEventListener('click', () => this.#backToList());
    root.getElementById('d-copy')?.addEventListener('click', () => {
      const text = s?.summary ?? '';
      if (!text) return;
      void navigator.clipboard
        ?.writeText(text)
        .then(() => toast(this.deps.ui, '摘要已复制到剪贴板'))
        .catch(() => toast(this.deps.ui, '复制失败（页面剪贴板权限）'));
    });
    const cover = box.querySelector<HTMLImageElement>('.d-cover img');
    cover?.addEventListener('error', () => cover.remove());
  }

  // ---- 桥事件 ----

  handleEvent(e: UiEvent): void {
    if (e.type === 'SUMMARY_PROGRESS') {
      // stage 更新与 delta 解耦：stage 变化常在 LLM 流式窗口之外单独成包（审查 P1-1）
      if (this.#stream && e.videoKey === this.#stream.videoKey) {
        if (e.stage) this.#stream.stage = e.stage;
        if (e.deltaText) this.#stream.acc += e.deltaText;
        this.#paintStream();
      }
      return;
    }
    if (e.type === 'SESSION_STATE') {
      // 重连补偿（审查 P2-6）：SW 每次 Port 连接都回放 SESSION_STATE → 顺带全量刷新，
      // 兜住断线退避窗口内丢失的终态广播（徽章滞留「生成中」自愈）
      if (this.#open) void this.refresh();
      return;
    }
    if (e.type === 'SUMMARY_DONE' || e.type === 'SUMMARY_FAILED' || e.type === 'SUMMARY_NEED_ASR' || e.type === 'SUMMARY_UPDATED') {
      if (!this.#open) return;
      // 终态/排队变化：节流刷新（列表整体重查；详情重开载荷）
      if (this.#refreshTimer) return;
      this.#refreshTimer = this.#setTimeout(() => {
        this.#refreshTimer = null;
        if (this.#view === 'detail' && this.#detailKey) void this.#openDetail(this.#detailKey);
        else void this.refresh();
      }, 300);
    }
  }

  /** 流式打字：只重绘摘要区，避免整屏 innerHTML 重建打断阅读/滚动。 */
  #paintStream(): void {
    if (!this.#stream) return;
    const el = this.deps.ui.root.getElementById('d-summary');
    if (!el) return;
    const partial = extractStreamingSummary(this.#stream.acc);
    const stage = STAGE_LABEL[this.#stream.stage ?? ''] ?? '豆包正在记笔记…';
    el.innerHTML = partial
      ? `${esc(partial)}<span class="caret"></span>`
      : `<div class="d-summary-empty"><span class="spinner"></span>${stage}</div>`;
  }
}
