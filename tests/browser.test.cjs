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
    async function screenshot(name) {
      await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)`);
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
    await check('Global search opens and filters document results', async () => {
      await click('#globalSearch');
      await cdp('Input.insertText', { text: 'เอกสารทดสอบ 12' });
      await waitFor(`document.querySelector('#view-documents').classList.contains('is-active')`);
      assert.equal(await evaluate(`document.querySelectorAll('#docsTableBody tr').length`), 1);
      await click('#clearFilters');
    });
    await check('Pagination and category filters work in the browser', async () => {
      await click('[data-page="2"]');
      assert.equal(await evaluate(`document.querySelectorAll('#docsTableBody tr').length`), 4);
      await evaluate(`document.getElementById('filterCategory').value='cat-b'; document.getElementById('filterCategory').dispatchEvent(new Event('change'))`);
      assert.equal(await evaluate(`document.querySelectorAll('#docsTableBody tr').length`), 6);
      await evaluate('emitFixture()');
      assert.equal(await evaluate(`document.getElementById('filterCategory').value`), 'cat-b');
      await click('#clearFilters');
    });
    await check('Document and category action IDs preserve quotes and HTML entities', async () => {
      const id = 'record" data-id-marker="injected &quot; literal';
      const ids = await evaluate(`(() => {
        const id = ${JSON.stringify(id)};
        allDocuments = [{ ...allDocuments[0], id }];
        allTrash = [{ ...allDocuments[0], deleted: true }];
        allCategories = [{ ...allCategories[0], id }];
        renderDocsTable(); renderTrash(); renderCategories();
        const actions = ['preview', 'download', 'edit', 'delete', 'restore', 'purge', 'del-cat'];
        return {
          values: actions.map(action => document.querySelector('[data-' + action + ']').getAttribute('data-' + action)),
          injected: document.querySelectorAll('[data-id-marker]').length,
        };
      })()`);
      assert.deepEqual(ids.values, Array(7).fill(id));
      assert.equal(ids.injected, 0, 'Record IDs must not create HTML attributes');
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
    let createdKey;
    await check('Invalid PDF is rejected; valid PDF can be added and edited', async () => {
      await click('#addDocBtn');
      await evaluate(`handleFile(new File(['invalid'], 'invalid.pdf', {type:'application/pdf'}))`);
      assert.equal(await evaluate(`document.getElementById('docFormError').hidden`), false);
      await evaluate(`document.getElementById('docTitle').value='Browser created'; document.getElementById('docNumber').value='TEST/100'; handleFile(new File([fixturePdf], 'test.pdf', {type:'application/pdf'}))`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.length===13`);
      // The PDF went to R2 through the Worker; Firestore got metadata only.
      const saved = await evaluate(`(() => { const d = fixtureStore.documents.find((x) => x.title === 'Browser created'); return { storageKey: d.storageKey, hasFileData: 'fileData' in d, mimeType: d.mimeType, createdBy: d.createdBy, fileName: d.fileName }; })()`);
      assert.match(saved.storageKey, STORAGE_KEY);
      assert.equal(saved.hasFileData, false);
      assert.deepEqual([saved.mimeType, saved.createdBy, saved.fileName], ['application/pdf', 'browser-test', 'test.pdf']);
      assert.ok(r2.get(saved.storageKey).subarray(0, 5).toString('latin1') === '%PDF-');
      assert.ok(apiLog.includes('POST /api/files'));
      createdKey = saved.storageKey;
      await evaluate(`document.getElementById('globalSearch').value='Browser created'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      await click('[data-edit]');
      await evaluate(`document.getElementById('docTitle').value='Browser edited'`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.some(d=>d.title==='Browser edited')`);
      await click('#clearFilters');
    });
    await check('PDF preview opens a Blob URL and releases it when closed', async () => {
      await evaluate(`(() => {const range=document.createRange(); range.selectNode(document.getElementById('previewFrame')); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);})()`);
      await click('[data-preview]');
      // The first row is the document just added, so its PDF comes from R2 through the Worker.
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
      await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await click('[data-download]');
      let downloaded;
      for (let i = 0; i < 100; i++) {
        downloaded = (await fs.readdir(downloads)).find((name) => name.endsWith('.pdf'));
        if (downloaded) break;
        await pause(50);
      }
      assert.ok(downloaded, 'PDF downloaded');
      assert.ok((await fs.readFile(path.join(downloads, downloaded), 'utf8')).startsWith('%PDF-'));
    });
    await check('Legacy base64 documents still open without the Worker', async () => {
      const calls = apiLog.length;
      await evaluate(`document.getElementById('globalSearch').value='ทดสอบ/5'; document.getElementById('globalSearch').dispatchEvent(new Event('input'))`);
      assert.equal(await evaluate(`document.querySelectorAll('#docsTableBody tr').length`), 1);
      await click('[data-preview]');
      await waitFor(`document.getElementById('previewFrame').src.startsWith('blob:')`);
      assert.equal(apiLog.length, calls);
      await click('#previewModalOverlay [data-close-modal]');
      await click('#clearFilters');
    });
    await check('Trash, restore, and permanent deletion update the interface', async () => {
      await click('[data-delete]');
      await click('#confirmActionBtn');
      await waitFor('allTrash.length===1');
      await click('[data-view="trash"]');
      await click('[data-restore]');
      await waitFor('allTrash.length===0 && allDocuments.length===13');
      await click('[data-view="documents"]');
      await click('[data-delete]');
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
    });
    await check('Theme changes and persists across reload', async () => {
      const previous = await evaluate('activeMode()');
      await click('#themeToggle');
      assert.notEqual(await evaluate('activeMode()'), previous);
      await reloadApp();
      assert.notEqual(await evaluate('activeMode()'), previous);
    });
    await check('Mobile navigation and form fit a 390px viewport', async () => {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await pause(350);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
      await screenshot('mobile.png');
      await click('#menuToggle');
      await pause(350);
      await click('[data-view="documents"]');
      await pause(350);
      assert.equal(await evaluate(`document.getElementById('menuToggle').getAttribute('aria-expanded')`), 'false');
      await click('#addDocBtn');
      assert.ok(await evaluate(`(() => {const r=document.querySelector('#docModalOverlay .modal').getBoundingClientRect(); return r.x>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`));
      await screenshot('mobile-form.png');
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
