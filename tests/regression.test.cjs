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

test('appearance migrates old palettes to purple while retaining mode and radius', () => {
  const old = {
    mode: 'dark', radius: 140, preset: 'emerald',
    light: { primary: '#0F6B4F', accent: '#D2A02F', bg: '#00FF00' },
    dark: { primary: '#BC9AE0', accent: '#CFA23C' },
  };
  const app = setup({ storageValues: { 'govdocs-appearance': JSON.stringify(old) } });
  assert.equal(app.run('appearance.mode'), 'dark');
  assert.equal(app.run('appearance.radius'), 140);
  assert.equal(app.run('JSON.stringify(appearance.light) === JSON.stringify(presetGradient(COLOR_PRESETS[0], "light"))'), true);
  assert.equal(app.run('appearance.dark.start.h >= 250 && appearance.dark.start.h <= 300'), true);
  assert.equal(app.run('appearance.dark.end.h === appearance.dark.start.h'), true, 'gold accent becomes a shade of the saved purple');
  assert.notEqual(app.run('baseColors("light").bg'), old.light.bg);
  app.run('saveAppearance()');
  const saved = JSON.parse(app.storage.get('govdocs-appearance'));
  assert.equal(saved.version, 2);
  assert.deepEqual(JSON.parse(setup({ storageValues: { 'govdocs-appearance': JSON.stringify(saved) } }).run('JSON.stringify(appearance)')), saved);
});

test('invalid stored gradient values are bounded and missing values use defaults', () => {
  const app = setup({ storageValues: { 'govdocs-appearance': JSON.stringify({
    version: 2, mode: 'invalid', radius: 900,
    light: { start: { h: 120, s: 200, l: -10 }, end: { h: 500, s: '50', l: null }, angle: 725 },
    dark: null,
  }) } });
  assert.equal(app.run('appearance.mode'), 'system');
  assert.equal(app.run('appearance.radius'), 200);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(appearance.light.start)')), { h: 250, s: 100, l: 5 });
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(appearance.light.end)')), { h: 300, s: 39, l: 32 });
  assert.equal(app.run('appearance.light.angle'), 360);
  assert.equal(app.run('JSON.stringify(appearance.dark) === JSON.stringify(presetGradient(COLOR_PRESETS[0], "dark"))'), true);
  assert.equal(app.run('purpleHex({ h: 270, s: 100, l: 50 })'), '#8000FF');
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

test('a failed startup sign-in is explained in Thai, not raw Firebase text', async () => {
  for (const [code, reason] of [
    ['auth/network-request-failed', 'อินเทอร์เน็ตขัดข้อง ระบบจะเชื่อมต่อใหม่เองเมื่อกลับมาออนไลน์'],
    ['auth/admin-restricted-operation', 'ระบบปิดการเข้าใช้งานอยู่ กรุณาติดต่อผู้ดูแลระบบ'],
  ]) {
    const app = setup({ authMode: 'deferred' });
    const toasts = [];
    app.context.record = (message, type) => toasts.push({ message, type });
    app.run('showToast = record');
    app.rejectAuthentication(Object.assign(new Error(`Firebase: Error (${code}).`), { code }));
    await flush();
    assert.deepEqual(toasts, [{ message: `เชื่อมต่อฐานข้อมูลไม่สำเร็จ: ${reason}`, type: 'error' }]);
  }
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

test('rows list newest saved first by default, without sequence numbers', () => {
  const { run, elements } = setup();
  // issue dates deliberately run against the save order; the legacy record has no timestamp at all
  run(`allDocuments = [
    { id: "b", title: "บันทึกที่สอง", date: "2026-01-01", createdAtMs: 2000 },
    { id: "c", title: "บันทึกล่าสุด", date: "2025-01-01", createdAtMs: 3000 },
    { id: "a", title: "บันทึกแรก", date: "2026-06-01", createdAtMs: 1000 },
    { id: "z", title: "เอกสารเก่าไม่มีเวลา", date: "2026-03-01" },
  ]; renderDocsTable()`);
  const rows = () => [...elements.get('docsTableBody').innerHTML.matchAll(/<td class="doc-title-cell">([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(rows(), ['บันทึกล่าสุด', 'บันทึกที่สอง', 'บันทึกแรก', 'เอกสารเก่าไม่มีเวลา']);
  assert.doesNotMatch(elements.get('docsTableBody').innerHTML, /col-entry/);
  run('sortKey = "date"; sortDir = "desc"; renderDocsTable()');
  assert.deepEqual(rows(), ['บันทึกแรก', 'เอกสารเก่าไม่มีเวลา', 'บันทึกที่สอง', 'บันทึกล่าสุด']);
  // documents issued on the same day appear in the order they were saved
  run(`allDocuments = [
    { id: "x", title: "บันทึกทีหลัง", date: "2026-09-10", createdAtMs: 20 },
    { id: "y", title: "บันทึกก่อน", date: "2026-09-10", createdAtMs: 10 },
  ]; sortDir = "asc"; renderDocsTable()`);
  assert.deepEqual(rows(), ['บันทึกก่อน', 'บันทึกทีหลัง']);
});

test('record IDs stay escaped in document, trash and category action attributes', () => {
  const app = setup();
  const id = 'record" data-id-marker="injected &quot;';
  const escapedId = 'record&quot; data-id-marker=&quot;injected &amp;quot;';
  app.context.recordId = id;
  app.run(`
    allDocuments = [{ id: recordId, title: 'Test', category: recordId }];
    allTrash = [{ id: recordId, title: 'Test' }];
    allCategories = [{ id: recordId, name: 'Category' }];
    renderDocsTable(); renderTrash(); renderCategories();
  `);
  for (const [elementId, actions] of [
    ['docsTableBody', ['preview', 'download', 'edit', 'delete']],
    ['trashTableBody', ['restore', 'purge']],
    ['categoryGrid', ['del-cat', 'open-cat']],
  ]) {
    const markup = app.elements.get(elementId).innerHTML;
    for (const action of actions) {
      assert.ok(markup.includes(`data-${action}="${escapedId}"`), `${action} must preserve the entire ID`);
    }
    assert.ok(!markup.includes(' data-id-marker="'), 'IDs must not create HTML attributes');
  }
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

test('a document with blank details and no PDF is saved without any file fields', async () => {
  const app = setup({ authMode: 'ready' });
  app.run('openDocModal()');
  app.elements.get('docTitle').value = '   ';
  app.elements.get('docDate').value = '';
  const saving = app.elements.get('docForm').fire('submit');
  await flush();
  assert.equal(app.uploads.length, 0);
  assert.equal(app.writes.length, 1);
  const [write] = app.writes;
  assert.equal(write.title, '');
  assert.equal(write.docNumber, '');
  assert.equal(write.date, '');
  assert.equal(write.status, '', 'no status has to be chosen');
  assert.equal('urgency' in write, false, 'ปกติ is not written, so saving still works under rules that predate the field');
  assert.equal(write.createdBy, 'user-1');
  // firestore.rules accepts a record without a file only when none of the file fields are present.
  for (const key of ['storageKey', 'fileData', 'fileName', 'fileSize', 'mimeType']) assert.equal(key in write, false, key);
  app.complete();
  await saving;
  assert.equal(app.elements.get('docModalOverlay').hidden, true);
});

test('the form, the labels and firestore.rules agree on the urgency levels', () => {
  const { run } = setup();
  const select = html.match(/<select id="docUrgency">([\s\S]*?)<\/select>/)[1];
  const options = [...select.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [['', 'ปกติ'], ['urgent', 'ด่วน'], ['very-urgent', 'ด่วนมาก'], ['most-urgent', 'ด่วนที่สุด']]);
  assert.deepEqual(JSON.parse(run('JSON.stringify(URGENCY_LABEL)')), Object.fromEntries(options.slice(1)));
  // a value the rules don't list would be refused with permission-denied on save
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const allowed = [...rules.match(/data\.urgency in \[([^\]]*)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed, options.map(([value]) => value));
});

test('the urgency choice is saved, restored when editing, shown before the title and searchable', async () => {
  const app = setup({ authMode: 'ready' });
  const { run, elements } = app;
  run('openDocModal()');
  elements.get('docUrgency').value = 'most-urgent';
  const saving = elements.get('docForm').fire('submit');
  await flush();
  assert.equal(app.writes[0].urgency, 'most-urgent');
  app.complete();
  await saving;

  run('openDocModal({ id: "a", urgency: "very-urgent" })');
  assert.equal(elements.get('docUrgency').value, 'very-urgent');
  // records from before the field existed, or with a value the form doesn't offer, open as ปกติ
  for (const urgency of ['undefined', '"toString"']) {
    run(`openDocModal({ id: "b", urgency: ${urgency} })`);
    assert.equal(elements.get('docUrgency').value, '');
  }

  run(`allDocuments = [
    { id: "a", title: "ขอเชิญประชุม", urgency: "most-urgent" },
    { id: "b", title: "ปกติ", urgency: "" },
    { id: "c", title: "เอกสารเดิม" },
    { id: "d", title: "ค่าแปลก", urgency: "<b>x</b>" },
  ]; renderDocsTable()`);
  const markup = elements.get('docsTableBody').innerHTML;
  assert.ok(markup.includes('<span class="urgency urgency-most-urgent">ด่วนที่สุด</span>ขอเชิญประชุม'));
  assert.equal((markup.match(/class="urgency /g) || []).length, 1, 'only the urgent record has a badge');
  assert.ok(!markup.includes('<b>'));
  assert.equal(run('urgencyBadge("urgent")'), '<span class="urgency urgency-urgent">ด่วน</span>');
  assert.equal(run('urgencyBadge("very-urgent")'), '<span class="urgency urgency-very-urgent">ด่วนมาก</span>');

  elements.get('globalSearch').value = 'ด่วนที่สุด';
  await elements.get('globalSearch').fire('input');
  assert.equal((elements.get('docsTableBody').innerHTML.match(/<tr>/g) || []).length, 1);
  assert.match(elements.get('docsTableBody').innerHTML, /ขอเชิญประชุม/);
});

test('the document and order forms, the labels, the filter, the stamps and firestore.rules agree on the statuses', () => {
  const { run } = setup();
  const options = (id) => [...html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))[1]
    .matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  const label = JSON.parse(run('JSON.stringify(STATUS_LABEL)'));
  // documents: the form starts like this, and none has to be chosen
  const documentStatuses = [['', 'ไม่ระบุสถานะ'], ['pending', 'รอดำเนินการ'], ['approved', 'อนุมัติแล้ว'], ['rejected', 'ไม่อนุมัติ']];
  assert.deepEqual(options('docStatus'), documentStatuses);
  assert.deepEqual(JSON.parse(run('JSON.stringify(DOC_STATUSES)')), documentStatuses.map(([value]) => value));
  documentStatuses.slice(1).forEach(([value, text]) => assert.equal(label[value], text));
  // orders: none has to be chosen either, then four steps; รอดำเนินการ is shared with documents
  const orderStatuses = JSON.parse(run('JSON.stringify(ORDER_STATUSES)'));
  assert.equal(orderStatuses[0], '');
  assert.deepEqual(orderStatuses.slice(1).map((s) => [s, label[s]]),
    [['pending', 'รอดำเนินการ'], ['in-progress', 'กำลังดำเนินการ'], ['completed', 'เสร็จสิ้น'], ['cancelled', 'ยกเลิก']]);
  const statuses = Object.keys(label);
  assert.deepEqual([...statuses].sort(), JSON.parse(run('JSON.stringify([...new Set([...DOC_STATUSES, ...ORDER_STATUSES])].filter(Boolean).sort())')));
  // the filter offers every status once, then the records with none
  assert.deepEqual(options('filterStatus'), [['', 'สถานะทั้งหมด'], ...Object.entries(label), ['none', 'ไม่ระบุสถานะ']]);
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  statuses.forEach((status) => assert.match(css, new RegExp(`\\.stamp-${status} \\{`), `a stamp colour for ${status}`));
  // a value the rules don't list would be refused with permission-denied on save
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const allowed = [...rules.match(/data\.status in \[([^\]]*)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), ['', ...statuses].sort());
});

test('a chosen status is restored when editing; a blank one opens and shows as not specified', () => {
  const { run, elements } = setup();
  run('openDocModal({ id: "a", status: "rejected" })');
  assert.equal(elements.get('docStatus').value, 'rejected');
  for (const status of ['""', 'undefined', '"toString"']) {
    run(`openDocModal({ id: "b", status: ${status} })`);
    assert.equal(elements.get('docStatus').value, '', status);
  }
  assert.equal(run('statusStamp("approved")'), '<span class="stamp stamp-approved">อนุมัติแล้ว</span>');
  for (const [status, text] of [['in-progress', 'กำลังดำเนินการ'], ['completed', 'เสร็จสิ้น'], ['cancelled', 'ยกเลิก']]) {
    assert.equal(run(`statusStamp("${status}")`), `<span class="stamp stamp-${status}">${text}</span>`);
  }
  for (const status of ['""', 'undefined', '"toString"', '"<b>x</b>"']) assert.equal(run(`statusStamp(${status})`), '-', status);
});

const DOCUMENT_LABELS = ['ชื่อเอกสาร', 'เลขที่หนังสือ', 'วันที่ออกเอกสาร', 'หน่วยงาน'];
const ORDER_LABELS = ['ชื่อคำสั่ง', 'เลขที่คำสั่ง', 'วันที่ออกคำสั่ง', 'ผู้สั่ง'];
// the order form leaves its "no status" choice blank instead of writing ไม่ระบุสถานะ
const ORDER_STATUS_TEXT = ['', 'รอดำเนินการ', 'กำลังดำเนินการ', 'เสร็จสิ้น', 'ยกเลิก'];
const formText = (elements, ...ids) => ids.map((id) => elements.get(id).textContent);
const formLabels = (elements) => formText(elements, 'docTitleLabel', 'docNumberLabel', 'docDateLabel', 'docAgencyLabel');
const statusOptions = (elements) => [...elements.get('docStatus').innerHTML.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => m[2]);

test('choosing the คำสั่ง category turns the document form into the order form, and the filtered table uses the same names', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "order", name: " คำสั่ง " }, { id: "memo", name: "บันทึกข้อความ" }, { id: "old", name: "หนังสือคำสั่ง" }]; renderCategoryOptions()`);
  const placeholders = () => ['docTitle', 'docNumber', 'docAgency'].map((id) => elements.get(id).placeholder);
  const heads = () => formText(elements, 'titleHead', 'docNumberHead', 'dateHead', 'agencyHead');
  const status = elements.get('docStatus');
  const choose = (id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  run('openDocModal()');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  assert.deepEqual(placeholders(), ['เช่น ขอเชิญประชุมคณะกรรมการ', 'เช่น ศธ 0001/2569', 'เช่น กรมการปกครอง']);
  assert.equal(elements.get('docUrgencyField').hidden, false);
  assert.deepEqual(statusOptions(elements), ['ไม่ระบุสถานะ', 'รอดำเนินการ', 'อนุมัติแล้ว', 'ไม่อนุมัติ']);
  await choose('order');
  assert.deepEqual(formLabels(elements), ORDER_LABELS);
  assert.deepEqual(placeholders(), ['เช่น แต่งตั้งคณะกรรมการตรวจรับพัสดุ', 'เช่น 123/2569', 'เช่น นายก อบต.']);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docSaveBtn'), ['เพิ่มคำสั่งใหม่', 'บันทึกคำสั่ง']);
  assert.equal(elements.get('docUrgencyField').hidden, true, 'orders have no urgency');
  assert.deepEqual(statusOptions(elements), ORDER_STATUS_TEXT);
  assert.equal(status.value, '', 'still no status chosen');
  assert.equal('locked' in elements.get('docCategory').dataset, false, 'a category chosen here can still be changed');
  status.value = 'completed';
  await choose('memo');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docSaveBtn'), ['เพิ่มเอกสารใหม่', 'บันทึกเอกสาร']);
  assert.equal(elements.get('docUrgencyField').hidden, false);
  assert.equal(status.value, '', 'an order-only status falls back to not specified');
  status.value = 'pending';
  await choose('order');
  await choose('memo');
  assert.equal(status.value, 'pending', 'รอดำเนินการ belongs to both forms, so it is kept');

  // the built-in rename หนังสือคำสั่ง → คำสั่ง can arrive while the form is open
  await choose('old');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  run(`allCategories = [{ id: "old", name: "คำสั่ง" }]; renderCategoryOptions()`);
  assert.deepEqual(formLabels(elements), ORDER_LABELS);

  run('allDocuments = []; renderDocsTable()');
  assert.deepEqual(heads(), DOCUMENT_LABELS);
  elements.get('filterCategory').value = 'old';
  await elements.get('filterCategory').fire('change');
  assert.deepEqual(heads(), ORDER_LABELS);
  await elements.get('clearFilters').fire('click');
  assert.deepEqual(heads(), DOCUMENT_LABELS);
});

test('the เพิ่มคำสั่ง button opens the order form locked to คำสั่ง and saves an order without urgency', async () => {
  const app = setup({ authMode: 'ready' });
  const { run, elements } = app;
  const toasts = recordToasts(app);
  const category = elements.get('docCategory');
  run(`allCategories = [{ id: "memo", name: "บันทึกข้อความ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  elements.get('docUrgency').value = 'most-urgent'; // left over from an earlier document; the order form hides it
  await elements.get('addOrderBtn').fire('click');
  assert.equal(elements.get('docModalOverlay').hidden, false);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docModalSubtitle', 'docSaveBtn'), ['เพิ่มคำสั่งใหม่', 'กรอกรายละเอียดคำสั่งและแนบไฟล์ PDF', 'บันทึกคำสั่ง']);
  assert.deepEqual(formLabels(elements), ORDER_LABELS);
  assert.equal(category.value, 'order');
  assert.equal('locked' in category.dataset, true);
  assert.equal(elements.get('docUrgencyField').hidden, true);
  assert.deepEqual(statusOptions(elements), ORDER_STATUS_TEXT);
  assert.equal(elements.get('docStatus').value, '', 'a new order starts with no status');

  elements.get('docTitle').value = 'แต่งตั้งคณะกรรมการตรวจรับพัสดุ';
  elements.get('docNumber').value = '123/2569';
  elements.get('docAgency').value = 'นายก อบต.';
  elements.get('docStatus').value = 'in-progress';
  const saving = elements.get('docForm').fire('submit');
  await flush();
  const [write] = app.writes;
  assert.deepEqual([write.title, write.docNumber, write.agency, write.category, write.status],
    ['แต่งตั้งคณะกรรมการตรวจรับพัสดุ', '123/2569', 'นายก อบต.', 'order', 'in-progress']);
  assert.equal('urgency' in write, false, 'orders have no urgency');
  app.complete();
  await saving;
  assert.equal(elements.get('docModalOverlay').hidden, true);
  assert.deepEqual(toasts, [{ message: 'เพิ่มคำสั่งสำเร็จ', type: 'success' }]);

  // the next document opens unlocked, as a document again
  run('openDocModal()');
  assert.equal('locked' in category.dataset, false);
  assert.equal(category.value, '');
  assert.deepEqual(formText(elements, 'docModalTitle', 'docTitleLabel', 'docSaveBtn'), ['เพิ่มเอกสารใหม่', 'ชื่อเอกสาร', 'บันทึกเอกสาร']);
  assert.equal(elements.get('docUrgencyField').hidden, false);
  assert.equal(elements.get('docStatus').value, '');
});

test('editing an order opens the order form and keeps an older status the order form does not offer', async () => {
  const edit = async (existing, change = () => {}) => {
    const app = setup({ authMode: 'ready' });
    const toasts = recordToasts(app);
    app.context.existing = existing;
    app.run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "memo", name: "บันทึกข้อความ" }]; allDocuments = [existing]; openDocModal(existing)`);
    const { elements } = app;
    const form = {
      title: elements.get('docModalTitle').textContent, locked: 'locked' in elements.get('docCategory').dataset,
      statuses: statusOptions(elements), status: elements.get('docStatus').value,
    };
    change(elements);
    const saving = elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return { form, write: app.writes[0], toasts };
  };
  const order = { id: 'o1', title: 'คำสั่งเดิม', category: 'order', status: 'completed' };
  const saved = await edit(order);
  assert.deepEqual(saved.form, { title: 'แก้ไขคำสั่ง', locked: true, statuses: ORDER_STATUS_TEXT, status: 'completed' });
  assert.deepEqual([saved.write.category, saved.write.status], ['order', 'completed']);
  assert.deepEqual(saved.toasts, [{ message: 'แก้ไขคำสั่งสำเร็จ', type: 'success' }]);

  // orders saved through the document form before keep their status until someone picks a new one
  const approved = await edit({ ...order, status: 'approved', urgency: 'most-urgent' });
  assert.deepEqual(approved.form.statuses, ['อนุมัติแล้ว', ...ORDER_STATUS_TEXT]);
  assert.equal(approved.write.status, 'approved');
  assert.equal(approved.write.urgency, '', 'orders have no urgency, so an earlier level is cleared');
  // no status is one of the order form's own choices, so nothing extra is added for it
  const unset = await edit({ ...order, status: undefined });
  assert.deepEqual([unset.form.statuses, unset.form.status, unset.write.status], [ORDER_STATUS_TEXT, '', '']);
  const changed = await edit({ ...order, status: 'approved' }, (elements) => { elements.get('docStatus').value = 'cancelled'; });
  assert.equal(changed.write.status, 'cancelled');

  // records in other categories still open the document form
  const memo = await edit({ id: 'm1', title: 'บันทึก', category: 'memo', status: 'approved' });
  assert.deepEqual(memo.form, { title: 'แก้ไขเอกสาร', locked: false, statuses: ['ไม่ระบุสถานะ', 'รอดำเนินการ', 'อนุมัติแล้ว', 'ไม่อนุมัติ'], status: 'approved' });
});

test('an order is not saved before the คำสั่ง category has loaded, and picks it up once it arrives', async () => {
  const app = setup({ authMode: 'ready' });
  app.run('allCategories = []; openDocModal(null, { order: true })');
  assert.deepEqual(formText(app.elements, 'docModalTitle', 'docTitleLabel'), ['เพิ่มคำสั่งใหม่', 'ชื่อคำสั่ง'], 'still the order form');
  await app.elements.get('docForm').fire('submit');
  assert.equal(app.writes.length, 0, 'without its category it would be saved as a document');
  assert.match(app.elements.get('docFormError').textContent, /ยังโหลดหมวดหมู่คำสั่งไม่เสร็จ/);
  app.run('allCategories = [{ id: "order", name: "คำสั่ง" }]; renderCategoryOptions()');
  assert.equal(app.elements.get('docCategory').value, 'order');
  const saving = app.elements.get('docForm').fire('submit');
  await flush();
  assert.deepEqual([app.writes[0].category, app.writes[0].status], ['order', ''], 'saved as an order with no status chosen');
  app.complete();
  await saving;
});

test('editing writes urgency only when one is chosen or has to be cleared back to ปกติ', async () => {
  const edit = async (existing, choice) => {
    const app = setup({ authMode: 'ready' });
    app.context.existing = existing;
    app.run('allDocuments = [existing]; openDocModal(existing)');
    app.elements.get('docUrgency').value = choice;
    const saving = app.elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return app.writes[0];
  };
  const old = { id: 'old', title: 'เอกสารเดิม' };
  assert.equal('urgency' in await edit(old, ''), false, 'an older record saved as ปกติ is written exactly as before');
  assert.equal((await edit(old, 'urgent')).urgency, 'urgent');
  assert.equal((await edit({ ...old, urgency: 'most-urgent' }, '')).urgency, '', 'going back to ปกติ clears the stored level');
});

test('documents without a PDF or a title still read sensibly', () => {
  const app = setup();
  app.context.window.getSelection = () => ({ removeAllRanges() {} });
  app.run(`allDocuments = [
    { id: "none", title: "" },
    { id: "r2", title: "ไฟล์ใน R2", storageKey: "${STORAGE_KEY}" },
    { id: "legacy", title: "ไฟล์แบบเดิม", fileData: "data:application/pdf;base64,JVBERi0=" },
  ]; allTrash = [{ id: "trashed", title: "" }]; renderDocsTable(); renderTrash()`);
  assert.ok(app.elements.get('trashTableBody').innerHTML.includes('<td class="doc-title-cell">-</td>'));
  const markup = app.elements.get('docsTableBody').innerHTML;
  // no PDF: the buttons are disabled instead of reporting a broken file when pressed
  assert.match(markup, /data-preview="none" title="ดูตัวอย่าง \(ไม่มีไฟล์ PDF\)" disabled>/);
  assert.match(markup, /data-download="none" title="ดาวน์โหลด \(ไม่มีไฟล์ PDF\)" disabled>/);
  for (const id of ['r2', 'legacy']) {
    assert.match(markup, new RegExp(`data-preview="${id}" title="ดูตัวอย่าง">`));
    assert.match(markup, new RegExp(`data-download="${id}" title="ดาวน์โหลด">`));
  }
  assert.ok(markup.includes('<td class="doc-title-cell">-</td>'), 'a missing title shows "-" like the other columns');

  // the preview heading names the dialog, so it falls back instead of going blank
  app.context.data = 'data:application/pdf;base64,' + btoa('%PDF-1.7');
  for (const [doc, heading] of [['{ title: "", fileName: "คำสั่ง.pdf", fileData: data }', 'คำสั่ง.pdf'], ['{ title: "", fileData: data }', 'ดูตัวอย่างเอกสาร']]) {
    app.run(`previewDoc(${doc})`);
    assert.equal(app.elements.get('previewTitle').textContent, heading);
    app.run('closeModal("previewModalOverlay")');
  }
});

test('saving before the anonymous sign-in has finished is explained in Thai', async () => {
  for (const app of [setup(), setup({ authMode: 'ready' })]) {
    app.run('if (typeof auth !== "undefined") auth.currentUser = null');
    app.run('openDocModal()');
    app.elements.get('docTitle').value = 'หนังสือทดสอบ';
    await app.elements.get('docForm').fire('submit');
    assert.equal(app.writes.length, 0);
    assert.match(app.elements.get('docFormError').textContent, /^บันทึกข้อมูลไม่สำเร็จ: ยืนยันตัวตนไม่สำเร็จ/);
    assert.equal(app.elements.get('docModalOverlay').hidden, false);
  }
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

test('realtime updates refresh category counts and report stream errors in Thai', () => {
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
  subscriptions[0].fail(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  subscriptions[1].fail(Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' }));
  assert.deepEqual(toasts, [
    { message: 'โหลดข้อมูลล้มเหลว: ไม่มีสิทธิ์อ่านข้อมูลเอกสาร', type: 'error' },
    { message: 'โหลดข้อมูลล้มเหลว: มีการใช้งานฐานข้อมูลเกินโควตา กรุณาลองใหม่ภายหลัง', type: 'error' },
  ]);
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

/* =========================================================
   Debug review 2026-10-02
   ========================================================= */
test('built-in categories cannot be deleted (they would come back empty), others still can', () => {
  const app = setup();
  app.run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "memo", name: " บันทึกข้อความ " }, { id: "own", name: "หนังสือเวียน" }]; renderCategories()`);
  const markup = app.elements.get('categoryGrid').innerHTML;
  assert.deepEqual([...markup.matchAll(/data-del-cat="([^"]*)"/g)].map((m) => m[1]), ['own']);
  assert.equal((markup.match(/disabled title="หมวดหมู่หลักของระบบ ลบไม่ได้"/g) || []).length, 2);
});
test('every folder opens its own documents, with the other filters cleared', () => {
  const app = setup();
  app.run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "own", name: "หนังสือเวียน" }];
    allDocuments = [
      { id: "a", title: "คำสั่งแต่งตั้ง", category: "order", status: "pending" },
      { id: "b", title: "คำสั่งย้าย", category: "order" },
      { id: "c", title: "หนังสือเวียนแจ้ง", category: "own", status: "approved" },
    ];
    renderCategories()`);
  const markup = app.elements.get('categoryGrid').innerHTML;
  // built-in folders can't be deleted, but they still open
  assert.deepEqual([...markup.matchAll(/data-open-cat="([^"]*)"/g)].map((m) => m[1]), ['order', 'own']);
  assert.match(markup, /<button type="button" class="cat-name" aria-label="ดูเอกสารในหมวดหมู่ คำสั่ง">คำสั่ง<\/button>/);
  for (const [id, value] of [['globalSearch', 'ย้าย'], ['filterStatus', 'approved'], ['filterDate', '2026-01-01']]) app.elements.get(id).value = value;
  app.run('resetDocFilters("order")');
  assert.deepEqual(['globalSearch', 'filterCategory', 'filterStatus', 'filterDate'].map((id) => app.elements.get(id).value), ['', 'order', '', '']);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(getFilteredDocs().map((d) => d.title))')).sort(), ['คำสั่งแต่งตั้ง', 'คำสั่งย้าย'].sort());
});

test('the status filter can find documents saved without a status', () => {
  const { run, elements } = setup();
  run(`allDocuments = [
    { id: "a", title: "ไม่ระบุ", status: "" },
    { id: "b", title: "เดิมไม่มีช่องสถานะ" },
    { id: "c", title: "อนุมัติ", status: "approved" },
    { id: "d", title: "คำสั่งเสร็จสิ้น", status: "completed" },
  ]`);
  const titles = () => JSON.parse(run('JSON.stringify(getFilteredDocs().map((d) => d.title))')).sort();
  elements.get('filterStatus').value = 'none';
  assert.deepEqual(titles(), ['ไม่ระบุ', 'เดิมไม่มีช่องสถานะ'].sort());
  elements.get('filterStatus').value = 'approved';
  assert.deepEqual(titles(), ['อนุมัติ']);
  elements.get('filterStatus').value = 'completed';
  assert.deepEqual(titles(), ['คำสั่งเสร็จสิ้น']);
  assert.match(html.match(/<select id="filterStatus">([\s\S]*?)<\/select>/)[1], /<option value="none">ไม่ระบุสถานะ<\/option>/);
});

test('the trash lists the most recently deleted first', () => {
  const { run, elements } = setup();
  run(`allTrash = [
    { id: "a", title: "ลบก่อน", deletedAt: 1000 },
    { id: "b", title: "ลบล่าสุด", deletedAt: 3000 },
    { id: "c", title: "ไม่มีเวลาลบ" },
    { id: "d", title: "ลบกลาง", deletedAt: 2000 },
  ]; renderTrash()`);
  const titles = [...elements.get('trashTableBody').innerHTML.matchAll(/doc-title-cell">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['ลบล่าสุด', 'ลบกลาง', 'ลบก่อน', 'ไม่มีเวลาลบ']);
});

test('failed trash, restore and category actions are explained in Thai, not raw Firestore text', async () => {
  const notFound = Object.assign(new Error('No document to update: projects/x'), { code: 'not-found' });
  const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

  const trash = setup({ authMode: 'ready' });
  const trashToasts = recordToasts(trash);
  trash.run('softDeleteDoc("gone")');
  const moving = trash.elements.get('confirmActionBtn').fire('click');
  await flush();
  trash.rejectWrite(notFound);
  await moving;
  trash.run('restoreDoc("gone")');
  await flush();
  trash.rejectWrite(denied);
  await flush();
  assert.deepEqual(trashToasts.map((t) => [t.type, t.message]), [
    ['error', 'ไม่พบข้อมูลนี้แล้ว อาจถูกลบไปแล้ว'],
    ['error', 'ไม่มีสิทธิ์บันทึกหรือแก้ไขข้อมูลเอกสาร'],
  ]);

  const cat = setup({ authMode: 'ready' });
  const catToasts = recordToasts(cat);
  cat.run('allCategories = [{ id: "x", name: "หนังสือเวียน" }]');
  for (const name of ['   ', ' หนังสือเวียน ']) {
    cat.elements.get('categoryName').value = name;
    await cat.elements.get('categoryForm').fire('submit');
  }
  assert.equal(cat.writes.length, 0);
  cat.elements.get('categoryName').value = 'หนังสือใหม่';
  const adding = cat.elements.get('categoryForm').fire('submit');
  await flush();
  cat.rejectWrite(denied);
  await adding;
  assert.deepEqual(catToasts.map((t) => t.message), [
    'กรุณากรอกชื่อหมวดหมู่', 'มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น', 'ไม่มีสิทธิ์บันทึกหรือแก้ไขข้อมูลเอกสาร',
  ]);
});
