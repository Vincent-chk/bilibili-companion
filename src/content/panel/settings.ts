// P2.5 · 设置视图（原型 renderSettings 1:1 移植 + 偏好开关扩展）：
// 三组模型区（LLM 必填/ASR 可选/TTS 置灰预留）+ 陪看偏好（阈值滑杆/人设预设/气泡/隐藏豆包/暂停陪看）
// + 数据保留规则 + 危险操作（立即清除全部数据）。Key 打码显示（F9），保存走 SETTINGS_SAVE 部分载荷；
// 探活走 TEST_CONNECTION（Key 哨兵由 SW 解析）。渲染进 Shadow DOM #view-settings，由 PanelController 编排。
import type { Bridge } from '../bridge';
import { esc, toast, type DoubaoUi } from '../ui/root';
import { PERSONA_OPTIONS, maskApiKey } from './settings-logic';
import { validateAsr, validateLlm, type ModelConfigInput } from '../onboarding/onboarding-logic';

/** SETTINGS_GET 应答（SW 打码后的只读快照）。 */
export interface SettingsData {
  ok: boolean;
  llm?: { baseUrl: string; modelId: string; apiKeyMasked: string };
  asr?: { baseUrl: string; modelId: string; apiKeyMasked: string; provider?: 'openai-compatible' | 'doubao-agent-plan' };
  triggerSeconds: number;
  persona: string;
  bubbles: boolean;
  paused: boolean;
  asrMaxMB: number;
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  denied?: string[];
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

const fieldHtml = (dataF: string, label: string, value: string, placeholder: string, type = 'text'): string =>
  `<div class="field" data-f="${dataF}"><label>${label}</label>` +
  `<input type="${type}" data-k="${dataF}" aria-label="${label}" value="${esc(value)}" placeholder="${esc(placeholder)}">` +
  `<div class="field-err">请填写 ${label}</div></div>`;

function modelSection(
  id: string,
  title: string,
  tag: string,
  tagCls: string,
  cfg: { baseUrl: string; modelId: string; apiKey: string },
  desc: string,
  disabled = false,
  provider: 'openai-compatible' | 'doubao-agent-plan' = 'openai-compatible',
): string {
  return (
    `<div class="set-sec${disabled ? ' set-disabled' : ''}" id="${id}">` +
    `<h3>${title}<span class="set-tag ${tagCls}">${tag}</span></h3>` +
    (desc ? `<div class="set-desc">${desc}</div>` : '') +
    (disabled ? '' :
      (id === 'sec-asr' ? `<label class="model-provider">服务类型 <select id="asr-provider"><option value="openai-compatible"${provider === 'openai-compatible' ? ' selected' : ''}>OpenAI 兼容</option><option value="doubao-agent-plan"${provider === 'doubao-agent-plan' ? ' selected' : ''}>豆包 Agent Plan</option></select></label>` : '') +
      fieldHtml('baseUrl', 'Base URL', cfg.baseUrl, 'https://api.example.com/v1') +
      fieldHtml('modelId', 'Model ID', cfg.modelId, 'model-name') +
      fieldHtml('apiKey', 'API Key', cfg.apiKey, 'sk-...', 'password') +
      `<div class="set-row-btns"><button class="btn btn-ghost" data-test="${id}">测试连接</button><button class="btn btn-primary" data-save="${id}">保存</button>${id === 'sec-asr' ? '<button class="btn btn-ghost" id="clear-asr-config">清除配置</button>' : ''}</div><div class="test-status hidden" data-status="${id}"></div>`) +
    `</div>`
  );
}

const switchRow = (id: string, title: string, sub: string, on: boolean): string =>
  `<div class="switch-row"><div class="sw-label"><b>${title}</b>${sub ? `<span id="${id}-desc">${sub}</span>` : ''}</div>` +
  `<label class="switch"><input type="checkbox" id="${id}" aria-label="${title}"${sub ? ` aria-describedby="${id}-desc"` : ''}${on ? ' checked' : ''}><i></i></label></div>`;

export function renderSettingsView(deps: SettingsViewDeps): void {
  const root = deps.ui.root;
  const box = root.getElementById('view-settings');
  if (!box) return;
  const d = deps.data;
  // apiKey 显示打码形态：长度与原密钥一致，保存时 SW 按打码哨兵沿用旧 Key。
  const llmCfg = d.llm ? { baseUrl: d.llm.baseUrl, modelId: d.llm.modelId, apiKey: d.llm.apiKeyMasked } : { baseUrl: '', modelId: '', apiKey: '' };
  const asrCfg = d.asr ? { baseUrl: d.asr.baseUrl, modelId: d.asr.modelId, apiKey: d.asr.apiKeyMasked } : { baseUrl: '', modelId: '', apiKey: '' };
  box.innerHTML =
    `<div class="d-head"><button class="d-back" id="s-back" title="返回">←</button><b>设置</b></div>` +
    modelSection('sec-llm', '🧠 通用 LLM', d.llm ? '已配置' : '必填', d.llm ? 'tag-optional' : 'tag-required', llmCfg, d.llm ? '清空 API Key 并保存可清除配置。' : '') +
    modelSection('sec-asr', '🎙 ASR 语音转写', d.asr ? '已配置' : '可选', 'tag-optional', asrCfg, '配置并授权后，无可用中文字幕的视频会自动下载完整音频并发送至所选语音服务，可能消耗额度或提前剧透。识别中断、费用状态不明或结果冲突时需确认后处理。', false, d.asr?.provider ?? 'openai-compatible') +
    modelSection('sec-tts', '🔊 TTS 语音合成', '暂不可用', 'tag-reserved', { baseUrl: '', modelId: '', apiKey: '' }, '', true) +
    `<div class="set-sec"><h3>⏱ 陪看偏好</h3>` +
    `<div class="slider-row"><label for="set-threshold">累计播放后自动摘要</label><input type="range" id="set-threshold" min="5" max="120" step="5" value="${d.triggerSeconds}"><span class="slider-val" id="th-val">${d.triggerSeconds} 秒</span></div>` +
    `<div class="preference-label">豆包点评人设</div>` +
    `<div class="persona-row">${PERSONA_OPTIONS.map((p) => `<div class="persona-pill${p.id === d.persona ? ' on' : ''}" data-persona="${p.id}">${p.label}</div>`).join('')}</div>` +
    switchRow('sw-bubbles', '气泡通知', '', d.bubbles) +
    switchRow('sw-hide', '隐藏豆包（本次会话）', '继续记录；刷新页面或清除本次数据后恢复显示', deps.mascotHidden) +
    switchRow('sw-pause', '暂停陪看', '停止记录和新任务，已开始的生成会继续', d.paused) +
    `</div>` +
    `<div class="set-sec"><h3>🗂 数据保留规则</h3><div class="rule-box">` +
    `仅记录陪看期间的视频。<br>结束后保留 <b>1 小时</b>，期间恢复可继续查看；超时后由你确认清除。<br>数据保存在本机浏览器。</div></div>` +
    `<div class="set-sec set-danger"><div class="set-desc">清除列表、摘要和转写，模型配置保留。</div>` +
    `<button class="btn btn-danger" id="btn-clear" style="width:100%">清除陪看数据</button></div>`;

  const readSection = (id: string): ModelConfigInput => {
    const sec = box.querySelector(`#${id}`);
    const out: ModelConfigInput = { baseUrl: '', modelId: '', apiKey: '' };
    sec?.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      const key = inp.getAttribute('data-k');
      if (key === 'baseUrl' || key === 'modelId' || key === 'apiKey') out[key] = inp.value.trim();
    });
    if (id === 'sec-asr') out.provider = box.querySelector<HTMLSelectElement>('#asr-provider')?.value === 'doubao-agent-plan' ? 'doubao-agent-plan' : 'openai-compatible';
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

  const revisions: Record<string, number> = { 'sec-llm': 0, 'sec-asr': 0 };
  for (const id of Object.keys(revisions)) {
    box.querySelector(`#${id}`)?.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((input) => {
      input.addEventListener('input', () => {
        revisions[id] = (revisions[id] ?? 0) + 1;
        const status = box.querySelector<HTMLElement>(`[data-status="${id}"]`);
        if (status) { status.className = 'test-status hidden'; status.textContent = ''; }
      });
    });
  }
  const providerSelect = box.querySelector<HTMLSelectElement>('#asr-provider');
  const updateProviderView = (clearKey: boolean) => {
    const section = box.querySelector<HTMLElement>('#sec-asr');
    const isDoubao = providerSelect?.value === 'doubao-agent-plan';
    section?.querySelectorAll<HTMLElement>('[data-f="baseUrl"], [data-f="modelId"]').forEach(el => { el.style.display = isDoubao ? 'none' : ''; });
    if (clearKey) {
      const key = section?.querySelector<HTMLInputElement>('input[data-k="apiKey"]');
      if (key) key.value = '';
      revisions['sec-asr'] = (revisions['sec-asr'] ?? 0) + 1;
      const status = box.querySelector<HTMLElement>('[data-status="sec-asr"]');
      if (status) { status.className = 'test-status hidden'; status.textContent = ''; }
    }
  };
  providerSelect?.addEventListener('change', () => updateProviderView(true));
  if (providerSelect) updateProviderView(false);
  box.querySelector('#clear-asr-config')?.addEventListener('click', () => {
    void deps.bridge.request<SaveResult>({type:'SETTINGS_SAVE',asr:{baseUrl:'',modelId:'',apiKey:''}}).then(r => {
      if (!r?.ok) { toast(deps.ui, r?.error ?? '清除配置失败'); return; }
      deps.data.asr = undefined;
      box.querySelectorAll<HTMLInputElement>('#sec-asr input[data-k]').forEach(input => {input.value = '';});
      if (providerSelect) providerSelect.value = 'openai-compatible';
      updateProviderView(true);
      toast(deps.ui, 'ASR 配置已清除');
      deps.onSaved(r);
    }).catch(() => toast(deps.ui, '清除配置失败，请重试'));
  });

  // ---- 模型区：测试连接 / 保存（LLM 空 Key 保存 = 清除配置，先确认） ----
  for (const sel of ['[data-test]', '[data-save]']) {
    box.querySelectorAll<HTMLButtonElement>(sel).forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute(sel === '[data-test]' ? 'data-test' : 'data-save')!;
        const kind = id === 'sec-asr' ? 'asr' : 'llm';
        const cfg = readSection(id);
        const sameProvider = kind !== 'asr' || (cfg.provider ?? 'openai-compatible') === (deps.data.asr?.provider ?? 'openai-compatible');
        const forValidation = { ...cfg, apiKey: cfg.apiKey || (sameProvider && (cfg.baseUrl || cfg.modelId) ? deps.data[kind]?.apiKeyMasked : '') || '' };
        let validationError: string | undefined;
        if (kind === 'llm') {
          const v = validateLlm(forValidation);
          if (!v.ok) validationError = v.error ?? '请完整填写模型地址、模型名和 Key';
        } else {
          const v = validateAsr(forValidation);
          if (v.kind === 'error' || (btn.hasAttribute('data-test') && v.kind === 'skip')) validationError = v.error ?? '请完整填写模型配置再测试';
        }
        const clearingLlm = !btn.hasAttribute('data-test') && kind === 'llm' && !cfg.apiKey && deps.data.llm;
        if (validationError && !clearingLlm) { setStatus(id, 'err', validationError); return; }
        if (btn.hasAttribute('data-test')) {
          const revision = revisions[id];
          const status = box.querySelector<HTMLElement>(`[data-status="${id}"]`);
          if (status) { status.className = 'test-status hidden'; status.textContent = ''; }
          btn.disabled = true;
          btn.textContent = '连接中…';
          void deps.bridge
            .request<{ ok: boolean; msg: string }>({ type: 'TEST_CONNECTION', kind, llm: cfg })
            .then((r) => { if (revisions[id] === revision) setStatus(id, r?.ok ? 'ok' : 'err', `${r?.ok ? '✓' : '✕'} ${r?.msg ?? '无应答，请重试'}`); })
            .catch(() => { if (revisions[id] === revision) setStatus(id, 'err', '✕ 连接失败（后台无响应），请重试'); })
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
          .then((r) => {
            if (r?.ok) {
              const key = box.querySelector<HTMLInputElement>(`#${id} input[data-k="apiKey"]`);
              if (key?.value) key.value = maskApiKey(key.value);
              if (kind === 'asr' && cfg.provider === 'doubao-agent-plan' && key?.value) {
                deps.data.asr = {provider:'doubao-agent-plan',baseUrl:'https://openspeech.bytedance.com',modelId:'doubao-seed-asr-2.0',apiKeyMasked:key.value};
              }
              toast(deps.ui, r.denied?.length ? '设置已保存，但模型端点未获授权；连接失败时请重新保存并允许访问' : '设置已保存', r.denied?.length ? 6000 : 2600);
              deps.onSaved(r);
            } else toast(deps.ui, r?.error ?? '保存失败，请重试');
          })
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
          toast(deps.ui, paused ? '已暂停：当前任务继续完成，后续任务等待恢复' : '已恢复陪看', 2600);
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
