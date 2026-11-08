'use strict';
/* 把測試頁跑起來、選 5 個、截一張圖 → preview.png */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const EXT = path.join(os.tmpdir(), 'amb-ext-build');
const PORT = 8897;
const CDP_PORT = 9335;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280, H = 900;

function client(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const api = {
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('ws'));
  });
}

(async () => {
  // 這支要一份「match 改成 127.0.0.1」的擴充功能複本，自己建，不必先跑 run-test.js
  const ROOT = path.join(__dirname, '..');
  fs.rmSync(EXT, { recursive: true, force: true });
  fs.cpSync(ROOT, EXT, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (top === 'test' || top.endsWith('.md') || top.startsWith('preview')) return false;
      return true;
    },
  });
  {
    const mf = path.join(EXT, 'manifest.json');
    const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const match = ['http://127.0.0.1/*', 'http://localhost/*'];
    j.host_permissions = match;
    j.content_scripts[0].matches = match;
    fs.writeFileSync(mf, JSON.stringify(j, null, 2), 'utf8');
  }

  const dir = __dirname;
  const server = http.createServer((req, res) => {
    const p = path.join(dir, req.url.split('?')[0]);
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('x'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(p));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const USER_DIR = path.join(os.tmpdir(), 'amb-shot-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + USER_DIR,
    '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=' + W + ',' + H,
    'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')).json(); break; } catch (_) { await sleep(250); }
  }
  const br = await client(ver.webSocketDebuggerUrl);
  await br.send('Extensions.loadUnpacked', { path: EXT });
  await sleep(1000);

  const t = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const cdp = await client(t.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/aimode/fixture.html' });
  await sleep(3500);

  const SR = "document.querySelector('#amb-bulk-host').shadowRoot";
  // 選 5 個
  await cdp.send('Runtime.evaluate', {
    expression: '(()=>{const s=' + SR + ';const b=s.querySelectorAll(".box"); [0,1,2,3,5].forEach(i=>b[i].click()); return s.querySelector(".sel").textContent})()',
    returnByValue: true,
  });
  await sleep(400);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'preview.png'), Buffer.from(shot.data, 'base64'));
  console.log('preview.png 已存');

  // 模擬「沒有對話圖示」的列（使用者回報的那種排版）
  await cdp.send('Runtime.evaluate', {
    expression: 'document.querySelectorAll(".ico").forEach(e=>e.remove()); 1',
    returnByValue: true,
  });
  await sleep(700);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'preview-noicon.png'), Buffer.from(shot2.data, 'base64'));
  console.log('preview-noicon.png 已存');

  // 匯出內容的設定視窗
  await cdp.send('Runtime.evaluate', {
    expression: "document.querySelector('#amb-bulk-host').shadowRoot.querySelector('[data-act=expfull]').click(); 1",
    returnByValue: true,
  });
  await sleep(600);
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'preview-export.png'), Buffer.from(shot3.data, 'base64'));
  console.log('preview-export.png 已存');

  chrome.kill();
  server.close();
  // 收工把 Chrome 設定檔刪掉（set AMB_KEEP_TEMP=1 可保留）
  if (process.env.AMB_KEEP_TEMP !== '1') {
    await sleep(700);
    try { fs.rmSync(USER_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {}
  }
  process.exit(0);
})();
