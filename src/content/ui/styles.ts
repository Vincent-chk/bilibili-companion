// P1.5 · 共享 UI 样式：高保真原型 style.css 的 UI 部分（mascot/panel/modal/toast/表单字段）
// 近乎 1:1 移植进 Shadow DOM —— 仅把 :root 换成 :host、去掉模拟 B 站页面与演示控制条样式。
// 视觉规范：B站粉 #FB7299 / 蓝 #23ADE5，底色 #f4f5f7，卡片白底 12px 圆角柔和阴影，过渡 200-300ms ease。
export const UI_STYLES = `
  :host {
    all: initial;
    --pink: #FB7299; --blue: #23ADE5; --bg: #f4f5f7;
    --text: #18191c; --text2: #61666d; --text3: #9499a0; --line: #e3e5e7;
    --card: #ffffff; --radius: 12px;
    --shadow: 0 2px 12px rgba(0,0,0,.08);
    --shadow-lg: 0 8px 32px rgba(0,0,0,.16);
    --green: #16a34a; --green-bg: #e8f8ee;
    --blue2: #0284c7; --blue2-bg: #e6f6fd;
    --orange: #ea580c; --orange-bg: #fff3e6;
    --gray: #6b7280; --gray-bg: #f1f2f4;
    --red: #dc2626; --red-bg: #fee2e2;
    --purple: #7c3aed; --purple-bg: #f3e8ff;
  }
  :host, :host * { box-sizing: border-box; }
  :host {
    font-family: system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: var(--text);
  }
  button { font-family: inherit; cursor: pointer; border: none; background: none; color: inherit; }
  input { font-family: inherit; }
  .hidden { display: none !important; }
  ::selection { background: #ffd9e4; }

  /* ============ 豆包吉祥物（1.6：状态机切图 + CSS 动画） ============ */
  #mascot-wrap { position: fixed; z-index: 5000; width: 170px; user-select: none; -webkit-user-select: none; }
  #mascot { position: relative; width: 150px; height: 150px; cursor: grab; transition: filter .2s; }
  #mascot:active { cursor: grabbing; }
  #mascot:hover { filter: drop-shadow(0 6px 16px rgba(251,114,153,.35)); }
  #mascot-img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  .mascot-float { animation: float 3.2s ease-in-out infinite alternate; }
  @keyframes float { from { transform: translateY(0) rotate(-1.5deg); } to { transform: translateY(-9px) rotate(1.5deg); } }
  .st-thinking .mascot-float { animation: sway 1.6s ease-in-out infinite alternate; }
  @keyframes sway { from { transform: translateY(0) rotate(-2.5deg); } to { transform: translateY(-9px) rotate(2.5deg); } }
  .st-sleep .mascot-float { animation: float 4.5s ease-in-out infinite alternate; }
  .st-happy .mascot-float { animation: bounce .65s cubic-bezier(.28,.84,.42,1) 2, float 3.2s ease-in-out 1.3s infinite alternate; }
  @keyframes bounce { 0%,100% { transform: translateY(0); } 35% { transform: translateY(-16px) rotate(-4deg); } 70% { transform: translateY(0); } 85% { transform: translateY(-7px); } }

  /* 气泡：完全悬浮在人物上方，不与立绘重叠（原型三修结论） */
  .mascot-bubble { position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%); min-width: 120px; max-width: 230px; background: #fff; border-radius: 14px; padding: 9px 14px; font-size: 13px; line-height: 1.5; color: var(--text); box-shadow: var(--shadow-lg); text-align: center; animation: bubbleIn .25s ease; z-index: 2; }
  .mascot-bubble::after { content: ""; position: absolute; bottom: -7px; left: 50%; transform: translateX(-50%); border: 8px solid transparent; border-top-color: #fff; border-bottom: none; }
  @keyframes bubbleIn { from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(.9); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
  .mascot-bubble .bubble-btn { display: inline-block; margin-top: 6px; background: var(--pink); color: #fff; font-size: 13px; font-weight: 600; padding: 7px 18px; border-radius: 99px; transition: transform .15s, opacity .15s; white-space: nowrap; }
  .mascot-bubble .bubble-btn:hover { transform: scale(1.05); opacity: .92; }
  .mascot-bubble .caret { display: inline-block; width: 2px; height: 14px; background: var(--pink); vertical-align: -2px; animation: caretBlink .8s step-end infinite; }
  @keyframes caretBlink { 50% { opacity: 0; } }

  /* ============ 右侧面板（overlay，不推挤页面布局） ============ */
  #panel { position: fixed; top: 0; right: 0; bottom: 0; width: 400px; background: var(--bg); z-index: 6000; display: flex; flex-direction: column; transform: translateX(105%); transition: transform .28s cubic-bezier(.22,.8,.36,1); box-shadow: -8px 0 32px rgba(0,0,0,.12); }
  #panel.open { transform: translateX(0); }
  .p-head { background: #fff; padding: 14px 16px 12px; border-bottom: 1px solid var(--line); flex: none; }
  .p-head-row { display: flex; align-items: center; gap: 10px; }
  .p-mascot-avatar { width: 38px; height: 38px; flex: none; border-radius: 50%; background: linear-gradient(135deg,#fff6de,#ffd98a); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .p-mascot-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
  .p-titles { min-width: 0; flex: 1; }
  .p-title { font-size: 15px; font-weight: 700; }
  .p-sub { font-size: 12px; color: var(--text2); margin-top: 2px; display: flex; align-items: center; gap: 6px; min-height: 16px; }
  .dot-live { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,.45); } 50% { box-shadow: 0 0 0 5px rgba(34,197,94,0); } }
  .p-icon-btn { width: 32px; height: 32px; border-radius: 8px; font-size: 16px; color: var(--text2); transition: background .15s; }
  .p-icon-btn:hover { background: #f1f2f4; }
  .p-head-actions { display: flex; gap: 8px; margin-top: 10px; }
  .btn { border-radius: 8px; font-size: 13px; padding: 8px 14px; transition: all .15s; font-weight: 500; }
  .btn-primary { background: var(--pink); color: #fff; }
  .btn-primary:hover { opacity: .88; }
  .btn-ghost { background: #fff; border: 1px solid var(--line); color: var(--text2); }
  .btn-ghost:hover { border-color: var(--pink); color: var(--pink); }
  .btn-danger { background: #fee2e2; color: #dc2626; }
  .btn-danger:hover { background: #fecaca; }
  .btn-blue { background: var(--blue); color: #fff; }
  .btn-blue:hover { opacity: .88; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .countdown-pill { display: inline-flex; align-items: center; gap: 5px; background: #fff7ed; color: #c2410c; font-size: 11.5px; border-radius: 99px; padding: 3px 10px; font-variant-numeric: tabular-nums; }
  .p-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 14px 14px 30px; }
  .p-body::-webkit-scrollbar { width: 6px; }
  .p-body::-webkit-scrollbar-thumb { background: #d3d6db; border-radius: 3px; }

  /* ---- 列表视图 ---- */
  .list-head { display: flex; justify-content: space-between; align-items: baseline; margin: 2px 4px 10px; }
  .list-head b { font-size: 14px; }
  .list-head span { font-size: 12px; color: var(--text3); }
  .v-item { background: #fff; border-radius: var(--radius); padding: 12px; margin-bottom: 12px; box-shadow: var(--shadow); cursor: pointer; transition: transform .15s, box-shadow .15s; }
  .v-item:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.1); }
  .v-item-top { display: flex; gap: 10px; }
  .v-cover { position: relative; flex: none; width: 128px; height: 80px; border-radius: 8px; overflow: hidden; background: #e3e5e7; }
  .v-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .v-cover .dur { position: absolute; right: 4px; bottom: 4px; background: rgba(0,0,0,.72); color: #fff; font-size: 10.5px; padding: 1px 5px; border-radius: 4px; }
  .cover-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 26px; background: linear-gradient(135deg,#ffd9e4,#cdeefe); }
  .v-info { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .v-name { font-size: 13.5px; font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .v-sub { font-size: 11.5px; color: var(--text3); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .v-prog-row { display: flex; align-items: center; gap: 8px; margin-top: auto; }
  .v-prog { flex: 1; height: 4px; border-radius: 2px; background: #eceef1; overflow: hidden; }
  .v-prog i { display: block; height: 100%; background: linear-gradient(90deg,#ff9db8,var(--pink)); border-radius: 2px; transition: width .3s; }
  .v-pct { font-size: 11px; color: var(--text3); font-variant-numeric: tabular-nums; }
  .badge { flex: none; font-size: 11px; font-weight: 600; border-radius: 99px; padding: 3px 9px; white-space: nowrap; }
  .badge-summarized { background: var(--green-bg); color: var(--green); }
  .badge-generating { background: var(--blue2-bg); color: var(--blue2); }
  .badge-nosub { background: var(--orange-bg); color: var(--orange); }
  .badge-ungenerated { background: var(--gray-bg); color: var(--gray); }
  .badge-failed { background: var(--red-bg); color: var(--red); }
  .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid #bae6fd; border-top-color: var(--blue2); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; margin-right: 4px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---- 详情视图 ---- */
  .d-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .d-back { width: 30px; height: 30px; border-radius: 8px; background: #fff; box-shadow: var(--shadow); font-size: 15px; color: var(--text2); flex: none; }
  .d-back:hover { color: var(--pink); }
  .d-head b { font-size: 14.5px; }
  .d-cover { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: var(--radius); overflow: hidden; background: #e3e5e7; box-shadow: var(--shadow); }
  .d-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .d-cover .dur { position: absolute; right: 8px; bottom: 8px; background: rgba(0,0,0,.72); color: #fff; font-size: 11px; padding: 2px 7px; border-radius: 5px; }
  .d-title { font-size: 15.5px; font-weight: 700; line-height: 1.5; margin: 12px 2px 6px; }
  .d-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text3); margin-bottom: 14px; }
  .src-badge { font-size: 11px; font-weight: 600; border-radius: 99px; padding: 2px 9px; }
  .src-ai { background: var(--blue2-bg); color: var(--blue2); }
  .src-manual { background: var(--green-bg); color: var(--green); }
  .src-asr { background: var(--purple-bg); color: var(--purple); }
  .d-sec { background: #fff; border-radius: var(--radius); padding: 14px; margin-bottom: 12px; box-shadow: var(--shadow); }
  .d-sec h3 { font-size: 13.5px; margin-bottom: 9px; display: flex; align-items: center; gap: 6px; }
  .d-summary { font-size: 13px; line-height: 1.85; color: #333; text-align: justify; }
  .d-summary .caret { display: inline-block; width: 2px; height: 12px; background: var(--blue); vertical-align: -1px; animation: caretBlink .8s step-end infinite; }
  .d-summary-empty { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text2); }
  .d-outline { list-style: none; }
  .d-outline li { display: flex; gap: 10px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 12.8px; line-height: 1.5; transition: background .15s; }
  .d-outline li:hover { background: #fff0f5; }
  .d-outline .ot { flex: none; color: var(--blue); font-variant-numeric: tabular-nums; font-weight: 600; }
  .d-outline li:hover .ot { color: var(--pink); }
  .mascot-card { background: linear-gradient(135deg,#fff9ec,#fff2f6); border: 1px solid #ffe3c2; }
  .empty-mascot { width: 72px; height: 72px; object-fit: contain; display: block; margin: 0 auto 10px; }
  .mascot-say { display: flex; gap: 10px; }
  .mascot-say-avatar { flex: none; width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg,#fff6de,#ffd98a); display: flex; align-items: center; justify-content: center; font-size: 18px; overflow: hidden; }
  .mascot-say-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
  .mascot-say-body { min-width: 0; }
  .mascot-stars { font-size: 13px; letter-spacing: 2px; margin-bottom: 4px; }
  .mascot-stars .dim { opacity: .22; filter: grayscale(1); }
  .mascot-say-text { font-size: 12.8px; line-height: 1.75; color: #57432b; }
  .d-transcript summary { font-size: 13.5px; font-weight: 600; cursor: pointer; color: var(--text2); outline: none; }
  .d-transcript[open] summary { margin-bottom: 8px; }
  .tr-line { display: flex; gap: 10px; font-size: 12.3px; line-height: 1.65; padding: 4px 0; color: var(--text2); cursor: pointer; border-radius: 6px; transition: background .15s; }
  .tr-line:hover { background: #f6f7f9; }
  .tr-line .tt { flex: none; color: var(--text3); font-variant-numeric: tabular-nums; }
  .d-foot { display: flex; gap: 10px; margin: 14px 2px 6px; }
  .d-foot .btn { flex: 1; text-align: center; }

  /* ---- 表单字段（onboarding 1.7 / 设置页 2.5 共用） ---- */
  .set-sec { background: #fff; border-radius: var(--radius); padding: 14px; margin-bottom: 12px; box-shadow: var(--shadow); scroll-margin-top: 12px; }
  .set-sec.flash { animation: secFlash 1.6s ease; }
  @keyframes secFlash { 0%,100% { box-shadow: var(--shadow); } 30% { box-shadow: 0 0 0 3px rgba(251,114,153,.45); } }
  .set-sec h3 { font-size: 13.5px; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .set-tag { font-size: 10.5px; font-weight: 600; border-radius: 99px; padding: 2px 8px; }
  .tag-required { background: #fee2e2; color: #dc2626; }
  .tag-optional { background: var(--blue2-bg); color: var(--blue2); }
  .tag-reserved { background: var(--gray-bg); color: var(--gray); }
  .set-desc { font-size: 11.5px; color: var(--text3); line-height: 1.6; margin-bottom: 10px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 5px; font-weight: 500; }
  .field input[type=text], .field input[type=password] { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; font-size: 12.5px; outline: none; transition: border-color .15s, box-shadow .15s; background: #fff; color: var(--text); }
  .field input:focus { border-color: var(--pink); box-shadow: 0 0 0 3px rgba(251,114,153,.12); }
  .field input.err { border-color: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.12); animation: shake .35s; }
  @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
  .field .field-err { display: none; font-size: 11px; color: #ef4444; margin-top: 4px; }
  .field.has-err .field-err { display: block; }
  .set-disabled input { background: #f6f7f9 !important; color: var(--text3) !important; cursor: not-allowed; }
  .set-row-btns { display: flex; gap: 8px; margin-top: 4px; }
  .set-row-btns .btn { flex: 1; text-align: center; padding: 8px 10px; }
  .rule-box { background: #f8fafc; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font-size: 12px; color: var(--text2); line-height: 1.8; }
  .rule-box b { color: var(--text); }

  /* ============ 弹窗 ============ */
  #modal-root { position: fixed; inset: 0; z-index: 7000; display: none; align-items: center; justify-content: center; background: rgba(15,17,26,.5); backdrop-filter: blur(2px); animation: fadeIn .2s ease; }
  #modal-root.show { display: flex; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal { width: 480px; max-width: calc(100vw - 48px); max-height: calc(100vh - 80px); background: #fff; border-radius: 16px; box-shadow: var(--shadow-lg); overflow-y: auto; animation: modalIn .25s cubic-bezier(.22,.8,.36,1); }
  @keyframes modalIn { from { opacity: 0; transform: translateY(16px) scale(.97); } to { opacity: 1; transform: none; } }
  .modal-head { padding: 20px 24px 0; display: flex; align-items: flex-start; gap: 12px; }
  .modal-head .m-emoji { font-size: 34px; line-height: 1; }
  .modal-head h2 { font-size: 17px; line-height: 1.4; }
  .modal-head p { font-size: 12.5px; color: var(--text2); margin-top: 4px; line-height: 1.6; }
  .modal-body { padding: 16px 24px; }
  .modal-foot { padding: 0 24px 20px; display: flex; gap: 10px; justify-content: flex-end; }
  .modal-foot .btn { padding: 9px 20px; font-size: 13.5px; }
  .m-step { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .m-step + .m-step { margin-top: 14px; }
  .m-step h4 { font-size: 13px; display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
  .m-step .set-desc { margin-bottom: 8px; }
  .m-step.step-disabled { background: #fafbfc; opacity: .75; }
  .step-num { width: 18px; height: 18px; border-radius: 50%; background: var(--pink); color: #fff; font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .step-num.gray { background: #c6cad1; }
  .test-status { font-size: 12px; margin-top: 6px; }
  .test-status.ok { color: var(--green); }
  .test-status.err { color: #ef4444; }

  /* ============ Toast ============ */
  #toast-root { position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%); z-index: 9999; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
  .toast { background: rgba(24,25,28,.88); color: #fff; font-size: 13px; padding: 9px 18px; border-radius: 99px; box-shadow: var(--shadow-lg); animation: toastIn .25s ease; max-width: 70vw; text-align: center; backdrop-filter: blur(4px); }
  .toast.out { animation: toastOut .3s ease forwards; }
  @keyframes toastIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes toastOut { to { opacity: 0; transform: translateY(-6px); } }
`;
