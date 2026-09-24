// Run with Node 24 and installed Chrome. No npm packages are required.
// Actual HTML/CSS/JavaScript and Chart.js; Firebase is replaced with an in-memory fixture.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'artifacts');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
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
    async function selectProfileImage({ color = '#168a75', type = 'image/png', corrupt = false } = {}) {
      await evaluate(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
        const context = canvas.getContext('2d'); context.fillStyle = ${JSON.stringify(color)}; context.fillRect(0, 0, 480, 320);
        const blob = ${corrupt ? "new Blob(['not a valid image'])" : "await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))"};
        const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'portrait.png', {type:${JSON.stringify(type)}}));
        const input = document.getElementById('officerPhotoInput'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
    }
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
    await check('Selected profile photo becomes a 256px JPEG and survives reload', async () => {
      await selectProfileImage();
      await waitFor(`document.getElementById('officerPhoto').naturalWidth === 256 && !document.getElementById('officerPhotoBtn').classList.contains('is-busy')`);
      assert.equal(await evaluate(`document.getElementById('officerPhoto').naturalHeight`), 256);
      const photo = await evaluate(`document.getElementById('officerPhoto').src`);
      assert.ok(photo.startsWith('data:image/jpeg;base64,'));
      await waitFor(`fixtureStore.settings[0]?.photo === document.getElementById('officerPhoto').src && JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending === false`);
      await reloadApp();
      assert.equal(await evaluate(`document.getElementById('officerPhoto').src`), photo);
    });
    await check('Denied cloud writes retain the new photo and local status after reload', async () => {
      await evaluate(`configureFixture({profileWriteMode:'denied'})`);
      const oldPhoto = await evaluate(`fixtureStore.settings[0].photo`);
      await selectProfileImage({ color: '#ad385d' });
      await waitFor(`JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending && /ในเครื่อง/.test(document.getElementById('officerPhotoStatus').textContent) && !document.getElementById('officerPhotoBtn').classList.contains('is-busy')`);
      const localPhoto = await evaluate(`document.getElementById('officerPhoto').src`);
      assert.notEqual(localPhoto, oldPhoto);
      assert.equal(await evaluate(`fixtureStore.settings[0].photo`), oldPhoto);
      assert.equal(await evaluate(`document.getElementById('officerPhotoStatus').hidden`), false);
      await reloadApp();
      assert.equal(await evaluate(`document.getElementById('officerPhoto').src`), localPhoto);
      assert.ok(await evaluate(`JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending`));
    });
    await check('Photo removal persists locally while denied and later deletes the shared photo', async () => {
      await click('#officerPhotoRemove');
      await click('#confirmActionBtn');
      await waitFor(`document.getElementById('confirmModalOverlay').hidden && !document.getElementById('officerPhotoBtn').classList.contains('has-photo')`);
      assert.deepEqual(await evaluate(`(() => {const cache=JSON.parse(localStorage.getItem('govdocs-profile-photo')); return {photo:cache.photo,pending:cache.pending};})()`), { photo: null, pending: true });
      await reloadApp();
      assert.equal(await evaluate(`document.getElementById('officerPhotoBtn').classList.contains('has-photo')`), false);
      assert.equal(await evaluate(`fixtureStore.settings.length`), 1, 'The denied delete leaves the old cloud photo');
      await evaluate(`configureFixture({profileWriteMode:'ok'}); syncProfilePhoto()`);
      await waitFor(`fixtureStore.settings.length === 0 && !JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending`);
    });
    await check('Photo decoding supports missing createImageBitmap and empty MIME types', async () => {
      await evaluate(`window.fixtureOriginalCreateImageBitmap = window.createImageBitmap; window.createImageBitmap = undefined`);
      try {
        await selectProfileImage({ color: '#da9c24', type: '' });
        await waitFor(`document.getElementById('officerPhoto').naturalWidth === 256 && !JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending`);
        assert.equal(await evaluate(`document.getElementById('officerPhoto').naturalHeight`), 256);
      } finally { await evaluate(`window.createImageBitmap = window.fixtureOriginalCreateImageBitmap; delete window.fixtureOriginalCreateImageBitmap`); }
    });
    await check('Corrupt images leave the existing photo and cloud record intact', async () => {
      const photo = await evaluate(`document.getElementById('officerPhoto').src`);
      const writes = await evaluate('fixtureProfileWriteAttempts.length');
      await selectProfileImage({ corrupt: true });
      await waitFor(`!document.getElementById('officerPhotoBtn').classList.contains('is-busy') && document.querySelectorAll('.toast.error').length > 0`);
      assert.equal(await evaluate(`document.getElementById('officerPhoto').src`), photo);
      assert.equal(await evaluate('fixtureProfileWriteAttempts.length'), writes);
    });
    await check('Slow sign-in and cloud writes do not block local photo changes', async () => {
      await evaluate(`configureFixture({authMode:'delayed',profileWriteMode:'delayed'})`);
      await cdp('Page.reload');
      await waitFor(`typeof syncProfilePhoto === 'function' && document.getElementById('pageLoader').hidden`);
      await selectProfileImage({ color: '#394bbb' });
      await waitFor(`JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending && !document.getElementById('officerPhotoBtn').classList.contains('is-busy')`);
      assert.equal(await evaluate('fixtureProfileWriteAttempts.length'), 0, 'The profile write waits for authentication');
      assert.equal(await evaluate(`document.getElementById('officerPhoto').naturalWidth`), 256);
      await evaluate('releaseFixtureAuth()');
      await waitFor('fixturePendingProfileWrites.length === 1');
      assert.equal(await evaluate('fixtureProfileWriteAttempts[0].signedIn'), true);
      assert.equal(await evaluate(`document.getElementById('officerPhotoBtn').classList.contains('is-busy')`), false);
      await evaluate(`configureFixture({authMode:'ok',profileWriteMode:'ok'}); releaseFixtureProfileWrites()`);
      await waitFor(`!JSON.parse(localStorage.getItem('govdocs-profile-photo')).pending`);
      await waitForApp();
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
    await check('Modal traps keyboard focus and restores it on Escape', async () => {
      await click('#addDocBtn');
      await evaluate(`document.getElementById('docSaveBtn').focus()`);
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert.ok(await evaluate(`document.getElementById('docModalOverlay').contains(document.activeElement) && document.activeElement.id!=='docSaveBtn'`));
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await evaluate(`document.activeElement.id`), 'addDocBtn');
      assert.equal(await evaluate(`document.getElementById('app').inert`), false);
    });
    await check('Invalid PDF is rejected; valid PDF can be added and edited', async () => {
      await click('#addDocBtn');
      await evaluate(`handleFile(new File(['invalid'], 'invalid.pdf', {type:'application/pdf'}))`);
      assert.equal(await evaluate(`document.getElementById('docFormError').hidden`), false);
      await evaluate(`document.getElementById('docTitle').value='Browser created'; document.getElementById('docNumber').value='TEST/100'; handleFile(new File([fixturePdf], 'test.pdf', {type:'application/pdf'}))`);
      await click('#docSaveBtn');
      await waitFor(`document.getElementById('docModalOverlay').hidden && allDocuments.length===13`);
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
      assert.ok(await evaluate(`document.getElementById('previewFrame').src.startsWith('blob:')`));
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
      await click('[data-purge]');
      await click('#confirmActionBtn');
      await waitFor('allTrash.length===0 && allDocuments.length===12');
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
