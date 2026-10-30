// P1.7 · onboarding 配置门槛弹窗（原型 openOnboarding 1:1 移植进 Shadow DOM #modal-root）：
// LLM 必填三件套（逐项标红）+【测试连接】+ ASR 可选三元组 + TTS 置灰预留位；
// 【保存并激活】→ content 侧 SETTINGS_SAVE（background 落 settings + optional_host_permissions）→ SESSION_START。
// 不可点背景关闭（F1：关闭弹窗=保持未激活，只有「稍后再说」一个出口）。
import { esc, toast, type DoubaoUi } from '../ui/root';
import {
  buildSavePayload,
  validateAsr,
  validateLlm,
  type ModelConfigInput,
  type SettingsSavePayload,
} from './onboarding-logic';

export interface OnboardingDeps {
  ui: DoubaoUi;
  assetUrl: (p: string) => string;
  /** 最小请求探活（background TEST_CONNECTION；kind=asr 走 /models 探活，P2.3）。 */
  testConnection: (cfg: ModelConfigInput, kind: 'llm' | 'asr') => Promise<{ ok: boolean; msg: string }>;
  /** 保存（background SETTINGS_SAVE：写 settings/onboarded + 申请端点 origin 权限）。 */
  save: (payload: SettingsSavePayload) => Promise<{ ok: boolean; error?: string; denied?: string[] }>;
  /** 「稍后再说」：回未激活态（开始陪看气泡 + 提示）。 */
  onDismiss: () => void;
  /** 保存成功：触发 SESSION_START（配置已就绪，激活必成）。 */
  onSaved: () => void;
  /** P2.3 ASR 补配模式：LLM 已配置沿用（Key 不下发面板），仅展示/保存 ASR 区。 */
  asrOnly?: boolean;
}

const field = (dataF: string, label: string, placeholder: string, type = 'text'): string =>
  `<div class="field" data-f="${dataF}"><label>${label}</label>` +
  `<input type="${type}" data-k="${dataF}" aria-label="${label}" placeholder="${esc(placeholder)}">` +
  `<div class="field-err">请填写 ${label}</div></div>`;

export function openOnboarding(deps: OnboardingDeps): void {
  const root = deps.ui.root;
  const modalRoot = root.getElementById('modal-root');
  // 属主标记：onboarding 已开则不重开；其他弹窗占用时本版直接替换（2.x 弹窗增多后按 owner 协调）
  if (!modalRoot || (modalRoot.classList.contains('show') && modalRoot.dataset.owner === 'onboarding')) return;
  modalRoot.dataset.owner = 'onboarding';

  const asrOnly = deps.asrOnly === true;
  const m = root.ownerDocument.createElement('div');
  m.className = 'modal modal-onboarding';
  m.innerHTML =
    `<div class="modal-head">` +
    `<div class="m-emoji"><img src="${deps.assetUrl('/mascot/mascot-happy.png')}" alt="豆包" style="width:52px;height:52px;border-radius:12px;display:block"></div>` +
    `<div><h2>${asrOnly ? '配置 ASR 语音转写' : '欢迎使用豆包！'}</h2><p>${asrOnly ? '通用 LLM 配置会保留。' : '开始陪看前请配置大模型。数据保存在本机，摘要请求直连你选择的服务。'}</p></div>` +
    `</div>` +
    `<div class="modal-body"><div>` +
    (asrOnly
      ? ''
      : `<div class="m-step" id="ob-llm"><h4>通用 LLM <span class="set-tag tag-required">必填</span></h4>` +
        `<div class="set-desc">兼容 OpenAI 协议的服务均可，例如 DeepSeek / 火山方舟。</div>` +
        field('baseUrl', 'Base URL', 'https://api.deepseek.com/v1') +
        field('modelId', 'Model ID', 'deepseek-chat') +
        field('apiKey', 'API Key', 'sk-...（仅保存在本机）', 'password') +
        `<div class="set-row-btns"><button class="btn btn-ghost" id="ob-test">测试连接</button></div>` +
        `<div class="test-status hidden" id="ob-test-status"></div>` +
        `</div>`) +
    `<div class="m-step" id="ob-asr"><h4>ASR 语音转写 <span class="set-tag ${asrOnly ? 'tag-required' : 'tag-optional'}">${asrOnly ? '必填' : '可选'}</span></h4>` +
    `<div class="set-desc">配置并授权后，无可用中文字幕的视频会自动下载完整音频并发送至所选语音服务，可能消耗额度或提前剧透。识别中断、费用状态不明或结果冲突时需确认后处理。</div>` +
    `<label class="model-provider">服务类型 <select id="ob-asr-provider"><option value="openai-compatible">OpenAI 兼容</option><option value="doubao-agent-plan">豆包 Agent Plan</option></select></label>` +
    field('baseUrl', 'Base URL', 'https://api.siliconflow.cn/v1') +
    field('modelId', 'Model ID', 'FunAudioLLM/SenseVoiceSmall') +
    field('apiKey', 'API Key', 'sk-...', 'password') +
    (asrOnly ? `<div class="set-row-btns"><button class="btn btn-ghost" id="ob-test-asr">测试连接</button></div><div class="test-status hidden" id="ob-test-status"></div>` : '') +
    `<div class="field-err" id="ob-asr-err" style="display:none;color:#ef4444;font-size:11px"></div>` +
    `</div>` +
    (asrOnly ? '' : `<div class="m-step step-disabled"><h4>TTS 语音合成 <span class="set-tag tag-reserved">暂不可用</span></h4></div>`) +
    `</div></div>` +
    `<div class="modal-foot">` +
    `<button class="btn btn-ghost" id="ob-cancel">${asrOnly ? '取消' : '稍后再说'}</button>` +
    `<button class="btn btn-primary" id="ob-save">${asrOnly ? '保存' : '保存并激活'}</button>` +
    `</div>`;

  modalRoot.replaceChildren(m);
  modalRoot.classList.add('show');

  const readSection = (id: string): ModelConfigInput => {
    const sec = m.querySelector(`#${id}`);
    const out: ModelConfigInput = { baseUrl: '', modelId: '', apiKey: '' };
    sec?.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      const key = inp.getAttribute('data-k');
      if (key === 'baseUrl' || key === 'modelId' || key === 'apiKey') out[key] = inp.value.trim();
    });
    if (id === 'ob-asr') out.provider = m.querySelector<HTMLSelectElement>('#ob-asr-provider')?.value === 'doubao-agent-plan' ? 'doubao-agent-plan' : 'openai-compatible';
    return out;
  };
  m.querySelector<HTMLSelectElement>('#ob-asr-provider')?.addEventListener('change', (event) => {
    const doubao = (event.currentTarget as HTMLSelectElement).value === 'doubao-agent-plan';
    m.querySelectorAll<HTMLElement>('#ob-asr [data-f="baseUrl"], #ob-asr [data-f="modelId"]').forEach(el => { el.style.display = doubao ? 'none' : ''; });
    const key = m.querySelector<HTMLInputElement>('#ob-asr input[data-k="apiKey"]');
    if (key) key.value = '';
  });
  const markErrors = (id: string, missing: string[]): void => {
    m.querySelectorAll(`#${id} .field`).forEach((f) => {
      const k = f.getAttribute('data-f') ?? '';
      const bad = missing.includes(k);
      f.classList.toggle('has-err', bad);
      f.querySelector('input')?.classList.toggle('err', bad);
    });
  };
  const close = (): void => {
    modalRoot.classList.remove('show');
    modalRoot.replaceChildren();
  };

  m.querySelector('#ob-cancel')?.addEventListener('click', () => {
    close();
    deps.onDismiss();
  });

  m.querySelector(asrOnly ? '#ob-test-asr' : '#ob-test')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const cfg = readSection(asrOnly ? 'ob-asr' : 'ob-llm');
    const v = asrOnly ? validateAsr(cfg) : validateLlm(cfg);
    if (!asrOnly) markErrors('ob-llm', (v as ReturnType<typeof validateLlm>).missing);
    const status = m.querySelector('#ob-test-status');
    const bad = asrOnly ? (v as ReturnType<typeof validateAsr>).kind === 'error' : !(v as ReturnType<typeof validateLlm>).ok;
    if (bad) {
      if (status) {
        status.className = 'test-status err';
        status.textContent = asrOnly ? (v as ReturnType<typeof validateAsr>).error ?? '请先填写完整配置' : (v as ReturnType<typeof validateLlm>).error ?? '请先填写完整配置';
      }
      return;
    }
    btn.disabled = true;
    btn.textContent = '连接中…';
    if (status) {
      status.className = 'test-status hidden';
    }
    void deps
      .testConnection(cfg, asrOnly ? 'asr' : 'llm')
      .then((r) => {
        if (status) {
          status.className = `test-status ${r?.ok ? 'ok' : 'err'}`;
          status.textContent = `${r?.ok ? '✓' : '✕'} ${r?.msg ?? '无应答，请重试'}`;
        }
      })
      .catch(() => {
        if (status) {
          status.className = 'test-status err';
          status.textContent = '✕ 连接失败（后台无响应），请重试';
        }
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = '测试连接';
      });
  });

  m.querySelector('#ob-save')?.addEventListener('click', () => {
    const asr = readSection('ob-asr');
    const a = validateAsr(asr);
    const asrErr = m.querySelector<HTMLElement>('#ob-asr-err');
    if (asrErr) {
      asrErr.style.display = a.kind === 'error' ? 'block' : 'none';
      asrErr.textContent = a.error ?? '';
    }
    if (a.kind === 'error') return;
    if (asrOnly) {
      // P2.3 补配模式：仅带 asr（不带 llm 键）——SW 沿用已存 LLM，Key 明文不出 SW
      if (a.kind !== 'ok') {
        toast(deps.ui, '请完整填写 ASR 三项');
        return;
      }
      void deps
        .save({ asr })
        .then((r) => {
          if (r.ok) {
            close();
            deps.onSaved();
            if (r.denied?.length) toast(deps.ui, '设置已保存，但模型端点未获授权；连接失败时请重新保存并允许访问', 6000);
          } else {
            toast(deps.ui, r.error ?? '保存失败，请重试');
          }
        })
        .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
      return;
    }
    const llm = readSection('ob-llm');
    const v = validateLlm(llm);
    markErrors('ob-llm', v.missing);
    if (!v.ok) {
      toast(deps.ui, v.error ?? `请先完成必填配置（${v.missing.length} 项未填）`);
      return;
    }
    void deps
      .save(buildSavePayload(llm, asr))
      .then((r) => {
        if (r.ok) {
          close();
          deps.onSaved();
          if (r.denied?.length) toast(deps.ui, '设置已保存，但模型端点未获授权；连接失败时请重新保存并允许访问', 6000);
        } else {
          toast(deps.ui, r.error ?? '保存失败，请重试');
        }
      })
      .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
  });
}
