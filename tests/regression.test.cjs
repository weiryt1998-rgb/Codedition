const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const STORAGE_KEY = 'documents/2026/123e4567-e89b-42d3-a456-426614174000.pdf';
const OLD_STORAGE_KEY = 'documents/2025/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf';
const FIELD_DELETE = { __fieldDelete: true };

// Stand-in for the Cloudflare Worker: GET returns a PDF, DELETE succeeds.
function defaultApiResponse(url, init = {}) {
  if ((init.method || 'GET') === 'GET') {
    return new Response(new TextEncoder().encode('%PDF-1.7\n%%EOF'), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  }
  return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Minimal DOM doubles: these exercise application logic, not browser layout.
function setup({
  storageThrows = false, legacyTheme = null, storageValues = {}, authMode = 'missing', databaseAvailable = true,
  apiUrl = 'https://pdf-api.test', apiRespond = defaultApiResponse, firestoreDeleteError = null,
} = {}) {
  const elements = new Map();
  const storage = new Map(Object.entries(storageValues));
  if (legacyTheme !== null) storage.set('govdocs-theme', legacyTheme);
  const windowEvents = {};
  let document;
  class Element {
    constructor(id = '') {
      this.id = id;
      this.value = '';
      this.textContent = '0';
      this.innerHTML = '';
      this.disabled = false;
      this.hidden = id.endsWith('Overlay');
      this.isConnected = true;
      this.dataset = {};
      this.events = {};
      this.attributes = {};
      this.style = { removeProperty() {}, setProperty() {} };
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (name) => classes.has(name),
        toggle(name, enabled = !classes.has(name)) { enabled ? classes.add(name) : classes.delete(name); },
      };
    }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    set textContent(value) { this.text = String(value); }
    get textContent() { return this.text; }
    async fire(name, extra = {}) {
      await Promise.all((this.events[name] || []).map((fn) => fn({ target: this, preventDefault() {}, ...extra })));
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
    querySelector() { return new Element(); }
    querySelectorAll(selector) {
      if (this.id === 'docModalOverlay' && selector === 'button, input, select, textarea') {
        return ['docSaveBtn', 'docFile', 'docTitle'].map((id) => elements.get(id));
      }
      if (this.id === 'confirmModalOverlay' && selector === 'button, input, select, textarea') return [elements.get('confirmActionBtn')];
      return [];
    }
    focus() { document.activeElement = this; }
    reset() {}
    appendChild() {}
    remove() {}
    click() { return this.fire('click'); }
    getClientRects() { return [1]; }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
  const created = [];
  document = {
    getElementById(id) { assert.ok(elements.has(id), `Unknown DOM id: ${id}`); return elements.get(id); },
    querySelector(selector) { return elements.get(selector.slice(1)) || new Element(); },
    querySelectorAll(selector) {
      if (selector === '.modal-overlay') return [...elements.values()].filter((el) => el.id.endsWith('Overlay'));
      if (selector === '.view') return [...elements.values()].filter((el) => el.id.startsWith('view-'));
      return [];
    },
    documentElement: new Element(), body: new Element(), activeElement: new Element('trigger'),
    createElement: () => { const el = new Element(); created.push(el); return el; }, addEventListener() {},
  };
  const subscriptions = [];
  const writes = [];
  const deletes = [];
  const pendingWrites = [];
  const warnings = [];
  function subscribe(details, options, receive, fail) {
    if (typeof options === 'function') [options, receive, fail] = [undefined, options, receive];
    const subscription = { ...details, options, receive, fail, active: true };
    subscriptions.push(subscription);
    return () => { subscription.active = false; };
  }
  const db = {
    collection(name) {
      const query = {
        where(field, operator, value) { this.deleted = value; return this; },
        orderBy() { return this; },
        onSnapshot(options, receive, fail) { return subscribe({ name, deleted: this.deleted }, options, receive, fail); },
        add(payload) {
          writes.push(payload);
          return new Promise((resolve, reject) => { pendingWrites.push({ resolve, reject }); });
        },
        doc(id) {
          return {
            update: (payload) => query.add(payload),
            set: (payload) => query.add(payload),
            delete: () => {
              if (firestoreDeleteError) return Promise.reject(firestoreDeleteError);
              deletes.push(`${name}/${id}`);
              return Promise.resolve();
            },
            onSnapshot(options, receive, fail) { return subscribe({ name, doc: id }, options, receive, fail); },
          };
        },
      };
      return query;
    },
  };
  const authAttempts = [];
  const auth = {
    currentUser: { uid: 'user-1', getIdToken: async () => 'id-token-1' },
    signInAnonymously() {
      if (authMode === 'deferred') {
        return new Promise((resolve, reject) => { authAttempts.push({ resolve, reject }); });
      }
      authAttempts.push({});
      return Promise.resolve();
    },
  };
  // Upload goes through XHR (for progress); tests answer each request by hand.
  const uploads = [];
  class XMLHttpRequest {
    constructor() { this.upload = {}; this.headers = {}; uploads.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
    respond(status, body) {
      this.status = status;
      this.responseText = body === undefined ? '' : JSON.stringify(body);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 });
      this.onload();
    }
    fail() { this.onerror(); }
  }
  const apiCalls = [];
  const fetch = async (url, init = {}) => {
    apiCalls.push({ url, method: init.method || 'GET', headers: init.headers || {} });
    return apiRespond(url, init);
  };
  const context = vm.createContext({
    document, db: databaseAvailable ? db : undefined,
    auth: authMode === 'missing' ? undefined : auth,
    PDF_API_URL: apiUrl, XMLHttpRequest, fetch, Response,
    firebase: { firestore: { FieldValue: { delete: () => FIELD_DELETE } } },
    console: { ...console, warn: (...args) => warnings.push(args) }, Blob, Uint8Array, URL, atob, btoa,
    navigator: { onLine: true },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); },
      scrollTo() {},
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageThrows) throw new Error('Storage blocked'); storage.set(key, String(value)); },
      removeItem(key) { if (storageThrows) throw new Error('Storage blocked'); storage.delete(key); },
    },
    performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout() {},
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  return {
    run, elements, context, subscriptions, writes, deletes, storage, warnings, authAttempts, uploads, apiCalls, created,
    authenticate: (index = authAttempts.length - 1) => authAttempts[index].resolve(),
    rejectAuthentication: (error, index = authAttempts.length - 1) => authAttempts[index].reject(error),
    complete: (index = pendingWrites.length - 1) => pendingWrites[index].resolve(),
    rejectWrite: (error, index = pendingWrites.length - 1) => pendingWrites[index].reject(error),
    fireWindow: (name) => (windowEvents[name] || []).forEach((fn) => fn()),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
function pdf(name = 'document.pdf', content = '%PDF-1.7\n%%EOF', type = 'application/pdf') {
  const bytes = new TextEncoder().encode(content);
  return {
    name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer,
    // slice() reads through this.arrayBuffer so tests can still delay or fail the read
    slice(start, end) { const file = this; return { arrayBuffer: async () => (await file.arrayBuffer()).slice(start, end) }; },
  };
}

test('startup survives blocked storage and unavailable Firebase', () => {
  const app = setup({ storageThrows: true, databaseAvailable: false });
  assert.equal(app.run('appearance.mode'), 'system');
  assert.ok(app.elements.get('globalSearch').events.input.length);
});

test('invalid legacy theme falls back to system mode', () => {
  assert.equal(setup({ legacyTheme: 'invalid' }).run('activeMode()'), 'light');
});

test('category snapshots preserve selections and clear removed categories', () => {
  const { run, elements } = setup();
  run('allCategories = [{id:"a",name:"A"},{id:"b",name:"B"}]');
  elements.get('docCategory').value = 'b';
  elements.get('filterCategory').value = 'a';
  run('renderCategoryOptions()');
  assert.equal(elements.get('docCategory').value, 'b');
  assert.equal(elements.get('filterCategory').value, 'a');
  run('allCategories = []; renderCategoryOptions()');
  assert.equal(elements.get('docCategory').value, '');
  assert.equal(elements.get('filterCategory').value, '');
});

test('default categories are seeded once, and never when they already exist', () => {
  const seed = (docs) => {
    const { run, subscriptions, writes } = setup();
    run('attachFirestoreListeners()');
    const stream = subscriptions.find((s) => s.name === 'categories');
    const snap = { docs, metadata: { fromCache: false, hasPendingWrites: false } };
    stream.receive({ ...snap, metadata: { ...snap.metadata, fromCache: true } }); // cached first paint
    stream.receive(snap);
    stream.receive(snap); // a later snapshot must not add a duplicate
    return writes;
  };
  const existing = (...names) => names.map((name, i) => ({ id: `e${i}`, data: () => ({ name }) }));
  assert.deepEqual(seed([]).map((w) => w.name), ['คำสั่ง', 'บันทึกข้อความ', 'คำร้อง']);
  assert.deepEqual(seed(existing(' คำสั่ง ', 'บันทึกข้อความ', 'คำร้อง')), []);
  // only the missing defaults are added
  assert.deepEqual(seed(existing('คำสั่ง')).map((w) => w.name), ['บันทึกข้อความ', 'คำร้อง']);
  // the old name is renamed in place (not duplicated), unless the new name already exists
  assert.deepEqual(seed([
    { id: 'c', data: () => ({ name: 'หนังสือคำสั่ง' }) },
    ...existing('บันทึกข้อความ', 'คำร้อง'),
  ]).map((w) => w.name), ['คำสั่ง']);
  assert.deepEqual(seed([
    { id: 'c', data: () => ({ name: 'หนังสือคำสั่ง' }) },
    { id: 'd', data: () => ({ name: 'คำสั่ง' }) },
    ...existing('บันทึกข้อความ', 'คำร้อง'),
  ]), []);
});

test('connectivity recovery retries failed authentication and replaces old listeners once', async () => {
  const app = setup({ authMode: 'deferred' });
  app.rejectAuthentication(new Error('Offline during startup'));
  await flush();
  assert.equal(app.authAttempts.length, 1);
  assert.equal(app.subscriptions.filter((s) => s.active).length, 3);
  assert.equal(app.subscriptions.some((s) => s.name === 'settings'), false); // no profile photo stream

  app.fireWindow('online');
  app.fireWindow('online');
  await flush();
  assert.equal(app.authAttempts.length, 2);

  app.authenticate();
  await flush();
  assert.equal(app.subscriptions.length, 6);
  assert.equal(app.subscriptions.slice(0, 3).every((s) => !s.active), true);
  assert.equal(app.subscriptions.filter((s) => s.active).length, 3);
});

test('global search opens results and tolerates legacy numeric metadata', async () => {
  const { run, elements } = setup();
  run('allDocuments = [{id:"a", title:"Test", docNumber:123}]');
  elements.get('globalSearch').value = '123';
  await elements.get('globalSearch').fire('input');
  assert.ok(elements.get('view-documents').classList.contains('is-active'));
  assert.match(elements.get('docsTableBody').innerHTML, /Test/);
});

test('document numbers sort naturally and pagination stays bounded', () => {
  const { run, elements } = setup();
  assert.equal(run('allDocuments = [{docNumber:"10"},{docNumber:"2"}]; sortKey="docNumber"; sortDir="asc"; getFilteredDocs()[0].docNumber'), '2');
  run('currentPage = 500; renderPagination(1000)');
  assert.equal((elements.get('pagination').innerHTML.match(/<button/g) || []).length, 7);
  assert.match(elements.get('pagination').innerHTML, /aria-current="page"/);
});

test('newest file selection wins even when an older read finishes last', async () => {
  const { run, context, elements } = setup();
  let finishOld;
  context.oldFile = { ...pdf('old.pdf'), arrayBuffer: () => new Promise((resolve) => { finishOld = resolve; }) };
  context.newFile = pdf('new.pdf');
  const oldRead = run('handleFile(oldFile)');
  assert.equal(elements.get('docSaveBtn').disabled, true);
  await run('handleFile(newFile)');
  finishOld(await pdf().arrayBuffer());
  await oldRead;
  assert.equal(run('pendingFileData.name'), 'new.pdf');
  assert.equal(elements.get('docSaveBtn').disabled, false);
});

test('closing the form invalidates unfinished file reads', async () => {
  const { run, context } = setup();
  let finish;
  context.file = { ...pdf(), arrayBuffer: () => new Promise((resolve) => { finish = resolve; }) };
  const read = run('handleFile(file)');
  run('closeModal("docModalOverlay")');
  finish(await pdf().arrayBuffer());
  await read;
  assert.equal(run('pendingFileData'), null);
});

test('PDF validation rejects renamed content and supports missing MIME types', async () => {
  const { run, context, elements } = setup();
  context.file = pdf('valid.pdf', '%PDF-1.4\n%%EOF', '');
  await run('handleFile(file)');
  assert.equal(run('fileInvalid'), false);
  context.file = pdf('fake.pdf', '<html>not a PDF</html>');
  await run('handleFile(file)');
  assert.equal(run('pendingFileData'), null);
  assert.equal(run('fileInvalid'), true);
  assert.equal(elements.get('docFormError').hidden, false);
});

test('oversized and unreadable files cannot leave a stale attachment selected', async () => {
  const { run, context, elements } = setup();
  context.file = { ...pdf(), size: 20 * 1024 * 1024 + 1 };
  await run('handleFile(file)');
  assert.equal(run('fileInvalid'), true);
  context.file = { ...pdf(), arrayBuffer: async () => { throw new Error('Read failed'); } };
  await run('handleFile(file)');
  assert.equal(elements.get('docSaveBtn').disabled, false);
  assert.match(elements.get('docFormError').textContent, /Read failed/);
});

test('document save prevents duplicate submissions and closing during the write', async () => {
  const app = setup({ authMode: 'ready' });
  const { run, elements, context } = app;
  run('openDocModal()');
  elements.get('docTitle').value = 'Test';
  elements.get('docNumber').value = '001';
  elements.get('docDate').value = '2026-09-10';
  context.file = pdf();
  await run('handleFile(file)');
  const saving = elements.get('docForm').fire('submit');
  await elements.get('docForm').fire('submit');
  await flush();
  assert.equal(app.uploads.length, 1);
  app.uploads[0].respond(201, { storageKey: STORAGE_KEY, size: 14 });
  await flush();
  run('closeModal("docModalOverlay")');
  assert.equal(elements.get('docModalOverlay').hidden, false);
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].category, '');
  app.complete();
  await saving;
  assert.equal(elements.get('docModalOverlay').hidden, true);
  assert.equal(elements.get('docSaveBtn').disabled, false);
});

test('whitespace-only required fields never reach Firestore', async () => {
  const app = setup();
  app.elements.get('docTitle').value = '   ';
  app.elements.get('docNumber').value = '001';
  app.elements.get('docDate').value = '2026-09-10';
  await app.elements.get('docForm').fire('submit');
  assert.equal(app.writes.length, 0);
  assert.equal(app.elements.get('docFormError').hidden, false);
});

test('preview accepts PDF blobs and rejects executable data URLs', () => {
  const { run, context } = setup();
  context.data = 'data:application/pdf;base64,' + btoa('%PDF-1.7');
  assert.equal(run('attachmentBlob({fileData:data}).type'), 'application/pdf');
  assert.equal(run('attachmentBlob({fileData:"data:text/html,<script>alert(1)</script>"})'), null);
  assert.equal(run('attachmentBlob(undefined)'), null);
});

test('opening a PDF clears a stale selection in the host page', () => {
  const { run, context, elements } = setup();
  let cleared = false;
  context.window.getSelection = () => ({ removeAllRanges() { cleared = true; } });
  context.data = 'data:application/pdf;base64,' + btoa('%PDF-1.7');
  run('previewDoc({title:"PDF",fileData:data})');
  assert.equal(cleared, true);
  assert.equal(elements.get('previewModalOverlay').hidden, false);
  run('closeModal("previewModalOverlay")');
});

test('realtime updates refresh category counts and report stream errors', () => {
  const { run, subscriptions, elements, context } = setup();
  const toasts = [];
  context.record = (message, type) => toasts.push({ message, type });
  run('showToast = record');
  run('attachFirestoreListeners()');
  const snap = (docs) => ({ docs, metadata: { fromCache: false, hasPendingWrites: false } });
  subscriptions.find((s) => s.name === 'categories').receive(snap([{ id: 'cat', data: () => ({ name: 'Category' }) }]));
  subscriptions.find((s) => s.deleted === false).receive(snap([{ id: 'actual-id', data: () => ({ id: 'bad-id', title: 'Test', category: 'cat' }) }]));
  subscriptions.find((s) => s.deleted === true).receive(snap([]));
  assert.equal(run('allDocuments[0].id'), 'actual-id');
  assert.match(elements.get('categoryGrid').innerHTML, /1 เอกสาร/);
  assert.equal(toasts.length, 0);
  subscriptions[0].fail(new Error('Permission denied'));
  assert.deepEqual(toasts, [{ message: 'โหลดข้อมูลล้มเหลว: Permission denied', type: 'error' }]);
});

test('trend counts import timestamps instead of document issue dates', () => {
  const { run, context } = setup();
  const painted = {};
  context.Chart = { defaults: { font: {} } };
  context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  context.capture = (id, type, data) => { painted[id] = data; };
  run('paintChart = capture; allCategories=[{id:"a",name:"__proto__"}]; allDocuments=[{category:"a",date:"2000-01-01",createdAt:Date.now()}]; renderCharts()');
  assert.equal(painted.chartTrend.datasets[0].data.at(-1), 1);
  assert.equal(painted.chartCategory.datasets[0].data[0], 1);
  assert.equal(run('createdAtMillis({createdAt:{seconds:123}})'), 123000);
});

/* =========================================================
   PDF files in Cloudflare R2 (through the Worker)
   ========================================================= */
async function submitNewDocument(app, file = pdf('คำสั่ง.pdf')) {
  const { run, elements, context } = app;
  run('openDocModal()');
  elements.get('docTitle').value = 'หนังสือทดสอบ';
  elements.get('docNumber').value = 'ทด 1/2569';
  elements.get('docDate').value = '2026-09-10';
  context.file = file;
  await run('handleFile(file)');
  const saving = elements.get('docForm').fire('submit');
  await flush();
  return { saving }; // wrapped: returning the promise itself would make callers wait for the whole save
}
async function submitReplacement(app, existing, file = pdf('ฉบับใหม่.pdf')) {
  app.context.existing = existing;
  app.run('allDocuments = [existing]; openDocModal(existing)');
  app.context.file = file;
  await app.run('handleFile(file)');
  const saving = app.elements.get('docForm').fire('submit');
  await flush();
  return { saving };
}
function recordToasts(app) {
  const toasts = [];
  app.context.record = (message, type) => toasts.push({ message, type });
  app.run('showToast = record');
  return toasts;
}
const jsonResponse = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('a new PDF goes to R2 through the Worker and Firestore gets metadata only', async () => {
  const app = setup({ authMode: 'ready' });
  const { saving } = await submitNewDocument(app);
  const [upload] = app.uploads;
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, 'https://pdf-api.test/api/files');
  assert.equal(upload.headers.Authorization, 'Bearer id-token-1');
  assert.equal(upload.headers['Content-Type'], 'application/pdf');
  assert.equal(upload.body, app.context.file);
  assert.equal(app.writes.length, 0, 'nothing is written before the upload finishes');

  upload.respond(201, { storageKey: STORAGE_KEY, size: 14 });
  await flush();
  const [write] = app.writes;
  assert.equal(write.storageKey, STORAGE_KEY);
  assert.equal(write.fileName, 'คำสั่ง.pdf');
  assert.equal(write.fileSize, 14);
  assert.equal(write.mimeType, 'application/pdf');
  assert.equal(write.createdBy, 'user-1');
  assert.equal('fileData' in write, false);
  assert.doesNotMatch(JSON.stringify(write), /base64|%PDF/);
  app.complete();
  await saving;
  assert.equal(app.elements.get('docModalOverlay').hidden, true);
});

test('PDFs up to 20 MB are accepted and larger ones are refused with a Thai message', async () => {
  const { run, context, elements } = setup();
  context.file = { ...pdf('ใกล้ 20MB.pdf'), size: 20 * 1024 * 1024 };
  await run('handleFile(file)');
  assert.equal(run('fileInvalid'), false);
  assert.equal(run('pendingFileData.size'), 20 * 1024 * 1024);
  context.file = { ...pdf('เกิน 20MB.pdf'), size: 20 * 1024 * 1024 + 1 };
  await run('handleFile(file)');
  assert.equal(run('pendingFileData'), null);
  assert.match(elements.get('docFormError').textContent, /เกินขนาดสูงสุด 20 MB/);
});

test('files that are not PDF are refused before anything is uploaded', async () => {
  const app = setup({ authMode: 'ready' });
  app.context.file = pdf('notes.txt', 'hello', 'text/plain');
  await app.run('handleFile(file)');
  assert.equal(app.run('fileInvalid'), true);
  assert.match(app.elements.get('docFormError').textContent, /เฉพาะไฟล์ PDF/);
  app.context.file = pdf('renamed.pdf', 'MZ not a pdf');
  await app.run('handleFile(file)');
  assert.equal(app.run('pendingFileData'), null);
  assert.match(app.elements.get('docFormError').textContent, /ไม่ใช่ PDF/);
  assert.equal(app.uploads.length, 0);
});

test('a failed upload never creates a Firestore record and is explained in Thai', async () => {
  const cases = [
    [(xhr) => xhr.respond(502, { error: 'storage-error' }), /ที่จัดเก็บไฟล์ขัดข้อง/],
    [(xhr) => xhr.fail(), /ตรวจสอบอินเทอร์เน็ต/],
    [(xhr) => xhr.respond(401, { error: 'invalid-token' }), /ยืนยันตัวตนไม่สำเร็จ/],
    [(xhr) => xhr.respond(403, { error: 'forbidden' }), /ไม่มีสิทธิ์/],
    [(xhr) => xhr.respond(413, { error: 'file-too-large' }), /เกิน 20 MB/],
    [(xhr) => xhr.respond(415, { error: 'not-pdf' }), /ไม่ใช่ PDF/],
  ];
  for (const [answer, reason] of cases) {
    const app = setup({ authMode: 'ready' });
    const { saving } = await submitNewDocument(app);
    answer(app.uploads[0]);
    await saving;
    const message = app.elements.get('docFormError').textContent;
    assert.equal(app.writes.length, 0);
    assert.match(message, /^อัปโหลดไฟล์ไม่สำเร็จ: /);
    assert.match(message, reason);
    assert.equal(app.elements.get('docModalOverlay').hidden, false);
    assert.equal(app.elements.get('docSaveBtn').disabled, false);
  }
});

test('uploads need a signed-in user and a configured Worker URL', async () => {
  const signedOut = setup(); // anonymous sign-in never completed
  await (await submitNewDocument(signedOut)).saving;
  assert.equal(signedOut.uploads.length, 0);
  assert.equal(signedOut.writes.length, 0);
  assert.match(signedOut.elements.get('docFormError').textContent, /ยืนยันตัวตนไม่สำเร็จ/);

  const unconfigured = setup({ authMode: 'ready', apiUrl: '' });
  await (await submitNewDocument(unconfigured)).saving;
  assert.equal(unconfigured.uploads.length, 0);
  assert.equal(unconfigured.writes.length, 0);
  assert.match(unconfigured.elements.get('docFormError').textContent, /PDF_API_URL/);
});

test('if Firestore fails after the upload, the uploaded file is removed from R2', async () => {
  const app = setup({ authMode: 'ready' });
  const { saving } = await submitNewDocument(app);
  app.uploads[0].respond(201, { storageKey: STORAGE_KEY, size: 14 });
  await flush();
  app.rejectWrite(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  await saving;
  await flush();
  assert.deepEqual(app.apiCalls.map((c) => [c.method, c.url, c.headers.Authorization]),
    [['DELETE', `https://pdf-api.test/api/files/${STORAGE_KEY}`, 'Bearer id-token-1']]);
  assert.match(app.elements.get('docFormError').textContent, /^บันทึกข้อมูลไม่สำเร็จ: ไม่มีสิทธิ์/);
});

test('replacing a file drops legacy base64 and discards the previous R2 file only after saving', async () => {
  const legacy = setup({ authMode: 'ready' });
  const { saving: legacySaving } = await submitReplacement(legacy, {
    id: 'old', title: 'เอกสารเก่า', docNumber: '1', date: '2026-01-01', fileName: 'a.pdf', fileSize: 10,
    fileData: 'data:application/pdf;base64,JVBERi0=',
  });
  legacy.uploads[0].respond(201, { storageKey: STORAGE_KEY, size: 14 });
  await flush();
  assert.equal(legacy.writes[0].fileData, FIELD_DELETE);
  assert.equal(legacy.writes[0].storageKey, STORAGE_KEY);
  legacy.complete();
  await legacySaving;
  assert.equal(legacy.apiCalls.length, 0, 'a legacy document has no R2 file to discard');

  const stored = setup({ authMode: 'ready' });
  const { saving: storedSaving } = await submitReplacement(stored, {
    id: 'doc-1', title: 'เอกสารใหม่', docNumber: '2', date: '2026-01-01', fileName: 'a.pdf', fileSize: 10,
    storageKey: OLD_STORAGE_KEY, mimeType: 'application/pdf',
  });
  stored.uploads[0].respond(201, { storageKey: STORAGE_KEY, size: 14 });
  await flush();
  assert.equal('fileData' in stored.writes[0], false);
  assert.equal(stored.apiCalls.length, 0, 'the old file stays until Firestore points at the new one');
  stored.complete();
  await storedSaving;
  await flush();
  assert.deepEqual(stored.apiCalls.map((c) => [c.method, c.url]), [['DELETE', `https://pdf-api.test/api/files/${OLD_STORAGE_KEY}`]]);
});

test('R2 documents preview and download through the Worker with the user token', async () => {
  const app = setup({ authMode: 'ready' });
  let cleared = false;
  app.context.window.getSelection = () => ({ removeAllRanges() { cleared = true; } });
  app.context.doc = { id: 'doc-1', title: 'เอกสารใหม่', fileName: 'คำสั่งแต่งตั้ง.pdf', storageKey: STORAGE_KEY };
  await app.run('previewDoc(doc)');
  assert.deepEqual(app.apiCalls.map((c) => [c.method, c.url, c.headers.Authorization]),
    [['GET', 'https://pdf-api.test/api/documents/doc-1/file', 'Bearer id-token-1']]);
  assert.match(app.elements.get('previewFrame').src, /^blob:/);
  assert.equal(app.elements.get('previewModalOverlay').hidden, false);
  assert.equal(cleared, true);
  app.run('closeModal("previewModalOverlay")');

  await app.run('downloadDoc(doc)');
  const link = app.created.find((el) => el.download);
  assert.equal(link.download, 'คำสั่งแต่งตั้ง.pdf');
  assert.match(link.href, /^blob:/);
  assert.equal(app.apiCalls.length, 2);
});

test('preview and download explain Worker errors in Thai instead of opening a broken file', async () => {
  for (const [status, error, reason] of [[404, 'file-not-found', /ไม่พบไฟล์ PDF/], [403, 'forbidden', /ไม่มีสิทธิ์/], [401, 'token-expired', /ยืนยันตัวตนไม่สำเร็จ/]]) {
    const app = setup({ authMode: 'ready', apiRespond: jsonResponse(status, { error }) });
    const toasts = recordToasts(app);
    app.context.doc = { id: 'doc-1', title: 'เอกสารใหม่', storageKey: STORAGE_KEY };
    await app.run('previewDoc(doc)');
    await app.run('downloadDoc(doc)');
    assert.equal(app.elements.get('previewModalOverlay').hidden, true);
    assert.equal(app.created.some((el) => el.download), false);
    assert.equal(toasts.length, 2);
    toasts.forEach((t) => { assert.equal(t.type, 'error'); assert.match(t.message, reason); });
  }
});

test('legacy base64 documents still open and download without the Worker', async () => {
  const app = setup({ authMode: 'ready', apiUrl: '' });
  app.context.window.getSelection = () => ({ removeAllRanges() {} });
  app.context.doc = { title: 'เอกสารเก่า', fileName: 'old.pdf', fileData: 'data:application/pdf;base64,' + btoa('%PDF-1.7') };
  app.run('previewDoc(doc)');
  assert.equal(app.elements.get('previewModalOverlay').hidden, false);
  await app.run('downloadDoc(doc)');
  assert.equal(app.created.find((el) => el.download).download, 'old.pdf');
  assert.equal(app.apiCalls.length, 0);
});

test('permanent delete removes the R2 file before the Firestore record', async () => {
  const purge = async (app, doc) => {
    const toasts = recordToasts(app);
    app.context.trashed = doc;
    app.run('allTrash = [trashed]; permanentlyDeleteDoc(trashed.id)');
    await app.elements.get('confirmActionBtn').fire('click');
    return toasts;
  };
  const r2Doc = { id: 'doc-1', title: 'เอกสารใหม่', storageKey: STORAGE_KEY, deleted: true };

  const ok = setup({ authMode: 'ready' });
  const okToasts = await purge(ok, r2Doc);
  assert.deepEqual(ok.apiCalls.map((c) => [c.method, c.url]), [['DELETE', 'https://pdf-api.test/api/documents/doc-1/file']]);
  assert.deepEqual(ok.deletes, ['documents/doc-1']);
  assert.equal(okToasts[0].type, 'success');

  const r2Down = setup({ authMode: 'ready', apiRespond: jsonResponse(502, { error: 'storage-error' }) });
  const downToasts = await purge(r2Down, r2Doc);
  assert.deepEqual(r2Down.deletes, [], 'the record stays so the delete can be retried');
  assert.match(downToasts[0].message, /ลบไฟล์ PDF ไม่สำเร็จ เอกสารยังอยู่ในถังขยะ/);

  const firestoreDown = setup({ authMode: 'ready', firestoreDeleteError: Object.assign(new Error('offline'), { code: 'unavailable' }) });
  const halfwayToasts = await purge(firestoreDown, r2Doc);
  assert.match(halfwayToasts[0].message, /ลบไฟล์แล้ว แต่ลบข้อมูลเอกสารไม่สำเร็จ กรุณากดลบถาวรอีกครั้ง/);

  const legacy = setup({ authMode: 'ready' });
  await purge(legacy, { id: 'old', title: 'เอกสารเก่า', fileData: 'data:application/pdf;base64,JVBERi0=', deleted: true });
  assert.equal(legacy.apiCalls.length, 0);
  assert.deepEqual(legacy.deletes, ['documents/old']);
});
