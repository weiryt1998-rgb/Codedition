// Run with Node 24 and installed Chrome. No npm packages are required.
// Actual HTML/CSS/JavaScript and Chart.js; Firebase is replaced with an in-memory fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'artifacts');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STORAGE_KEY = /^documents\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

// Stand-in for the Cloudflare Worker + R2 (worker/src/index.js has its own tests in worker.test.mjs).
const r2 = new Map();        // storageKey -> bytes
const registry = new Map();  // document id -> { storageKey, fileName, deleted }, mirrored from the fixture
const apiLog = [];
function readBody(req, limit = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function fakeWorker(req, res, url) {
  apiLog.push(`${req.method} ${url.pathname}`);
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (req.headers.authorization !== 'Bearer browser-test-token') return send(401, { error: 'invalid-token' });
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'POST' && url.pathname === '/api/files') {
    if (req.headers['content-type'] !== 'application/pdf') return send(415, { error: 'not-pdf' });
    const body = await readBody(req, 20 * 1024 * 1024);
    if (!body) return send(413, { error: 'file-too-large' });
    if (body.subarray(0, 5).toString('latin1') !== '%PDF-') return send(415, { error: 'not-pdf' });
    const storageKey = `documents/${new Date().getUTCFullYear()}/${randomUUID()}.pdf`;
    r2.set(storageKey, body);
    return send(201, { storageKey, size: body.length });
  }
  if (parts[1] === 'documents' && parts[3] === 'file') {
    const doc = registry.get(parts[2]);
    if (!doc) return send(404, { error: 'document-not-found' });
    if (req.method === 'GET') return r2.has(doc.storageKey) ? send(200, r2.get(doc.storageKey), 'application/pdf') : send(404, { error: 'file-not-found' });
    if (req.method === 'DELETE') {
      if (!doc.deleted) return send(409, { error: 'not-in-trash' });
      r2.delete(doc.storageKey);
      return send(200, { deleted: true });
    }
  }
  if (req.method === 'DELETE' && parts[1] === 'files') {
    const key = parts.slice(2).join('/');
    if ([...registry.values()].some((d) => d.storageKey === key)) return send(409, { error: 'file-in-use' });
    r2.delete(key);
    return send(200, { deleted: true });
  }
  return send(404, { error: 'not-found' });
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const chartResponse = await fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js', { signal: AbortSignal.timeout(20000) });
  assert.ok(chartResponse.ok, 'Chart.js CDN is available');
  const chart = await chartResponse.text();
  const original = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const html = original.replace(/<script src="https:\/\/www\.gstatic\.com[^\"]+"><\/script>/g, '')
    .replace('https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js', '/chart.js')
    .replace('src="firebase-config.js"', 'src="/fixture.js"')
    .replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g, '');
  const assetsDir = path.join(root, 'assets');
  const assetPath = (pathname) => {
    const file = path.join(root, decodeURIComponent(pathname));
    return file.startsWith(assetsDir + path.sep) ? file : null;
  };
  const server = http.createServer(async (req, res) => {
    const files = { '/style.css': 'style.css', '/script.js': 'script.js', '/fixture.js': 'tests/browser-fixture.js' };
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/__fixture/documents' && req.method === 'POST') {
        const info = JSON.parse(await readBody(req));
        if (info.removed) registry.delete(info.id); else registry.set(info.id, info);
        res.writeHead(204); res.end();
      } else if (url.pathname.startsWith('/api/')) await fakeWorker(req, res, url);
      else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
      else if (url.pathname === '/chart.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(chart); }
      else if (files[url.pathname]) {
        res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await fs.readFile(path.join(root, files[url.pathname])));
      } else if (assetPath(url.pathname)) {
        // CSS masks only accept SVG served as image/svg+xml, so the type must be right.
        res.setHeader('Content-Type', { '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(url.pathname)] || 'application/octet-stream');
        res.end(await fs.readFile(assetPath(url.pathname)));
      } else { res.writeHead(204); res.end(); }
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'govdocs-browser-test-'));
  let browser, socket;
  const results = [], errors = [];
  try {
    const chrome = process.env.CHROME_PATH || (process.argv.includes('--edge')
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let launchError;
    browser.on('error', (error) => { launchError = error; });
    let port;
    for (let i = 0; i < 100; i++) {
      if (launchError) throw launchError;
      try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(100); }
    }
    assert.ok(port, 'Chrome started');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const item = pending.get(message.id);
        if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
      } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    function cdp(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    async function waitFor(expression) {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
      throw new Error(`Condition not reached: ${expression}`);
    }
    async function waitForApp() {
      await waitFor(`document.getElementById('navCountDocs')?.textContent === '12' && document.getElementById('pageLoader').hidden`);
    }
    async function reloadApp() { await cdp('Page.reload'); await waitForApp(); }
    async function click(selector) {
      const point = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('Missing target'); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    async function check(name, fn) {
      try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
      catch (error) { results.push({ name, passed: false, error: error.message }); throw error; }
    }
    // Waits for every finite animation and transition, so measurements don't catch a layout mid-change.
    async function settle() {
      await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)`);
    }
    async function screenshot(name) {
      await settle();
      const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path.join(output, name), Buffer.from(image.data, 'base64'));
    }
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await waitForApp();
    await check('Dashboard renders 12 documents and three real charts', async () => {
      await waitFor(`document.getElementById('statTotal').textContent === '12'`);
      assert.equal(await evaluate(`Object.keys(charts).length`), 3);
      assert.ok(await evaluate(`Object.values(charts).every(c=>c.width>0&&c.height>0)`));
      await screenshot('desktop.png');
    });
    await check('Logo loads in the loader, sidebar and banner', async () => {
      await waitFor(`[...document.querySelectorAll('img[src="assets/logo.png"]')].every(img => img.complete)`);
      const logos = await evaluate(`[...document.querySelectorAll('img[src="assets/logo.png"]')].map(img => img.naturalWidth)`);
      assert.equal(logos.length, 3);
      assert.ok(logos.every((width) => width > 0), 'every logo image decoded');
    });
    await check('Menu icons are glossy tiles with white icons, and the current page is a raised card', async () => {
      const nav = await evaluate(`(() => {
        const active = document.querySelector('.nav-item.is-active'), style = getComputedStyle(active);
        return {
          active: active.dataset.view, card: style.backgroundColor, darkText: style.color !== 'rgb(255, 255, 255)',
          tiles: [...document.querySelectorAll('.nav-ico')].every((ico) => getComputedStyle(ico).backgroundImage.startsWith('linear-gradient')),
          glyphs: [...new Set([...document.querySelectorAll('.nav-ico svg')].map((svg) => getComputedStyle(svg).stroke))],
          badge: getComputedStyle(document.getElementById('navCountCats')).backgroundColor,
          trashAlert: document.getElementById('navCountTrash').classList.contains('is-alert'),
        };
      })()`);
      assert.deepEqual(nav, { active: 'dashboard', card: 'rgb(255, 255, 255)', darkText: true, tiles: true,
        glyphs: ['rgb(255, 255, 255)'], badge: 'rgba(255, 255, 255, 0.94)', trashAlert: false });
      // the selected item's label stays on one line, even "เอกสารทั้งหมด" next to a two-digit count
      await click('[data-view="documents"]');
      assert.equal(await evaluate(`(() => { const label = document.querySelector('.nav-item.is-active .nav-label'); return label.getClientRects().length === 1 && label.getBoundingClientRect().height < 30; })()`), true);
      await click('[data-view="dashboard"]');
      const sidebar = await evaluate(`(() => { const r = document.querySelector('.nav').getBoundingClientRect(); return { x: 0, y: 0, width: r.right + 16, height: r.bottom + 16, scale: 1 }; })()`);
      const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: sidebar });
      await fs.writeFile(path.join(output, 'sidebar.png'), Buffer.from(shot.data, 'base64'));
    });
    await check('Dashboard stat cards tilt toward the mouse with a glare, and stay flat for reduced motion', async () => {
      const move = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      const card = () => evaluate(`(() => { const c = document.querySelectorAll('.stat-card')[1]; return { rx: c.style.getPropertyValue('--rx'), ry: c.style.getPropertyValue('--ry'), glare: c.querySelectorAll('.fx-glare').length }; })()`);
      const point = await evaluate(`(() => { const r = document.querySelectorAll('.stat-card')[1].getBoundingClientRect(); return { x: r.left + r.width * .9, y: r.top + r.height * .1 }; })()`);
      await move(5, 990);
      assert.deepEqual(await card(), { rx: '', ry: '', glare: 1 });
      await move(point.x - 10, point.y + 10);
      await move(point.x, point.y);
      await waitFor(`document.querySelectorAll('.stat-card')[1].style.getPropertyValue('--rx') !== ''`);
      // near the top-right corner the card tips its top away and turns toward the right
      const tilted = await card();
      assert.ok(parseFloat(tilted.rx) > 3 && parseFloat(tilted.ry) > 3, JSON.stringify(tilted));
      await waitFor(`getComputedStyle(document.querySelectorAll('.stat-card')[1].querySelector('.fx-glare')).opacity === '1'`);
      await move(5, 990);
      await waitFor(`document.querySelectorAll('.stat-card')[1].style.getPropertyValue('--rx') === ''`);
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await move(point.x - 10, point.y + 10);
      await move(point.x, point.y);
      await pause(200);
      assert.equal((await card()).rx, '', 'reduced motion keeps the cards flat');
      await cdp('Emulation.setEmulatedMedia', { features: [] });
      await move(5, 990);
      // the point is measured on the card itself, so its visual centre stays level even once the card has tilted and lifted
      await move(point.x, point.y);
      await pause(400);
      const centre = await evaluate(`(() => { const r = document.querySelectorAll('.stat-card')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await move(centre.x, centre.y);
      await pause(300);
      const level = await card();
      assert.ok(Math.abs(parseFloat(level.rx)) < 1 && Math.abs(parseFloat(level.ry)) < 1, JSON.stringify(level));
      await move(5, 990);
    });
    await check('Glow and press details: an empty meter has no glow, a pressed top-bar button sinks, a long note does not widen its table', async () => {
      // nothing rejected: that meter is empty and must not leave a glowing dot
      await evaluate(`fixtureStore.documents.forEach((d) => { if (d.status === 'rejected') { d.status = 'pending'; d.wasRejected = true; } }); emitFixture()`);
      await waitFor(`document.getElementById('meterRejected').style.width === '0%'`);
      assert.deepEqual(await evaluate(`(() => { const m = document.getElementById('meterRejected'); return [m.classList.contains('is-empty'), getComputedStyle(m).boxShadow]; })()`), [true, 'none']);
      await evaluate(`fixtureStore.documents.forEach((d) => { if (d.wasRejected) { d.status = 'rejected'; delete d.wasRejected; } }); emitFixture()`);
      // pressing the top bar's เพิ่มเอกสาร shows the sunk shadow, not the hover glow
      const button = await evaluate(`(() => { const r = document.querySelector('.topbar .btn-primary').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...button });
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
      await pause(300);
      assert.match(await evaluate(`getComputedStyle(document.querySelector('.topbar .btn-primary')).boxShadow`), /^rgba\(0, 0, 0, 0\.22\) 0px 2px 5px 0px inset/);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 990 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 990, button: 'left', clickCount: 1 });
      assert.equal(await evaluate(`document.getElementById('docModalOverlay').hidden`), true, 'released elsewhere, nothing opened');
      // a long note and file name are cut with … instead of widening the title column
      await evaluate(`(() => { const d = fixtureStore.documents[0]; d.description = 'กองคลัง ขอความอนุเคราะห์ตรวจสอบเอกสารประกอบการเบิกจ่ายงบประมาณประจำปี พ.ศ. 2569 โดยด่วน'; d.fileName = 'หนังสือขออนุมัติจัดซื้อจัดจ้าง_ปีงบประมาณ2569_ฉบับแก้ไขครั้งที่2_สำเนาถูกต้อง.pdf'; emitFixture(); switchView('documents'); })()`);
      await pause(400);
      assert.deepEqual(await evaluate(`(() => { const box = document.querySelector('[data-group="cat-a"]'), scroll = box.querySelector('.table-scroll'), sub = box.querySelector('.doc-sub');
        return { fits: scroll.scrollWidth <= scroll.clientWidth, cut: sub.scrollWidth > sub.clientWidth, tooltip: sub.title.endsWith('สำเนาถูกต้อง.pdf') }; })()`), { fits: true, cut: true, tooltip: true });
      await evaluate(`(() => { const d = fixtureStore.documents[0]; delete d.description; d.fileName = 'sample.pdf'; emitFixture(); switchView('dashboard'); })()`);
    });
    await check('Global search opens and filters document results', async () => {
      await click('#globalSearch');
      await cdp('Input.insertText', { text: 'เอกสารทดสอบ 12' });
      await waitFor(`document.querySelector('#view-documents').classList.contains('is-active')`);
      assert.equal(await evaluate(`document.querySelectorAll('#docGroups tbody tr').length`), 1);
      await click('#clearFilters');
    });
    await check('Each category box pages on its own; keyboard paging keeps focus; the category filter leaves one box', async () => {
      // four older หนังสือรับ records give that box a second page, while หนังสือส่ง keeps a single page of six
      await evaluate(`for (let i = 0; i < 4; i++) fixtureStore.documents.push({ id: 'page-' + i, title: 'หน้าสอง ' + i, docNumber: 'หน้า/' + i, category: 'cat-a', deleted: false, createdAtMs: 1 + i }); emitFixture()`);
      await waitFor('allDocuments.length === 16');
      const box = (group) => evaluate(`(() => {
        const box = document.querySelector('[data-group="${group}"]');
        return { rows: box.querySelectorAll('tbody tr').length, pages: [...box.querySelectorAll('.pagination button')].map((b) => b.textContent) };
      })()`);
      assert.deepEqual(await box('cat-a'), { rows: 8, pages: ['‹', '1', '2', '›'] });
      assert.deepEqual(await box('cat-b'), { rows: 6, pages: [] });
      // หน้าถัดไป by keyboard: the box re-renders, and focus lands on the new current page since หน้าถัดไป is now off
      await evaluate(`document.querySelector('[data-group="cat-a"] [aria-label="หน้าถัดไป"]').focus()`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      assert.equal((await box('cat-a')).rows, 2, '6 seed records and 4 more: 8 on the first page, 2 on the second');
      assert.deepEqual(await evaluate(`[document.activeElement.closest('[data-group]')?.dataset.group, document.activeElement.getAttribute('aria-current'), document.activeElement.textContent]`),
        ['cat-a', 'page', '2']);
      assert.deepEqual(await box('cat-b'), { rows: 6, pages: [] }, 'the other box stays as it was');
      await click('[data-group="cat-a"] [aria-label="หน้าก่อนหน้า"]');
      assert.equal((await box('cat-a')).rows, 8);
      await evaluate(`document.getElementById('filterCategory').value='cat-b'; document.getElementById('filterCategory').dispatchEvent(new Event('change'))`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups h3')].map((h) => h.textContent)`), ['หนังสือส่ง']);
      await evaluate('emitFixture()');
      assert.equal(await evaluate(`document.getElementById('filterCategory').value`), 'cat-b');
      await click('#clearFilters');
      await evaluate(`fixtureStore.documents = fixtureStore.documents.filter((d) => !d.id.startsWith('page-')); emitFixture()`);
      await waitFor('allDocuments.length === 12');
    });
    await check('Boxes follow the paper workflow and list newest saved first, with no sequence-number column', async () => {
      const boxes = await evaluate(`[...document.querySelectorAll('#docGroups .doc-group')].map((box) => {
        const heads = [...box.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        const column = heads.indexOf('เลขที่หนังสือ');
        return [box.querySelector('h3').textContent, heads[0] ?? null, [...box.querySelectorAll('tbody tr')].map((tr) => tr.cells[column].textContent)];
      })`);
      // seed-0 (ทดสอบ/1) is the newest of the 12 records; the box of หนังสือรับ starts with its เลขที่รับ column
      assert.deepEqual(boxes, [
        ['หนังสือรับ', 'เลขที่รับ', ['ทดสอบ/1', 'ทดสอบ/3', 'ทดสอบ/5', 'ทดสอบ/7', 'ทดสอบ/9', 'ทดสอบ/11']],
        ['หนังสือส่ง', 'เลขที่หนังสือ', ['ทดสอบ/2', 'ทดสอบ/4', 'ทดสอบ/6', 'ทดสอบ/8', 'ทดสอบ/10', 'ทดสอบ/12']],
        ['คำสั่ง', null, []], ['บันทึกข้อความ', null, []], ['คำร้อง', null, []],
      ]);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#recentTable tbody tr')].map((tr) => tr.cells[0].textContent)`),
        ['ทดสอบ/1', 'ทดสอบ/2', 'ทดสอบ/3', 'ทดสอบ/4', 'ทดสอบ/5']);
      assert.equal(await evaluate(`document.querySelectorAll('.col-entry').length`), 0);
      assert.equal(await evaluate(`document.querySelector('#recentTable thead th').textContent.trim()`), 'เลขที่หนังสือ');
      await screenshot('documents-boxes.png');
      // a 1280px laptop fits even the widest box (หนังสือรับ: เลขที่รับ plus the file icons) without sideways scrolling
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await pause(200);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups .table-scroll')].filter((s) => s.scrollWidth > s.clientWidth).map((s) => s.closest('.doc-group').querySelector('h3').textContent)`), []);
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    });
    await check('Document and category action IDs preserve quotes and HTML entities', async () => {
      const id = 'record" data-id-marker="injected &quot; literal';
      const ids = await evaluate(`(() => {
        const id = ${JSON.stringify(id)};
        allDocuments = [{ ...allDocuments[0], id }];
        allTrash = [{ ...allDocuments[0], deleted: true }];
        allCategories = [{ ...allCategories[0], id }];
        renderDocsTable(); renderRecentTable(); renderTrash(); renderCategories();
        const actions = ['preview', 'download', 'edit', 'delete', 'restore', 'purge', 'del-cat', 'open-cat', 'add-to', 'group', 'view-file'];
        return {
          values: actions.map(action => document.querySelector('[data-' + action + ']').getAttribute('data-' + action)),
          injected: document.querySelectorAll('[data-id-marker]').length,
        };
      })()`);
      assert.deepEqual(ids.values, Array(11).fill(id));
      assert.equal(ids.injected, 0, 'Record IDs must not create HTML attributes');
      await reloadApp();
      await click('[data-view="documents"]');
    });
    await check('A document saved without a PDF or title shows "-" and offers no preview or download', async () => {
      await evaluate(`allDocuments = [{ id: 'no-file', title: '', docNumber: 'NOFILE/1', status: 'pending', deleted: false }]; renderDocsTable()`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups [data-preview], #docGroups [data-download]')].map((b) => [b.disabled, b.title])`),
        [[true, 'ดูตัวอย่าง (ไม่มีไฟล์ PDF)'], [true, 'ดาวน์โหลด (ไม่มีไฟล์ PDF)']]);
      assert.equal(await evaluate(`document.querySelector('#docGroups .doc-title-cell').textContent`), '-');
      assert.deepEqual(await evaluate(`(() => { const open = document.querySelector('#docGroups .doc-open'); return [open.tagName, open.querySelector('svg').getAttribute('class')]; })()`),
        ['DIV', 'doc-ico is-none'], 'no file: a grey sheet, and the title is not a button');
      await click('#docGroups .doc-open');
      await click('#docGroups [data-preview]');
      await click('#docGroups [data-download]');
      await pause(200);
      assert.equal(await evaluate(`document.getElementById('previewModalOverlay').hidden`), true);
      assert.equal(await evaluate(`document.querySelectorAll('#toastStack .toast.error').length`), 0, 'no "broken file" error');
      await reloadApp();
      await click('[data-view="documents"]');
    });
    await check('Modal traps keyboard focus and restores it on Escape', async () => {
      await click('#addDocBtn');
      await evaluate(`document.getElementById('docSaveBtn').focus()`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert.ok(await evaluate(`document.getElementById('docModalOverlay').contains(document.activeElement) && document.activeElement.id!=='docSaveBtn'`));
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate(`document.activeElement.id`), 'addDocBtn');
      assert.equal(await evaluate(`document.getElementById('app').inert`), false);
    });
    let createdKey, createdId;
    await check('Invalid PDF is rejected; valid PDF can be added and edited', async () => {
      await click('#addDocBtn');
      // the upload arrow is a stroked icon; the PDF icons' styles once shared its class and hid it
      assert.deepEqual(await evaluate(`(() => { const svg = document.querySelector('#fileDrop svg'), r = svg.getBoundingClientRect(); return [getComputedStyle(svg.querySelector('path')).stroke !== 'none', r.width > 20 && r.height > 20]; })()`),
        [true, true], 'the drop zone shows its upload arrow');
      await evaluate(`handleFile(new File(['invalid'], 'invalid.pdf', {type:'application/pdf'}))`);
      assert.equal(await evaluate(`document.getElementById('docFormError').hidden`), false);
      await evaluate(`document.getElementById('docTitle').value='Browser created'; document.getElementById('docNumber').value='TEST/100'; document.getElementById('docUrgency').value='most-urgent'; handleFile(new File([fixturePdf], 'test.pdf', {type:'application/pdf'}))`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.length===13`);
      // The PDF went to R2 through the Worker; Firestore got metadata only.
      const saved = await evaluate(`(() => { const d = fixtureStore.documents.find((x) => x.title === 'Browser created'); return { id: d.id, storageKey: d.storageKey, hasFileData: 'fileData' in d, mimeType: d.mimeType, createdBy: d.createdBy, fileName: d.fileName, urgency: d.urgency }; })()`);
      createdId = saved.id; // later checks open, download and delete this record, the one whose PDF is in R2
      assert.match(saved.storageKey, STORAGE_KEY);
      assert.equal(saved.hasFileData, false);
      assert.deepEqual([saved.mimeType, saved.createdBy, saved.fileName, saved.urgency], ['application/pdf', 'browser-test', 'test.pdf', 'most-urgent']);
      assert.ok(r2.get(saved.storageKey).subarray(0, 5).toString('latin1') === '%PDF-');
      assert.ok(apiLog.includes('POST /api/files'));
      createdKey = saved.storageKey;
      await evaluate(`document.getElementById('globalSearch').value='Browser created'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      await click('[data-edit]');
      assert.equal(await evaluate(`document.getElementById('docUrgency').value`), 'most-urgent', 'editing shows the saved urgency');
      await evaluate(`document.getElementById('docTitle').value='Browser edited'; document.getElementById('docUrgency').value='urgent'`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.some(d=>d.title==='Browser edited' && d.urgency==='urgent')`);
      await click('#clearFilters');
      const badge = (docNumber) => evaluate(`(() => {
        // the หนังสือรับ box has เลขที่รับ first, so the document number may be in the second cell
        const row = [...document.querySelectorAll('#docGroups tbody tr')].find((tr) => [tr.cells[0], tr.cells[1]].some((td) => td.textContent === ${JSON.stringify(docNumber)}));
        if (!row) throw new Error('Missing row ' + ${JSON.stringify(docNumber)});
        return row.querySelector('.urgency')?.textContent ?? null;
      })()`);
      assert.equal(await badge('TEST/100'), 'ด่วน');
      assert.equal(await badge('ทดสอบ/4'), 'ด่วนมาก');
      assert.equal(await badge('ทดสอบ/5'), 'ด่วนที่สุด');
      assert.equal(await badge('ทดสอบ/1'), null, 'a record without the field shows no badge');
      assert.equal(await badge('ทดสอบ/2'), null, 'ปกติ shows no badge');
      await screenshot('documents.png');
      await click('#addDocBtn');
      assert.equal(await evaluate(`document.getElementById('docUrgency').value`), '', 'a new document starts as ปกติ');
      assert.equal(await evaluate(`document.getElementById('docStatus').value`), '', 'a new document starts with no status chosen');
      await screenshot('document-form.png');
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    });
    const documentLabels = ['ชื่อเอกสาร', 'เลขที่หนังสือ', 'วันที่ออกเอกสาร', 'หน่วยงาน'];
    const orderLabels = ['ชื่อคำสั่ง', 'เลขที่คำสั่ง', 'วันที่ออกคำสั่ง', 'ผู้สั่ง'];
    const orderStatuses = ['', 'รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น', 'ยกเลิก']; // starts blank
    const closeDocForm = async () => {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(`document.getElementById('docModalOverlay').hidden`);
    };
    // What the document form currently shows, as a person would see it
    const docForm = () => evaluate(`(() => {
      const category = document.getElementById('docCategory');
      return {
        title: document.getElementById('docModalTitle').textContent,
        labels: ['docTitleLabel', 'docNumberLabel', 'docDateLabel', 'docAgencyLabel'].map((id) => document.getElementById(id).textContent),
        category: [category.value, category.selectedOptions[0]?.textContent, category.disabled],
        urgencyShown: document.getElementById('docUrgency').getClientRects().length > 0,
        statuses: [...document.getElementById('docStatus').options].map((o) => o.textContent),
        status: document.getElementById('docStatus').value,
        save: document.getElementById('docSaveBtn').textContent,
      };
    })()`);
    await check('Choosing the คำสั่ง category turns the document form into the order form; its box adds orders the same way', async () => {
      const chooseOrder = (select) => evaluate(`(() => {
        const s = document.getElementById(${JSON.stringify(select)});
        s.value = [...s.options].find((o) => o.textContent === 'คำสั่ง').value;
        s.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(`document.getElementById('docModalOverlay').hidden`);
      await click('#addDocBtn');
      assert.deepEqual((await docForm()).labels, documentLabels);
      await chooseOrder('docCategory');
      const form = await docForm();
      assert.deepEqual([form.title, form.labels, form.urgencyShown, form.statuses, form.save],
        ['เพิ่มคำสั่งใหม่', orderLabels, false, orderStatuses, 'บันทึกคำสั่ง']);
      assert.equal(form.category[2], false, 'a category chosen in the document form can still be changed');
      assert.deepEqual(await evaluate(`['docNumber', 'docAgency'].map((id) => document.getElementById(id).placeholder)`), ['เช่น 123/2569', 'เช่น นายก อบต.']);
      await screenshot('document-form-order.png');
      await closeDocForm();
      await click('#addDocBtn');
      assert.deepEqual((await docForm()).labels, documentLabels, 'the next new document starts without a category');
      await closeDocForm();
      // filtered to คำสั่ง only its box is left; with no orders yet it is just the heading and its add button
      await chooseOrder('filterCategory');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups .doc-group')].map((box) => [box.querySelector('h3').textContent, box.querySelector('.panel-tag').textContent, box.querySelector('[data-add-to]').textContent.trim(), box.querySelectorAll('table').length])`),
        [['คำสั่ง', 'ยังไม่มีเอกสาร', 'เพิ่มคำสั่ง', 0]]);
      await click('#docGroups [data-add-to]');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      const fromBox = await docForm();
      assert.deepEqual([fromBox.title, fromBox.category.slice(1), fromBox.labels], ['เพิ่มคำสั่งใหม่', ['คำสั่ง', true], orderLabels], 'the คำสั่ง box opens the locked order form');
      await closeDocForm();
      await click('#clearFilters');
    });
    await check('Choosing หนังสือส่ง, หนังสือรับ or คำร้อง calls the agency field ถึง, จาก or ผู้ยื่นคำร้อง, and so does the column in their boxes', async () => {
      const choose = (select, name) => evaluate(`(() => {
        const s = document.getElementById(${JSON.stringify(select)});
        s.value = [...s.options].find((o) => o.textContent === ${JSON.stringify(name)}).value;
        s.dispatchEvent(new Event('change'));
      })()`);
      // the agency column is the fifth from the end, before date, size, status and the actions
      const agencyColumns = () => evaluate(`Object.fromEntries([...document.querySelectorAll('#docGroups .doc-group')].filter((box) => box.querySelector('thead'))
        .map((box) => [box.querySelector('h3').textContent, [...box.querySelectorAll('thead th')].at(-5).textContent]))`);
      await click('#addDocBtn');
      await choose('docCategory', 'หนังสือส่ง');
      assert.deepEqual((await docForm()).labels, [...documentLabels.slice(0, 3), 'ถึง']);
      await screenshot('document-form-outgoing.png');
      await choose('docCategory', 'หนังสือรับ');
      assert.deepEqual((await docForm()).labels, [...documentLabels.slice(0, 3), 'จาก']);
      await screenshot('document-form-incoming.png');
      await choose('docCategory', 'คำร้อง');
      assert.deepEqual((await docForm()).labels, [...documentLabels.slice(0, 3), 'ผู้ยื่นคำร้อง']);
      await screenshot('document-form-petition.png');
      await closeDocForm();
      await click('[data-view="documents"]');
      // the fixture has no คำร้อง yet, so only these two boxes have a table
      assert.deepEqual(await agencyColumns(), { 'หนังสือรับ': 'จาก', 'หนังสือส่ง': 'ถึง', 'ไม่ระบุหมวดหมู่': 'หน่วยงาน' });
      await choose('filterCategory', 'หนังสือส่ง');
      assert.deepEqual(await agencyColumns(), { 'หนังสือส่ง': 'ถึง' });
      await screenshot('documents-outgoing.png');
      await click('#clearFilters');
    });
    await check('The หนังสือรับ box adds with เลขที่รับ ready after หมวดหมู่, and lists it first, sorted as numbers', async () => {
      const choose = (select, name) => evaluate(`(() => {
        const s = document.getElementById(${JSON.stringify(select)});
        s.value = [...s.options].find((o) => o.textContent === ${JSON.stringify(name)}).value;
        s.dispatchEvent(new Event('change'));
      })()`);
      const fieldShown = () => evaluate(`document.getElementById('docReceiveNumber').getClientRects().length > 0`);
      await click('#addDocBtn');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      assert.equal(await fieldShown(), false, 'a new document has no category yet');
      await closeDocForm();
      // the box's own add button chooses หนังสือรับ, so เลขที่รับ is there from the start
      await click('[data-group="cat-a"] [data-add-to]');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      const fromBox = await docForm();
      assert.deepEqual([fromBox.title, fromBox.category, fromBox.labels[3], await fieldShown()], ['เพิ่มเอกสารใหม่', ['cat-a', 'หนังสือรับ', false], 'จาก', true]);
      // the grid cell after หมวดหมู่: the next row, under จาก
      assert.deepEqual(await evaluate(`(() => {
        const field = document.getElementById('docReceiveField').getBoundingClientRect();
        const category = document.getElementById('docCategory').closest('label').getBoundingClientRect();
        const agency = document.getElementById('docAgency').closest('label').getBoundingClientRect();
        return { below: field.top >= category.bottom, underAgency: Math.abs(field.left - agency.left) < 1 };
      })()`), { below: true, underAgency: true });
      await choose('docCategory', 'หนังสือส่ง');
      assert.equal(await fieldShown(), false);
      await choose('docCategory', 'หนังสือรับ');
      await evaluate(`document.getElementById('docTitle').value='หนังสือรับทดสอบ'; document.getElementById('docNumber').value='สท 0023.3/ว 456'; document.getElementById('docReceiveNumber').value='125'`);
      await screenshot('document-form-receive.png');
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.some((d) => d.title === 'หนังสือรับทดสอบ')`);
      assert.equal(await evaluate(`fixtureStore.documents.find((d) => d.title === 'หนังสือรับทดสอบ').receiveNumber`), '125');
      // an older one numbered 9 must sort before 125, not after it as text would
      await evaluate(`fixtureStore.documents.find((d) => d.id === 'seed-2').receiveNumber = '9'; emitFixture()`);

      const box = (group) => evaluate(`(() => {
        const heads = [...document.querySelectorAll('[data-group="${group}"] thead th')];
        return {
          heads: heads.slice(0, 2).map((th) => th.textContent.trim()),
          rounded: getComputedStyle(heads[0]).borderTopLeftRadius,
          sorted: heads.filter((th) => th.getAttribute('aria-sort') !== 'none' && th.hasAttribute('aria-sort')).map((th) => [th.textContent, th.getAttribute('aria-sort')]),
          rows: [...document.querySelectorAll('[data-group="${group}"] tbody tr')].map((tr) => [tr.cells[0].textContent, tr.cells[1].textContent]),
        };
      })()`);
      let shown = await box('cat-a');
      assert.deepEqual([shown.heads, shown.rounded, shown.sorted], [['เลขที่รับ', 'เลขที่หนังสือ'], '12px', []]);
      assert.deepEqual(shown.rows, [['125', 'สท 0023.3/ว 456'], ['-', 'ทดสอบ/1'], ['9', 'ทดสอบ/3'], ['-', 'ทดสอบ/5'], ['-', 'ทดสอบ/7'], ['-', 'ทดสอบ/9'], ['-', 'ทดสอบ/11']]);
      const outgoing = await box('cat-b');
      await screenshot('documents-receive.png');
      // sorted from the keyboard: the box re-renders, and focus stays on the same header
      await evaluate(`document.querySelector('[data-group="cat-a"] th[data-sort="receiveNumber"]').focus()`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      shown = await box('cat-a');
      assert.deepEqual([shown.sorted, shown.rows.map(([number]) => number)], [[['เลขที่รับ', 'ascending']], ['-', '-', '-', '-', '-', '9', '125']]);
      assert.equal(await evaluate(`document.activeElement.matches('[data-group="cat-a"] th[data-sort="receiveNumber"]')`), true, 'focus stays on the header');
      await click('[data-group="cat-a"] th[data-sort="receiveNumber"]');
      shown = await box('cat-a');
      assert.deepEqual([shown.sorted, shown.rows.map(([number]) => number)], [[['เลขที่รับ', 'descending']], ['125', '9', '-', '-', '-', '-', '-']]);
      assert.deepEqual(await box('cat-b'), outgoing, 'the หนังสือส่ง box keeps its own order');

      // found by its number from the search box, and the number comes back when editing
      await evaluate(`document.getElementById('globalSearch').value='125'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups .doc-group')].map((b) => [b.dataset.group, b.querySelectorAll('tbody tr').length])`), [['cat-a', 1]]);
      await click('[data-edit]');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      assert.deepEqual([await fieldShown(), await evaluate(`document.getElementById('docReceiveNumber').value`)], [true, '125']);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(`document.getElementById('docModalOverlay').hidden`);
      await click('#clearFilters');
      // later checks count the seed documents and open the newest row, so the test record goes away again
      await evaluate(`fixtureStore.documents = fixtureStore.documents.filter((d) => d.title !== 'หนังสือรับทดสอบ'); delete fixtureStore.documents.find((d) => d.id === 'seed-2').receiveNumber; emitFixture()`);
      await waitFor('allDocuments.length === 13');
    });
    await check('เพิ่มคำสั่ง in the คำสั่ง box opens the order form locked to คำสั่ง; orders save, show their status and edit there', async () => {
      const orderId = await evaluate(`allCategories.find((c) => c.name === 'คำสั่ง').id`);
      await click(`[data-add-to="${orderId}"]`);
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      assert.deepEqual(await docForm(), {
        title: 'เพิ่มคำสั่งใหม่', labels: orderLabels, category: [orderId, 'คำสั่ง', true], urgencyShown: false,
        statuses: orderStatuses, status: '', save: 'บันทึกคำสั่ง',
      });
      await screenshot('order-form.png');
      // the พ.ศ. year beside the date starts at this year; picking an earlier one backdates the order, keeping day and month
      assert.equal(await evaluate(`(() => { const y = document.getElementById('docYear'); return y.getClientRects().length > 0 && y.value === String(new Date().getFullYear() + 543); })()`), true);
      assert.equal(await evaluate(`(() => {
        const date = document.getElementById('docDate'), year = document.getElementById('docYear'), r = year.getBoundingClientRect(), d = date.getBoundingClientRect();
        return Math.abs(r.top - d.top) < 1 && r.left >= d.right && r.right <= date.closest('label').getBoundingClientRect().right + 1;
      })()`), true, 'the year sits beside the date, inside its column');
      await evaluate(`(() => {
        const date = document.getElementById('docDate'), year = document.getElementById('docYear');
        date.value = '2026-03-15'; date.dispatchEvent(new Event('change'));
        year.value = '2565'; year.dispatchEvent(new Event('change'));
      })()`);
      assert.equal(await evaluate(`document.getElementById('docDate').value`), '2022-03-15');
      await evaluate(`document.getElementById('docTitle').value='คำสั่งทดสอบเบราว์เซอร์'; document.getElementById('docNumber').value='ทดสอบ/คำสั่ง'; document.getElementById('docAgency').value='นายก อบต.'; document.getElementById('docStatus').value='in-progress'`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.some((d) => d.title === 'คำสั่งทดสอบเบราว์เซอร์')`);
      const saved = await evaluate(`(() => { const d = fixtureStore.documents.find((x) => x.title === 'คำสั่งทดสอบเบราว์เซอร์'); return { category: d.category, status: d.status, agency: d.agency, date: d.date, hasUrgency: 'urgency' in d }; })()`);
      assert.deepEqual(saved, { category: orderId, status: 'in-progress', agency: 'นายก อบต.', date: '2022-03-15', hasUrgency: false });
      // the คำสั่ง box names its columns like the order form
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-group="${orderId}"] thead th')].map((th) => th.textContent)`),
        ['เลขที่คำสั่ง', 'ชื่อคำสั่ง', 'ผู้สั่ง', 'วันที่ออกคำสั่ง', 'ขนาดไฟล์', 'สถานะ', 'การดำเนินการ']);
      // the status filter finds it, and its row carries the order status and the พ.ศ. year
      await evaluate(`document.getElementById('filterStatus').value='in-progress'; document.getElementById('filterStatus').dispatchEvent(new Event('change'))`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups tbody tr')].map((tr) => [tr.closest('[data-group]').dataset.group, tr.cells[0].textContent, tr.cells[3].textContent, tr.querySelector('.stamp').textContent])`),
        [[orderId, 'ทดสอบ/คำสั่ง', '15 มี.ค. 2565', 'กำลังดำเนินการ']]);
      await click('[data-edit]');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      const editing = await docForm();
      assert.deepEqual([editing.title, editing.category, editing.status, editing.save], ['แก้ไขคำสั่ง', [orderId, 'คำสั่ง', true], 'in-progress', 'บันทึกคำสั่ง']);
      await evaluate(`document.getElementById('docStatus').value='completed'`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.some((d) => d.title === 'คำสั่งทดสอบเบราว์เซอร์' && d.status === 'completed')`);
      await click('#clearFilters');
      // later checks count the seed documents, so the test order goes away again
      await evaluate(`fixtureStore.documents = fixtureStore.documents.filter((d) => d.title !== 'คำสั่งทดสอบเบราว์เซอร์'); emitFixture()`);
      await waitFor('allDocuments.length === 13');
      await click('#addDocBtn');
      const next = await docForm();
      assert.deepEqual([next.title, next.category[2], next.urgencyShown], ['เพิ่มเอกสารใหม่', false, true], 'the document form is unlocked again');
      await closeDocForm();
    });
    await check('The top bar has only เพิ่มเอกสาร on every page; เพิ่มคำสั่ง is the คำสั่ง box\'s button', async () => {
      const places = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length)
        .map((el) => el.closest('.topbar') ? 'topbar' : el.closest('.hero') ? 'hero' : el.closest('.view-head') ? 'page-head' : 'other')`);
      for (const [view, expected] of [['dashboard', ['topbar', 'hero']], ['documents', ['topbar', 'page-head']], ['categories', ['topbar']], ['trash', ['topbar']]]) {
        await click(`.nav-item[data-view="${view}"]`);
        assert.deepEqual(await places('#addDocBtn, [data-open="addDocBtn"]'), expected, view);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('.topbar button')].filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()).filter(Boolean)`),
          ['เพิ่มเอกสาร'], view);
      }
      await click('.nav-item[data-view="documents"]');
      const orderId = await evaluate(`allCategories.find((c) => c.name === 'คำสั่ง').id`);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'เพิ่มคำสั่ง').map((b) => b.closest('[data-group]')?.dataset.group ?? 'elsewhere')`),
        [orderId], 'the only เพิ่มคำสั่ง left is in the คำสั่ง box');
      await click(`[data-add-to="${orderId}"]`);
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      const form = await docForm();
      assert.deepEqual([form.title, form.category[1], form.category[2]], ['เพิ่มคำสั่งใหม่', 'คำสั่ง', true]);
      await closeDocForm();
      assert.equal(await evaluate(`document.activeElement.matches('[data-add-to="${orderId}"]')`), true, 'focus returns to the button');
    });
    await check('The order form searches saved orders, also by พ.ศ. year, and Enter or Esc there never saves or closes it', async () => {
      const before = await evaluate('allDocuments.length');
      // saved long ago (createdAtMs 1), so they never become the table's first row that later checks open
      const addOrder = (id, docNumber, title, agency, date, status = '') => evaluate(`(() => {
        fixtureStore.documents.push({ id: ${JSON.stringify(id)}, docNumber: ${JSON.stringify(docNumber)}, title: ${JSON.stringify(title)},
          agency: ${JSON.stringify(agency)}, date: ${JSON.stringify(date)}, status: ${JSON.stringify(status)},
          category: allCategories.find((c) => c.name === 'คำสั่ง').id, deleted: false, createdAtMs: 1 });
        emitFixture();
      })()`);
      await addOrder('lookup-1', '12/2565', 'แต่งตั้งคณะกรรมการตรวจรับพัสดุ', 'นายก อบต.', '2022-03-15', 'completed');
      await addOrder('lookup-2', '45/2565', 'แต่งตั้งคณะทำงานป้องกันภัย', 'ปลัด อบต.', '2022-11-02', 'in-progress');
      await addOrder('lookup-3', '3/2569', 'มอบหมายงานเวรยาม', 'นายก อบต.', '2026-01-10');
      await waitFor(`allDocuments.length === ${before + 3}`);
      const lookup = () => evaluate(`(() => {
        const results = document.getElementById('orderSearchResults');
        return {
          shown: document.getElementById('orderLookup').getClientRects().length > 0,
          note: document.getElementById('orderSearchNote').textContent,
          hits: results.hidden ? [] : [...results.querySelectorAll('.order-hit')].map((li) =>
            [li.querySelector('.order-hit-number').textContent, li.querySelector('.order-hit-date').textContent]),
        };
      })()`);
      const pickYear = (value) => evaluate(`(() => { const s = document.getElementById('orderSearchYear'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
      const press = async (key, code, windowsVirtualKeyCode, text) => {
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
      };

      const orderId = await evaluate(`allCategories.find((c) => c.name === 'คำสั่ง').id`);
      await click(`[data-add-to="${orderId}"]`);
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      let state = await lookup();
      assert.deepEqual([state.shown, state.hits, state.note], [true, [], 'มีคำสั่งที่บันทึกไว้แล้ว 3 รายการ พิมพ์คำค้นหรือเลือกปี พ.ศ. เพื่อดูรายการ']);
      await click('#orderSearch');
      await cdp('Input.insertText', { text: 'แต่งตั้ง' });
      state = await lookup();
      assert.deepEqual([state.hits, state.note], [[['45/2565', '2 พ.ย. 2565'], ['12/2565', '15 มี.ค. 2565']], 'พบ 2 คำสั่ง']);
      await pickYear('2569');
      state = await lookup();
      assert.deepEqual([state.hits, state.note], [[], 'ไม่พบคำสั่งที่ตรงกันในปี พ.ศ. 2569']);
      await pickYear('2565');
      state = await lookup();
      assert.deepEqual([state.hits.map(([number]) => number), state.note], [['45/2565', '12/2565'], 'พบ 2 คำสั่งในปี พ.ศ. 2565']);
      await screenshot('order-search.png');

      // Enter in the search box must not submit the (still empty) order form
      await evaluate(`document.getElementById('orderSearch').focus()`);
      await press('Enter', 'Enter', 13, '\r');
      await pause(300);
      assert.deepEqual(await evaluate(`[document.getElementById('docModalOverlay').hidden, allDocuments.length]`), [false, before + 3], 'Enter saves nothing');
      // Esc clears the search first; the chosen year keeps listing its orders
      await press('Escape', 'Escape', 27);
      state = await lookup();
      assert.deepEqual([await evaluate(`document.getElementById('orderSearch').value`), await evaluate(`document.getElementById('docModalOverlay').hidden`)], ['', false]);
      assert.deepEqual(state.hits.map(([number]) => number), ['45/2565', '12/2565']);
      // an order saved meanwhile (on another computer, say) shows up while the form is open
      await addOrder('lookup-4', '46/2565', 'แต่งตั้งเพิ่มเติม', 'นายก อบต.', '2022-12-01');
      await waitFor(`document.querySelectorAll('#orderSearchResults .order-hit').length === 3`);
      assert.equal(await evaluate(`document.querySelector('#orderSearchResults .order-hit-number').textContent`), '46/2565');
      // with the search empty, Esc closes the form as before
      await press('Escape', 'Escape', 27);
      await waitFor(`document.getElementById('docModalOverlay').hidden`);

      // the next order starts with an empty search, and the document form has none
      await click(`[data-add-to="${orderId}"]`);
      assert.deepEqual(await evaluate(`[document.getElementById('orderSearch').value, document.getElementById('orderSearchYear').value]`), ['', '']);
      await closeDocForm();
      await click('#addDocBtn');
      assert.equal(await evaluate(`document.getElementById('orderLookup').getClientRects().length`), 0);
      await closeDocForm();

      // on a phone (order form reached through เพิ่มเอกสาร → คำสั่ง) each result puts its title under the number and date
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await pause(350); // the sidebar slides off screen first; a click before then lands on its menu
      await click('#addDocBtn');
      await waitFor(`!document.getElementById('docModalOverlay').hidden`);
      await evaluate(`(() => {
        const category = document.getElementById('docCategory');
        category.value = allCategories.find((c) => c.name === 'คำสั่ง').id;
        category.dispatchEvent(new Event('change'));
        const search = document.getElementById('orderSearch');
        search.value = 'แต่งตั้ง'; search.dispatchEvent(new Event('input'));
      })()`);
      assert.deepEqual(await evaluate(`(() => {
        const body = document.querySelector('#docModalOverlay .modal-body');
        const hit = document.querySelector('#orderSearchResults .order-hit');
        const number = hit.querySelector('.order-hit-number').getBoundingClientRect(), title = hit.querySelector('.order-hit-title').getBoundingClientRect();
        return {
          measured: number.width > 0 && title.width > 0, fits: body.scrollWidth <= body.clientWidth,
          stacked: title.top >= number.bottom - 1 && Math.abs(title.left - number.left) < 1,
        };
      })()`), { measured: true, fits: true, stacked: true });
      await screenshot('order-search-mobile.png');
      await closeDocForm();
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await pause(350);
      assert.equal(await evaluate(`document.querySelector('.view.is-active').id`), 'view-documents', 'still on the documents page');

      await evaluate(`fixtureStore.documents = fixtureStore.documents.filter((d) => !d.id.startsWith('lookup-')); emitFixture()`);
      await waitFor(`allDocuments.length === ${before}`);
    });
    await check('PDF preview opens a Blob URL and releases it when closed', async () => {
      await evaluate(`(() => {const range=document.createRange(); range.selectNode(document.getElementById('previewFrame')); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);})()`);
      // The document added earlier keeps its PDF in R2, so it comes through the Worker.
      await click(`[data-preview="${createdId}"]`);
      await waitFor(`document.getElementById('previewFrame').src.startsWith('blob:')`);
      assert.ok(apiLog.some((line) => /^GET \/api\/documents\/[^/]+\/file$/.test(line)));
      assert.equal(await evaluate(`document.getElementById('previewPages').hidden`), true, 'desktop keeps the browser PDF viewer');
      assert.equal(await evaluate(`window.getSelection().isCollapsed`), true);
      assert.equal(await evaluate(`getComputedStyle(document.getElementById('previewFrame')).userSelect`), 'none');
      await pause(1500);
      await screenshot(process.argv.includes('--edge') ? 'preview-edge.png' : 'preview-chrome.png');
      if (process.argv.includes('--selection-debug')) {
        await evaluate(`(() => {const range=document.createRange(); range.selectNode(document.getElementById('previewFrame')); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);})()`);
        await screenshot('preview-selection.png');
      }
      await click('#previewModalOverlay [data-close-modal]');
      assert.equal(await evaluate(`document.getElementById('previewFrame').hasAttribute('src')`), false);
      assert.equal(await evaluate('previewUrl'), null);
    });
    await check('PDF download produces an actual PDF file', async () => {
      const downloads = await fs.mkdtemp(path.join(output, 'download-'));
      try {
        await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
        await click(`[data-download="${createdId}"]`);
        let downloaded;
        for (let i = 0; i < 100; i++) {
          downloaded = (await fs.readdir(downloads)).find((name) => name.endsWith('.pdf'));
          if (downloaded) break;
          await pause(50);
        }
        assert.ok(downloaded, 'PDF downloaded');
        assert.ok((await fs.readFile(path.join(downloads, downloaded), 'utf8')).startsWith('%PDF-'));
      } finally {
        await fs.rm(downloads, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
      }
    });
    await check('Legacy base64 documents still open without the Worker', async () => {
      const calls = apiLog.length;
      await evaluate(`document.getElementById('globalSearch').value='ทดสอบ/5'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      assert.equal(await evaluate(`document.querySelectorAll('#docGroups tbody tr').length`), 1);
      await click('[data-preview]');
      await waitFor(`document.getElementById('previewFrame').src.startsWith('blob:')`);
      assert.equal(apiLog.length, calls);
      await click('#previewModalOverlay [data-close-modal]');
      await click('#clearFilters');
    });
    await check('A title with a PDF has the red PDF icon and opens the file from the icon, the title, the keyboard and the dashboard', async () => {
      const openPreview = async (act) => {
        await act();
        await waitFor(`document.getElementById('previewFrame').src.startsWith('blob:')`);
        await click('#previewModalOverlay [data-close-modal]');
        await waitFor(`document.getElementById('previewModalOverlay').hidden && !document.getElementById('previewFrame').hasAttribute('src')`);
      };
      await evaluate(`document.getElementById('globalSearch').value='ทดสอบ/5'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      assert.deepEqual(await evaluate(`(() => {
        const open = document.querySelector('#docGroups .doc-open'), icon = open.querySelector('.doc-ico'), r = icon.getBoundingClientRect();
        return { tag: open.tagName, icon: icon.getAttribute('class'), size: [Math.round(r.width), Math.round(r.height)],
          fill: getComputedStyle(icon.querySelector('.sheet')).fill, label: icon.querySelector('text').textContent, sub: open.querySelector('.doc-sub').textContent };
      })()`), { tag: 'BUTTON', icon: 'doc-ico is-pdf', size: [30, 36], fill: 'rgb(229, 72, 77)', label: 'PDF', sub: 'sample.pdf' });
      await screenshot('title-pdf-icon.png');
      await openPreview(() => click('#docGroups .doc-open .doc-ico'));
      await openPreview(() => click('#docGroups .doc-open-title'));
      // the title is a button in the tab order, so Enter opens it too
      await openPreview(async () => {
        await evaluate(`document.querySelector('#docGroups .doc-open').focus()`);
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      });
      await click('#clearFilters');
      // the dashboard's latest documents open the same way
      await click('[data-view="dashboard"]');
      assert.equal(await evaluate(`document.querySelectorAll('#recentTable button.doc-open .doc-ico.is-pdf').length`), 5);
      await openPreview(() => click('#recentTable .doc-open'));
      await click('[data-view="documents"]');
    });
    await check('Trash, restore, and permanent deletion update the interface', async () => {
      const trashBadge = () => evaluate(`(() => { const b = document.getElementById('navCountTrash'); return [b.textContent, b.classList.contains('is-alert'), getComputedStyle(b).color]; })()`);
      await click(`[data-delete="${createdId}"]`);
      await click('#confirmActionBtn');
      await waitFor('allTrash.length===1');
      assert.deepEqual(await trashBadge(), ['1', true, 'rgb(190, 53, 53)'], 'the menu count turns red while something is in the trash');
      await click('[data-view="trash"]');
      await click('[data-restore]');
      await waitFor('allTrash.length===0 && allDocuments.length===13');
      assert.deepEqual((await trashBadge()).slice(0, 2), ['0', false]);
      await click('[data-view="documents"]');
      await click(`[data-delete="${createdId}"]`);
      await click('#confirmActionBtn');
      await waitFor('allTrash.length===1');
      await click('[data-view="trash"]');
      assert.equal(await evaluate('allTrash[0].storageKey'), createdKey);
      await click('[data-purge]');
      await click('#confirmActionBtn');
      await waitFor('allTrash.length===0 && allDocuments.length===12');
      // The R2 file went first (through the Worker), then the Firestore record.
      assert.ok(apiLog.some((line) => /^DELETE \/api\/documents\/[^/]+\/file$/.test(line)));
      assert.equal(r2.has(createdKey), false);
    });
    await check('Categories can be added and removed without deleting documents', async () => {
      await click('[data-view="categories"]');
      const count = await evaluate('allCategories.length');
      await click('#addCategoryBtn');
      await evaluate(`document.getElementById('categoryName').value='หมวดหมู่ทดสอบเบราว์เซอร์'`);
      await click('#categoryForm button[type="submit"]');
      await waitFor(`document.getElementById('categoryModalOverlay').hidden && allCategories.length===${count + 1}`);
      const id = await evaluate(`allCategories.find(c=>c.name==='หมวดหมู่ทดสอบเบราว์เซอร์').id`);
      await click(`[data-del-cat="${id}"]`);
      await click('#confirmActionBtn');
      await waitFor(`allCategories.length===${count}`);
      assert.equal(await evaluate('allDocuments.length'), 12);
      // built-in categories are recreated on every load, so their delete button is switched off
      const builtIn = await evaluate(`[...document.querySelectorAll('.category-card')]
        .filter((card) => ['คำสั่ง', 'บันทึกข้อความ', 'คำร้อง'].includes(card.querySelector('.cat-name').textContent))
        .map((card) => card.querySelector('.cat-actions button').disabled)`);
      assert.deepEqual(builtIn, [true, true, true]);
    });
    await check('Clicking a category folder opens its documents, but its trash button does not', async () => {
      const viewActive = (view) => evaluate(`document.getElementById('view-${view}').classList.contains('is-active')`);
      const filters = () => evaluate(`['globalSearch', 'filterCategory', 'filterStatus', 'filterDate'].map((id) => document.getElementById(id).value)`);
      await click('[data-view="categories"]');
      // leftover filters would hide documents that the folder counts
      await evaluate(`document.getElementById('globalSearch').value='ทดสอบ/1'; document.getElementById('filterStatus').value='approved'; document.getElementById('filterDate').value='2020-01-01'`);
      // the paper sheets above the cover are part of the folder too
      const paper = await evaluate(`(() => { const el=document.querySelector('[data-open-cat="cat-b"]'); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+40}; })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...paper, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...paper, button: 'left', clickCount: 1 });
      await waitFor(`document.getElementById('view-documents').classList.contains('is-active')`);
      assert.deepEqual(await filters(), ['', 'cat-b', '', '']);
      assert.equal(await evaluate(`document.getElementById('resultCount').textContent`), 'พบ 6 จาก 12 รายการ');
      // only that folder's box is left, with its agency column called ถึง
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#docGroups .doc-group')].map((box) => [box.querySelector('h3').textContent, box.querySelectorAll('tbody tr').length, [...box.querySelectorAll('thead th')].at(-5).textContent])`),
        [['หนังสือส่ง', 6, 'ถึง']]);

      await click('[data-view="categories"]');
      await click('[data-del-cat="cat-a"]');
      await waitFor(`!document.getElementById('confirmModalOverlay').hidden`);
      await click('#confirmModalOverlay [data-close-modal]');
      assert.equal(await viewActive('categories'), true, 'the trash button only asks to delete');
      const orderId = await evaluate(`allCategories.find((c) => c.name === 'คำสั่ง').id`);
      await click(`[data-open-cat="${orderId}"] .cat-actions button`);
      await pause(100);
      assert.equal(await viewActive('categories'), true, 'a built-in folder\'s disabled trash button does nothing');
      assert.equal(await evaluate(`document.getElementById('confirmModalOverlay').hidden`), true);

      // keyboard users open a folder from its name
      await evaluate(`document.querySelector('[data-open-cat="cat-a"] .cat-name').focus()`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitFor(`document.getElementById('view-documents').classList.contains('is-active')`);
      assert.deepEqual(await filters(), ['', 'cat-a', '', '']);
      await click('#clearFilters');
    });
    await check('Theme changes and persists across reload', async () => {
      const previous = await evaluate('activeMode()');
      await click('#themeToggle');
      assert.notEqual(await evaluate('activeMode()'), previous);
      await reloadApp();
      assert.notEqual(await evaluate('activeMode()'), previous);
    });
    await check('Purple gradients update real surfaces, stay separate by mode, and persist', async () => {
      const surfaceStyles = () => evaluate(`(() => {
        const probe = document.createElement('span');
        probe.style.backgroundImage = 'var(--grad-primary)';
        probe.style.color = 'var(--on-primary)';
        document.body.appendChild(probe);
        const expected = getComputedStyle(probe);
        const button = getComputedStyle(document.querySelector('#appearanceModalOverlay .btn-primary'));
        const topbar = getComputedStyle(document.querySelector('.topbar'));
        const result = {
          background: button.backgroundImage, ink: button.color,
          topbar: topbar.backgroundImage, topbarInk: topbar.color,
          pageTitle: getComputedStyle(document.getElementById('pageTitle')).color,
          topbarIcon: getComputedStyle(document.getElementById('themeToggle')).color,
          expectedBackground: expected.backgroundImage, expectedInk: expected.color,
          preview: getComputedStyle(document.getElementById('gradientPreview')).backgroundImage,
          variable: getComputedStyle(document.documentElement).getPropertyValue('--grad-primary').trim(),
        };
        probe.remove();
        return result;
      })()`);
      await click('#appearanceBtn');
      await pause(300);
      await click('#modeSegment [data-mode="light"]');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#presetGrid button')].map(b=>b.dataset.preset)`),
        ['default', 'lavender', 'lilac', 'violet', 'amethyst', 'orchid', 'royal', 'plum', 'midnight']);
      assert.equal(await evaluate(`document.querySelectorAll('#appearanceModalOverlay input[type="color"]').length`), 0);
      const originalDark = await evaluate('appearance.dark');
      await click('#presetGrid [data-preset="lavender"]');
      assert.equal(await evaluate(`document.querySelector('#presetGrid [data-preset="lavender"]').getAttribute('aria-pressed')`), 'true');
      await settle(); // icon buttons fade to the new text colour
      let surface = await surfaceStyles();
      assert.equal(surface.background, surface.expectedBackground, 'button renders the selected CSS gradient');
      assert.equal(surface.ink, surface.expectedInk);
      assert.equal(surface.ink, 'rgb(32, 16, 46)', 'light lavender uses dark text');
      // the top bar wears the same gradient as the sidebar, and its title and icons switch to the dark text too
      assert.deepEqual([surface.topbar, surface.topbarInk, surface.pageTitle, surface.topbarIcon],
        [surface.expectedBackground, surface.expectedInk, surface.expectedInk, surface.expectedInk]);
      assert.equal(surface.preview, surface.background, 'preview matches the applied gradient');
      assert.equal(await evaluate('document.activeElement.dataset.preset'), 'lavender', 'selected preset keeps keyboard focus');
      await evaluate(`document.querySelector('#appearanceModalOverlay .modal-body').scrollTop=0`);
      await screenshot('purple-appearance.png');
      for (const [id, value, expectedOutput] of [
        ['gradientStartHue', 290, '290°'], ['gradientStartSaturation', 82, '82%'],
        ['gradientStartLightness', 62, '62%'], ['gradientAngle', 225, '225°'],
      ]) {
        const before = surface;
        await evaluate(`(() => {
          const input = document.getElementById(${JSON.stringify(id)});
          input.focus(); input.value = ${value}; input.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
        surface = await surfaceStyles();
        assert.notEqual(surface.preview, before.preview, `${id} updates preview on input`);
        assert.notEqual(surface.variable, before.variable, `${id} updates the page gradient on input`);
        assert.equal(surface.background, surface.expectedBackground);
        assert.equal(surface.preview, surface.background, 'edited preview matches the page gradient');
        assert.equal(surface.ink, surface.expectedInk);
        assert.equal(await evaluate('document.activeElement.id'), id, 'slider retains focus');
        assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id + 'Value')}).textContent`), expectedOutput);
        await evaluate(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', {bubbles:true}))`);
      }
      assert.equal(await evaluate(`document.querySelectorAll('#presetGrid [aria-pressed="true"]').length`), 0);
      const beforeReverse = await evaluate('appearance.light');
      await click('#reverseGradientBtn');
      const editedLight = await evaluate('appearance.light');
      assert.deepEqual(editedLight, { start: beforeReverse.end, end: beforeReverse.start, angle: 225 });
      await click('#modeSegment [data-mode="dark"]');
      assert.deepEqual(await evaluate('appearance.dark'), originalDark, 'editing light mode preserves dark mode');
      await click('#presetGrid [data-preset="midnight"]');
      const editedDark = await evaluate('appearance.dark');
      await settle();
      surface = await surfaceStyles();
      assert.equal(surface.background, surface.expectedBackground, 'dark buttons use the selected gradient');
      assert.equal(surface.preview, surface.background, 'dark preview matches the page gradient');
      assert.equal(surface.ink, surface.expectedInk);
      assert.deepEqual([surface.topbar, surface.topbarInk, surface.pageTitle, surface.topbarIcon],
        [surface.expectedBackground, surface.expectedInk, surface.expectedInk, surface.expectedInk], 'the dark top bar follows the gradient too');
      await click('#modeSegment [data-mode="light"]');
      assert.deepEqual(await evaluate('appearance.light'), editedLight, 'dark preset preserves light edits');
      const saved = await evaluate('appearance');
      assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem('govdocs-appearance'))`), saved);
      await click('#appearanceModalOverlay [data-close-modal]');
      await reloadApp();
      assert.deepEqual(await evaluate('appearance'), saved, 'reload restores both exact endpoint sets and angle');
      assert.deepEqual(await evaluate('appearance.dark'), editedDark);
      await click('#appearanceBtn');
      await pause(300);
      assert.equal(await evaluate(`document.getElementById('gradientStartHue').value`), String(editedLight.start.h));
      assert.equal(await evaluate(`document.getElementById('gradientEndLightness').value`), String(editedLight.end.l));
      assert.equal(await evaluate(`document.getElementById('gradientAngle').value`), '225');
      await click('#resetAppearanceBtn');
      assert.deepEqual(await evaluate('appearance'), await evaluate(`({version:2,mode:'light',radius:100,light:presetGradient(COLOR_PRESETS[0],'light'),dark:presetGradient(COLOR_PRESETS[0],'dark')})`));
      assert.equal(await evaluate(`document.querySelector('#presetGrid [data-preset="default"]').getAttribute('aria-pressed')`), 'true');
      await click('#appearanceModalOverlay [data-close-modal]');
    });
    await check('Purple gradient controls fit and scroll within a 390px modal', async () => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await click('#appearanceBtn');
      await pause(300);
      await click('#presetGrid [data-preset="lavender"]');
      // The preset click starts colour transitions; measure the settled layout, not a frame mid-transition.
      await settle();
      assert.ok(await evaluate(`(() => {
        const modal=document.querySelector('#appearanceModalOverlay .modal');
        const body=modal.querySelector('.modal-body'); const r=modal.getBoundingClientRect();
        return r.x>=0 && r.right<=innerWidth && r.y>=0 && r.bottom<=innerHeight && body.scrollWidth<=body.clientWidth;
      })()`), 'modal fits viewport without horizontal scrolling');
      const outside = await evaluate(`JSON.stringify([...document.querySelectorAll('#gradientEditor input, #gradientEditor button')].flatMap(el => {
        const r=el.getBoundingClientRect();
        return r.width>0 && r.x>=0 && r.right<=innerWidth ? [] : [{ id: el.id || el.className, x: Math.round(r.x), right: Math.round(r.right), width: Math.round(r.width), innerWidth }];
      }))`);
      assert.equal(outside, '[]', 'all endpoint, direction, and reverse controls fit horizontally');
      // a slider keeps the browser's 2px side margins unless they are cleared, and then sticks 4px out of its box
      assert.equal(await evaluate(`JSON.stringify([...document.querySelectorAll('#appearanceModalOverlay .tune-range')].filter((el) => {
        const r = el.getBoundingClientRect(), box = el.parentElement.getBoundingClientRect(), s = getComputedStyle(el.parentElement);
        return r.left < box.left + parseFloat(s.paddingLeft) - .5 || r.right > box.right - parseFloat(s.paddingRight) + .5;
      }).map((el) => el.id))`), '[]', 'every slider stays inside its own box');
      assert.ok(await evaluate(`(() => {
        const [start,end]=document.querySelectorAll('.gradient-stop');
        return end.getBoundingClientRect().top>=start.getBoundingClientRect().bottom;
      })()`), 'endpoint cards stack on a phone');
      await evaluate(`document.getElementById('gradientAngle').scrollIntoView({block:'center'})`);
      assert.ok(await evaluate(`(() => {
        const r=document.getElementById('gradientAngle').getBoundingClientRect();
        const body=document.querySelector('#appearanceModalOverlay .modal-body').getBoundingClientRect();
        return r.top>=body.top && r.bottom<=body.bottom;
      })()`), 'lower controls are reachable by scrolling');
      await evaluate(`document.querySelector('#appearanceModalOverlay .modal-body').scrollTop=0`);
      await screenshot('purple-appearance-mobile.png');
      await click('#resetAppearanceBtn');
      await click('#appearanceModalOverlay [data-close-modal]');
    });
    await check('Mobile navigation and form fit a 390px viewport', async () => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate(`switchView('dashboard')`);
      await pause(350);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      // the top bar is too narrow on a phone, so its เพิ่มเอกสาร is hidden; the banner keeps its own
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-open="addDocBtn"]')].filter((el) => el.getClientRects().length).map((el) => el.textContent.trim())`),
        ['เพิ่มเอกสารใหม่']);
      await screenshot('mobile.png');
      await click('#menuToggle');
      await pause(350);
      await click('[data-view="documents"]');
      await pause(350);
      assert.equal(await evaluate(`document.getElementById('menuToggle').getAttribute('aria-expanded')`), 'false');
      const formFits = `(() => {const r=document.querySelector('#docModalOverlay .modal').getBoundingClientRect(); return r.x>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`;
      await click('#addDocBtn');
      assert.ok(await evaluate(formFits));
      await screenshot('mobile-form.png');
      // on a phone the toast from the last save lies over the popup's buttons; a tap on บันทึก must still reach it
      await evaluate(`showToast('เพิ่มเอกสารสำเร็จ', 'success')`);
      assert.equal(await evaluate(`(() => {
        const save = document.getElementById('docSaveBtn'); save.scrollIntoView({ block: 'nearest' });
        const r = save.getBoundingClientRect(), toast = document.querySelector('.toast').getBoundingClientRect();
        if (toast.bottom < r.top || toast.top > r.bottom) return 'the toast no longer covers the button, so this proves nothing';
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === save;
      })()`), true);
    });
    // Phones can't page through a PDF inside an iframe, so every page is drawn with PDF.js instead.
    async function checkPhonePdf(userAgent, shot) {
      await cdp('Emulation.setUserAgentOverride', { userAgent });
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await reloadApp();
      assert.equal(await evaluate('needsPageViewer()'), true);
      await evaluate(`switchView('documents'); document.getElementById('globalSearch').value='ทดสอบ/5'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      await click('[data-preview]');
      await waitFor(`document.querySelectorAll('#previewPages .preview-page').length === 3`);
      assert.equal(await evaluate(`document.getElementById('previewFrame').hidden && !document.getElementById('previewFrame').hasAttribute('src')`), true);
      await waitFor(`!!document.querySelector('#previewPages .preview-page canvas')`);
      assert.ok(await evaluate(`[...document.querySelectorAll('#previewPages .preview-page')].every((p) => p.getBoundingClientRect().right <= innerWidth)`), 'pages fit the phone width');
      await screenshot(shot);
      // Scroll to the end: the last page is drawn, and it is the blue third page rather than a copy of page one.
      await evaluate(`(() => { const c = document.getElementById('previewPages'); c.scrollTop = c.scrollHeight; })()`);
      await waitFor(`!!document.querySelector('#previewPages .preview-page:last-child canvas')`);
      const colour = (n) => evaluate(`(() => { const c = document.querySelector('#previewPages .preview-page:nth-child(${n}) canvas'); const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return [d[0], d[1], d[2]]; })()`);
      const last = await colour(3);
      assert.ok(last[2] > 200 && last[0] < 80 && last[1] < 80, `page 3 should be blue, got ${last}`);
      assert.equal(await evaluate(`document.querySelector('#previewPages .preview-page:last-child').dataset.label`), 'หน้า 3 / 3');
      await click('#previewModalOverlay [data-close-modal]');
      assert.equal(await evaluate(`document.getElementById('previewPages').children.length`), 0);
      assert.equal(await evaluate('previewUrl'), null);
    }
    await check('iPhone shows every page of a multi-page PDF and scrolls through them', () => checkPhonePdf(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'mobile-pdf-iphone.png'));
    await check('Android shows every page of a multi-page PDF and scrolls through them', () => checkPhonePdf(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'mobile-pdf-android.png'));
    await check('No uncaught JavaScript errors', async () => assert.deepEqual(errors, []));
  } finally {
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors }, null, 2));
    socket?.close();
    browser?.kill();
    server.close();
    // Only remove the dedicated temporary profile created by this test run.
    if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('govdocs-browser-test-')) {
      await pause(500);
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    }
  }
  console.log(`${results.length} browser checks passed. Artifacts: ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
