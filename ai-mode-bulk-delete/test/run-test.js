/**
 * 端到端測試：用真的 Chrome（headless）載入擴充功能，跑完整流程。
 * 覆蓋：自動偵測 → 頁面勾選框 → 校準 → 單筆刪除 → 全選 → 批次刪除
 *
 * 執行：node test/run-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');              // 擴充功能根目錄
const EXT = path.join(os.tmpdir(), 'amb-ext-build');  // 測試用的複本（不能放在原始碼目錄裡）
const PORT = 8899;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------- 1. 複製擴充功能並改 match ---------- */
function buildExt() {
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.cpSync(ROOT, EXT, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (top === 'test' || top === 'preview.png') return false;
      if (rel.endsWith('.md')) return false;
      return true;
    },
  });
  const mf = path.join(EXT, 'manifest.json');
  const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const match = ['http://127.0.0.1/*', 'http://localhost/*'];  // match pattern 不能帶 port
  j.host_permissions = match;
  j.content_scripts[0].matches = match;
  fs.writeFileSync(mf, JSON.stringify(j, null, 2), 'utf8');
  log('[build] 測試用擴充功能 →', EXT);
}

/* ---------- 2. 靜態伺服器 ---------- */
function serve() {
  const dir = __dirname; // 讓 /aimode/fixture.html 對到 test/aimode/fixture.html
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join(dir, u === '/' ? 'aimode/fixture.html' : u);
    if (!p.startsWith(dir) || !fs.existsSync(p)) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(fs.readFileSync(p));
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/* ---------- 3. CDP 小工具 ---------- */
function client(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    const api = {
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      events,
      close() { try { ws.close(); } catch (_) {} },
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method) events.push(m);
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('CDP ws error'));
  });
}

async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page error: ' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

async function waitEval(cdp, expr, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await evalJS(cdp, expr); } catch (_) {}
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + (label || expr));
    await sleep(200);
  }
}

const SR = "document.querySelector('#amb-bulk-host') && document.querySelector('#amb-bulk-host').shadowRoot";
const NTHREAD = 'document.querySelectorAll(".thread").length';

/* ---------- 4. 主流程 ---------- */
(async () => {
  let chrome, server, cdp;
  let userDir = '';   // Chrome 使用者設定檔（跑完會刪）
  let dlDir = '';     // 下載資料夾（跑完會刪）
  const fails = [];
  const check = (name, ok, extra) => {
    log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined && extra !== '' ? '  → ' + extra : ''));
    if (!ok) fails.push(name);
  };

  try {
    buildExt();
    server = await serve();

    userDir = path.join(os.tmpdir(), 'amb-ext-test-' + Date.now());
    chrome = spawn(CHROME, [
      '--headless=new',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + userDir,
      '--enable-unsafe-extension-debugging',
      '--disable-features=Translate',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ], { stdio: 'ignore' });

    let ver = null;
    for (let i = 0; i < 60; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); break; } catch (_) { await sleep(250); }
    }
    if (!ver) throw new Error('Chrome CDP 起不來');
    log('[chrome]', ver.Browser);

    // 用 CDP 載入未封裝擴充功能（--load-extension 在 headless 不可靠）
    let br = null;
    let extId = '';
    try {
      br = await client(ver.webSocketDebuggerUrl);
      const r = await br.send('Extensions.loadUnpacked', { path: EXT });
      extId = r.id;
      log('[ext] loadUnpacked →', r.id);
    } catch (e) {
      log('[ext] loadUnpacked 失敗：', e.message);
    }
    await sleep(900); // 等 content script 註冊

    dlDir = path.join(os.tmpdir(), 'amb-dl-' + Date.now());
    fs.mkdirSync(dlDir, { recursive: true });
    if (br) {
      try {
        await br.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
      } catch (e) { log('[dl] setDownloadBehavior 失敗：', e.message); }
    }

    const target = await (await fetch(
      'http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + PORT + '/aimode/fixture.html'),
      { method: 'PUT' }
    )).json();

    cdp = await client(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/aimode/fixture.html' });

    await waitEval(cdp, 'document.readyState === "complete" && ' + NTHREAD + ' === 9', 8000, 'fixture load');
    check('測試頁有 9 個討論串', true);

    await waitEval(cdp, '!!' + SR, 15000, 'content script 注入');
    check('content script 已注入', true);

    /* ---- 自動偵測 ---- */
    const n = await waitEval(cdp, SR + '.querySelectorAll(".item").length', 8000, '偵測列數');
    check('自動偵測抓到 9 個', n === 9, 'n=' + n);

    const titles = JSON.parse(await evalJS(cdp, 'JSON.stringify([...' + SR + '.querySelectorAll(".t")].map(e=>e.textContent))'));
    check('標題沒有殘留「更多選項」', !titles.some((t) => /更多選項/.test(t)), titles[0]);
    check('標題順序正確（最後一列故意同名）', titles[0] === '週末露營裝備清單' && titles[8] === '週末露營裝備清單',
      titles[0] + ' / ' + titles[8]);

    /* ---- 頁面勾選框 ---- */
    const boxes = await evalJS(cdp, SR + '.querySelectorAll(".box").length');
    check('頁面勾選框畫出 9 個', boxes === 9, 'boxes=' + boxes);

    /* ---- 勾選框不能壓到文字 ---- */
    const geo = JSON.parse(await evalJS(cdp, `(()=>{
      const t = document.querySelectorAll('.thread');
      const b = ${SR}.querySelectorAll('.box');
      const out = [];
      for (let i = 0; i < t.length; i++) {
        const r = t[i].getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(t[i]).paddingLeft);
        const br = b[i].getBoundingClientRect();
        out.push({
          pad: pad,
          boxRight: Math.round(br.right),
          textStart: Math.round(r.left + pad),
          overlap: br.right > r.left + pad + 0.5
        });
      }
      return JSON.stringify(out);
    })()`));
    check('每一列都有讓出走道', geo.every((g) => g.pad === 38), 'pad=' + geo[0].pad);
    check('勾選框完全沒有壓到文字', geo.every((g) => !g.overlap),
      'box右緣 ' + geo[0].boxRight + ' / 文字起點 ' + geo[0].textStart);
    check('勾選框垂直置中', (await evalJS(cdp, `(()=>{
      const r = document.querySelectorAll('.thread')[0].getBoundingClientRect();
      const b = ${SR}.querySelectorAll('.box')[0].getBoundingClientRect();
      return Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) < 1.5;
    })()`)) === true);

    await evalJS(cdp, '(()=>{const s=' + SR + ';const c=s.querySelector("input[type=checkbox]");c.checked=false;c.dispatchEvent(new Event("change"));return 1})()');
    const padOff = await evalJS(cdp, 'parseFloat(getComputedStyle(document.querySelectorAll(".thread")[0]).paddingLeft)');
    check('關掉勾選框後走道還原', padOff === 12, 'pad=' + padOff);
    await evalJS(cdp, '(()=>{const s=' + SR + ';const c=s.querySelector("input[type=checkbox]");c.checked=true;c.dispatchEvent(new Event("change"));return 1})()');
    await sleep(300);
    check('再打開勾選框又長回來', (await evalJS(cdp, SR + '.querySelectorAll(".box").length')) === 9);

    await evalJS(cdp, SR + '.querySelectorAll(".box")[2].click()');
    check('點頁面勾選框可以選取', (await evalJS(cdp, SR + '.querySelector(".sel").textContent')) === '1');
    await evalJS(cdp, SR + '.querySelector("[data-act=none]").click()');

    /* ---- 校準 ---- */
    await evalJS(cdp, SR + '.querySelector("[data-act=cal]").click()');
    await sleep(250);
    await evalJS(cdp, 'document.querySelectorAll(".thread")[2].click()');
    await sleep(700);
    const calN = await evalJS(cdp, SR + '.querySelectorAll(".item").length');
    check('校準後仍然抓到 9 個', calN === 9, 'n=' + calN);
    const calTitles = JSON.parse(await evalJS(cdp, 'JSON.stringify([...' + SR + '.querySelectorAll(".t")].map(e=>e.textContent))'));
    check('校準後標題一致', JSON.stringify(calTitles) === JSON.stringify(titles), calTitles[0]);

    /* ---- 壞掉的校準要能自己修回來（使用者實際踩到的坑） ---- */
    if (extId) {
      const extUrl = 'chrome-extension://' + extId + '/popup/popup.html';
      const t2 = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?' + encodeURIComponent(extUrl), { method: 'PUT' })).json();
      const cdp2 = await client(t2.webSocketDebuggerUrl);
      await cdp2.send('Runtime.enable');
      await sleep(700);
      await evalJS(cdp2, 'new Promise((res) => chrome.storage.local.set({ rin_bulk_cfg_v1: ' +
        '{ delay: 700, overlay: true, rowClass: "", rowSelector: "#threads > div:nth-of-type(1)", rowTag: "DIV", ' +
        'contentSelector: "", px: 356, py: 88, collapsed: false, hidden: false } }, () => res(1)))');
      cdp2.close();
      // 把那個 popup 分頁關掉，不然它會變前景分頁、測試頁被背景節流 整個流程會變超慢
      try { await fetch('http://127.0.0.1:' + CDP_PORT + '/json/close/' + t2.id); } catch (_) {}
      try { await cdp.send('Page.bringToFront'); } catch (_) {}

      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/aimode/fixture.html' });
      await waitEval(cdp, 'document.readyState === "complete" && ' + NTHREAD + ' === 9', 8000, 'reload for self-heal');
      const healed = await waitEval(cdp, SR + ' && ' + SR + '.querySelectorAll(".item").length === 9 ? 9 : 0',
        15000, 'self-heal detect');
      check('壞掉的校準（只選到 1 列）會自己修成 9 個', healed === 9, 'n=' + healed);
    }

    /* ---- 匯出內容（真的點開每一篇抓） ---- */
    await evalJS(cdp, SR + '.querySelector("[data-act=none]").click()');
    await evalJS(cdp, '(()=>{const s=' + SR + ';const it=s.querySelectorAll(".item");[0,2,8].forEach((i)=>it[i].click());return s.querySelector(".sel").textContent})()');

    /* ---- 匯出清單：純文字，不准再產生 .md（風 踩到的坑） ---- */
    await evalJS(cdp, SR + '.querySelector("[data-act=exp]").click()');
    let listPath = null;
    const tL = Date.now();
    while (Date.now() - tL < 15000) {
      const got = fs.readdirSync(dlDir).filter((f) => /^ai-mode-thread-list-.*\.txt$/.test(f));
      if (got.length) { listPath = path.join(dlDir, got[0]); break; }
      await sleep(300);
    }
    check('匯出清單有下載（.txt）', !!listPath, listPath || '');
    check('匯出清單不會產生 .md', fs.readdirSync(dlDir).filter((f) => /\.md$/.test(f)).length === 0);
    if (listPath) {
      const lt = fs.readFileSync(listPath, 'utf8');
      check('清單裡有勾選的標題', lt.indexOf('週末露營裝備清單') >= 0);
      check('清單沒有 Markdown 記號', lt.indexOf('# ') < 0 && lt.indexOf('---') < 0);
      check('清單檔名跟內容匯出不會撞', path.basename(listPath).indexOf('ai-mode-thread-list-') === 0);
      try { fs.unlinkSync(listPath); } catch (_) {}
    }

    await evalJS(cdp, SR + '.querySelector("[data-act=expfull]").click()');
    await waitEval(cdp, SR + '.querySelector(".ex").classList.contains("show")', 4000, '匯出設定視窗');
    check('匯出內容有設定視窗', true);
    await sleep(500);
    check('點匯出內容不會直接下載檔案',
      fs.readdirSync(dlDir).filter((f) => !/\.crdownload$/.test(f)).length === 0,
      fs.readdirSync(dlDir).join(','));
    const exGeo = JSON.parse(await evalJS(cdp, `(()=>{
      const d = ${SR}.querySelector('.ex .dialog');
      const r = d.getBoundingClientRect();
      const cs = getComputedStyle(d);
      return JSON.stringify({ w: Math.round(r.width), top: Math.round(r.top), left: Math.round(r.left), disp: cs.display });
    })()`));
    check('匯出設定視窗真的在畫面上',
      exGeo.w > 200 && exGeo.disp !== 'none' && exGeo.top >= 0, JSON.stringify(exGeo));
    check('面板不再有折疊鍵',
      (await evalJS(cdp, SR + '.querySelectorAll(".hd .ic").length')) === 1,
      'hd ic=' + (await evalJS(cdp, SR + '.querySelectorAll(".hd .ic").length')));
    check('設定視窗有抓到勾選數',
      /\b3\b/.test(await evalJS(cdp, SR + '.querySelector(".ex .ex-row label").textContent')));

    await evalJS(cdp, `(()=>{
      const s = ${SR};
      s.querySelector('.ex .ex-sel').value = 'txt';
      s.querySelector('.ex input[type=radio][value=sel]').click();
      const n = s.querySelector('.ex input[type=number]');
      n.value = '400';
      n.dispatchEvent(new Event('change'));
      const cb = s.querySelector('.ex input[type=checkbox]');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      s.querySelector('.ex .dbtns .btn.danger').click();
      return 1;
    })()`);

    let mdPath = null;
    const tDl = Date.now();
    while (Date.now() - tDl < 60000) {
      const got = fs.readdirSync(dlDir).filter((f) => /\.txt$/.test(f) && !/\.crdownload$/.test(f));
      if (got.length) { mdPath = path.join(dlDir, got[0]); break; }
      await sleep(400);
    }
    check('匯出檔案有下載下來', !!mdPath, mdPath || '');
    if (!mdPath) {
      log('[debug] 面板 log:\n' + (await evalJS(cdp, SR + '.querySelector(".log").innerText')));
      log('[debug] conv 文字 =', JSON.stringify(await evalJS(cdp, 'document.querySelector("#conv") ? document.querySelector("#conv").innerText.slice(0,80) : "no #conv"')));
    }
    if (mdPath) {
      const md = fs.readFileSync(mdPath, 'utf8');
      check('匯出檔含 3 篇', (md.match(/【\d+】/g) || []).length === 3, 'n=' + (md.match(/【\d+】/g) || []).length);
      check('第 1 篇標題正確', md.indexOf('【1】週末露營裝備清單') >= 0);
      check('有抓到第 1 篇內容', md.indexOf('MARKER_t0') >= 0);
      check('同名討論串兩個都匯出（t0 / t8）', md.indexOf('MARKER_t0') >= 0 && md.indexOf('MARKER_t8') >= 0);
      check('有抓到第 3 篇內容', md.indexOf('MARKER_t2') >= 0);
      /* 長文延遲渲染：尾巴不能漏（風 44 篇那次踩到的坑） */
      check('長文的尾巴有抓到（沒被截斷）',
        md.indexOf('TAIL_t0') >= 0 && md.indexOf('TAIL_t2') >= 0 && md.indexOf('TAIL_t8') >= 0,
        [md.indexOf('TAIL_t0'), md.indexOf('TAIL_t2'), md.indexOf('TAIL_t8')].join(','));
      check('延遲渲染那篇也沒有「可能不完整」', md.indexOf('可能不完整') < 0);
      check('沒勾的沒有被匯出', md.indexOf('MARKER_t1') < 0 && md.indexOf('MARKER_t3') < 0);
      check('沒有殘留按鈕文字', md.indexOf('重新命名') < 0 && md.indexOf('分享') < 0);
      check('沒有 Markdown 記號', md.indexOf('##') < 0 && md.indexOf('---') < 0);
      check('段落之間有空行', /\n\n重點一/.test(md), JSON.stringify(md.slice(md.indexOf('重點整理') - 6, md.indexOf('重點整理') + 30)));
      check('標題前後留了兩行', md.indexOf('\n\n\n重點整理\n\n') >= 0);

      /* 來源卡片：整排都不收（風 說讀的人根本不會點） */
      check('來源卡片沒有被匯出',
        md.indexOf('腾讯') < 0 && md.indexOf('cloud.tencent') < 0 &&
        md.indexOf('github.com') < 0 && md.indexOf('example.org') < 0,
        [md.indexOf('腾讯'), md.indexOf('cloud.tencent'), md.indexOf('github.com'), md.indexOf('example.org')].join(','));
      check('卡片標題沒有被匯出', md.indexOf('寫了個適配器') < 0 && md.indexOf('Build adapters') < 0);
      check('「來源」標籤沒有留下', !/^來源$/m.test(md), JSON.stringify(md.slice(md.indexOf('來源') - 40, md.indexOf('來源') + 40)));
      check('回答本文沒有被砍掉', md.indexOf('重點二') >= 0 && md.indexOf('網友補充') >= 0);
      /* 來源卡片有些是 role=link 不是 <a>，一樣要收乾淨 */
      check('role=link 的卡片也沒有被匯出',
        md.indexOf('线程管理') < 0 && md.indexOf('Astro') < 0 && md.indexOf('example.org') < 0,
        [md.indexOf('线程管理'), md.indexOf('Astro'), md.indexOf('example.org')].join(','));
      /* 旁邊那欄的贊助廣告 */
      check('廣告沒有被匯出',
        md.indexOf('Genspark') < 0 && md.indexOf('Nano Banana') < 0 &&
        md.indexOf('買一送一') < 0 && md.indexOf('贊助') < 0,
        [md.indexOf('Genspark'), md.indexOf('買一送一')].join(','));
      /* 右欄卡片：<a> 只有 aria-label、文字放在兄弟節點（風 實際抓到的 DOM） */
      check('右欄的來源卡片沒有被匯出',
        md.indexOf('永佳樂有線電視') < 0 && md.indexOf('mediacatv') < 0 &&
        md.indexOf('Mobile01') < 0 && md.indexOf('Ulti Box') < 0,
        [md.indexOf('永佳樂有線電視'), md.indexOf('Mobile01'), md.indexOf('Ulti Box')].join(','));
      /* 來源面板：ul > li > div[data-src-id]，<a aria-label="Qwen"> 只有站名幾個字 */
      check('來源面板（Qwen 那種）沒有被匯出',
        md.indexOf('Qwen3.5-Omni Technical Report') < 0 && md.indexOf('arXtv.org') < 0 &&
        md.indexOf('阿里雲文檔') < 0 && md.indexOf('顯示全部') < 0,
        [md.indexOf('Qwen3.5-Omni'), md.indexOf('阿里雲文檔'), md.indexOf('顯示全部')].join(','));
      /* 正文裡的連結不能跟著被砍（誤刪測試） */
      check('正文裡的連結段落還在',
        md.indexOf('延伸閱讀') >= 0 && md.indexOf('這篇說明') >= 0 && md.indexOf('更多細節') >= 0,
        JSON.stringify(md.slice(md.indexOf('延伸閱讀') - 20, md.indexOf('延伸閱讀') + 40)));

      check('簡體都轉成繁體了', md.indexOf('线') < 0 && md.indexOf('适') < 0 && md.indexOf('腾讯') < 0,
        JSON.stringify(md.slice(md.indexOf('網友補充'), md.indexOf('網友補充') + 40)));
      check('有轉出繁體字', md.indexOf('線程') >= 0 && md.indexOf('適配器') >= 0,
        JSON.stringify(md.slice(md.indexOf('網友補充'), md.indexOf('網友補充') + 40)));
      check('檔案大小正常', md.length > 300, md.length + ' 字');
    }

    /* ---- JSON 格式（同一批，來源卡片一樣不收，但要有結構） ---- */
    let jsonPath = null;
    const outDir = path.join(__dirname, 'out');
    try {
      fs.mkdirSync(outDir, { recursive: true });
      if (mdPath) fs.copyFileSync(mdPath, path.join(outDir, 'sample-export.txt'));
    } catch (_) {}
    try { fs.unlinkSync(mdPath); } catch (_) {}
    await evalJS(cdp, SR + '.querySelector("[data-act=expfull]").click()');
    await waitEval(cdp, SR + '.querySelector(".ex").classList.contains("show")', 4000, '第二次匯出視窗');
    await evalJS(cdp, `(()=>{
      const s = ${SR};
      s.querySelector('.ex .ex-sel').value = 'json';
      s.querySelector('.ex input[type=radio][value=sel]').click();
      const n = s.querySelector('.ex input[type=number]');
      n.value = '400';
      n.dispatchEvent(new Event('change'));
      s.querySelector('.ex .dbtns .btn.danger').click();
      return 1;
    })()`);
    const tJson = Date.now();
    while (Date.now() - tJson < 60000) {
      const got = fs.readdirSync(dlDir).filter((f) => /\.json$/.test(f) && !/\.crdownload$/.test(f));
      if (got.length) { jsonPath = path.join(dlDir, got[0]); break; }
      await sleep(400);
    }
    check('JSON 檔案有下載下來', !!jsonPath, jsonPath || '');
    if (jsonPath) {
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (_) {}
      check('JSON 可以正常解析', !!obj && Array.isArray(obj.threads));
      check('JSON 有 3 篇', !!obj && obj.threads.length === 3, obj ? obj.threads.length : '');
      const jt = obj ? obj.threads.map((x) => x.text).join('\n') : '';
      check('JSON 裡也沒有來源卡片',
        jt.indexOf('腾讯') < 0 && jt.indexOf('cloud.tencent') < 0 && jt.indexOf('github.com') < 0);
      check('JSON 裡也沒有廣告', jt.indexOf('Genspark') < 0 && jt.indexOf('買一送一') < 0);
      check('JSON 裡也沒有右欄卡片', jt.indexOf('永佳樂有線電視') < 0 && jt.indexOf('Ulti Box') < 0);
      check('JSON 裡也沒有來源面板', jt.indexOf('Qwen3.5-Omni') < 0 && jt.indexOf('阿里雲文檔') < 0);
      check('JSON 每篇內容都不一樣',
        !!obj && new Set(obj.threads.map((x) => x.text)).size === 3);
      check('JSON 裡保留正文連結', jt.indexOf('延伸閱讀') >= 0);
      check('JSON 有轉成繁體', jt.indexOf('線程') >= 0);
    }

    /* ---- 介面語言切換 ---- */
    const en = await evalJS(cdp, `(()=>{
      const s = ${SR};
      const sel = s.querySelector('select.lang');
      sel.value = 'en';
      sel.dispatchEvent(new Event('change'));
      return s.querySelector('.ttl').textContent + '|' + s.querySelector('[data-act=del]').textContent;
    })()`);
    check('切到英文會換字', en.indexOf('AI Mode · Bulk delete') === 0 && en.indexOf('Delete') > 0, en);

    const cn = await evalJS(cdp, `(()=>{
      const s = ${SR};
      const sel = s.querySelector('select.lang');
      sel.value = 'zh-CN';
      sel.dispatchEvent(new Event('change'));
      return s.querySelector('.ttl').textContent;
    })()`);
    check('切到簡體會換字', cn === 'AI 模式 · 批量删除', cn);

    await evalJS(cdp, `(()=>{
      const s = ${SR};
      const sel = s.querySelector('select.lang');
      sel.value = 'zh-TW';
      sel.dispatchEvent(new Event('change'));
      return 1;
    })()`);
    check('切回繁體', (await evalJS(cdp, SR + '.querySelector(".ttl").textContent')) === 'AI 模式 · 批次刪除');

    /* ---- 單筆刪除（面板上的 ✕） ---- */
    await evalJS(cdp, '(()=>{const s=' + SR + ';const it=s.querySelectorAll(".item")[3];it.querySelector(".del1").click();return 1})()');
    await waitEval(cdp, SR + '.querySelector(".modal").classList.contains("show")', 4000, '單筆確認視窗');
    await evalJS(cdp, SR + '.querySelector(".dbtns .btn.danger").click()');
    const n8 = await waitEval(cdp, NTHREAD + ' === 8 ? "8" : null', 15000, '單筆刪除');
    check('單筆刪除成功（9 → 8）', n8 === '8');

    /* ---- 全選 + 批次刪除 ---- */
    await evalJS(cdp, '(()=>{const s=' + SR + ';const i=s.querySelector("input[type=number]");i.value="200";i.dispatchEvent(new Event("change"));return i.value})()');
    await sleep(200);
    await evalJS(cdp, SR + '.querySelector("[data-act=all]").click()');
    const selAll = await evalJS(cdp, SR + '.querySelector(".sel").textContent');
    check('全選 = 8', selAll === '8', 'sel=' + selAll);
    const cntPair = JSON.parse(await evalJS(cdp, `(()=>{
      const s = ${SR};
      return JSON.stringify({ sel: s.querySelector('.sel').textContent, rows: s.querySelector('.stat b').textContent });
    })()`));
    check('全選後「已選」跟列數一致（同名不會少算）', cntPair.sel === cntPair.rows, JSON.stringify(cntPair));

    await evalJS(cdp, SR + '.querySelector("[data-act=del]").click()');
    await waitEval(cdp, SR + '.querySelector(".modal").classList.contains("show")', 4000, '批次確認視窗');
    check('批次刪除前有確認視窗', true);
    await evalJS(cdp, SR + '.querySelector(".dbtns .btn.danger").click()');

    let left = null;
    try {
      left = await waitEval(cdp, NTHREAD + ' === 0 ? "0" : null', 150000, '批次刪除');
    } catch (e) {
      log('[debug] 批次刪除 log:\n' + (await evalJS(cdp, SR + '.querySelector(".log").innerText')));
      log('[debug] 剩下 ' + (await evalJS(cdp, NTHREAD)) + ' 列');
      throw e;
    }
    check('剩下 8 個全部刪除', left === '0');

    const logTxt = await evalJS(cdp, SR + '.querySelector(".log").innerText');
    const okCount = (logTxt.match(/已刪除/g) || []).length;
    check('日誌記錄 8 次成功', okCount === 8, 'ok=' + okCount);
    check('沒有失敗紀錄', !/✗/.test(logTxt), logTxt.split('\n').filter((l) => /✗/.test(l)).join(' | '));

    await sleep(1500);
    const cnt = await evalJS(cdp, SR + '.querySelector(".stat b").textContent');
    check('清空後面板計數歸零', cnt === '0', 'cnt=' + cnt);
    const boxesAfter = await evalJS(cdp, SR + '.querySelectorAll(".box").length');
    check('清空後頁面勾選框收乾淨', boxesAfter === 0, 'boxes=' + boxesAfter);

    /* ---- 停止鈕 ---- */
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/aimode/fixture.html' });
    await waitEval(cdp, 'document.readyState === "complete" && ' + NTHREAD + ' === 9', 8000, 'reload');
    await waitEval(cdp, SR + '.querySelectorAll(".item").length === 9', 15000, 're-detect');

    await evalJS(cdp, '(()=>{const s=' + SR + ';const i=s.querySelector("input[type=number]");i.value="1500";i.dispatchEvent(new Event("change"));return i.value})()');
    await sleep(200);
    await evalJS(cdp, SR + '.querySelector("[data-act=all]").click()');
    await evalJS(cdp, SR + '.querySelector("[data-act=del]").click()');
    await waitEval(cdp, SR + '.querySelector(".modal").classList.contains("show")', 4000, 'stop-test modal');
    await evalJS(cdp, SR + '.querySelector(".dbtns .btn.danger").click()');
    await sleep(2600);

    const label = await evalJS(cdp, SR + '.querySelector("[data-act=del]").textContent');
    check('刪除中按鈕變成「停止」', label === '停止', 'label=' + label);
    check('刪除中按鈕沒有被 disable', (await evalJS(cdp, SR + '.querySelector("[data-act=del]").disabled')) === false);

    await evalJS(cdp, SR + '.querySelector("[data-act=del]").click()');
    await waitEval(cdp, SR + '.querySelector("[data-act=del]").textContent === "刪除選取"', 12000, 'stopped');
    const logTxt2 = await evalJS(cdp, SR + '.querySelector(".log").innerText');
    check('日誌有記錄「已停止」', /已停止/.test(logTxt2), logTxt2.split('\n').slice(-3).join(' / '));
    const leftThreads = await evalJS(cdp, NTHREAD);
    check('停止後確實還有沒刪到的', leftThreads > 0 && leftThreads < 9, 'left=' + leftThreads);

    /* ---- 例外檢查 ---- */
    const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('沒有未攔截的 JS 例外', errs.length === 0,
      errs.map((e) => e.params.exceptionDetails.text).join('; '));
    const consoleErrs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    check('沒有 console.error', consoleErrs.length === 0,
      consoleErrs.map((e) => (e.params.args[0] || {}).value).join('; '));
    const logErrs = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .filter((e) => !/favicon|404/.test(e.params.entry.text));
    check('沒有其他錯誤訊息', logErrs.length === 0, logErrs.map((e) => e.params.entry.text).join('; '));

    log('\n' + (fails.length ? '結果：' + fails.length + ' 項失敗 → ' + fails.join(', ') : '結果：全部通過 ✓'));
  } catch (e) {
    log('\n[錯誤]', e && e.message);
    fails.push('exception');
  } finally {
    try { cdp && cdp.close(); } catch (_) {}
    try { chrome && chrome.kill(); } catch (_) {}
    try { server && server.close(); } catch (_) {}

    // 收工把暫存清掉（一個 Chrome 設定檔就 70～120 MB，不清會愈堆愈多）
    // 想留著除錯：set AMB_KEEP_TEMP=1 再跑
    if (process.env.AMB_KEEP_TEMP !== '1') {
      await sleep(700);   // 等 Chrome 真的放手
      let removed = 0;
      for (const d of [userDir, dlDir]) {
        if (!d || !fs.existsSync(d)) continue;
        try {
          fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          removed++;
        } catch (_) {}
      }
      if (removed) log('[clean] 已刪除暫存設定檔與下載夾（要保留請 set AMB_KEEP_TEMP=1）');
    } else {
      log('[clean] 保留暫存：' + userDir + ' , ' + dlDir);
    }

    await sleep(300);
    process.exit(fails.length ? 1 : 0);
  }
})();
