/*!
 * AI 模式 · 批次刪除  v1.2.9
 * ------------------------------------------------------------------
 * 全部邏輯都在你的瀏覽器本機執行，不會連到任何伺服器、不會上傳資料。
 * 作法是「模擬你自己的滑鼠操作」去點 Google 原生的 ⋮ 選單，
 * 所以不需要任何 API key、也不會碰到你的登入 token。
 * ------------------------------------------------------------------
 */
(() => {
  'use strict';
  if (window.__RIN_BULK__) return;
  window.__RIN_BULK__ = true;

  const VERSION = '1.2.9';
  const CFG_KEY = 'rin_bulk_cfg_v1';
  const DEF = {
    delay: 700,
    overlay: true,
    lang: 'zh-TW',
    s2t: true,
    rowClass: '',
    rowSelector: '',
    rowTag: '',
    contentSelector: '',
    px: null,
    py: null,
    hidden: false,
  };

  let cfg = Object.assign({}, DEF);

  const I18N = window.__AMB_I18N__;
  const t = (key, vars) => (I18N ? I18N.t(cfg.lang, key, vars) : key);
  const S2T = window.__AMB_S2T__;

  /* 狀態 */
  let rows = [];              // [{ el, title }]
  let selected = new Set();   // 以 row.key（data-thread-id）當 key，同名討論串才分得開
  let busy = false;
  let abort = false;
  let forced = false;         // 由 popup 強制顯示
  let lastListKey = '';
  let toastTimer = 0;

  /* ============================================================
   *  小工具
   * ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/[\s\u00a0\u200b]+/g, ' ').trim();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  const isShown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  async function waitFor(fn, ms, step = 100) {
    const t0 = performance.now();
    for (;;) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      if (performance.now() - t0 >= ms) return null;
      await sleep(step);
    }
  }

  async function waitUntil(fn, ms, step = 180) {
    const t0 = performance.now();
    for (;;) {
      try { if (fn()) return true; } catch (_) {}
      if (performance.now() - t0 >= ms) return false;
      await sleep(step);
    }
  }

  const sleepAB = (ms) => new Promise((r) => {
    const t0 = performance.now();
    (function tick() {
      if (abort || performance.now() - t0 >= ms) return r();
      setTimeout(tick, Math.min(80, ms));
    })();
  });

  /* ============================================================
   *  設定讀寫
   * ============================================================ */
  let saveTimer = 0;
  function saveCfgSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCfg, 250);
  }
  function saveCfg() {
    try { chrome.storage.local.set({ [CFG_KEY]: cfg }); } catch (_) {}
  }
  async function loadCfg() {
    try {
      const o = await chrome.storage.local.get([CFG_KEY]);
      cfg = Object.assign({}, DEF, o[CFG_KEY] || {});
    } catch (_) {}
  }

  /* ============================================================
   *  樣式（全部關在 Shadow DOM 裡，不會污染 Google 的樣式）
   * ============================================================ */
  const CSS = String.raw`
  :host{all:initial}
  *{box-sizing:border-box;margin:0;padding:0;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  input{font:inherit}

  .overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;display:none}
  .box{position:absolute;left:0;top:0;width:16px;height:16px;border-radius:5px;border:1.5px solid rgba(255,255,255,.42);
       background:rgba(24,25,28,.92);color:#0b0c0e;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;
       cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.45);transition:background .12s,border-color .12s}
  .box:hover{border-color:#a8c7fa;background:rgba(40,44,52,.98)}
  .box.on{background:#a8c7fa;border-color:#a8c7fa}

  .panel{position:absolute;width:300px;display:flex;flex-direction:column;background:#1b1c1f;color:#e3e3e3;
         border:1px solid #35383e;border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.62);
         pointer-events:auto;overflow:hidden;font-size:12px;line-height:1.55;letter-spacing:.01em}
  .panel.off{display:none}

  .hd{display:flex;align-items:center;gap:7px;padding:9px 10px 9px 12px;background:#202226;
      border-bottom:1px solid #2c2f34;cursor:grab;user-select:none;flex:0 0 auto}
  .hd:active{cursor:grabbing}
  .dot{width:7px;height:7px;border-radius:50%;background:#a8c7fa;box-shadow:0 0 8px rgba(168,199,250,.75);flex:0 0 auto}
  .ttl{font-weight:700;font-size:12.5px;letter-spacing:.02em;flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge{font-size:11px;color:#a8c7fa;background:rgba(168,199,250,.13);border-radius:9px;padding:1px 7px;flex:0 0 auto}
  .ic{width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;
      color:#9aa0a6;font-size:14px;flex:0 0 auto}
  .ic:hover{background:#31343a;color:#e3e3e3}

  .body{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}

  .stat{padding:8px 12px 6px;color:#9aa0a6;font-size:11.5px;display:flex;align-items:center;gap:6px;flex:0 0 auto}
  .stat b{color:#e3e3e3;font-weight:600}
  .stat .sel{color:#a8c7fa;font-weight:700}

  .tools{display:flex;gap:5px;padding:0 10px 7px;flex:0 0 auto;flex-wrap:wrap}
  .btn{padding:4.5px 9px;border-radius:8px;background:#2a2d33;color:#d6d9de;font-size:11.5px;font-weight:500;
       border:1px solid #35383e;white-space:nowrap;transition:background .12s,border-color .12s}
  .btn:hover{background:#34373e;border-color:#43474f}
  .btn:active{transform:translateY(1px)}
  .btn.on{border-color:#a8c7fa;color:#a8c7fa}
  .btn.wide{flex:1 1 auto;text-align:center}
  .btn.danger{background:#3d2023;border-color:#5c2b30;color:#ff9aa2}
  .btn.danger:hover{background:#4a2529;border-color:#74343b}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.sm{padding:3px 7px;font-size:11px}

  .opts{display:flex;align-items:center;gap:10px;padding:0 12px 8px;flex:0 0 auto;color:#8f949b;font-size:11px}
  .opts label{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  .opts input[type=number]{width:52px;background:#26282d;border:1px solid #383b42;border-radius:6px;
       color:#d6d9de;padding:1px 4px;font-size:11px;text-align:right}
  .opts input[type=checkbox]{accent-color:#a8c7fa;width:12px;height:12px}
  .opts select{background:#26282d;border:1px solid #383b42;border-radius:6px;color:#d6d9de;
        padding:1px 3px;font-size:11px;cursor:pointer;max-width:98px;margin-left:2px}
  .opts select:focus{outline:1px solid #a8c7fa}

  .list{flex:1 1 auto;min-height:44px;max-height:280px;overflow-y:auto;overflow-x:hidden;
        border-top:1px solid #2a2d32;border-bottom:1px solid #2a2d32;background:#191a1d;scrollbar-width:thin;
        scrollbar-color:#3b3f46 transparent}
  .list::-webkit-scrollbar{width:8px}
  .list::-webkit-scrollbar-thumb{background:#3b3f46;border-radius:4px}
  .item{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;cursor:pointer;border-bottom:1px solid #212327}
  .item:hover{background:#232529}
  .item.on{background:rgba(168,199,250,.08)}
  .cb{flex:0 0 auto;width:15px;height:15px;margin-top:2px;border-radius:4px;border:1.5px solid #5a5f67;
      display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#0b0c0e}
  .item.on .cb{background:#a8c7fa;border-color:#a8c7fa}
  .t{flex:1 1 auto;min-width:0;font-size:11.5px;color:#cfd3d9;word-break:break-word;display:-webkit-box;
     -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .item.on .t{color:#eef1f5}
  .del1{flex:0 0 auto;opacity:0;color:#8b9098;padding:0 2px;font-size:13px;line-height:1}
  .item:hover .del1{opacity:1}
  .del1:hover{color:#ff9aa2}
  .empty{padding:16px 12px;text-align:center;color:#7c8188;font-size:11.5px;line-height:1.7}

  .prog{height:2px;background:#2a2d32;flex:0 0 auto;overflow:hidden;display:none}
  .prog.show{display:block}
  .prog i{display:block;height:100%;width:0;background:linear-gradient(90deg,#8ab4f8,#a8c7fa);transition:width .2s}

  .log{max-height:74px;overflow-y:auto;padding:5px 12px;font-size:11px;color:#8b9098;
       font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.5;display:none;
       background:#17181b;border-bottom:1px solid #2a2d32;white-space:pre-wrap;word-break:break-word}
  .log.show{display:block}
  .log .ok{color:#8fd18f}
  .log .bad{color:#ff9aa2}

  .foot{display:flex;gap:6px;padding:9px 10px;flex:0 0 auto}
  .foot.tight{padding-top:0}
  .foot .btn{padding:6px 10px;flex:1 1 0;text-align:center}

  .ex .dialog{width:332px}
  .ex-row{display:flex;align-items:center;gap:8px;margin:9px 0;font-size:12px;color:#b9bec6}
  .ex-row > .lb{flex:0 0 32px;color:#8f949b;font-size:11.5px}
  .ex-sel{flex:1 1 auto;background:#26282d;border:1px solid #383b42;border-radius:7px;color:#d6d9de;
          padding:4px 6px;font-size:11.5px;cursor:pointer}
  .ex-sel:focus{outline:1px solid #a8c7fa}
  .ex-row label{display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap}
  .ex-row label b{color:#a8c7fa;font-weight:700}
  .ex-row input[type=radio]{accent-color:#a8c7fa;width:12px;height:12px}
  .ex-row input[type=number]{width:58px;background:#26282d;border:1px solid #383b42;border-radius:6px;
          color:#d6d9de;padding:2px 5px;font-size:11.5px;text-align:right}
  .ex-note{font-size:11px;color:#8b9098;line-height:1.7;margin-top:10px;background:#191a1d;
           border:1px solid #2a2d32;border-radius:8px;padding:7px 9px}
  .ex-note b{color:#cfd3d9}
  .dbtns .btn.excal{padding:5px 9px;font-size:11px;margin-right:auto}

  .toast{position:absolute;left:50%;bottom:24px;transform:translate(-50%,12px);background:rgba(32,34,38,.97);
         color:#e3e3e3;border:1px solid #3d4149;border-radius:10px;padding:8px 14px;font-size:12px;
         pointer-events:none;opacity:0;transition:opacity .18s,transform .18s;box-shadow:0 8px 24px rgba(0,0,0,.5);
         max-width:60vw;text-align:center;z-index:9}
  .toast.show{opacity:1;transform:translate(-50%,0)}

  .modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;
         pointer-events:auto;z-index:30}
  .modal.show{display:flex}
  .dialog{width:320px;background:#1e2024;border:1px solid #3a3e45;border-radius:14px;padding:16px 16px 12px;
          box-shadow:0 24px 60px rgba(0,0,0,.65)}
  .dtitle{font-size:13px;font-weight:700;margin-bottom:6px;color:#f0f2f5}
  .dtext{font-size:12px;color:#b9bec6;line-height:1.65;word-break:break-word}
  .dbtns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  .dbtns .btn{padding:6px 14px}

  .cal-hint{position:fixed;left:50%;top:18px;transform:translateX(-50%);background:#a8c7fa;color:#0b0c0e;
            font-weight:700;font-size:13px;padding:9px 18px;border-radius:22px;pointer-events:none;
            box-shadow:0 10px 26px rgba(0,0,0,.5);z-index:11}
  .cal-hover{outline:2px solid #ff7b72 !important;outline-offset:-2px;background:rgba(255,123,114,.14) !important}
  `;

  /* ============================================================
   *  Shadow DOM 建立
   * ============================================================ */
  const host = document.createElement('div');
  host.id = 'amb-bulk-host';
  host.setAttribute('data-rin', '1');
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;' +
    'contain:layout style;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', { text: CSS }));

  const overlayEl = h('div', { class: 'overlay' });
  const panelEl = h('div', { class: 'panel off' });
  const toastEl = h('div', { class: 'toast' });
  const modalEl = h('div', { class: 'modal' });
  shadow.append(overlayEl, panelEl, toastEl, modalEl);

  /* ---- 面板 ---- */
  const elCount = h('b', { text: '0' });
  const elSel = h('span', { class: 'sel', text: '0' });
  const elBadge = h('span', { class: 'badge', text: '0' });
  const elList = h('div', { class: 'list' });
  const elLog = h('div', { class: 'log' });
  const elProg = h('i');
  const elProgWrap = h('div', { class: 'prog' }, elProg);
  const btnAll = h('button', { class: 'btn', 'data-act': 'all' });
  const btnInv = h('button', { class: 'btn', 'data-act': 'inv' });
  const btnNone = h('button', { class: 'btn', 'data-act': 'none' });
  const btnScan = h('button', { class: 'btn', 'data-act': 'scan' });
  const btnCal = h('button', { class: 'btn sm', 'data-act': 'cal' });
  const btnDiag = h('button', { class: 'btn sm', 'data-act': 'diag' });
  const btnDel = h('button', { class: 'btn danger', 'data-act': 'del' });
  const btnExp = h('button', { class: 'btn', 'data-act': 'exp' });
  const btnExpFull = h('button', { class: 'btn', 'data-act': 'expfull' });
  const btnLoad = h('button', { class: 'btn wide', 'data-act': 'loadall' });
  const inDelay = h('input', { type: 'number', min: '200', max: '6000', step: '100', value: String(DEF.delay) });
  const inOverlay = h('input', { type: 'checkbox' });
  const selLang = h('select', { class: 'lang' });
  const btnHide = h('button', { class: 'ic', text: '✕' });
  const lblTitle = h('span', { class: 'ttl' });
  const lblStat = h('span');
  const lblDelay = h('span');
  const lblOverlay = h('span');
  const lblLang = h('span');
  const lblMs = h('span', { text: 'ms' });

  panelEl.append(
    h('div', { class: 'hd' },
      h('span', { class: 'dot' }),
      lblTitle,
      elBadge,
      btnHide
    ),
    h('div', { class: 'body' },
      h('div', { class: 'stat' }, elCount, lblStat, elSel),
      h('div', { class: 'tools' }, btnAll, btnInv, btnNone, btnScan, btnCal, btnDiag),
      h('div', { class: 'opts' },
        h('label', {}, lblDelay, inDelay, lblMs),
        h('label', {}, inOverlay, lblOverlay)
      ),
      h('div', { class: 'opts' }, h('label', {}, lblLang, selLang)),
      elList,
      elProgWrap,
      elLog,
      h('div', { class: 'foot' }, btnDel, btnExp, btnExpFull),
      h('div', { class: 'foot tight' }, btnLoad)
    )
  );

  /* ============================================================
   *  Toast / Modal
   * ============================================================ */
  function toast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  let modalResolve = null;
  const dTitle = h('div', { class: 'dtitle' });
  const dText = h('div', { class: 'dtext', text: '' });
  const dYes = h('button', { class: 'btn danger' });
  const dNo = h('button', { class: 'btn' });
  modalEl.append(h('div', { class: 'dialog' }, dTitle, dText, h('div', { class: 'dbtns' }, dNo, dYes)));

  function ask(title, text, okLabel) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      dTitle.textContent = title;
      dText.textContent = text;
      dYes.textContent = okLabel || t('dlg.oneOk');
      dNo.textContent = t('dlg.cancel');
      modalEl.classList.add('show');
      dYes.focus();
    });
  }
  function closeModal(v) {
    if (!modalResolve) return;
    const r = modalResolve;
    modalResolve = null;
    modalEl.classList.remove('show');
    r(v);
  }
  dYes.addEventListener('click', () => closeModal(true));
  dNo.addEventListener('click', () => closeModal(false));
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalResolve) { e.stopPropagation(); closeModal(false); return; }
    if (exResolve) { e.stopPropagation(); closeExport(null); }
  }, true);

  /* ---- 匯出內容的設定視窗 ---- */
  const exModal = h('div', { class: 'modal ex' });
  const exFmt = h('select', { class: 'ex-sel' });
  const exScopeSel = h('input', { type: 'radio', name: 'amb-ex-scope', value: 'sel' });
  const exScopeAll = h('input', { type: 'radio', name: 'amb-ex-scope', value: 'all' });
  const exSelLbl = h('span');
  const exAllLbl = h('span');
  const exGap = h('input', { type: 'number', min: '300', max: '6000', step: '100', value: '900' });
  const exS2T = h('input', { type: 'checkbox' });
  const exS2TLbl = h('span');
  const exCancel = h('button', { class: 'btn' });
  const exStart = h('button', { class: 'btn danger' });
  const exCalBtn = h('button', { class: 'btn excal' });
  const exTitle = h('div', { class: 'dtitle' });
  const exLbFmt = h('span', { class: 'lb' });
  const exLbScope = h('span', { class: 'lb' });
  const exLbGap = h('span', { class: 'lb' });
  const exNote = h('div', { class: 'ex-note' },
    h('div'), h('div'), h('div'), h('div'));
  let exResolve = null;

  exModal.append(h('div', { class: 'dialog' },
    exTitle,
    h('div', { class: 'ex-row' }, exLbFmt, exFmt),
    h('div', { class: 'ex-row' }, exLbScope,
      h('label', {}, exScopeSel, exSelLbl),
      h('label', {}, exScopeAll, exAllLbl)),
    h('div', { class: 'ex-row' }, exLbGap, exGap, h('span', { text: 'ms' }),
      h('label', { style: 'margin-left:auto' }, exS2T, exS2TLbl)),
    exNote,
    h('div', { class: 'dbtns' }, exCalBtn, exCancel, exStart)
  ));
  shadow.append(exModal);

  function applyExportLang() {
    exTitle.textContent = t('ex.title');
    exLbFmt.textContent = t('ex.format');
    exLbScope.textContent = t('ex.scope');
    exLbGap.textContent = t('ex.gap');
    exS2TLbl.textContent = t('ex.s2t');
    exNote.children[0].textContent = t('ex.note1');
    exNote.children[1].textContent = t('ex.note2');
    exNote.children[2].textContent = t('ex.note3');
    exNote.children[3].textContent = t('ex.note4');
    exCalBtn.textContent = t('ex.cal');
    exCancel.textContent = t('dlg.cancel');
    exStart.textContent = t('ex.start');

    const keep = exFmt.value;
    exFmt.textContent = '';
    exFmt.append(
      h('option', { value: 'txt', text: t('fmt.txt') }),
      h('option', { value: 'json', text: t('fmt.json') })
    );
    if (keep === 'json') exFmt.value = 'json';
  }

  function askExport() {
    return new Promise((resolve) => {
      exResolve = resolve;
      applyExportLang();
      exSelLbl.textContent = t('ex.selN', { n: selected.size });
      exAllLbl.textContent = t('ex.allN', { n: rows.length });
      exScopeSel.disabled = selected.size === 0;
      if (selected.size) exScopeSel.checked = true;
      else exScopeAll.checked = true;
      exGap.value = String(Math.min(6000, Math.max(500, cfg.delay + 200)));
      exS2T.checked = !!cfg.s2t;
      exModal.classList.add('show');
    });
  }

  function closeExport(v) {
    if (!exResolve) return;
    const r = exResolve;
    exResolve = null;
    exModal.classList.remove('show');
    r(v);
  }

  exCancel.addEventListener('click', () => closeExport(null));
  exModal.addEventListener('click', (e) => { if (e.target === exModal) closeExport(null); });
  exStart.addEventListener('click', () => {
    cfg.s2t = exS2T.checked;
    saveCfgSoon();
    closeExport({
      scope: exScopeSel.checked ? 'sel' : 'all',
      format: exFmt.value,
      delay: clamp(parseInt(exGap.value, 10) || 900, 300, 6000),
      s2t: exS2T.checked,
    });
  });
  exCalBtn.addEventListener('click', () => {
    closeExport(null);
    startContentCalibrate(() => setTimeout(openExportDialog, 450));
  });

  /* ---- 語言切換 ---- */
  function applyLang() {
    lblTitle.textContent = t('app.title');
    lblStat.textContent = t('stat.suffix');
    lblDelay.textContent = t('opt.delay');
    lblOverlay.textContent = t('opt.overlay');
    lblLang.textContent = t('opt.lang');
    btnAll.textContent = t('act.all');
    btnInv.textContent = t('act.inv');
    btnNone.textContent = t('act.none');
    btnScan.textContent = t('act.scan');
    btnCal.textContent = t('act.cal');
    btnDiag.textContent = t('act.diag');
    btnDel.textContent = busy ? t('btn.stop') : t('btn.del');
    btnExp.textContent = t('btn.expList');
    btnExpFull.textContent = t('btn.expContent');
    btnLoad.textContent = t('btn.loadAll');
    btnHide.title = t('btn.close');

    selLang.textContent = '';
    const langs = I18N ? I18N.LANGS : [['zh-TW', '繁體中文']];
    for (const pair of langs) {
      const o = h('option', { value: pair[0], text: pair[1] });
      if (pair[0] === cfg.lang) o.selected = true;
      selLang.append(o);
    }
    if (selLang.value !== cfg.lang) selLang.value = cfg.lang;

    lastListKey = '';
    renderList();
    if (exResolve) applyExportLang();
  }

  selLang.addEventListener('change', () => {
    if (!I18N || !I18N.has(selLang.value)) return;
    cfg.lang = selLang.value;
    saveCfgSoon();
    applyLang();
    refresh(true);
  });

  /* ============================================================
   *  偵測討論串列
   * ============================================================ */
  const FIXED_LABELS = [
    /^新增(對話串|對話|討論串|筆記本|筆記)$/,
    /^新(增)?(對話|討論|筆記)/,
    /^搜尋/,
    /^筆記$/,
    /^我的筆記本$/,
    /^最近的討論串$/,
    /^最近$/,
    /^設定$/,
    /^說明$/,
    /^更多$/,
    /^登入$/,
    /^帳戶/,
    /^使用說明$/,
    /^(顯示更多|查看更多|載入更多|看更多|show more|load more)$/i,
    /^(new chat|new conversation|new notebook|search|notes?|my notebooks?|recent.*|settings|help|more|sign in|account)$/i,
  ];
  const isFixedLabel = (t) => FIXED_LABELS.some((re) => re.test(t));

  const MORE_LABEL = /(更多選項|其他選項|更多|選項|more options|more|options|conversation options|thread options|menu)/i;
  const STRIP_MORE = /\s*(的)?\s*(其他)?\s*(更多選項|更多|選項|more options|options|menu)\s*[」』"']?$/i;
  // Google 有些列的 aria-label 會夾「，第 3 項 (共 42 項)」這種位置資訊
  const STRIP_POS = /[，,、]?\s*第\s*\d+\s*項\s*(?:[（(]\s*共\s*\d+\s*項\s*[）)])?\s*$/;
  const stripQuotes = (s) => String(s).replace(/^[「『"'\s]+/, '').replace(/[」』"'\s]+$/, '');

  // 有些列的 innerText 會把左邊的圖示字元（✎ ＋ 💬）也帶進來，先剝掉
  function stripIcons(s) {
    let t = String(s == null ? '' : s);
    t = t.replace(/^(?:[\p{So}\p{S}\p{Sk}]\s*)+/u, '');
    t = t.replace(/[\s⋮︙⋯]+$/u, '');
    return norm(t);
  }


  function inRail(el) {
    const r = el.getBoundingClientRect();
    return r.left >= -24 && r.left <= 420 && r.width >= 110 && r.width <= 400;
  }

  function findMoreButtons() {
    const out = [];
    const nodes = document.querySelectorAll('button[aria-label], [role="button"][aria-label], [aria-label][jsname]');
    for (const b of nodes) {
      const label = b.getAttribute('aria-label') || '';
      if (!MORE_LABEL.test(label)) continue;
      if (!isShown(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.left > 420 || r.width > 60 || r.width < 8) continue;
      out.push(b);
    }
    return out;
  }

  const stripMore = (s) => stripQuotes(stripIcons(norm(norm(s).replace(STRIP_MORE, '').replace(STRIP_POS, ''))));

  function rowFromMoreButton(btn) {
    let el = btn;
    for (let i = 0; i < 6; i++) {
      el = el.parentElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.height >= 26 && r.height <= 110 && r.width >= 130 && r.width <= 420) {
        const t = norm(el.innerText);
        if (t && t.length > 0) return el;
      }
    }
    return null;
  }

  function titleOfRow(row, btn) {
    let t = '';
    if (btn) t = stripMore(btn.getAttribute('aria-label'));
    if (!t) {
      const lbl = row.getAttribute && row.getAttribute('aria-label');
      if (lbl) t = stripMore(lbl);
    }
    if (!t) {
      const inner = row.querySelector('[aria-label]');
      if (inner && inner !== row) {
        const cand = stripMore(inner.getAttribute('aria-label'));
        if (cand && cand.length < 200) t = cand;
      }
    }
    if (!t) t = row.innerText || row.textContent || '';
    t = stripQuotes(stripIcons(norm(t).replace(STRIP_MORE, '')));
    t = stripQuotes(stripIcons(norm(t).replace(STRIP_POS, '')));
    if (t.length > 220) t = t.slice(0, 220);
    return t;
  }

  function heuristicRows() {
    const cands = [];
    const nodes = document.querySelectorAll('[role="button"], a[href], li, [tabindex="0"]');
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width < 118 || r.width > 400) continue;
      if (r.left < -24 || r.left > 420) continue;
      if (r.height < 26 || r.height > 100) continue;
      const t = stripIcons(el.innerText);
      if (!t || t.length > 180) continue;
      if (isFixedLabel(t)) continue;
      cands.push(el);
    }
    const groups = new Map();
    for (const el of cands) {
      const p = el.parentElement;
      if (!p) continue;
      const k = p;
      if (!groups.has(k)) groups.set(k, new Map());
      const byTag = groups.get(k);
      if (!byTag.has(el.tagName)) byTag.set(el.tagName, []);
      byTag.get(el.tagName).push(el);
    }
    let best = [];
    for (const [parent, byTag] of groups) {
      // 這個容器裡如果塞了一堆導覽項（新增/搜尋/筆記本），那就不是討論串清單
      const fixedSiblings = [...parent.children].filter((c) => isFixedLabel(stripIcons(c.innerText))).length;
      if (fixedSiblings >= 2) continue;
      for (const arr of byTag.values()) {
        if (arr.length < 3) continue;
        const hs = arr.map((e) => e.getBoundingClientRect().height);
        const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
        if (hs.some((x) => Math.abs(x - avg) > 14)) continue;
        // 需要垂直連續（避免抓到散落各處的按鈕）
        const sorted = arr.slice().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        let contiguous = true;
        for (let i = 1; i < sorted.length; i++) {
          const gap = sorted[i].getBoundingClientRect().top - sorted[i - 1].getBoundingClientRect().bottom;
          if (gap > 60) { contiguous = false; break; }
        }
        if (!contiguous && arr.length < 6) continue;
        if (arr.length > best.length) best = arr;
      }
    }
    return best;
  }

  function rowShapeOk(el) {
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.height > 130) return false;
    if (r.width < 100) return false;
    return !!norm(el.innerText);
  }

  // 校準結果「直接對到每一列」
  // 優先：class（同一份 DOM 裡每一列都共用）→ 其次：父層路徑 + 標籤
  function matchCalibrated() {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el) || !el.isConnected) return;
      if (!rowShapeOk(el)) return;
      seen.add(el);
      out.push(el);
    };

    if (cfg.rowClass) {
      let els = [];
      try { els = [...document.querySelectorAll('.' + CSS.escape(cfg.rowClass))]; } catch (_) { els = []; }
      if (els.length <= 400) els.forEach(add);
    }
    if (!out.length && cfg.rowSelector) {
      let els = [];
      try { els = [...document.querySelectorAll(cfg.rowSelector)]; } catch (_) { els = []; }
      if (els.length <= 400) els.forEach(add);
    }
    return out.length > 400 ? [] : out;
  }

  // 完全不靠校準的偵測
  function autoRows() {
    const list = [];
    const seen = new Set();
    for (const b of findMoreButtons()) {
      const row = rowFromMoreButton(b);
      if (!row || seen.has(row)) continue;
      seen.add(row);
      list.push({ el: row, title: titleOfRow(row, b) });
    }
    if (list.length >= 2) return list;

    for (const el of heuristicRows()) {
      if (seen.has(el)) continue;
      seen.add(el);
      list.push({ el, title: titleOfRow(el, null) });
    }
    return list;
  }

  function dedupeRows(list) {
    const out = [];
    for (const it of list) {
      if (!it.el || !it.el.isConnected) continue;
      if (out.some((o) => o.el === it.el)) continue;
      if (out.some((o) => o.el.contains(it.el) || it.el.contains(o.el))) {
        // 保留外層（比較大、含更多資訊）
        const idx = out.findIndex((o) => o.el.contains(it.el) || it.el.contains(o.el));
        if (idx >= 0) {
          const a = out[idx];
          if (a.el.contains(it.el)) continue;
          out[idx] = it;
          continue;
        }
      }
      out.push(it);
    }
    return out;
  }

  let selfHealNotified = false;

  function detectRows() {
    const cal = matchCalibrated();
    let raw;

    if (cal.length >= 2) {
      // 校準有效就信校準
      raw = cal.map((el) => ({ el, title: titleOfRow(el, null) }));
    } else {
      const auto = autoRows();
      // 校準只抓到 1 個（選擇器選錯）→ 自動偵測比較準就換掉它
      if (auto.length >= 2 || auto.length > cal.length) {
        raw = auto;
        if (cfg.rowClass || cfg.rowSelector) {
          cfg.rowClass = '';
          cfg.rowSelector = '';
          cfg.rowTag = '';
          saveCfgSoon();
          if (!selfHealNotified) {
            selfHealNotified = true;
            toast(t('toast.healed'), 3200);
          }
        }
      } else {
        raw = cal.map((el) => ({ el, title: titleOfRow(el, null) }));
      }
    }

    const list = [];
    for (const it of raw) {
      const t = norm(it.title);
      if (!it.el || !t) continue;
      if (isFixedLabel(t)) continue;
      list.push({ el: it.el, title: t });
    }
    const d = dedupeRows(list);
    d.sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
    const used = new Set();
    return d.map((r) => ({ el: r.el, title: r.title, key: keyOf(r.el, r.title, used) }));
  }

  // 每一列的身分證：優先用 Google 的 data-thread-id
  // 同名討論串（例如兩個 Browser Harness）才有辦法各自勾、各自刪
  function keyOf(el, title, used) {
    let id = '';
    try {
      const b = el.querySelector('[data-thread-id]');
      id = (b && b.getAttribute('data-thread-id')) || (el.getAttribute && el.getAttribute('data-thread-id')) || '';
    } catch (_) {}
    const base = id ? 'id:' + id : 't:' + title;
    let k = base;
    let n = 1;
    while (used.has(k)) k = base + '#' + (n++);
    used.add(k);
    return k;
  }

  const titlesNow = () => detectRows().map((r) => r.title);

  /* ============================================================
   *  選取 / 繪製
   * ============================================================ */
  function toggle(key) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    syncSelectionUI();
  }

  function syncSelectionUI() {
    const kids = elList.children;
    for (let i = 0; i < rows.length && i < kids.length; i++) {
      const on = selected.has(rows[i].key);
      const item = kids[i];
      if (!item || !item.classList.contains('item')) continue;
      item.classList.toggle('on', on);
      const cb = item.firstElementChild;
      if (cb) cb.textContent = on ? '✓' : '';
    }
    elSel.textContent = String(selected.size);
    elBadge.textContent = String(selected.size);
    renderOverlay();
    btnDel.disabled = busy ? false : selected.size === 0;
  }

  function renderList() {
    const key = rows.map((r) => r.key).join('\u0000');
    if (key === lastListKey) { syncSelectionUI(); return; }
    lastListKey = key;

    elList.textContent = '';
    if (!rows.length) {
      elList.append(h('div', { class: 'empty' },
        h('div', { text: t('empty.none') }),
        h('div', { text: t('empty.h1') }),
        h('div', { text: t('empty.h2') })
      ));
      syncSelectionUI();
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const on = selected.has(row.key);
      const item = h('div', { class: 'item' + (on ? ' on' : '') },
        h('span', { class: 'cb', text: on ? '✓' : '' }),
        h('span', { class: 't', title: row.title, text: row.title }),
        h('button', { class: 'del1', title: t('btn.delOne'), text: '✕' })
      );
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('del1')) {
          e.stopPropagation();
          deleteSingle(row.key);
          return;
        }
        toggle(row.key);
      });
      frag.append(item);
    }
    elList.append(frag);
    syncSelectionUI();
  }

  /* ---- 頁面上的勾選框（覆蓋層，不碰 Google 的 DOM） ---- */
  // 有些列的左緣就緊貼標題文字，硬畫上去會蓋掉第一個字。
  // 所以先幫每一列「讓出左邊一條走道」（只改 padding-left），框子畫在走道裡，
  // 保證不會壓到任何文字。停用時會把 padding 還原。
  const GUTTER = 26;
  const BOX = 16;
  const basePad = new Map();   // el -> 原始 padding-left

  function ensureGutter(el) {
    if (!basePad.has(el)) {
      basePad.set(el, parseFloat(getComputedStyle(el).paddingLeft) || 0);
    }
    const want = basePad.get(el) + GUTTER;
    const cur = parseFloat(el.style.paddingLeft);
    if (!(cur >= want - 0.5 && cur <= want + 0.5)) {
      el.style.paddingLeft = want + 'px';
    }
  }

  function releaseGutter(el) {
    if (!basePad.has(el)) return;
    const base = basePad.get(el);
    el.style.paddingLeft = base ? base + 'px' : '';
    basePad.delete(el);
  }

  function releaseAllGutters() {
    for (const el of basePad.keys()) {
      const base = basePad.get(el);
      try { el.style.paddingLeft = base ? base + 'px' : ''; } catch (_) {}
    }
    basePad.clear();
  }

  const boxes = [];
  function mkBox() {
    const b = h('div', { class: 'box' });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const k = b.dataset.k;
      if (k) toggle(k);
    });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    return b;
  }

  function renderOverlay() {
    const show = cfg.overlay && rows.length > 0 && (!cfg.hidden || forced);
    overlayEl.style.display = show ? 'block' : 'none';
    if (!show) {
      while (boxes.length) boxes.pop().remove();
      releaseAllGutters();
      return;
    }

    // 已經從 DOM 消失的列，把紀錄清掉
    for (const el of basePad.keys()) if (!el.isConnected) basePad.delete(el);

    while (boxes.length < rows.length) {
      const b = mkBox();
      overlayEl.append(b);
      boxes.push(b);
    }
    while (boxes.length > rows.length) boxes.pop().remove();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const b = boxes[i];
      ensureGutter(row.el);
      const r = row.el.getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.bottom < 0 || r.top > vh || r.width <= 0) { b.style.display = 'none'; continue; }
      b.style.display = 'flex';
      b.style.transform = 'translate(' + Math.round(r.left + 5) + 'px,' +
        Math.round(r.top + (r.height - BOX) / 2) + 'px)';
      const on = selected.has(row.key);
      b.classList.toggle('on', on);
      b.textContent = on ? '✓' : '';
      b.dataset.k = row.key;
    }
  }

  let rafPending = false;
  function scheduleOverlay() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderOverlay();
    });
  }
  window.addEventListener('scroll', scheduleOverlay, true);
  window.addEventListener('resize', () => { scheduleOverlay(); clampPanel(); }, true);

  /* ============================================================
   *  刪除引擎
   * ============================================================ */
  function hover(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const sent = [
      () => el.dispatchEvent(new PointerEvent('pointerover', o)),
      () => el.dispatchEvent(new MouseEvent('mouseover', o)),
      () => el.dispatchEvent(new PointerEvent('pointermove', o)),
      () => el.dispatchEvent(new MouseEvent('mousemove', o)),
      () => el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, o, { bubbles: false }))),
      () => el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, o, { bubbles: false }))),
    ];
    for (const f of sent) { try { f(); } catch (_) {} }
  }

  function realClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (__) { return false; }
    }
  }

  function findMoreIn(row) {
    if (!row) return null;
    const rr = row.getBoundingClientRect();
    const cands = row.querySelectorAll('button, [role="button"], [aria-label]');
    let best = null;
    let bestScore = 0;
    for (const b of cands) {
      if (b === row) continue;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width > 52 || r.height > 52) continue;
      let s = 0;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      if (MORE_LABEL.test(label)) s += 12;
      if (b.tagName === 'BUTTON') s += 2;
      if (!norm(b.innerText).replace(/[⋮︙⋯.]/g, '')) s += 2;
      if (r.left > rr.left + rr.width * 0.55) s += 4;
      if (s > bestScore) { bestScore = s; best = b; }
    }
    return bestScore >= 6 ? best : null;
  }

  function menuNow() {
    const cands = document.querySelectorAll('[role="menu"], [role="listbox"], .VfPpkd-xl07Ob, [popover]');
    for (const m of cands) {
      const r = m.getBoundingClientRect();
      if (r.width < 60 || r.height < 20) continue;
      if (getComputedStyle(m).visibility === 'hidden') continue;
      return m;
    }
    return null;
  }

  function anyVisibleMenu() {
    // 有些版本的選單沒有 role=menu：直接從「刪除」這個 menuitem 往上找浮層
    const items = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]');
    for (const it of items) {
      if (!isShown(it)) continue;
      const t = norm(it.innerText || it.textContent);
      if (!t || t.length > 40 || !DEL_TEXT.test(t)) continue;
      let p = it.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const cs = getComputedStyle(p);
        if (cs.position === 'absolute' || cs.position === 'fixed') return p;
        p = p.parentElement;
      }
      return it.parentElement;
    }
    return null;
  }

  const DEL_TEXT = /^(刪除|刪掉|移除|delete|remove|delete thread|delete conversation|刪除討論串|刪除對話)$/i;
  const NO_DEL = /(取消|cancel|還原|undo)/i;

  function findMenuDelete(menu) {
    if (!menu) return null;
    const items = menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, [role="button"], li');
    for (const it of items) {
      if (!isShown(it)) continue;
      const t = norm(it.innerText || it.textContent);
      if (!t || t.length > 40) continue;
      if (NO_DEL.test(t)) continue;
      if (DEL_TEXT.test(t)) return it;
    }
    // 寬鬆比對
    for (const it of items) {
      if (!isShown(it)) continue;
      const t = norm(it.innerText || it.textContent);
      if (/^(刪除|delete)/i.test(t) && !NO_DEL.test(t)) return it;
    }
    return null;
  }

  function confirmDialog() {
    const ds = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]');
    const vis = [];
    for (const d of ds) {
      if (!isShown(d)) continue;
      if (d.closest('#amb-bulk-host')) continue;
      vis.push(d);
    }
    for (const d of vis) if (findDialogDelete(d)) return d;
    return vis.length ? vis[0] : null;
  }

  function findDialogDelete(d) {
    if (!d) return null;
    const btns = d.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      if (!isShown(b)) continue;
      const t = norm(b.innerText || b.textContent);
      if (!t || t.length > 24) continue;
      if (NO_DEL.test(t)) continue;
      if (DEL_TEXT.test(t)) return b;
    }
    return null;
  }

  async function openRowMenu(rowEl) {
    let btn = findMoreIn(rowEl);
    if (!btn) {
      hover(rowEl);
      await sleepAB(220);
      btn = findMoreIn(rowEl);
    }
    if (btn) {
      hover(btn);
      await sleepAB(60);
      btn.click();
      let menu = await waitFor(menuNow, 900, 80) || await waitFor(anyVisibleMenu, 500, 80);
      if (menu) return menu;
      realClick(btn);
      menu = await waitFor(menuNow, 900, 80) || await waitFor(anyVisibleMenu, 500, 80);
      if (menu) return menu;
    }

    // 退路 1：右鍵選單
    hover(rowEl);
    try {
      const r = rowEl.getBoundingClientRect();
      rowEl.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2,
      }));
    } catch (_) {}
    let menu = await waitFor(menuNow, 700, 80) || await waitFor(anyVisibleMenu, 500, 80);
    if (menu) return menu;

    // 退路 2：鍵盤 Shift+F10
    try {
      const target = rowEl.matches('[tabindex]') ? rowEl : (rowEl.querySelector('[tabindex]') || rowEl);
      target.focus && target.focus();
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, {
          key: 'F10', code: 'F10', keyCode: 121, which: 121, shiftKey: true, bubbles: true, cancelable: true,
        }));
      }
    } catch (_) {}
    menu = await waitFor(menuNow, 700, 80) || await waitFor(anyVisibleMenu, 500, 80);
    if (menu) return menu;

    throw new Error(t('err.more'));
  }

  async function deleteThread(key) {
    let list = detectRows();
    let row = list.find((r) => r.key === key);
    if (!row) {
      await loadMoreTick();
      list = detectRows();
      row = list.find((r) => r.key === key);
    }
    if (!row) throw new Error(t('err.row'));

    // 用身分證判斷這一列真的不見了（同名討論串也不會誤判）
    const hasKey = () => detectRows().some((r) => r.key === key);
    const goneCheck = () => !hasKey();

    try { row.el.scrollIntoView({ block: 'center' }); } catch (_) {}
    await sleepAB(150);

    const menu = await openRowMenu(row.el);
    const del = findMenuDelete(menu);
    if (!del) {
      document.body.click();
      throw new Error(t('err.noDelete'));
    }

    realClick(del);

    let gone = await waitUntil(goneCheck, 800, 200);
    if (!gone) {
      const dlg = await waitFor(() => confirmDialog(), 1200, 100);
      if (dlg) {
        const ok = findDialogDelete(dlg);
        if (!ok) {
          try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
          throw new Error(t('err.noOkBtn'));
        }
        realClick(ok);
      }
    }

    gone = await waitUntil(goneCheck, 6000, 220);
    if (!gone) {
      try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (_) {}
      throw new Error(t('err.notDeleted'));
    }
    return true;
  }

  function log(msg, cls) {
    elLog.classList.add('show');
    const line = h('div', { class: cls || '' , text: msg });
    elLog.append(line);
    while (elLog.children.length > 60) elLog.firstElementChild.remove();
    elLog.scrollTop = elLog.scrollHeight;
  }
  function progress(p) {
    elProgWrap.classList.add('show');
    elProg.style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
  }

  function setBusy(v) {
    busy = v;
    // 跑的時候這顆要變成「停止」，所以不能被 disable
    btnDel.disabled = v ? false : selected.size === 0;
    btnDel.textContent = v ? t('btn.stop') : t('btn.del');
    btnDel.classList.toggle('danger', !v);
    btnDel.classList.toggle('on', v);
    btnAll.disabled = v; btnInv.disabled = v; btnNone.disabled = v; btnScan.disabled = v; btnLoad.disabled = v;
    btnExp.disabled = v; btnExpFull.disabled = v;
  }

  async function startDelete() {
    if (busy) { abort = true; log(t('log.stopReq')); return; }
    const targets = rows.filter((r) => selected.has(r.key)).map((r) => ({ key: r.key, title: r.title }));
    if (!targets.length) { toast(t('toast.needSelect')); return; }

    const ok = await ask(
      '要刪掉 ' + targets.length + ' 個討論串？',
      '這個動作會直接從 Google 帳號刪除，無法復原。\n\n第一筆：' + targets[0].title +
      (targets.length > 1 ? '\n最後一筆：' + targets[targets.length - 1].title : ''),
      '刪除 ' + targets.length + ' 個'
    );
    if (!ok) return;

    abort = false;
    setBusy(true);
    elLog.classList.add('show');
    elLog.textContent = '';
    progress(0);
    log(t('log.deleteStart', { n: targets.length, ms: cfg.delay }));

    let done = 0;
    const failed = [];
    for (let i = 0; i < targets.length; i++) {
      if (abort) { log(t('log.stopped')); break; }
      const title = targets[i].title;
      const short = title.length > 34 ? title.slice(0, 34) + '…' : title;
      log('(' + (i + 1) + '/' + targets.length + ') ' + short);
      try {
        await deleteThread(targets[i].key);
        done++;
        selected.delete(targets[i].key);
        log(t('log.ok'), 'ok');
      } catch (e) {
        failed.push(title);
        log('   ✗ ' + (e && e.message ? e.message : e), 'bad');
        if (String(e && e.message).indexOf('找不到 ⋮') >= 0) {
          log(t('log.calStop'), 'bad');
          abort = true;
        }
      }
      refresh(true);
      progress((i + 1) / targets.length);
      if (i < targets.length - 1) await sleepAB(cfg.delay);
    }

    setBusy(false);
    progress(1);
    log(t('log.deleteEnd', { a: done, b: failed.length }), failed.length ? 'bad' : 'ok');
    toast(t('toast.deleteDone', { a: done, b: failed.length }), 3200);
    refresh(true);
  }

  async function deleteSingle(key) {
    if (busy) return;
    const row = rows.find((r) => r.key === key);
    const title = row ? row.title : key;
    const ok = await ask('刪掉這一個？', title, '刪除');
    if (!ok) return;
    setBusy(true);
    elLog.classList.add('show');
    log(t('log.single', { t: title }));
    try {
      await deleteThread(key);
      selected.delete(key);
      log(t('log.ok'), 'ok');
    } catch (e) {
      log('   ✗ ' + (e && e.message ? e.message : e), 'bad');
    }
    setBusy(false);
    refresh(true);
  }

  /* ============================================================
   *  載入更多
   * ============================================================ */
  function scrollerOf(el) {
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const cs = getComputedStyle(cur);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 24) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function moreButton() {
    const nodes = document.querySelectorAll('button, [role="button"], a');
    for (const b of nodes) {
      const r = b.getBoundingClientRect();
      if (r.left > 420 || r.width < 60) continue;
      const t = norm(b.innerText);
      if (/^(顯示更多|查看更多|載入更多|看更多|show more|load more|more)$/i.test(t)) return b;
    }
    return null;
  }

  async function loadMoreTick() {
    const btn = moreButton();
    if (btn) { hover(btn); btn.click(); await sleepAB(500); return true; }
    const anchor = rows[0] && rows[0].el;
    const sc = anchor ? scrollerOf(anchor) : null;
    if (!sc) return false;
    sc.scrollTop = sc.scrollHeight;
    await sleepAB(450);
    return true;
  }

  async function loadAll() {
    if (busy) return;
    setBusy(true);
    elLog.classList.add('show');
    log(t('log.loadStart'));
    let last = -1;
    let same = 0;
    for (let i = 0; i < 45; i++) {
      if (abort) break;
      refresh(true);
      if (rows.length === last) {
        same++;
        if (same >= 3) break;
      } else {
        same = 0;
        last = rows.length;
        log(t('log.loadNow', { n: rows.length }));
      }
      const acted = await loadMoreTick();
      if (!acted) break;
    }
    const sc = rows[0] && scrollerOf(rows[0].el);
    if (sc) sc.scrollTop = 0;
    setBusy(false);
    log(t('log.loadEnd', { n: rows.length }), 'ok');
    refresh(true);
  }

  /* ============================================================
   *  匯出
   * ============================================================ */
  // 只匯出「標題清單」：純文字 不產生 .md
  function exportList() {
    const list = rows.filter((r) => selected.has(r.key));
    const use = list.length ? list : rows;
    if (!use.length) { toast(t('toast.nothingToExport')); return; }
    const body = use.map((r, i) => (i + 1) + '. ' + r.title).join('\n');
    const loc = cfg.lang === 'en' ? 'en-US' : cfg.lang === 'zh-CN' ? 'zh-CN' : 'zh-TW';
    const txt = t('file.listTitle') + '\n\n' +
      t('file.time') + new Date().toLocaleString(loc) + '\n' +
      t('file.countOnly') + use.length + (list.length ? t('file.onlySel') : t('file.onlyAll')) + '\n' +
      t('file.source') + location.href + '\n\n' +
      '─'.repeat(46) + '\n\n' + body + '\n';
    saveText('ai-mode-thread-list-' + new Date().toISOString().slice(0, 10) + '.txt', txt, 'text/plain');
    toast(t('toast.listExported', { n: use.length }));
  }

  /* ============================================================
   *  匯出討論串內容
   *  作法：一篇一篇點開，等內容穩定後把「對話區」的文字抓下來
   * ============================================================ */
  function saveText(filename, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.documentElement.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  }

  // 用「元素探針」找對話區：從畫面右半邊某一點往上找，最大但又不含側邊欄的容器
  // 這樣不管 Google 用 main / #main / 全寬 wrapper 都吃得下
  function probeBox() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const rowEls = rows.map((r) => r.el);

    const bad = (el) => {
      if (!el || el === document.body || el === document.documentElement) return true;
      if (el.closest && el.closest('#amb-bulk-host')) return true;
      if (el.closest && el.closest('[role="dialog"], [role="alertdialog"]')) return true;
      return rowEls.some((re) => el.contains(re));
    };

    // 對話區一定在側邊欄右邊，所以先算出側邊欄右緣，再往右邊多點取樣
    let railRight = 0;
    for (const r of rows) {
      const b = r.el.getBoundingClientRect();
      if (b.right > railRight) railRight = b.right;
    }
    const x0 = railRight > 40 && railRight < vw * 0.6 ? railRight : vw * 0.42;
    const xs = [x0 + (vw - x0) * 0.5, x0 + 24, x0 + (vw - x0) * 0.78];

    for (const fy of [0.15, 0.3, 0.45, 0.62, 0.78]) {
      for (const x of xs) {
        if (x >= vw - 4) continue;
        let stack = [];
        try {
          stack = document.elementsFromPoint(Math.round(x), Math.round(vh * fy)) || [];
        } catch (_) { stack = []; }
        let best = null;
        for (const el of stack) {
          if (bad(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 240 || r.height < 120) continue;
          if ((el.textContent || '').length < 40) continue;
          best = el;   // stack 是由內往外，最後一個符合的就是最大的合法容器
        }
        if (best) return best;
      }
    }
    return null;
  }

  function contentBoxes() {
    const out = [];
    const rowEls = rows.map((r) => r.el);
    const usable = (el) => {
      if (!el || !el.isConnected) return false;
      if (el === document.body || el === document.documentElement) return false;
      if (el.closest && el.closest('#amb-bulk-host')) return false;
      return !rowEls.some((re) => el.contains(re));
    };

    if (cfg.contentSelector) {
      try {
        const el = document.querySelector(cfg.contentSelector);
        if (usable(el)) out.push(el);
      } catch (_) {}
    }

    const p = probeBox();
    if (p && out.indexOf(p) < 0) out.push(p);

    for (const q of ['main', '[role="main"]', '#main']) {
      const el = document.querySelector(q);
      if (usable(el) && out.indexOf(el) < 0) out.push(el);
    }
    return out;
  }

  function cleanText(s) {
    return String(s || '')
      .replace(/\r/g, '')
      .replace(/[\u00a0\u200b]/g, ' ')
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const SKIP_TAG = /^(SCRIPT|STYLE|SVG|NOSCRIPT|BUTTON|INPUT|TEXTAREA|IFRAME|IMG|CANVAS|SELECT)$/;

  /* ---- 來源卡片 / 廣告 ----
     回答尾巴那一排「來源」卡片（favicon + 網站名 + 標題 + 摘要）不收進檔案
     Google 的來源連結是跳轉網址（www.google.com/url?q=… 或 vertexaisearch 的 grounding redirect）
     所以不能看到 google 網域就當成「站內連結」跳過 這一點是之前沒掃乾淨的原因
     另外也認沒有 <a>、只用 role="link" 做的卡片（同一個容器裡 ≥2 張、都有小圖示）

     判斷原則：外連 <a> 往上找「文字幾乎都落在連結裡、而且不長」的容器就是卡片
     回答本文裡的連結不會被誤刪 因為那種容器扣掉連結文字後還有一大段正文
     P / LI / H / PRE 這種正文標籤一律不動 */
  const EXT_HREF = /^https?:\/\//i;
  const GOOGLE_HOST = /(^|\.)google\.[a-z.]{2,}$/i;
  const GOOGLE_REDIRECT = /(^|\.)(vertexaisearch\.cloud\.google\.com|googleusercontent\.com|googleapis\.com)$/i;
  const REDIRECT_PATH = /\/url\?|\/interstitial|grounding|redirect|aclk|\/imgres/i;
  const CARD_LABEL = /^(來源|来源|資料來源|參考來源|参考来源|引用來源|引用|來源網站|sources?|citations?|references?)\s*[:：]?$/i;
  const TEXT_TAG = /^(P|LI|H[1-6]|PRE|TD|TH|BLOCKQUOTE|FIGCAPTION)$/;
  const FAVICON = 'img, svg, [role="img"], [class*="favicon"], [class*="Favicon"]';
  const AD_LABEL = /(廣告|广告|贊助|赞助|sponsored|advertisement|ad choices)/i;
  const AD_BADGE = /^(廣告|广告|贊助|赞助|sponsored|advertisement|ad)$/i;

  function isExtLink(a) {
    if (!a || !a.getAttribute) return false;
    const href = a.getAttribute('href') || '';
    if (!EXT_HREF.test(href)) return false;
    let hn = '';
    try { hn = new URL(href, location.href).hostname || ''; } catch (_) { return false; }
    if (!hn) return false;
    if (hn === location.hostname) return false;
    if (a.closest && a.closest('pre, code')) return false;
    // 來源卡片是 google 的跳轉連結 這種要算外部連結
    if (GOOGLE_REDIRECT.test(hn)) return true;
    if (GOOGLE_HOST.test(hn)) return REDIRECT_PATH.test(href);
    return true;
  }

  function isShownEl(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (_) { return true; }
  }

  function stripSources(root) {
    if (!root) return 0;
    const txt = (el) => norm(el.textContent || '');
    const extCount = (el) => Array.from(el.querySelectorAll('a[href]')).filter(isExtLink).length;
    const cards = [];
    const addCard = (el) => {
      if (!el) return;
      if (cards.some((c) => c === el || c.contains(el) || el.contains(c))) return;
      cards.push(el);
    };

    // 1) 有 <a href> 的卡片：從連結往上找「文字幾乎都在連結裡」的容器
    for (const a of Array.from(root.querySelectorAll('a[href]')).filter(isExtLink)) {
      const own = txt(a).length;
      if (own < 10) continue;                 // 太短的（行內引用的小標號）當成正文
      const chain = [];
      let cur = a;
      for (let depth = 0; depth < 6; depth++) {
        if (!cur || cur === root) break;
        if (depth && TEXT_TAG.test(cur.tagName)) break;
        const t = txt(cur).length;
        if (t > 600) break;
        if (extCount(cur) > 1) break;
        if (t - own > 60) break;
        chain.push(cur);
        cur = cur.parentElement;
      }
      if (!chain.length) continue;
      // 正文段落裡的連結（沒往上長出去）不算卡片
      if (chain.length === 1 && a.parentElement && TEXT_TAG.test(a.parentElement.tagName)) continue;

      let card = null;                        // 有 favicon 的最外層就是卡片
      for (const el of chain) if (el.querySelector(FAVICON)) card = el;
      if (!card) card = chain[chain.length - 1];
      if (card === a && !a.querySelector(FAVICON)) continue;   // 純文字連結 不動
      addCard(card);
    }

    // 2) 沒有 <a>、用 role="link" 做的卡片：同一容器裡 ≥2 張、都有小圖示才認
    const grouped = new Map();
    for (const el of root.querySelectorAll('[role="link"]')) {
      if (el.tagName === 'A') continue;
      if (!isShownEl(el)) continue;
      const t = txt(el);
      if (t.length < 10 || t.length > 400) continue;
      if (!el.querySelector(FAVICON)) continue;
      if (el.closest && el.closest('p, li, h1, h2, h3, h4, h5, h6, pre, blockquote')) continue;
      const p = el.parentElement;
      if (!p) continue;
      if (!grouped.has(p)) grouped.set(p, []);
      grouped.get(p).push(el);
    }
    for (const arr of grouped.values()) if (arr.length >= 2) arr.forEach(addCard);

    // 3) 空殼 <a>：Google 的來源／廣告卡片常常是「一個沒有文字、只有 aria-label 的連 <a>」
    //    真正的網站名、標題、摘要都放在它的兄弟節點裡（風 抓到的就是這種）
    //    只有「卡片上的字真的包含 aria-label」時才動手，避免誤殺正文裡的引用小標
    const shellOk = (a) => {
      if (!a || a.tagName !== 'A') return false;
      if (norm(a.textContent || '').length > 3) return false;
      if (norm(a.getAttribute('aria-label') || '').length < 2) return false;
      if (!EXT_HREF.test(a.getAttribute('href') || '')) return false;
      if (a.closest && a.closest('pre, code')) return false;
      return true;
    };
    const shells = Array.from(root.querySelectorAll('a[href][aria-label]')).filter(shellOk);
    for (const a of shells) {
      const lab = norm(a.getAttribute('aria-label') || '');
      const key = lab.slice(0, 24);
      const key2 = lab.slice(0, 14);
      let box = a.parentElement;
      let best = null;
      for (let depth = 0; depth < 5 && box && box !== root; depth++) {
        if (TEXT_TAG.test(box.tagName)) break;      // 正文標籤（p / li / h）一律不動
        const t = txt(box);
        if (t.length > 1200) break;
        if (box.querySelector('p, li, h1, h2, h3, h4, h5, h6, pre, table, blockquote')) break;
        const others = Array.from(box.querySelectorAll('a[href][aria-label]')).filter(shellOk).length;
        if (others > 1) break;                       // 已經走到「整排卡片」那層
        const matched = t.indexOf(lab) >= 0 || t.indexOf(key) >= 0 || t.indexOf(key2) >= 0;
        // 卡片一定有小圖示（favicon）或縮圖 用這個擋掉「正文段落裡的引用小標」
        if (matched && t.length >= lab.length && box.querySelector('img, [role="img"], svg')) best = box;
        box = box.parentElement;
      }
      if (best) addCard(best);
    }

    // 3b) Google 來源面板的正字標記：每張卡都有 data-src-id（點開才知道原來它一直都長這樣）
    for (const el of root.querySelectorAll('[data-src-id], [data-crb-el]')) {
      if (!isShownEl(el)) continue;
      if (el.closest && el.closest('pre, code')) continue;
      const t = txt(el);
      if (t.length < 5 || t.length > 3000) continue;
      addCard(el);
    }

    // 4) 就算對不上 aria-label：同一個容器裡有 ≥2 個空殼 就是「一排卡片」
    //    取最小的那一層（第一層出現 ≥2 個空殼的祖先）整排砍掉
    for (const a of shells) {
      let box = a.parentElement;
      for (let depth = 0; depth < 5 && box && box !== root; depth++) {
        const t = txt(box).length;
        if (t > 4000) break;
        // 卡片列本身可能就是 ul > li，所以這裡只擋真正的正文標籤
        if (box.querySelector('p, h1, h2, h3, h4, h5, h6, pre, table, blockquote')) break;
        const n = Array.from(box.querySelectorAll('a[href][aria-label]')).filter(shellOk).length;
        if (n >= 2) { addCard(box); break; }
        box = box.parentElement;
      }
    }

    if (!cards.length) return 0;

    // 3) 往上併成「來源區塊」：除了卡片以外只剩「來源」這種標籤才併
    const insideLen = (el) => cards.reduce((n, c) => n + (el.contains(c) ? txt(c).length : 0), 0);
    const blocks = [];
    for (const card of cards) {
      let cur = card;
      for (let depth = 0; depth < 4; depth++) {
        const p = cur.parentElement;
        if (!p || p === root) break;
        if (TEXT_TAG.test(p.tagName)) break;
        if (p.querySelector('p, li, h1, h2, h3, h4, h5, h6, pre, table, blockquote')) break;
        if (txt(p).length - insideLen(p) > 24) break;
        cur = p;
      }
      if (blocks.indexOf(cur) < 0) blocks.push(cur);
    }

    let n = 0;
    for (const el of blocks) {
      if (!el.isConnected) continue;
      if (blocks.some((o) => o !== el && o.contains(el))) continue;
      el.remove();
      n++;
    }

    // 4) 卡片砍掉了 但「來源」標籤還孤零零留著的 一起清掉
    for (const el of Array.from(root.querySelectorAll('div, span'))) {
      if (!el.isConnected || el.querySelector('*')) continue;
      const s = norm(el.textContent || '');
      if (s && s.length <= 12 && CARD_LABEL.test(s)) { el.remove(); n++; }
    }
    return n;
  }

  /* 旁邊那欄的廣告（Genspark 那種贊助卡）也會被一起抓進來 這裡把它們清掉 */
  function stripAds(root) {
    if (!root) return 0;
    const txt = (el) => norm(el.textContent || '');
    let n = 0;
    const kill = (el) => { if (el && el.isConnected && el.parentElement) { el.remove(); n++; } };

    // (1) 有明確廣告標記的
    for (const el of Array.from(root.querySelectorAll('[data-ad], [data-ad-slot], [data-ads], [data-text-ad], [aria-label]'))) {
      if (!el.isConnected) continue;
      const marked = el.hasAttribute('data-ad') || el.hasAttribute('data-ad-slot') ||
        el.hasAttribute('data-ads') || el.hasAttribute('data-text-ad');
      if (!marked && !AD_LABEL.test(el.getAttribute('aria-label') || '')) continue;
      if (txt(el).length > 2000) continue;
      kill(el);
    }

    // (2) 「贊助」這種小標：往上找它那張卡
    for (const el of Array.from(root.querySelectorAll('div, span'))) {
      if (!el.isConnected || el.querySelector('*')) continue;
      const s = norm(el.textContent || '');
      if (!s || s.length > 12 || !AD_BADGE.test(s)) continue;
      let box = el.parentElement;
      for (let i = 0; i < 4 && box && box !== root; i++) {
        const t = txt(box);
        if (t.length > 1200) break;
        if (TEXT_TAG.test(box.tagName)) break;
        if (box.querySelectorAll('p').length > 1) break;
        if (box.querySelector('img, svg, a[href], [role="link"]') || i === 1) { kill(box); break; }
        box = box.parentElement;
      }
    }
    return n;
  }

  // 把對話區拆成一塊一塊（標題 / 段落 / 項目 / 程式碼），後面再自己排版
  function renderFlow(box) {
    const parts = [];
    let buf = '';
    let kind = 'p';

    const flush = () => {
      const text = buf.replace(/\s+/g, ' ').trim();
      if (text) parts.push({ kind, text });
      buf = '';
    };

    const walk = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { buf += node.nodeValue; continue; }
        if (node.nodeType !== 1) continue;
        if (SKIP_TAG.test(node.tagName)) continue;

        let cs;
        try { cs = getComputedStyle(node); } catch (_) { cs = null; }
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;

        const display = cs ? cs.display : 'block';
        const block = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)$/.test(display);
        if (!block) { walk(node); continue; }

        flush();
        const prev = kind;
        const isHeading = /^H[1-6]$/.test(node.tagName) ||
          (cs && parseFloat(cs.fontSize) >= 17 &&
            (cs.fontWeight === 'bold' || parseInt(cs.fontWeight, 10) >= 600));
        kind = node.tagName === 'PRE' ? 'pre'
          : node.tagName === 'LI' ? 'li'
            : isHeading ? 'h' : 'p';
        walk(node);
        flush();
        kind = prev;
      }
    };

    try { walk(box); } catch (_) {}
    flush();
    return parts;
  }

  // 排版：段落之間空一行，標題前後各空兩行，項目縮兩格
  function compose(parts) {
    const lines = [];
    for (const p of parts) {
      if (p.kind === 'h') {
        if (lines.length) { lines.push(''); lines.push(''); }
        lines.push(p.text);
        lines.push('');
      } else if (p.kind === 'li') {
        lines.push('  • ' + p.text);
        lines.push('');
      } else if (p.kind === 'pre') {
        for (const l of p.text.split('\n')) lines.push('    ' + l);
        lines.push('');
      } else {
        lines.push(p.text);
        lines.push('');
      }
    }
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  }

  function readFromBox(box) {
    if (!box) return '';
    let c = null;
    try {
      c = box.cloneNode(true);
      c.style.cssText = 'position:fixed!important;left:-20000px!important;top:0!important;width:900px!important;' +
        'height:auto!important;max-height:none!important;overflow:visible!important;' +
        'pointer-events:none!important;visibility:visible!important;opacity:0!important';
      document.body.append(c);
      stripAds(c);                          // 旁邊的贊助／廣告先清掉
      stripSources(c);                      // 再砍來源卡片
      c.querySelectorAll('button, [role="button"], svg, style, script, noscript, input, textarea, iframe')
        .forEach((n) => n.remove());
      c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      return compose(renderFlow(c));
    } catch (_) {
      try { return cleanText(box.innerText || box.textContent || ''); } catch (__) { return ''; }
    } finally {
      if (c) c.remove();
    }
  }

  function readContentPair() {
    for (const box of contentBoxes()) {
      const txt = readFromBox(box);
      if (txt && txt.length >= 40) return { txt: txt, box: box };
    }
    return { txt: '', box: null };
  }

  function readContent() {
    return readContentPair().txt;
  }

  /* ---- 判斷「這一篇講完了沒」 ----
     不看「有沒有結束圖示」 因為那個容器裡同時放著好幾則回答
     每一則都有自己的圖示排 很容易被上一則騙到
     所以一律等「安靜五次 ＋ 再確認一次沒有繼續長」
     另外長文的尾巴可能是捲到才畫 先捲一遍再讀 */
  function forceRender(box) {
    let sc = null;
    try { sc = scrollerOf(box); } catch (_) {}
    if (!sc || !sc.clientHeight) return false;
    if (sc.scrollHeight < sc.clientHeight * 1.4) return false;
    const keep = sc.scrollTop;
    const step = Math.max(240, Math.floor(sc.clientHeight * 0.85));
    for (let y = 0; y < sc.scrollHeight; y += step) sc.scrollTop = y;
    sc.scrollTop = sc.scrollHeight;
    sc.scrollTop = keep;
    return true;
  }

  /* ---- 切換討論串 ----
     真正的可點元素是列裡面那顆 button（data-thread-id）
     直接對外層 div 送 click 不會有反應 這也是「只有第一篇抓得到」的原因
     所以先用 elementFromPoint 找列中央最上層的元素 真的像人一樣點下去 */
  const isRowActive = (el) => {
    if (!el) return false;
    if (el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
    return !!el.querySelector('[aria-current="true"], [aria-selected="true"]');
  };

  function rowClickTarget(row) {
    if (!row) return null;
    const cands = row.querySelectorAll('button[data-thread-id], [data-thread-id], a[href], [role="button"], button');
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 16) continue;
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
      if (r.width <= 52 && r.height <= 52 && MORE_LABEL.test(label)) continue;   // 右邊那顆 ⋮
      return el;
    }
    return row;
  }

  function clickRow(row) {
    const inner = rowClickTarget(row);
    if (!inner) return null;
    const r = inner.getBoundingClientRect();
    let hit = null;
    try { hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); } catch (_) {}
    const el = hit && inner.contains(hit) ? hit : inner;
    hover(el);
    realClick(el);
    return inner;
  }

  // 便宜的「現在畫面上是什麼」指紋 只用來判斷有沒有切過去
  function rawSig() {
    const b = contentBoxes()[0];
    if (!b) return '';
    const s = String(b.textContent || '');
    return s.length + '|' + s.slice(0, 64) + '|' + s.slice(-64);
  }

  async function captureThread(key, title, prevHash, first) {
    const row = detectRows().find((r) => r.key === key);
    if (!row) throw new Error(t('err.row'));

    try { row.el.scrollIntoView({ block: 'center' }); } catch (_) {}
    await sleepAB(120);

    const wasActive = isRowActive(row.el);
    const sig = rawSig();

    clickRow(row.el);

    // 等它真的切換：內容變了（或這一列自己變成 active）
    let switched = await waitUntil(() => rawSig() !== sig, 2600, 160);
    if (!switched) {
      // 換一招：對內層按鈕送原生 click
      try { rowClickTarget(row.el).click(); } catch (_) {}
      switched = await waitUntil(() => rawSig() !== sig, 2600, 160);
    }

    const LIMIT = 40000;
    const t0 = performance.now();
    let lastH = 0;
    let stable = 0;
    let got = '';
    let box = null;
    let scrolled = false;
    let brief = false;
    const NEED = 5;   // 安靜五次（約 1.2 秒）才算定稿

    while (performance.now() - t0 < LIMIT) {
      if (abort) break;
      const pair = readContentPair();
      const txt = pair.txt;
      if (pair.box) box = pair.box;
      const h = hashText(txt);
      if (txt.length > 30 && (h !== prevHash || wasActive)) {
        if (h === lastH) {
          stable++;
          if (stable >= NEED) {
            // 先捲到底 逼它把還沒畫的段落畫出來
            if (!scrolled && forceRender(box)) { scrolled = true; await sleepAB(260); stable = 0; lastH = 0; continue; }
            // 最後再確認一次「還在長嗎」 變多就繼續等
            await sleepAB(650);
            const again = readContentPair();
            const h2 = hashText(again.txt);
            if (again.txt && h2 !== h) { stable = 0; lastH = 0; continue; }
            got = (again.txt && again.txt.length > txt.length) ? again.txt : txt;
            break;
          }
        } else {
          stable = 0;
          lastH = h;
        }
      }
      await sleepAB(240);
    }

    if (!got) {
      // 時間到還沒定稿：先拿現有的 但標記可能不完整
      const pair = readContentPair();
      const liveRow = detectRows().find((r) => r.key === key);
      if (pair.txt.length > 30 && (isRowActive(liveRow && liveRow.el) || hashText(pair.txt) !== prevHash)) {
        got = pair.txt;
        box = pair.box || box;
        brief = true;
      }
    }
    if (!got) {
      throw new Error(t('err.noContent') + ' [' + (switched ? 'switched' : 'no-switch') +
        ' active=' + (isRowActive((detectRows().find((r) => r.key === key) || {}).el) ? 1 : 0) +
        ' len=' + readContent().length + ']');
    }

    return { text: got, brief: brief, len: got.length };
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function buildExport(docs, failed, format, useS2T) {
    const conv = (s) => (useS2T && S2T ? S2T.convert(s) : s);
    const loc = cfg.lang === 'en' ? 'en-US' : cfg.lang === 'zh-CN' ? 'zh-CN' : 'zh-TW';
    const now = new Date().toLocaleString(loc);
    const name = 'ai-mode-threads-' + stamp();
    const sep = '─'.repeat(46);

    if (format === 'json') {
      return {
        name: name + '.json',
        mime: 'application/json',
        text: JSON.stringify({
          exportedAt: new Date().toISOString(),
          source: location.href,
          count: docs.length,
          failed: failed.map(conv),
          threads: docs.map((d, i) => ({ index: i + 1, title: conv(d.title), url: d.url, text: conv(d.text) })),
        }, null, 2),
      };
    }

    const head = [
      t('file.title'),
      t('file.time') + now,
      t('file.count') + docs.length,
      t('file.source') + location.href,
    ].join('\n');

    const body = docs.map((d, i) =>
      sep + '\n\n' + '【' + (i + 1) + '】' + conv(d.title) + '\n\n' + conv(d.text)
    ).join('\n\n');

    let out = head + '\n\n' + body + '\n';
    if (failed.length) {
      out += '\n' + sep + '\n\n' + t('file.failed') + '\n\n' + failed.map((x) => '· ' + conv(x)).join('\n') + '\n';
    }
    return { name: name + '.txt', mime: 'text/plain', text: out };
  }

  async function exportContents(opts) {
    if (busy) return;
    const targets = (opts.scope === 'sel' ? rows.filter((r) => selected.has(r.key)) : rows)
      .map((r) => ({ key: r.key, title: r.title }));
    if (!targets.length) { toast(t('toast.nothingToExport')); return; }

    abort = false;
    busy = true;
    setBusy(true);
    elLog.classList.add('show');
    elLog.textContent = '';
    progress(0);
    log(t('log.exportStart', { n: targets.length, fmt: String(opts.format).toUpperCase() }));

    const docs = [];
    const failed = [];
    let prevHash = 0;

    for (let i = 0; i < targets.length; i++) {
      if (abort) { log(t('log.stopped')); break; }
      const title = targets[i].title;
      const short = title.length > 26 ? title.slice(0, 26) + '…' : title;
      try {
        let cap;
        try {
          cap = await captureThread(targets[i].key, title, prevHash, i === 0);
        } catch (e1) {
          if (abort) throw e1;
          // 失敗一次不算失敗：重新偵測、再試一次（連續匯出時最容易踩到）
          log('          ↻ ' + t('log.retry'), 'bad');
          await sleepAB(700);
          rows = detectRows();
          cap = await captureThread(targets[i].key, title, prevHash, i === 0);
        }
        prevHash = hashText(cap.text);
        docs.push({ title: title, text: cap.text, url: location.href });
        log('(' + (i + 1) + '/' + targets.length + ') ' + short + ' · ' + cap.len +
          (cap.brief ? '  ' + t('log.brief') : ''), cap.brief ? 'bad' : 'ok');
      } catch (e) {
        failed.push(title);
        log('(' + (i + 1) + '/' + targets.length + ') ' + short + ' ✗ ' + ((e && e.message) || e), 'bad');
      }
      progress((i + 1) / targets.length);
      // 長文之後多留一點緩衝，讓頁面收尾再點下一篇
      if (i < targets.length - 1) {
        const last = docs[docs.length - 1];
        const extra = last && last.text.length > 8000 ? 700 : 0;
        await sleepAB(Math.max(600, (opts.delay || 0) + extra));
      }
    }

    busy = false;
    setBusy(false);

    if (!docs.length) {
      log(t('log.nothing'), 'bad');
      toast(t('log.nothing'), 3200);
      return;
    }

    const out = buildExport(docs, failed, opts.format, opts.s2t);
    saveText(out.name, out.text, out.mime);
    log(t('log.exportEnd', { a: docs.length, b: failed.length, file: out.name }),
      failed.length ? 'bad' : 'ok');
    toast(t('toast.exportDone', { n: docs.length }), 3200);
  }

  async function openExportDialog() {
    if (busy) { toast(t('toast.busy')); return; }
    if (exResolve) { exModal.classList.add('show'); return; }   // 已經開著就別重開
    const opts = await askExport();
    if (opts) exportContents(opts);
  }

  /* ============================================================
   *  校準（點一下任何一個討論串）
   * ============================================================ */
  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      let i = 1;
      let sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) i++;
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  let pickActive = false;
  let pickHoverEl = null;
  let pickHintEl = null;
  let pickFn = null;
  let pickCancelFn = null;

  function beginPick(hint, onPick, onCancel) {
    if (pickActive) return;
    pickActive = true;
    pickFn = onPick;
    pickCancelFn = onCancel || null;
    forced = true;
    showPanel(true);
    pickHintEl = h('div', { class: 'cal-hint', text: hint });
    shadow.append(pickHintEl);
    document.addEventListener('mousemove', pickMove, true);
    document.addEventListener('click', pickClick, true);
    document.addEventListener('keydown', pickEsc, true);
    toast(hint, 4200);
  }

  function endPick() {
    pickActive = false;
    document.removeEventListener('mousemove', pickMove, true);
    document.removeEventListener('click', pickClick, true);
    document.removeEventListener('keydown', pickEsc, true);
    if (pickHoverEl) { pickHoverEl.classList.remove('cal-hover'); pickHoverEl = null; }
    if (pickHintEl) { pickHintEl.remove(); pickHintEl = null; }
  }

  function pickMove(e) {
    const el = e.target;
    if (!el || el === pickHoverEl) return;
    if (pickHoverEl) pickHoverEl.classList.remove('cal-hover');
    pickHoverEl = el;
    if (el.classList) el.classList.add('cal-hover');
  }

  function pickEsc(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const cb = pickCancelFn;
    endPick();
    toast(t('toast.cancelPick'));
    if (cb) cb();
  }

  function pickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const fn = pickFn;
    endPick();
    if (fn) fn(el);
  }

  function startCalibrate() {
    beginPick('點一下左側任何「一個討論串」，Esc 取消', (el) => {
      let row = el;
      // 往上爬到「像一列」的元素
      for (let i = 0; i < 8; i++) {
        if (!row || !row.parentElement) break;
        const r = row.getBoundingClientRect();
        if (r.height >= 24 && r.height <= 110 && r.width >= 130) break;
        row = row.parentElement;
      }
      if (!row) return;

      const prev = { rowClass: cfg.rowClass, rowSelector: cfg.rowSelector, rowTag: cfg.rowTag };

      // 1) 先用 class 認（同一份 DOM 裡每一列都共用同一個 class）
      const classes = (row.className || '').toString().trim().split(/\s+/)
        .filter((c) => /^[A-Za-z][\w-]{2,}$/.test(c));
      let ok = false;
      for (const c of classes) {
        cfg.rowClass = c;
        cfg.rowSelector = '';
        if (matchCalibrated().length >= 2) { ok = true; break; }
      }

      // 2) class 不行就退回「父層路徑 + 同一種標籤」
      if (!ok) {
        cfg.rowClass = '';
        cfg.rowSelector = cssPath(row.parentElement) + ' > ' + row.tagName.toLowerCase();
        cfg.rowTag = row.tagName;
      }
      saveCfgSoon();

      const found = detectRows();
      if (found.length >= 2) {
        toast(t('toast.calDone', { n: found.length }), 3000);
        refresh(true);
        return;
      }

      // 校準反而變差 → 還原，交給自動偵測
      cfg.rowClass = prev.rowClass;
      cfg.rowSelector = prev.rowSelector;
      cfg.rowTag = prev.rowTag;
      saveCfgSoon();
      const auto = detectRows();
      refresh(true);
      if (auto.length >= 2) {
        toast(t('toast.calNoMatch', { n: auto.length }), 3600);
      } else {
        toast(t('toast.calFail'), 3000);
      }
    });
  }

  // 匯出內容用的「對話區」校準
  function startContentCalibrate(after) {
    beginPick('點一下右邊「對話內容」的區塊，Esc 取消',
      (el) => {
        let box = el;
        for (let i = 0; i < 6; i++) {
          if (!box || !box.parentElement) break;
          const r = box.getBoundingClientRect();
          if (r.width >= 300 && r.height >= 200) break;
          box = box.parentElement;
        }
        cfg.contentSelector = cssPath(box);
        saveCfgSoon();
        toast(t('toast.contentCalDone'), 2600);
        if (after) setTimeout(after, 400);
      },
      () => { if (after) setTimeout(after, 400); }
    );
  }

  /* ============================================================
   *  診斷
   * ============================================================ */
  const rectObj = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  function buildDiagnostics() {
    const rs = detectRows();
    const nav = document.querySelector('[role="navigation"]') || document.querySelector('nav');
    const boxes = contentBoxes();
    const info = {
      ext: VERSION,
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      cfg: { rowClass: cfg.rowClass, rowSelector: cfg.rowSelector, rowTag: cfg.rowTag, contentSelector: cfg.contentSelector },
      rowCount: rs.length,
      rows: rs.slice(0, 6).map((r) => ({
        title: r.title,
        tag: r.el.tagName,
        cls: String(r.el.className || '').slice(0, 120),
        rect: rectObj(r.el),
        html: r.el.outerHTML.slice(0, 900),
      })),
      moreButtons: findMoreButtons().slice(0, 6).map((b) => ({
        label: b.getAttribute('aria-label'),
        rect: rectObj(b),
      })),
      contentBoxes: boxes.slice(0, 3).map((el) => ({
        tag: el.tagName,
        id: el.id || '',
        cls: String(el.className || '').slice(0, 80),
        rect: rectObj(el),
        textLen: (el.textContent || '').length,
      })),
      contentSample: (readContent() || '').slice(0, 160),
      nav: nav ? { tag: nav.tagName, aria: nav.getAttribute('aria-label'), cls: String(nav.className || '').slice(0, 120) } : null,
      menus: [...document.querySelectorAll('[role="menu"]')].length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].length,
    };
    return JSON.stringify(info, null, 1);
  }

  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.documentElement.append(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (__) { return false; }
    }
  }

  async function copyDiagnostics() {
    const txt = buildDiagnostics();
    const ok = await copyText(txt);
    if (ok) {
      toast(t('toast.diagCopied'), 3200);
      log(t('log.diagCopied'));
    } else {
      elLog.classList.add('show');
      log(t('log.diagFail'));
      log(txt.slice(0, 1500));
    }
  }

  /* ============================================================
   *  面板顯示 / 拖曳
   * ============================================================ */
  function clampPanel() {
    const w = 300;
    const h = Math.min(panelEl.getBoundingClientRect().height || 460, window.innerHeight - 24);
    if (cfg.px == null) cfg.px = Math.min(window.innerWidth - w - 16, 356);
    if (cfg.py == null) cfg.py = 88;
    cfg.px = clamp(cfg.px, 4, Math.max(4, window.innerWidth - w - 4));
    cfg.py = clamp(cfg.py, 4, Math.max(4, window.innerHeight - h - 4));
    panelEl.style.left = cfg.px + 'px';
    panelEl.style.top = cfg.py + 'px';
  }

  function showPanel(v) {
    cfg.hidden = !v;
    saveCfgSoon();
    updatePanelVisibility();
  }

  function updatePanelVisibility() {
    const show = !cfg.hidden || forced;
    panelEl.classList.toggle('off', !show);
    if (show) clampPanel();
    if (!show) {
      overlayEl.style.display = 'none';
      while (boxes.length) boxes.pop().remove();
      releaseAllGutters();
    }
  }

  btnHide.addEventListener('click', () => { forced = false; showPanel(false); toast(t('toast.closed')); });

  (function drag() {
    let dragging = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;
    const hd = panelEl.querySelector('.hd');
    hd.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = cfg.px || 0; oy = cfg.py || 0;
      try { hd.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    hd.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cfg.px = clamp(ox + (e.clientX - sx), 4, Math.max(4, window.innerWidth - 300 - 4));
      cfg.py = clamp(oy + (e.clientY - sy), 4, Math.max(4, window.innerHeight - 80));
      panelEl.style.left = cfg.px + 'px';
      panelEl.style.top = cfg.py + 'px';
    });
    hd.addEventListener('pointerup', () => { if (dragging) { dragging = false; saveCfgSoon(); } });
    hd.addEventListener('pointercancel', () => { dragging = false; });
  })();

  /* ============================================================
   *  按鈕事件
   * ============================================================ */
  btnAll.addEventListener('click', () => { rows.forEach((r) => selected.add(r.key)); syncSelectionUI(); });
  btnInv.addEventListener('click', () => {
    rows.forEach((r) => (selected.has(r.key) ? selected.delete(r.key) : selected.add(r.key)));
    syncSelectionUI();
  });
  btnNone.addEventListener('click', () => { selected.clear(); syncSelectionUI(); });
  btnScan.addEventListener('click', () => { refresh(true); toast(t('toast.rescan', { n: rows.length })); });
  btnCal.addEventListener('click', startCalibrate);
  btnDiag.addEventListener('click', copyDiagnostics);
  btnDel.addEventListener('click', startDelete);
  btnExp.addEventListener('click', exportList);
  btnExpFull.addEventListener('click', openExportDialog);
  btnLoad.addEventListener('click', loadAll);

  inDelay.addEventListener('change', () => {
    const v = clamp(parseInt(inDelay.value, 10) || 700, 200, 6000);
    cfg.delay = v;
    inDelay.value = String(v);
    saveCfgSoon();
  });
  inOverlay.addEventListener('change', () => {
    cfg.overlay = inOverlay.checked;
    saveCfgSoon();
    renderOverlay();
  });

  /* ============================================================
   *  主迴圈
   * ============================================================ */
  function looksLikeAiMode() {
    const u = location.pathname + location.search;
    if (/udm=50/.test(location.search)) return true;
    if (/\/(aimode|ai)(\/|$|\?)/.test(location.pathname)) return true;
    if (/[?&](q|udm)=/.test(u) && document.querySelector('[role="navigation"]')) return true;
    return false;
  }

  function shouldScan() {
    if (busy) return false;
    if (pickActive) return false;
    if (cfg.hidden && !forced) return false;
    if (!looksLikeAiMode() && !rows.length && !forced) return false;
    return true;
  }

  function refresh(force) {
    if (!document.documentElement.contains(host)) document.documentElement.append(host);
    if (pickActive) return;
    const next = detectRows();
    const same = next.length === rows.length &&
      next.every((r, i) => r.key === rows[i].key && r.el === rows[i].el);
    rows = next;
    // 清掉已消失的勾選
    const set = new Set(rows.map((r) => r.key));
    for (const k of [...selected]) if (!set.has(k)) selected.delete(k);

    elCount.textContent = String(rows.length);
    if (!same || force) renderList();
    else syncSelectionUI();
    updatePanelVisibility();
  }

  let tickTimer = 0;
  function startLoop() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (!shouldScan()) return;
      try { refresh(false); } catch (_) {}
    }, 1200);
  }

  // 頁面 SPA 換頁也要重掃
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastListKey = '';
      refresh(true);
    }
  }, 700);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });

  /* ============================================================
   *  對外訊息（popup 用）
   * ============================================================ */
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'RIN_TOGGLE') {
        forced = true;
        const open = cfg.hidden || panelEl.classList.contains('off');
        showPanel(open);
        if (open) refresh(true);
        sendResponse({ ok: true, visible: !panelEl.classList.contains('off') });
        return;
      }
      if (msg.type === 'RIN_SHOW') {
        forced = true;
        showPanel(true);
        refresh(true);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'RIN_STATUS') {
        sendResponse({ ok: true, rows: rows.length, selected: selected.size, busy, hidden: cfg.hidden });
        return;
      }
      if (msg.type === 'RIN_DIAG') {
        sendResponse({ ok: true, text: buildDiagnostics() });
        return;
      }
    });
  } catch (_) {}

  /* ============================================================
   *  啟動
   * ============================================================ */
  (async function boot() {
    await loadCfg();
    applyLang();
    inDelay.value = String(cfg.delay);
    inOverlay.checked = !!cfg.overlay;
    document.documentElement.append(host);
    clampPanel();

    // 等 SPA 把側邊欄畫出來
    for (let i = 0; i < 24; i++) {
      refresh(true);
      if (rows.length) break;
      await sleep(500);
    }
    if (rows.length) {
      if (cfg.hidden === false) updatePanelVisibility();
      toast(t('toast.detected', { n: rows.length }), 2600);
    }
    startLoop();
  })();
})();