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
  /** 最小请求探活（background TEST_CONNECTION）。 */
  testConnection: (cfg: ModelConfigInput) => Promise<{ ok: boolean; msg: string }>;
  /** 保存（background SETTINGS_SAVE：写 settings/onboarded + 申请端点 origin 权限）。 */
  save: (payload: SettingsSavePayload) => Promise<{ ok: boolean; error?: string }>;
  /** 「稍后再说」：回未激活态（开始陪看气泡 + 提示）。 */
  onDismiss: () => void;
  /** 保存成功：触发 SESSION_START（配置已就绪，激活必成）。 */
  onSaved: () => void;
}

const field = (dataF: string, label: string, placeholder: string, type = 'text'): string =>
  `<div class="field" data-f="${dataF}"><label>${label}</label>` +
  `<input type="${type}" data-k="${dataF}" placeholder="${esc(placeholder)}">` +
  `<div class="field-err">请填写 ${label}</div></div>`;

export function openOnboarding(deps: OnboardingDeps): void {
  const root = deps.ui.root;
  const modalRoot = root.getElementById('modal-root');
  // 属主标记：onboarding 已开则不重开；其他弹窗占用时本版直接替换（2.x 弹窗增多后按 owner 协调）
  if (!modalRoot || (modalRoot.classList.contains('show') && modalRoot.dataset.owner === 'onboarding')) return;
  modalRoot.dataset.owner = 'onboarding';

  const m = root.ownerDocument.createElement('div');
  m.className = 'modal';
  m.innerHTML =
    `<div class="modal-head">` +
    `<div class="m-emoji"><img src="${deps.assetUrl('/mascot/mascot-happy.png')}" alt="豆包" style="width:52px;height:52px;border-radius:12px;display:block"></div>` +
    `<div><h2>欢迎使用豆包！</h2><p>开始陪看前，请先配置一个大模型（必填）。所有数据只保存在你的浏览器本机，摘要调用直连你自己的 API。</p></div>` +
    `</div>` +
    `<div class="modal-body"><div>` +
    `<div class="m-step" id="ob-llm"><h4><span class="step-num">1</span> 通用 LLM（必填）<span class="set-tag tag-required">用于摘要与点评</span></h4>` +
    `<div class="set-desc">兼容 OpenAI 协议的服务均可，例如 DeepSeek / 火山方舟。</div>` +
    field('baseUrl', 'Base URL', 'https://api.deepseek.com/v1') +
    field('modelId', 'Model ID', 'deepseek-chat') +
    field('apiKey', 'API Key', 'sk-...（仅保存在本机）', 'password') +
    `<div class="set-row-btns"><button class="btn btn-ghost" id="ob-test">测试连接</button></div>` +
    `<div class="test-status hidden" id="ob-test-status"></div>` +
    `</div>` +
    `<div class="m-step" id="ob-asr"><h4><span class="step-num">2</span> ASR 语音转写（可选）<span class="set-tag tag-optional">用于无字幕视频</span></h4>` +
    `<div class="set-desc">可稍后在「设置」中配置，不影响有字幕视频的摘要。</div>` +
    field('baseUrl', 'Base URL', 'https://api.siliconflow.cn/v1') +
    field('modelId', 'Model ID', 'FunAudioLLM/SenseVoiceSmall') +
    field('apiKey', 'API Key', '选填', 'password') +
    `<div class="field-err" id="ob-asr-err" style="display:none;color:#ef4444;font-size:11px"></div>` +
    `</div>` +
    `<div class="m-step step-disabled"><h4><span class="step-num gray">3</span> TTS 语音合成 <span class="set-tag tag-reserved">当前版本暂不启用</span></h4>` +
    `<div class="set-desc">预留位：未来版本豆包可以用你自己的 TTS 模型开口说话。</div></div>` +
    `</div></div>` +
    `<div class="modal-foot">` +
    `<button class="btn btn-ghost" id="ob-cancel">稍后再说</button>` +
    `<button class="btn btn-primary" id="ob-save">保存并激活</button>` +
    `</div>`;

  modalRoot.replaceChildren(m);
  modalRoot.classList.add('show');

  const readSection = (id: string): ModelConfigInput => {
    const sec = m.querySelector(`#${id}`);
    const out: ModelConfigInput = { baseUrl: '', modelId: '', apiKey: '' };
    sec?.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) => {
      out[inp.getAttribute('data-k') as keyof ModelConfigInput] = inp.value.trim();
    });
    return out;
  };
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

  m.querySelector('#ob-test')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const cfg = readSection('ob-llm');
    const v = validateLlm(cfg);
    markErrors('ob-llm', v.missing);
    const status = m.querySelector('#ob-test-status');
    if (!v.ok) {
      if (status) {
        status.className = 'test-status err';
        status.textContent = v.error ?? '请先填写完整配置';
      }
      return;
    }
    btn.disabled = true;
    btn.textContent = '连接中…';
    if (status) {
      status.className = 'test-status hidden';
    }
    void deps
      .testConnection(cfg)
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
    const llm = readSection('ob-llm');
    const asr = readSection('ob-asr');
    const v = validateLlm(llm);
    markErrors('ob-llm', v.missing);
    if (!v.ok) {
      toast(deps.ui, v.error ?? `请先完成必填配置（${v.missing.length} 项未填）`);
      return;
    }
    const a = validateAsr(asr);
    const asrErr = m.querySelector<HTMLElement>('#ob-asr-err');
    if (asrErr) {
      asrErr.style.display = a.kind === 'error' ? 'block' : 'none';
      asrErr.textContent = a.error ?? '';
    }
    if (a.kind === 'error') return;
    void deps
      .save(buildSavePayload(llm, asr))
      .then((r) => {
        if (r.ok) {
          close();
          deps.onSaved();
        } else {
          toast(deps.ui, r.error ?? '保存失败，请重试');
        }
      })
      .catch(() => toast(deps.ui, '保存失败（后台无响应），请重试'));
  });
}
