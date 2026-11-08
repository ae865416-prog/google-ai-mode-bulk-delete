const $ = (id) => document.getElementById(id);
const h1El = $('h1');
const verEl = $('ver');
const statusEl = $('status');
const toggleBtn = $('toggle');
const diagBtn = $('diag');
const footEl = $('foot');

const VERSION = '1.2.9';
const CFG_KEY = 'rin_bulk_cfg_v1';

let tabId = null;
let lang = 'zh-TW';

const I18N = window.__AMB_I18N__;
const t = (key, vars) => (I18N ? I18N.t(lang, key, vars) : key);

function paint() {
  document.documentElement.lang = lang === 'en' ? 'en' : lang === 'zh-CN' ? 'zh-CN' : 'zh-Hant';
  document.title = t('app.title');
  h1El.textContent = t('app.title');
  verEl.textContent = 'v' + VERSION;
  toggleBtn.textContent = toggleBtn.dataset.show === '1' ? t('popup.show') : t('popup.hide');
  diagBtn.textContent = t('popup.diag');
  footEl.textContent = t('popup.foot');
}

function setStatus(html) { statusEl.innerHTML = html; }

function send(type, timeout = 1200) {
  return new Promise((resolve) => {
    if (tabId == null) return resolve(null);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    try {
      chrome.tabs.sendMessage(tabId, { type }, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    } catch (_) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function loadLang() {
  try {
    const o = await chrome.storage.local.get([CFG_KEY]);
    const cfg = o[CFG_KEY] || {};
    if (cfg.lang && I18N && I18N.has(cfg.lang)) lang = cfg.lang;
  } catch (_) {}
  paint();
}

async function init() {
  await loadLang();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) {
    setStatus('<span class="warn">' + t('popup.noTab') + '</span>');
    toggleBtn.disabled = true;
    diagBtn.disabled = true;
    return;
  }
  tabId = tab.id;
  const url = tab.url || '';
  const isGoogle = /^https?:\/\/([^/]*\.)?google\.[a-z.]+(\/|$)/i.test(url);

  if (!isGoogle) {
    setStatus('<span class="warn">' + t('popup.notGoogle') + '</span>');
    toggleBtn.disabled = true;
    diagBtn.disabled = true;
    return;
  }

  const st = await send('RIN_STATUS', 1000);
  if (!st) {
    setStatus('<span class="warn">' + t('popup.notLoaded') + '</span>');
    toggleBtn.disabled = true;
    diagBtn.disabled = true;
    return;
  }

  if (st.rows > 0) {
    setStatus(t('popup.found', { n: st.rows }) + (st.selected ? t('popup.selected', { s: st.selected }) : '') +
      (st.busy ? t('popup.busy') : ''));
  } else {
    setStatus('<span class="warn">' + t('popup.none') + '</span>');
  }
  toggleBtn.dataset.show = st.hidden ? '1' : '0';
  toggleBtn.textContent = st.hidden ? t('popup.show') : t('popup.hide');
}

toggleBtn.addEventListener('click', async () => {
  const res = await send('RIN_TOGGLE', 1500);
  if (!res) { setStatus('<span class="warn">' + t('popup.noResp') + '</span>'); return; }
  toggleBtn.dataset.show = res.visible ? '0' : '1';
  toggleBtn.textContent = res.visible ? t('popup.hide') : t('popup.show');
});

diagBtn.addEventListener('click', async () => {
  const res = await send('RIN_DIAG', 2500);
  if (!res || !res.text) { setStatus('<span class="warn">' + t('popup.noDiag') + '</span>'); return; }
  try {
    await navigator.clipboard.writeText(res.text);
    setStatus(t('popup.diagCopied'));
    diagBtn.textContent = t('popup.diagDone');
    setTimeout(() => { diagBtn.textContent = t('popup.diag'); }, 1800);
  } catch (_) {
    setStatus('<span class="warn">' + t('popup.copyBlocked') + '</span>');
  }
});

init();
