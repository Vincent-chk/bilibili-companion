// P2.5 · 设置视图（原型 renderSettings 1:1 移植 + 偏好开关扩展）：
// 三组模型区（LLM 必填/ASR 可选/TTS 置灰预留）+ 陪看偏好（阈值滑杆/人设预设/气泡/隐藏豆包/暂停陪看）
// + 数据保留规则 + 危险操作（立即清除全部数据）。Key 打码显示（F9），保存走 SETTINGS_SAVE 部分载荷；
// 探活走 TEST_CONNECTION（Key 哨兵由 SW 解析）。渲染进 Shadow DOM #view-settings，由 PanelController 编排。
import { browser } from 'wxt/browser';
import type { Bridge } from '../bridge';
import { esc, toast, type DoubaoUi } from '../ui/root';
import { PERSONA_OPTIONS } from './settings-logic';
import type { ModelConfigInput } from '../onboarding/onboarding-logic';

/** SETTINGS_GET 应答（SW 打码后的只读快照）。 */
export interface SettingsData {
  ok: boolean;
  llm?: { baseUrl: string; modelId: string; apiKeyMasked: string };
  asr?: { baseUrl: string; modelId: string; apiKeyMasked: string };
  triggerSeconds: number;
  persona: string;
  bubbles: boolean;
  paused: boolean;
  asrMaxMB: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  llmCleared?: boolean;
  personaChanged?: boolean;
}

export interface SettingsViewDeps {
  ui: DoubaoUi;
  bridge: Bridge;
  data: SettingsData;
  /** 隐藏豆包（本次会话）当前态（content 内存，不落盘）。 */
  mascotHidden: boolean;
  /** 返回列表。 */
  onBack: () => void;
  /** 保存成功后的回调（刷新数据/人设切换联动询问 2.7b 等）。 */
  onSaved: (r: SaveResult) => void;
  /** 危险操作【立即清除全部数据】（PanelController 复用 P2.2 确认弹窗）。 */
  onWipe: () => void;
  /** 隐藏豆包开关翻转（content 侧持有内存态）。 */
  onMascotHiddenChange: (hidden: boolean) => void;
}

const fieldHtml = (dataF: string, label: string, value: string, placeholder: string, type = 'text', disabled = false): string =>
  `<div class="field" data-f="${dataF}"><label>${label}</label>` +
  `<input type="${type}" data-k="${dataF}" value="${esc(value)}" placeholder="${esc(placeholder)}"${disabled ? ' disabled' : ''}>` +
  `<div class="field-err">请填写 ${label}</div></div>`;

function modelSection(
  id: string,
  title: string,
  tag: string,
  tagCls: string,
  cfg: { baseUrl: string; modelId: string; apiKey: string },
  desc: string,
  disabled = false,
): string {
  return (
    `<div class="set-sec${disabled ? ' set-disabled' : ''}" id="${id}">` +
    `<h3>${title}<span class="set-tag ${tagCls}">${tag}</span></h3>` +
    `<div class="set-desc">${desc}</div>` +
    fieldHtml('baseUrl', 'Base URL', cfg.baseUrl, 'https://api.example.com/v1', 'text', disabled) +
    fieldHtml('modelId', 'Model ID', cfg.modelId, 'model-name', 'text', disabled) +
    fieldHtml('apiKey', 'API Key', cfg.apiKey, 'sk-...（仅保存在本机）', 'password', disabled) +
    (disabled ? '' : `<div class="set-row-btns"><button class="btn btn-ghost" data-test="${id}">测试连接</button><button class="btn btn-primary" data-save="${id}">保存</button></div><div class="test-status hidden" data-status="${id}"></div>`) +
    `</div>`
  );
}

const switchRow = (id: string, title: string, sub: string, on: boolean): string =>
  `<div class="switch-row"><div class="sw-label"><b>${title}</b><span>${sub}</span></div>` +
  `<label class="switch"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><i></i></label></div>`;

export function renderSettingsView(deps: SettingsViewDeps): void {
  const root = deps.ui.root;
  const box = root.getElementById('view-settings');
  if (!box) return;
  const d = deps.data;
  // apiKey 显示打码形态（F9）：input 值=****尾4，保存时 SW 按打码哨兵沿用旧 Key
  const llmCfg = d.llm ? { baseUrl: d.llm.baseUrl, modelId: d.llm.modelId, apiKey: d.llm.apiKeyMasked } : { baseUrl: '', modelId: '', apiKey: '' };
  const asrCfg = d.asr ? { baseUrl: d.asr.baseUrl, modelId: d.asr.modelId, apiKey: d.asr.apiKeyMasked } : { baseUrl: '', modelId: '', apiKey: '' };
  box.innerHTML =
    `<div class="d-head"><button class="d-back" id="s-back" title="返回">←</button><b>设置</b></div>` +
    modelSection('sec-llm', '🧠 通用 LLM', d.llm ? '已配置' : '必填', d.llm ? 'tag-optional' : 'tag-required', llmCfg, '用于生成摘要与豆包点评。首次使用必须配置，否则无法激活陪看。清空 API Key 保存 = 清除配置（需确认）。') +
    modelSection('sec-asr', '🎙 ASR 语音转写', d.asr ? '已配置' : '可选', 'tag-optional', asrCfg, '用于「无字幕」视频的语音转写。不配置也可以正常使用有字幕视频的摘要功能。清空三项保存 = 清除配置。') +
    modelSection('sec-tts', '🔊 TTS 语音合成', '预留位', 'tag-reserved', { baseUrl: '', modelId: '', apiKey: '' }, '当前版本暂不启用，敬请期待豆包开口说话～', true) +
    `<div class="set-sec"><h3>⏱ 陪看偏好</h3><div class="set-desc">播放超过阈值后，豆包自动开始记笔记并生成摘要。</div>` +
    `<div class="slider-row"><span style="font-size:12px;color:#61666d">自动摘要阈值</span><input type="range" id="set-threshold" min="5" max="120" step="5" value="${d.triggerSeconds}"><span class="slider-val" id="th-val">${d.triggerSeconds} 秒</span></div>` +
    `<div class="set-desc" style="margin-top:12px">豆包点评人设（切换后可重新生成当前视频的点评）</div>` +
    `<div class="persona-row">${PERSONA_OPTIONS.map((p) => `<div class="persona-pill${p.id === d.persona ? ' on' : ''}" data-persona="${p.id}">${p.label}</div>`).join('')}</div>` +
    switchRow('sw-bubbles', '气泡通知', '关闭后豆包不再弹气泡（表情仍在）', d.bubbles) +
    switchRow('sw-hide', '隐藏豆包（本次会话）', '隐藏≠结束陪看：记录照常；刷新页面或本次陪看数据清除后回归', deps.mascotHidden) +
    switchRow('sw-pause', '暂停陪看', '开启后不再有任何采集与请求（列表不新增、不生成）', d.paused) +
    `</div>` +
    `<div class="set-sec"><h3>🗂 数据保留规则</h3><div class="rule-box">` +
    `· 点「开始陪看」= 激活，仅记录<b>激活期间</b>看过的视频<br>· 点「结束陪看」= 关闭，并开始 <b>1 小时</b>倒计时<br>· 1 小时内重新打开 → <b>恢复上次浏览状态</b><br>· 超过 1 小时 → 弹窗确认后<b>全部清除</b>（含摘要 / 转写）<br>· 所有数据仅保存在本机浏览器中</div></div>` +
    `<div class="set-sec set-danger"><h3>⚠️ 危险操作</h3><div class="set-desc">清除本地保存的全部陪看数据（列表、摘要、转写、配置保留）。</div>` +
    `<button class="btn btn-danger" id="btn-clear" style="width:100%">立即清除全部数据</button></div>`;

  const readSection = (id: string): ModelConfigInput => {
    const sec = box.querySelector(`#${id}`);
    const out: ModelConfigInput = { baseUrl: '', modelId: '', apiKey: '' };
    sec?.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      out[inp.getAttribute('data-k') as keyof ModelConfigInput] = inp.value.trim();
    });
    return out;
  };
  const setStatus = (id: string, cls: 'ok' | 'err', text: string): void => {
    const el = box.querySelector(`[data-status="${id}"]`);
    if (el) {
      el.className = `test-status ${cls}`;
      el.textContent = text;
    }
  };

  box.querySelector('#s-back')?.addEventListener('click', () => deps.onBack());
  box.querySelector('#btn-clear')?.addEventListener('click', () => deps.onWipe());

  // ---- 模型区：测试连接 / 保存（LLM 空 Key 保存 = 清除配置，先确认） ----
  for (const sel of ['[data-test]', '[data-save]']) {
    box.querySelectorAll<HTMLButtonElement>(sel).forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute(sel === '[data-test]' ? 'data-test' : 'data-save')!;
        const kind = id === 'sec-asr' ? 'asr' : 'llm';
        const cfg = readSection(id);
        if (btn.hasAttribute('data-test')) {
          btn.disabled = true;
          btn.textContent = '连接中…';
          void deps.bridge
            .request<{ ok: boolean; msg: string }>({ type: 'TEST_CONNECTION', kind, llm: cfg })
            .then((r) => setStatus(id, r?.ok ? 'ok' : 'err', `${r?.ok ? '✓' : '✕'} ${r?.msg ?? '无应答，请重试'}`))
            .catch(() => setStatus(id, 'err', '✕ 连接失败（后台无响应），请重试'))
            .finally(() => {
              btn.disabled = false;
              btn.textContent = '测试连接';
            });
          return;
        }
        // 保存
        if (kind === 'llm' && !cfg.apiKey && deps.data.llm) {
          showLlmClearConfirm(deps.ui, () => {
            void deps.bridge
              .request<SaveResult>({ type: 'SETTINGS_SAVE', llmClear: true })
              .then((r) => (r?.ok ? deps.onSaved(r) : toast(deps.ui, r?.error ?? '保存失败，请重试')))
              .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
          });
          return;
        }
        void deps.bridge
          .request<SaveResult>({ type: 'SETTINGS_SAVE', [kind]: cfg })
          .then((r) => (r?.ok ? deps.onSaved(r) : toast(deps.ui, r?.error ?? '保存失败，请重试')))
          .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
      });
    });
  }

  // ---- 偏好：滑杆（change 落库，input 只动标签）/ 人设 / 开关 ----
  const slider = box.querySelector<HTMLInputElement>('#set-threshold');
  slider?.addEventListener('input', () => {
    const val = box.querySelector('#th-val');
    if (val) val.textContent = `${slider.value} 秒`;
  });
  slider?.addEventListener('change', () => {
    void deps.bridge
      .request<SaveResult>({ type: 'SETTINGS_SAVE', triggerSeconds: Number(slider.value) })
      .then((r) => {
        if (r?.ok) deps.onSaved(r);
        else toast(deps.ui, r?.error ?? '保存失败，请重试');
      })
      .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
  });
  box.querySelectorAll<HTMLElement>('.persona-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const prev = box.querySelector('.persona-pill.on');
      box.querySelectorAll('.persona-pill').forEach((p) => p.classList.toggle('on', p === pill));
      void deps.bridge
        .request<SaveResult>({ type: 'SETTINGS_SAVE', persona: pill.getAttribute('data-persona') ?? 'spicy' })
        .then((r) => {
          if (r?.ok) deps.onSaved(r);
          else {
            // 审查 P2-5：保存失败回滚选中态（UI 与存储不背离）
            if (prev) box.querySelectorAll('.persona-pill').forEach((p) => p.classList.toggle('on', p === prev));
            toast(deps.ui, r?.error ?? '保存失败，请重试');
          }
        })
        .catch(() => {
          if (prev) box.querySelectorAll('.persona-pill').forEach((p) => p.classList.toggle('on', p === prev));
          toast(deps.ui, '保存失败（后台无响应），请重试');
        });
    });
  });
  box.querySelector<HTMLInputElement>('#sw-bubbles')?.addEventListener('change', (e) => {
    void deps.bridge
      .request<SaveResult>({ type: 'SETTINGS_SAVE', bubbles: (e.target as HTMLInputElement).checked })
      .then((r) => {
        if (r?.ok) deps.onSaved(r);
        else toast(deps.ui, r?.error ?? '保存失败，请重试');
      })
      .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
  });
  box.querySelector<HTMLInputElement>('#sw-pause')?.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    const paused = el.checked;
    void deps.bridge
      .request<SaveResult>({ type: 'SETTINGS_SAVE', paused })
      .then((r) => {
        if (r?.ok) {
          toast(deps.ui, paused ? '已暂停陪看：不再采集与请求' : '已恢复陪看', 2600);
          deps.onSaved(r);
        } else {
          el.checked = !paused; // 审查 P2-5：暂停开关保存失败回滚（F12 语义不得虚标）
          toast(deps.ui, r?.error ?? '保存失败，请重试');
        }
      })
      .catch(() => {
        el.checked = !paused;
        toast(deps.ui, '保存失败（后台无响应），请重试');
      });
  });
  box.querySelector<HTMLInputElement>('#sw-hide')?.addEventListener('change', (e) => {
    deps.onMascotHiddenChange((e.target as HTMLInputElement).checked);
  });
}

/** F9「清空 LLM Key 保存」二次确认（清配置=回未激活门槛 + 会话收口，防误触）。 */
function showLlmClearConfirm(ui: DoubaoUi, onConfirm: () => void): void {
  const modalRoot = ui.root.getElementById('modal-root');
  if (!modalRoot) return;
  modalRoot.dataset.owner = 'llm-clear';
  const m = ui.root.ownerDocument.createElement('div');
  m.className = 'modal';
  m.innerHTML =
    `<div class="modal-head"><div class="m-emoji">🧹</div><div><h2>清除 LLM 配置？</h2>` +
    `<p>将删除已保存的 LLM 配置（API Key），陪看会话按保留规则收口，重新配置后可继续。ASR 配置与陪看数据保留。</p></div></div>` +
    `<div class="modal-foot"><button class="btn btn-ghost" id="llm-clear-no">取消</button>` +
    `<button class="btn btn-danger" id="llm-clear-yes">确认清除</button></div>`;
  modalRoot.replaceChildren(m);
  modalRoot.classList.add('show');
  const close = () => {
    modalRoot.classList.remove('show');
    modalRoot.replaceChildren();
    delete modalRoot.dataset.owner;
  };
  m.querySelector('#llm-clear-no')?.addEventListener('click', close);
  m.querySelector('#llm-clear-yes')?.addEventListener('click', () => {
    close();
    onConfirm();
  });
}
