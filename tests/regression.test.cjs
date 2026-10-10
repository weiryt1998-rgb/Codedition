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
  apiUrl = 'https://pdf-api.test', apiRespond = defaultApiResponse, firestoreDeleteError = null, legacyBrowser = false,
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
  // the งานที่รับผิดชอบ choices have no ids, so they are kept here in the order of the form
  const sectionRadios = [...html.matchAll(/<input type="radio" name="docSection" value="([^"]*)">/g)]
    .map((m) => Object.assign(new Element(), { name: 'docSection', value: m[1], checked: false }));
  const created = [];
  document = {
    getElementById(id) { assert.ok(elements.has(id), `Unknown DOM id: ${id}`); return elements.get(id); },
    querySelector(selector) { return elements.get(selector.slice(1)) || new Element(); },
    querySelectorAll(selector) {
      if (selector === '.modal-overlay') return [...elements.values()].filter((el) => el.id.endsWith('Overlay'));
      if (selector === '.view') return [...elements.values()].filter((el) => el.id.startsWith('view-'));
      if (selector === '#docSectionPicks input[name="docSection"]') return sectionRadios;
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
  // Safari before 15.4 has neither of these
  if (legacyBrowser) run('delete Object.hasOwn; delete Array.prototype.at;');
  run(source);
  return {
    run, elements, context, subscriptions, writes, deletes, storage, warnings, authAttempts, uploads, apiCalls, created, sectionRadios,
    // a click on a choice, as the browser does it: the choice becomes the checked one, then the click reaches the group
    pickSection: (value) => {
      const radio = sectionRadios.find((r) => r.value === value);
      sectionRadios.forEach((r) => { r.checked = r === radio; });
      return elements.get('docSectionPicks').fire('click', { target: radio });
    },
    authenticate: (index = authAttempts.length - 1) => authAttempts[index].resolve(),
    rejectAuthentication: (error, index = authAttempts.length - 1) => authAttempts[index].reject(error),
    complete: (index = pendingWrites.length - 1) => pendingWrites[index].resolve(),
    rejectWrite: (error, index = pendingWrites.length - 1) => pendingWrites[index].reject(error),
    fireWindow: (name) => (windowEvents[name] || []).forEach((fn) => fn()),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// The documents page as a person reads it: one box per category, with its title, count, add button,
// column heads, and rows as { column head: cell text }.
function docBoxes(elements) {
  return elements.get('docGroups').innerHTML.split('<section ').slice(1).map((box) => {
    const heads = [...box.matchAll(/<th data-sort="[^"]*"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    const rows = [...box.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim()))
      .filter((cells) => cells.length);
    return {
      group: box.match(/data-group="([^"]*)"/)[1],
      title: box.match(/<h3 [^>]*>([^<]*)<\/h3>/)[1],
      tag: box.match(/<span class="panel-tag">([^<]*)<\/span>/)[1],
      add: box.match(/data-add-to="[^"]*"[^>]*>[\s\S]*?<span>([^<]*)<\/span>/)?.[1] ?? null,
      note: box.match(/<p class="doc-group-empty">([^<]*)<\/p>/)?.[1] ?? null,
      heads,
      rows: rows.map((cells) => Object.fromEntries(heads.map((head, i) => [head, cells[i]]))),
    };
  });
}
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
  assert.match(elements.get('docGroups').innerHTML, /Test/);
});

test('document numbers sort naturally and pagination stays bounded', () => {
  const { run } = setup();
  assert.equal(run('sortDocs([{docNumber:"10"},{docNumber:"2"}], { sortKey: "docNumber", sortDir: "asc" })[0].docNumber'), '2');
  const pages = run('paginationHtml(500, 1000)');
  assert.equal((pages.match(/<button/g) || []).length, 7);
  assert.match(pages, /aria-current="page"/);
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
  const rows = () => docBoxes(elements)[0].rows.map((row) => row['ชื่อเอกสาร']);
  assert.deepEqual(rows(), ['บันทึกล่าสุด', 'บันทึกที่สอง', 'บันทึกแรก', 'เอกสารเก่าไม่มีเวลา']);
  assert.doesNotMatch(elements.get('docGroups').innerHTML, /col-entry/);
  run('Object.assign(groupView(""), { sortKey: "date", sortDir: "desc" }); renderDocsTable()');
  assert.deepEqual(rows(), ['บันทึกแรก', 'เอกสารเก่าไม่มีเวลา', 'บันทึกที่สอง', 'บันทึกล่าสุด']);
  // documents issued on the same day appear in the order they were saved
  run(`allDocuments = [
    { id: "x", title: "บันทึกทีหลัง", date: "2026-09-10", createdAtMs: 20 },
    { id: "y", title: "บันทึกก่อน", date: "2026-09-10", createdAtMs: 10 },
  ]; groupView("").sortDir = "asc"; renderDocsTable()`);
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
    ['docGroups', ['preview', 'download', 'edit', 'delete', 'add-to', 'group']],
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
  const markup = elements.get('docGroups').innerHTML;
  assert.ok(markup.includes('<span class="urgency urgency-most-urgent">ด่วนที่สุด</span>ขอเชิญประชุม'));
  assert.equal((markup.match(/class="urgency /g) || []).length, 1, 'only the urgent record has a badge');
  assert.ok(!markup.includes('<b>'));
  assert.equal(run('urgencyBadge("urgent")'), '<span class="urgency urgency-urgent">ด่วน</span>');
  assert.equal(run('urgencyBadge("very-urgent")'), '<span class="urgency urgency-very-urgent">ด่วนมาก</span>');

  elements.get('globalSearch').value = 'ด่วนที่สุด';
  await elements.get('globalSearch').fire('input');
  assert.deepEqual(docBoxes(elements).flatMap((box) => box.rows.map((row) => row['ชื่อเอกสาร'])), ['ด่วนที่สุดขอเชิญประชุม']);
});

// ชื่อสถานะที่ระบบเคยมี (เสร็จสิ้นกับยกเลิกของคำสั่งไม่อยู่ในนี้ เพราะเป็นชื่อปุ่มในหน้าต่างต่าง ๆ ด้วย)
const DOCUMENT_STATUS_WORDS = /รอดำเนินการ|อนุมัติแล้ว|ไม่อนุมัติ|กำลังดำเนินการ|ไม่ระบุสถานะ|สถานะทั้งหมด/;
const STATUS_WORDS = new RegExp(`${DOCUMENT_STATUS_WORDS.source}|เสร็จสิ้น|ยกเลิก`);

test('statuses are gone: no status field, filter, column or stamp, and records that still carry one show none of it', async () => {
  const { run, elements } = setup();
  assert.doesNotMatch(html, /id="docStatus"|id="filterStatus"|>\s*สถานะ\s*</);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), DOCUMENT_STATUS_WORDS);
  assert.equal(run('[typeof STATUS_LABEL, typeof DOC_STATUSES, typeof ORDER_STATUSES, typeof statusStamp, typeof renderStatusOptions].join()'),
    'undefined,undefined,undefined,undefined,undefined');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), /\.stamp\b/);

  // records saved while statuses existed keep them in Firestore, but no page shows them any more
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions();
    allDocuments = [
      { id: "a", category: "in", title: "ขอเชิญประชุม", status: "approved", createdAtMs: 3 },
      { id: "b", category: "order", title: "แต่งตั้งคณะกรรมการ", docNumber: "12/2569", agency: "นายก อบต.", status: "in-progress", createdAtMs: 2 },
      { id: "c", category: "in", title: "แจ้งโอนงบประมาณ", status: "pending", createdAtMs: 1 },
    ]; renderAll()`);
  const boxes = docBoxes(elements);
  assert.deepEqual(boxes.map((box) => [box.title, box.heads]), [
    ['หนังสือรับ', ['เลขที่รับ', 'เลขที่หนังสือ', 'ชื่อเอกสาร', 'จาก', 'วันที่ออกเอกสาร', 'ขนาดไฟล์', 'งานที่รับผิดชอบ']],
    ['คำสั่ง', ['เลขที่คำสั่ง', 'ชื่อคำสั่ง', 'ผู้สั่ง', 'วันที่ออกคำสั่ง', 'ขนาดไฟล์']],
  ]);
  for (const id of ['docGroups', 'recentList']) assert.doesNotMatch(elements.get(id).innerHTML, new RegExp(`stamp|${STATUS_WORDS.source}`), id);
  // the order search lists who gave the order, and no status after it
  run('openDocModal(null, { order: true })');
  elements.get('orderSearch').value = 'แต่งตั้ง';
  await elements.get('orderSearch').fire('input');
  assert.match(elements.get('orderSearchResults').innerHTML, /<span class="order-hit-sub">นายก อบต\.<\/span>/);
  assert.doesNotMatch(elements.get('orderSearchResults').innerHTML, STATUS_WORDS);
});

test('saving writes the blank status firestore.rules still requires only where it is missing, and leaves an old status as it was', async () => {
  const save = async (existing) => {
    const app = setup({ authMode: 'ready' });
    app.context.existing = existing;
    app.run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions();
      allDocuments = existing ? [existing] : []; openDocModal(existing)`);
    const saving = app.elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return app.writes[0];
  };
  assert.equal((await save(null)).status, '', 'a new record');
  assert.equal('status' in await save({ id: 'a', title: 'ขอเชิญประชุม', category: 'in', status: 'approved' }), false, 'an old status stays untouched');
  assert.equal('status' in await save({ id: 'o', title: 'แต่งตั้งคณะกรรมการ', category: 'order', status: 'in-progress' }), false);
  assert.equal((await save({ id: 'b', title: 'บันทึกก่อนมีช่องสถานะ', category: 'in' })).status, '', 'a record without the field gets one, or the rules refuse the edit');
  // the rules check status on every write, so '' and every status a record may still carry must stay allowed
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const allowed = [...rules.match(/data\.status in \[([^\]]*)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), ['', 'approved', 'cancelled', 'completed', 'in-progress', 'pending', 'rejected']);
});

const DOCUMENT_LABELS = ['ชื่อเอกสาร', 'เลขที่หนังสือ', 'วันที่ออกเอกสาร', 'หน่วยงาน'];
const ORDER_LABELS = ['ชื่อคำสั่ง', 'เลขที่คำสั่ง', 'วันที่ออกคำสั่ง', 'ผู้สั่ง'];
const formText = (elements, ...ids) => ids.map((id) => elements.get(id).textContent);
const formLabels = (elements) => formText(elements, 'docTitleLabel', 'docNumberLabel', 'docDateLabel', 'docAgencyLabel');

test('choosing the คำสั่ง category turns the document form into the order form, and the คำสั่ง box uses the same names', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "order", name: " คำสั่ง " }, { id: "memo", name: "บันทึกข้อความ" }, { id: "old", name: "หนังสือคำสั่ง" }]; renderCategoryOptions()`);
  const placeholders = () => ['docTitle', 'docNumber', 'docAgency'].map((id) => elements.get(id).placeholder);
  const choose = (id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  run('openDocModal()');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  assert.deepEqual(placeholders(), ['เช่น ขอเชิญประชุมคณะกรรมการ', 'เช่น ศธ 0001/2569', 'เช่น กรมการปกครอง']);
  assert.equal(elements.get('docUrgencyField').hidden, false);
  await choose('order');
  assert.deepEqual(formLabels(elements), ORDER_LABELS);
  assert.deepEqual(placeholders(), ['เช่น แต่งตั้งคณะกรรมการตรวจรับพัสดุ', 'เช่น 123/2569', 'เช่น นายก อบต.']);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docSaveBtn'), ['เพิ่มคำสั่งใหม่', 'บันทึกคำสั่ง']);
  assert.equal(elements.get('docUrgencyField').hidden, true, 'orders have no urgency');
  assert.equal('locked' in elements.get('docCategory').dataset, false, 'a category chosen here can still be changed');
  await choose('memo');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docSaveBtn'), ['เพิ่มเอกสารใหม่', 'บันทึกเอกสาร']);
  assert.equal(elements.get('docUrgencyField').hidden, false);

  // the built-in rename หนังสือคำสั่ง → คำสั่ง can arrive while the form is open
  await choose('old');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  run(`allCategories = [{ id: "old", name: "คำสั่ง" }]; renderCategoryOptions()`);
  assert.deepEqual(formLabels(elements), ORDER_LABELS);

  // on the documents page the คำสั่ง box names its columns like the order form; other boxes keep the document names
  run(`allCategories = [{ id: "old", name: "คำสั่ง" }, { id: "memo", name: "บันทึกข้อความ" }]; renderCategoryOptions();
    allDocuments = [{ id: "o1", category: "old" }, { id: "m1", category: "memo" }]; renderDocsTable()`);
  const heads = () => Object.fromEntries(docBoxes(elements).map((box) => [box.title, box.heads.slice(0, 4)]));
  assert.deepEqual(heads(), {
    'คำสั่ง': ['เลขที่คำสั่ง', 'ชื่อคำสั่ง', 'ผู้สั่ง', 'วันที่ออกคำสั่ง'],
    'บันทึกข้อความ': ['เลขที่หนังสือ', 'ชื่อเอกสาร', 'หน่วยงาน', 'วันที่ออกเอกสาร'],
  });
  elements.get('filterCategory').value = 'old';
  await elements.get('filterCategory').fire('change');
  assert.deepEqual(heads(), { 'คำสั่ง': ['เลขที่คำสั่ง', 'ชื่อคำสั่ง', 'ผู้สั่ง', 'วันที่ออกคำสั่ง'] }, 'filtered to คำสั่ง, only its box is left');
});

test('the หนังสือส่ง, หนังสือรับ and คำร้อง categories call the agency field and column ถึง, จาก and ผู้ยื่นคำร้อง, also when editing', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "out", name: " หนังสือส่ง " }, { id: "in", name: "หนังสือรับ" }, { id: "petition", name: "คำร้อง" }, { id: "memo", name: "บันทึกข้อความ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  const agency = () => elements.get('docAgencyLabel').textContent;
  const choose = (id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  run('openDocModal()');
  assert.deepEqual(formLabels(elements), DOCUMENT_LABELS);
  await choose('out');
  assert.deepEqual(formLabels(elements), [...DOCUMENT_LABELS.slice(0, 3), 'ถึง'], 'only the agency field is renamed');
  assert.deepEqual(formText(elements, 'docModalTitle', 'docSaveBtn'), ['เพิ่มเอกสารใหม่', 'บันทึกเอกสาร']);
  await choose('in');
  assert.equal(agency(), 'จาก');
  await choose('petition');
  assert.equal(agency(), 'ผู้ยื่นคำร้อง');
  await choose('order');
  assert.equal(agency(), 'ผู้สั่ง');
  await choose('memo');
  assert.equal(agency(), 'หน่วยงาน');
  await choose('');
  assert.equal(agency(), 'หน่วยงาน');

  run('openDocModal({ id: "a", category: "in", agency: "อำเภอศรีสำโรง" })');
  assert.deepEqual([agency(), elements.get('docAgency').value], ['จาก', 'อำเภอศรีสำโรง']);
  run('openDocModal({ id: "b", category: "petition", agency: "นายสมชาย ใจดี" })');
  assert.deepEqual([agency(), elements.get('docAgency').value], ['ผู้ยื่นคำร้อง', 'นายสมชาย ใจดี']);
  run('openDocModal()');
  assert.equal(agency(), 'หน่วยงาน', 'the next new document starts with หน่วยงาน again');

  // on the documents page each of their boxes names its agency column the same way
  run(`allDocuments = ["out", "in", "petition", "memo", "order"].map((category) => ({ id: category, category })); renderDocsTable()`);
  // the agency column sits just before the date column
  const agencyColumns = () => Object.fromEntries(docBoxes(elements).map((box) => [box.title.trim(), box.heads[box.heads.findIndex((h) => h.startsWith('วันที่')) - 1]]));
  assert.deepEqual(agencyColumns(), { 'หนังสือรับ': 'จาก', 'หนังสือส่ง': 'ถึง', 'คำสั่ง': 'ผู้สั่ง', 'บันทึกข้อความ': 'หน่วยงาน', 'คำร้อง': 'ผู้ยื่นคำร้อง' });
  elements.get('filterCategory').value = 'out';
  await elements.get('filterCategory').fire('change');
  assert.deepEqual(agencyColumns(), { 'หนังสือส่ง': 'ถึง' });
});

test('only the หนังสือรับ form has a เลขที่รับ field, right after หมวดหมู่, as long as firestore.rules allows', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "in", name: " หนังสือรับ " }, { id: "out", name: "หนังสือส่ง" }, { id: "petition", name: "คำร้อง" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  const field = elements.get('docReceiveField');
  const choose = (id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  run('openDocModal()');
  assert.equal(field.hidden, true, 'a new document has no category yet');
  await choose('in');
  assert.equal(field.hidden, false);
  for (const id of ['out', 'petition', 'order', '']) {
    await choose(id);
    assert.equal(field.hidden, true, id);
  }
  run('openDocModal(null, { order: true })');
  assert.equal(field.hidden, true, 'the order form');
  run('openDocModal({ id: "a", category: "in", receiveNumber: "124" })');
  assert.deepEqual([field.hidden, elements.get('docReceiveNumber').value], [false, '124']);
  run('openDocModal({ id: "b", category: "out" })');
  assert.equal(field.hidden, true);

  const afterCategory = html.split('<select id="docCategory">')[1].split('</label>')[1];
  assert.match(afterCategory, /^\s*(<!--[^>]*-->\s*)?<label id="docReceiveField" hidden>เลขที่รับ\s*<input type="text" id="docReceiveNumber"/);
  // a field the rules don't list, or a longer number than they allow, would be refused with permission-denied
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.match(rules.match(/hasOnly\(\[([^\]]*)\]/)[1], /'receiveNumber'/);
  assert.equal(html.match(/id="docReceiveNumber" maxlength="(\d+)"/)[1], rules.match(/data\.receiveNumber is string && data\.receiveNumber\.size\(\) <= (\d+)/)[1]);
});

test('เลขที่รับ is written only for หนังสือรับ, or as "" to clear one the record no longer shows', async () => {
  const save = async (existing, change) => {
    const app = setup({ authMode: 'ready' });
    app.context.existing = existing;
    app.run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "out", name: "หนังสือส่ง" }]; renderCategoryOptions();
      allDocuments = existing ? [existing] : []; openDocModal(existing)`);
    await change(app.elements);
    const saving = app.elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return app.writes[0];
  };
  const choose = (elements, id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  const type = (elements, text) => { elements.get('docReceiveNumber').value = text; };

  const created = await save(null, async (elements) => { await choose(elements, 'in'); type(elements, ' 125 '); });
  assert.deepEqual([created.category, created.receiveNumber], ['in', '125']);
  const blank = await save(null, (elements) => choose(elements, 'in'));
  assert.equal('receiveNumber' in blank, false, 'left empty, it is not written, so saving still works under rules that predate the field');
  const moved = await save(null, async (elements) => { await choose(elements, 'in'); type(elements, '125'); await choose(elements, 'out'); });
  assert.deepEqual([moved.category, 'receiveNumber' in moved], ['out', false], 'a number typed before choosing another category is not saved');

  const received = { id: 'r1', title: 'ขอเชิญประชุม', category: 'in', receiveNumber: '124' };
  assert.equal((await save(received, () => {})).receiveNumber, '124', 'kept when something else is edited');
  assert.equal((await save(received, (elements) => type(elements, '130'))).receiveNumber, '130');
  assert.equal((await save(received, (elements) => type(elements, ''))).receiveNumber, '', 'emptied, the stored number is cleared');
  assert.equal((await save(received, (elements) => choose(elements, 'out'))).receiveNumber, '', 'moved out of หนังสือรับ, its hidden number is cleared');
  assert.equal('receiveNumber' in await save({ id: 'o1', title: 'หนังสือส่ง', category: 'out' }, () => {}), false, 'other records are written exactly as before');
});

test('the หนังสือรับ box starts with a เลขที่รับ column that sorts as numbers, other boxes have none, and search finds the number', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "out", name: "หนังสือส่ง" }]; renderCategoryOptions()`);
  run(`allDocuments = [
    { id: "a", category: "in", docNumber: "สท 0023.3/ว 456", receiveNumber: "125", title: "ขอเชิญประชุม", createdAtMs: 5 },
    { id: "b", category: "in", docNumber: "สท 0023.1/ว 789", receiveNumber: "9", title: "แจ้งโอนงบประมาณ", createdAtMs: 4 },
    { id: "c", category: "in", docNumber: "มท 0810.5/ว 12", title: "ยังไม่ได้ลงเลขรับ", createdAtMs: 3 },
    { id: "d", category: "out", docNumber: "สท 75301/1", title: "หนังสือส่ง", createdAtMs: 2 },
    { id: "f", category: "in", docNumber: "สท 0023.5/ว 3", receiveNumber: "10", title: "ขอความร่วมมือ", createdAtMs: 1 },
  ]; renderDocsTable()`);
  const box = (title) => docBoxes(elements).find((b) => b.title === title);
  const numbers = () => box('หนังสือรับ').rows.map((row) => row['เลขที่รับ']);

  assert.deepEqual(box('หนังสือรับ').heads.slice(0, 3), ['เลขที่รับ', 'เลขที่หนังสือ', 'ชื่อเอกสาร']);
  assert.deepEqual(box('หนังสือรับ').rows.map((row) => [row['เลขที่รับ'], row['เลขที่หนังสือ']]),
    [['125', 'สท 0023.3/ว 456'], ['10', 'สท 0023.5/ว 3'], ['9', 'สท 0023.1/ว 789'], ['-', 'มท 0810.5/ว 12']], 'largest เลขที่รับ first, as numbers');
  assert.match(elements.get('docGroups').innerHTML, /<th data-sort="receiveNumber" tabindex="0" class="is-sorted-desc" aria-sort="descending">เลขที่รับ<\/th>/);
  assert.deepEqual(box('หนังสือส่ง').heads.slice(0, 2), ['เลขที่หนังสือ', 'ชื่อเอกสาร'], 'no เลขที่รับ outside หนังสือรับ');
  assert.doesNotMatch(elements.get('docGroups').innerHTML, /data-group="out"[\s\S]*is-sorted/, 'other boxes still start in saved order');
  run('sortGroup("in", "receiveNumber")');
  assert.deepEqual(numbers(), ['-', '9', '10', '125'], 'numbers sort as numbers');
  assert.match(elements.get('docGroups').innerHTML, /<th data-sort="receiveNumber" tabindex="0" class="is-sorted-asc" aria-sort="ascending">เลขที่รับ<\/th>/);
  run('sortGroup("in", "receiveNumber")');
  assert.deepEqual(numbers(), ['125', '10', '9', '-']);

  // the search box finds a record by its เลขที่รับ, and only boxes with a match stay
  elements.get('globalSearch').value = '125';
  await elements.get('globalSearch').fire('input');
  assert.deepEqual(docBoxes(elements).map((b) => [b.title, b.rows.map((row) => row['เลขที่หนังสือ'])]), [['หนังสือรับ', ['สท 0023.3/ว 456']]]);

  run(`allDocuments = [{ id: "x", category: "in", receiveNumber: "<b>1</b>" }]; document.getElementById("globalSearch").value = ""; renderDocsTable()`);
  assert.deepEqual(numbers(), ['&lt;b&gt;1&lt;/b&gt;']);
});

/* =========================================================
   งานที่รับผิดชอบ
   ========================================================= */
const SECTIONS = [
  ['palat', 'สำนักปลัด'], ['finance', 'กองคลัง'], ['engineering', 'กองช่าง'], ['education', 'กองการศึกษาฯ'], ['health', 'กองสาธารณสุขฯ'],
  ['clerk', 'จพง.ธุรการฯ'], ['disaster', 'จพง.ป้องกันฯ'], ['general-affairs', 'นักจัดการงานทั่วไปฯ'],
  ['human-resources', 'นักทรัพยากรบุคคลฯ'], ['policy-planning', 'นักวิเคราะห์นโยบายและแผนฯ'],
];

test('the งานที่รับผิดชอบ choices in the form and the filter, SECTION_LABEL and firestore.rules list the same ten, in the same order', () => {
  const { run } = setup();
  assert.deepEqual(Object.entries(JSON.parse(run('JSON.stringify(SECTION_LABEL)'))), SECTIONS);
  const picks = [...html.matchAll(/<label class="section-pick"><input type="radio" name="docSection" value="([^"]*)"><span>([^<]*)<\/span><\/label>/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(picks, SECTIONS);
  const filter = [...html.match(/<select id="filterSection">([\s\S]*?)<\/select>/)[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(filter, [['', 'งานทั้งหมด'], ...SECTIONS, ['none', 'ยังไม่ระบุงาน']]);
  // a field or a value the rules don't list would be refused with permission-denied on save
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.match(rules.match(/hasOnly\(\[([^\]]*)\]/)[1], /'section'/);
  const allowed = [...rules.match(/data\.section in \[([^\]]*)\]/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(allowed, ['', ...SECTIONS.map(([key]) => key)]);
  // in the form it comes right after ชั้นความเร็ว, with the hint under the choices
  const afterUrgency = html.split('<label id="docUrgencyField">')[1].split('</label>').slice(1).join('</label>');
  assert.match(afterUrgency, /^\s*(<!--[\s\S]*?-->\s*)?<fieldset class="span-2 section-field" id="docSectionField" aria-describedby="docSectionHint">\s*<legend>งานที่รับผิดชอบ<\/legend>/);
  assert.match(html, /<p class="field-hint" id="docSectionHint">ไม่บังคับเลือก — กดตัวเลือกเดิมซ้ำเพื่อยกเลิกการเลือก<\/p>/);
});

test('งานที่รับผิดชอบ takes one choice, pressing it again clears it, editing shows the saved one, and the order form has none', async () => {
  const { run, elements, sectionRadios, pickSection } = setup();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  const state = () => [run('chosenSection()'), sectionRadios.filter((r) => r.checked).map((r) => r.value)];
  run('openDocModal()');
  assert.deepEqual([...state(), elements.get('docSectionField').hidden], ['', [], false], 'a new document starts with none');
  await pickSection('finance');
  assert.deepEqual(state(), ['finance', ['finance']]);
  await pickSection('finance');
  assert.deepEqual(state(), ['', []], 'pressing the chosen one again clears it');
  await pickSection('palat');
  await pickSection('clerk');
  assert.deepEqual(state(), ['clerk', ['clerk']]);
  // the text of a choice passes its click on to the choice; that first click does nothing by itself
  await elements.get('docSectionPicks').fire('click', { target: {} });
  assert.deepEqual(state(), ['clerk', ['clerk']]);
  // a choice made with the arrow keys arrives as a change, so pressing it afterwards still clears it
  sectionRadios.forEach((r) => { r.checked = r.value === 'health'; });
  await elements.get('docSectionPicks').fire('change', { target: sectionRadios.find((r) => r.value === 'health') });
  await pickSection('health');
  assert.deepEqual(state(), ['', []]);
  // Space on the chosen one clears it (Chrome sends that choice no click), and its key-up is held back
  // so a browser that clicks on key-up does not choose it again
  await pickSection('clerk');
  const clerk = sectionRadios.find((r) => r.value === 'clerk');
  let prevented = 0;
  const press = (type, target) => elements.get('docSectionPicks').fire(type, { key: ' ', target, preventDefault() { prevented++; } });
  await press('keydown', clerk);
  assert.deepEqual(state(), ['', []]);
  await press('keyup', clerk);
  assert.equal(prevented, 2);
  await press('keydown', clerk);
  assert.equal(prevented, 2, 'Space on a choice that is not chosen is left to the browser, which chooses it');

  run('openDocModal({ id: "a", category: "in", section: "health" })');
  assert.deepEqual(state(), ['health', ['health']], 'editing shows the saved choice');
  run('openDocModal({ id: "b", category: "in", section: "toString" })');
  assert.deepEqual(state(), ['', []], 'an unknown value is no choice');
  run('openDocModal()');
  assert.deepEqual(state(), ['', []], 'the next new document starts empty again');
  // the order form has no งานที่รับผิดชอบ, and choosing คำสั่ง in the document form hides it too
  run('openDocModal(null, { order: true })');
  assert.equal(elements.get('docSectionField').hidden, true);
  run('openDocModal()');
  const choose = (id) => { elements.get('docCategory').value = id; return elements.get('docCategory').fire('change'); };
  await choose('order');
  assert.equal(elements.get('docSectionField').hidden, true);
  await choose('in');
  assert.equal(elements.get('docSectionField').hidden, false);
});

test('งานที่รับผิดชอบ is written only when chosen, or as "" to clear one; orders never keep one', async () => {
  const save = async (existing, change = () => {}) => {
    const app = setup({ authMode: 'ready' });
    app.context.existing = existing;
    app.run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions();
      allDocuments = existing ? [existing] : []; openDocModal(existing)`);
    await change(app);
    const saving = app.elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return app.writes[0];
  };
  const choose = (app, id) => { app.elements.get('docCategory').value = id; return app.elements.get('docCategory').fire('change'); };
  assert.equal('section' in await save(null), false, 'none chosen: not written, so saving still works under rules that predate the field');
  assert.equal((await save(null, (app) => app.pickSection('finance'))).section, 'finance');
  const kept = { id: 'd1', title: 'หนังสือเดิม', category: 'in', section: 'health' };
  assert.equal((await save(kept)).section, 'health', 'kept when something else is edited');
  assert.equal((await save(kept, (app) => app.pickSection('health'))).section, '', 'pressed again, the stored one is cleared');
  assert.equal((await save(kept, (app) => app.pickSection('palat'))).section, 'palat');
  assert.equal((await save(kept, (app) => choose(app, 'order'))).section, '', 'moved to คำสั่ง, its section goes');
  assert.equal('section' in await save(null, async (app) => { await app.pickSection('finance'); await choose(app, 'order'); }), false,
    'a new order saves none, even after a choice was made in the document form');
  assert.equal('section' in await save({ id: 'o1', title: 'คำสั่งเดิม', category: 'order' }), false, 'orders are written as before');
});

test('the documents page has a งานที่รับผิดชอบ column (not in the คำสั่ง box) and filter, and finds and sorts by it', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "out", name: "หนังสือส่ง" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions();
    allDocuments = [
      { id: "a", category: "in", docNumber: "ที่ 1", section: "policy-planning", createdAtMs: 6 },
      { id: "b", category: "in", docNumber: "ที่ 2", section: "palat", createdAtMs: 5 },
      { id: "c", category: "in", docNumber: "ที่ 3", createdAtMs: 4 },
      { id: "d", category: "out", docNumber: "ที่ 4", section: "finance", createdAtMs: 3 },
      { id: "e", category: "order", docNumber: "12/2569", section: "finance", createdAtMs: 2 },
      { id: "f", category: "", docNumber: "ที่ 6", section: "toString", createdAtMs: 1 },
    ]; renderDocsTable()`);
  const column = () => docBoxes(elements).map((box) => [box.title, box.heads.at(-1), box.rows.map((row) => row['งานที่รับผิดชอบ'] ?? null)]);
  assert.deepEqual(column(), [
    ['หนังสือรับ', 'งานที่รับผิดชอบ', ['นักวิเคราะห์นโยบายและแผนฯ', 'สำนักปลัด', '-']],
    ['หนังสือส่ง', 'งานที่รับผิดชอบ', ['กองคลัง']],
    // orders have no such column, even one still carrying a value
    ['คำสั่ง', 'ขนาดไฟล์', [null]],
    ['ไม่ระบุหมวดหมู่', 'งานที่รับผิดชอบ', ['-']],
  ]);
  run('sortGroup("in", "section")');
  assert.deepEqual(column()[0][2], ['-', 'สำนักปลัด', 'นักวิเคราะห์นโยบายและแผนฯ'], 'in the order of the form, none first');

  const numbers = () => docBoxes(elements).map((box) => [box.title, box.rows.map((row) => row['เลขที่หนังสือ'] ?? row['เลขที่คำสั่ง'])]);
  const filter = async (value) => { elements.get('filterSection').value = value; await elements.get('filterSection').fire('change'); return numbers(); };
  assert.deepEqual(await filter('finance'), [['หนังสือส่ง', ['ที่ 4']]], 'only the boxes with a match, and no order');
  assert.deepEqual(await filter('none'), [['หนังสือรับ', ['ที่ 3']], ['ไม่ระบุหมวดหมู่', ['ที่ 6']]], 'ยังไม่ระบุงาน leaves orders out');
  assert.equal(elements.get('resultCount').textContent, 'พบ 2 จาก 6 รายการ');
  await elements.get('clearFilters').fire('click');
  assert.equal(elements.get('filterSection').value, '');
  assert.equal(numbers().length, 4);
  elements.get('globalSearch').value = 'นักวิเคราะห์';
  await elements.get('globalSearch').fire('input');
  assert.deepEqual(numbers(), [['หนังสือรับ', ['ที่ 1']]], 'the search finds the section by name');
});

test('แยกตามงานที่รับผิดชอบ lists the ten in form order, then ยังไม่ระบุงาน, leaves orders out, and a row opens its documents', async () => {
  const { run, elements } = setupDashboard();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions();
    allDocuments = [
      { id: "a", category: "in", section: "finance" }, { id: "b", category: "in", section: "finance" },
      { id: "c", category: "in", section: "policy-planning" }, { id: "d", category: "in" },
      { id: "e", category: "order", section: "finance" }, { id: "f", category: "order" },
    ]; renderSectionBreakdown()`);
  const markup = elements.get('sectionBreakdown').innerHTML;
  const rows = [...markup.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, row]) => [
    row.match(/<span class="bd-name"><span>([^<]*)<\/span>/)[1],
    row.match(/<b class="mono">(\d+)<\/b><small class="mono">(\d+)%<\/small>/).slice(1).join(' '),
    row.match(/data-show-section="([^"]*)"/)[1],
  ]);
  // four documents count (the two orders don't): กองคลัง 2, นักวิเคราะห์นโยบายและแผนฯ 1, ยังไม่ระบุงาน 1
  const counts = { finance: '2 50', 'policy-planning': '1 25' };
  assert.deepEqual(rows, [...SECTIONS.map(([key, label]) => [label, counts[key] ?? '0 0', key]), ['ยังไม่ระบุงาน', '1 25', 'none']]);
  assert.match(markup, /<button type="button" class="bd-row is-none" data-show-section="none" aria-label="ยังไม่ระบุงาน 1 ฉบับ \(25%\) กดเพื่อดูเอกสาร">/);
  assert.doesNotMatch(markup, /bd-dot/, 'sections have no colour dots');

  await elements.get('sectionBreakdown').fire('click', { target: { closest: (selector) => (selector === '[data-show-section]' ? { dataset: { showSection: 'none' } } : null) } });
  assert.deepEqual([elements.get('pageTitle').textContent, elements.get('filterSection').value, elements.get('filterCategory').value], ['เอกสารทั้งหมด', 'none', '']);
  assert.deepEqual(docBoxes(elements).map((box) => [box.title, box.tag]), [['หนังสือรับ', '1 รายการ']], 'the same count as the row');
});

test('the documents page has one box per category, in paper-workflow order, and empty ones show unless a filter narrows the list', async () => {
  const { run, elements } = setup();
  // Firestore lists categories by name; the ones staff made follow the six known ones, still by name
  run(`allCategories = ["คำร้อง", "คำสั่ง", "งานพัสดุ", "บันทึกข้อความ", "ประกาศ", "หนังสือรับ", "หนังสือส่ง", "หนังสือเวียน"].map((name) => ({ id: name, name }));
    renderCategoryOptions();
    allDocuments = [
      { id: "a", category: "หนังสือรับ", title: "หนังสือเชิญประชุม", date: "2026-09-10", createdAtMs: 4 },
      { id: "b", category: "คำสั่ง", title: "แต่งตั้งคณะกรรมการ", createdAtMs: 3 },
      { id: "c", category: "", title: "ยังไม่ได้เลือกหมวด", createdAtMs: 2 },
      { id: "d", category: "หมวดที่ถูกลบแล้ว", title: "หมวดเดิมถูกลบ", createdAtMs: 1 },
    ]; renderDocsTable()`);
  const boxes = () => docBoxes(elements).map((box) => [box.title, box.tag, box.add]);
  const filter = (id, value) => { elements.get(id).value = value; return elements.get(id).fire(id === 'globalSearch' ? 'input' : 'change'); };
  assert.deepEqual(boxes(), [
    ['หนังสือรับ', '1 รายการ', 'เพิ่มหนังสือรับ'], ['หนังสือส่ง', 'ยังไม่มีเอกสาร', 'เพิ่มหนังสือส่ง'],
    ['หนังสือเวียน', 'ยังไม่มีเอกสาร', 'เพิ่มหนังสือเวียน'], ['คำสั่ง', '1 รายการ', 'เพิ่มคำสั่ง'],
    ['บันทึกข้อความ', 'ยังไม่มีเอกสาร', 'เพิ่มบันทึกข้อความ'], ['คำร้อง', 'ยังไม่มีเอกสาร', 'เพิ่มคำร้อง'],
    ['งานพัสดุ', 'ยังไม่มีเอกสาร', 'เพิ่มงานพัสดุ'], ['ประกาศ', 'ยังไม่มีเอกสาร', 'เพิ่มประกาศ'],
    // a record of a deleted category reads as uncategorised, as the edit form shows it
    ['ไม่ระบุหมวดหมู่', '2 รายการ', null],
  ]);
  assert.equal(elements.get('docsEmpty').hidden, true);
  assert.equal(docBoxes(elements).find((box) => box.title === 'หนังสือส่ง').heads.length, 0, 'an empty box has no table');
  assert.doesNotMatch(elements.get('docGroups').innerHTML, /data-sort="category"|<th[^>]*>หมวดหมู่</, 'the box title already names the category');

  // a search or a date filter leaves only the boxes with a match
  await filter('globalSearch', 'แต่งตั้ง');
  assert.deepEqual(boxes(), [['คำสั่ง', '1 รายการ', 'เพิ่มคำสั่ง']]);
  await filter('globalSearch', '');
  await filter('filterDate', '2026-09-10');
  assert.deepEqual(boxes(), [['หนังสือรับ', '1 รายการ', 'เพิ่มหนังสือรับ']]);
  await filter('filterDate', '2020-01-01');
  assert.deepEqual(boxes(), []);
  assert.deepEqual([elements.get('docsEmpty').hidden, elements.get('docsEmptyMessage').textContent, elements.get('docsEmptyAddBtn').hidden],
    [false, 'ไม่พบเอกสารที่ตรงกับตัวกรอง', true]);

  // the category filter keeps that one box, even when it has nothing to show
  await elements.get('clearFilters').fire('click');
  await filter('filterCategory', 'หนังสือส่ง');
  assert.deepEqual(docBoxes(elements).map((box) => [box.title, box.tag, box.note]), [['หนังสือส่ง', 'ยังไม่มีเอกสาร', null]]);
  await filter('globalSearch', 'ไม่มีคำนี้');
  await filter('filterCategory', 'หนังสือรับ');
  assert.deepEqual(docBoxes(elements).map((box) => [box.title, box.tag, box.note]), [['หนังสือรับ', '0 รายการ', 'ไม่พบเอกสารที่ตรงกับตัวกรองในหมวดนี้']]);

  // nothing at all yet: the page says so and offers the first document
  run('allCategories = []; renderCategoryOptions(); allDocuments = []; resetDocFilters()');
  assert.deepEqual([docBoxes(elements).length, elements.get('docsEmpty').hidden, elements.get('docsEmptyMessage').textContent, elements.get('docsEmptyAddBtn').hidden],
    [0, false, 'ยังไม่มีเอกสารในระบบ', false]);
});

test('each box sorts and pages on its own, and a new filter takes every box back to its first page', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "out", name: "หนังสือส่ง" }]; renderCategoryOptions();
    allDocuments = Array.from({ length: 20 }, (_, i) => ({ id: "d" + i, category: i < 10 ? "in" : "out", docNumber: "ที่ " + i, createdAtMs: i }));
    renderDocsTable()`);
  const numbers = (title) => docBoxes(elements).find((box) => box.title === title).rows.map((row) => row['เลขที่หนังสือ']);
  const pager = (group) => elements.get('docGroups').innerHTML.split('<section ').find((box) => box.includes(`data-group="${group}"`))
    .match(/<nav class="pagination" aria-label="([^"]*)">[\s\S]*?aria-current="page">(\d+)</).slice(1);
  assert.deepEqual(numbers('หนังสือรับ'), ['ที่ 9', 'ที่ 8', 'ที่ 7', 'ที่ 6', 'ที่ 5', 'ที่ 4', 'ที่ 3', 'ที่ 2']);
  assert.deepEqual(pager('in'), ['หน้าของหนังสือรับ', '1']);
  run('showGroupPage("in", 2)');
  assert.deepEqual([numbers('หนังสือรับ'), pager('in')], [['ที่ 1', 'ที่ 0'], ['หน้าของหนังสือรับ', '2']]);
  assert.deepEqual([numbers('หนังสือส่ง')[0], pager('out')], ['ที่ 19', ['หน้าของหนังสือส่ง', '1']], 'the other box stays on its page');
  run('sortGroup("out", "docNumber")');
  assert.deepEqual(numbers('หนังสือส่ง'), ['ที่ 10', 'ที่ 11', 'ที่ 12', 'ที่ 13', 'ที่ 14', 'ที่ 15', 'ที่ 16', 'ที่ 17']);
  assert.deepEqual(numbers('หนังสือรับ'), ['ที่ 1', 'ที่ 0'], 'sorting one box leaves the other alone');

  elements.get('filterCategory').value = '';
  await elements.get('filterCategory').fire('change');
  assert.deepEqual([pager('in'), numbers('หนังสือรับ')[0], numbers('หนังสือส่ง')[0]], [['หน้าของหนังสือรับ', '1'], 'ที่ 9', 'ที่ 10'], 'first pages again, sort kept');
  // a page that no longer exists after records leave falls back to the last one
  run('showGroupPage("in", 2); allDocuments = allDocuments.slice(5); renderDocsTable()');
  assert.deepEqual(numbers('หนังสือรับ'), ['ที่ 9', 'ที่ 8', 'ที่ 7', 'ที่ 6', 'ที่ 5']);
});

test('a box\'s add button opens the form with its category chosen; the คำสั่ง box opens the order form', () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  const form = () => [elements.get('docModalTitle').textContent, elements.get('docCategory').value, 'locked' in elements.get('docCategory').dataset];
  run('addToCategory("in")');
  assert.deepEqual(form(), ['เพิ่มเอกสารใหม่', 'in', false], 'chosen, but it can still be changed');
  assert.deepEqual([elements.get('docReceiveField').hidden, elements.get('docAgencyLabel').textContent], [false, 'จาก'], 'เลขที่รับ is ready from the start');
  run('closeModal("docModalOverlay"); addToCategory("order")');
  assert.deepEqual(form(), ['เพิ่มคำสั่งใหม่', 'order', true]);
  run('closeModal("docModalOverlay"); openDocModal()');
  assert.deepEqual(form(), ['เพิ่มเอกสารใหม่', '', false], 'เพิ่มเอกสาร still starts without a category');
  run('addToCategory("deleted-meanwhile")');
  assert.equal(elements.get('docCategory').value, '', 'a category deleted meanwhile is not chosen');
});

test('the คำสั่ง box\'s เพิ่มคำสั่ง button opens the order form locked to คำสั่ง and saves an order without urgency', async () => {
  const app = setup({ authMode: 'ready' });
  const { run, elements } = app;
  const toasts = recordToasts(app);
  const category = elements.get('docCategory');
  run(`allCategories = [{ id: "memo", name: "บันทึกข้อความ" }, { id: "order", name: "คำสั่ง" }]; renderCategoryOptions()`);
  // the top bar no longer has its own เพิ่มคำสั่ง; the box's button is the way in
  assert.doesNotMatch(html, /id="addOrderBtn"|>\s*เพิ่มคำสั่ง\s*</);
  elements.get('docUrgency').value = 'most-urgent'; // left over from an earlier document; the order form hides it
  run('addToCategory("order")');
  assert.equal(elements.get('docModalOverlay').hidden, false);
  assert.deepEqual(formText(elements, 'docModalTitle', 'docModalSubtitle', 'docSaveBtn'), ['เพิ่มคำสั่งใหม่', 'กรอกรายละเอียดคำสั่งและแนบไฟล์ PDF', 'บันทึกคำสั่ง']);
  assert.deepEqual(formLabels(elements), ORDER_LABELS);
  assert.equal(category.value, 'order');
  assert.equal('locked' in category.dataset, true);
  assert.equal(elements.get('docUrgencyField').hidden, true);

  elements.get('docTitle').value = 'แต่งตั้งคณะกรรมการตรวจรับพัสดุ';
  elements.get('docNumber').value = '123/2569';
  elements.get('docAgency').value = 'นายก อบต.';
  const saving = elements.get('docForm').fire('submit');
  await flush();
  const [write] = app.writes;
  assert.deepEqual([write.title, write.docNumber, write.agency, write.category, write.status],
    ['แต่งตั้งคณะกรรมการตรวจรับพัสดุ', '123/2569', 'นายก อบต.', 'order', '']);
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
});

test('the order form has a พ.ศ. year beside its date, so past orders can be entered', async () => {
  const { run, elements } = setup();
  run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "memo", name: "บันทึกข้อความ" }]; renderCategoryOptions()`);
  const year = elements.get('docYear'), date = elements.get('docDate');
  const years = () => [...year.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => m[2]);
  const thisYear = new Date().getFullYear() + 543;
  run('openDocModal()');
  assert.equal(year.hidden, true, 'documents keep the plain date');
  elements.get('docCategory').value = 'order';
  await elements.get('docCategory').fire('change');
  assert.equal(year.hidden, false, 'choosing คำสั่ง in the document form shows it');

  run('openDocModal(null, { order: true })');
  assert.equal(year.hidden, false);
  assert.equal(year.value, String(thisYear), 'a new order starts in this year');
  assert.deepEqual([years()[0], years().at(-1), years().length], [`พ.ศ. ${thisYear}`, `พ.ศ. ${thisYear - 30}`, 31]);
  date.value = '2026-03-15';
  await date.fire('change');
  year.value = '2565';
  await year.fire('change');
  assert.equal(date.value, '2022-03-15', 'the day and month stay');
  date.value = '2024-02-29';
  await date.fire('change');
  assert.equal(year.value, '2567', 'a date picked in the calendar moves the year with it');
  year.value = '2566';
  await year.fire('change');
  assert.equal(date.value, '2023-02-28', '2566 has no 29 February');

  // an order older than the list still shows its own year
  run('openDocModal({ id: "o1", title: "คำสั่งเก่า", category: "order", date: "1990-05-01" })');
  assert.equal(year.value, '2533');
  assert.equal(years().at(-1), 'พ.ศ. 2533');
  // with the date cleared, a chosen year takes today's day and month
  date.value = '';
  await date.fire('change');
  assert.deepEqual([year.value, years()[0]], ['', 'ปี พ.ศ.']);
  year.value = '2560';
  await year.fire('change');
  assert.match(date.value, /^2017-\d{2}-\d{2}$/);
  assert.equal(year.value, '2560');
});

test('the order form searches saved orders, optionally in one พ.ศ. year, and Enter or Esc there never saves or closes it', async () => {
  const { run, elements, subscriptions } = setup();
  const saved = [
    { id: 'a', category: 'order', title: 'แต่งตั้งคณะกรรมการตรวจรับพัสดุ', docNumber: '12/2565', agency: 'นายก อบต.', date: '2022-03-15', status: 'completed' },
    { id: 'b', category: 'order', title: 'แต่งตั้งคณะทำงาน <b>ป้องกันภัย</b>', docNumber: '45/2565', agency: 'ปลัด อบต.', date: '2022-11-02' },
    { id: 'c', category: 'order', title: 'มอบหมายงานเวรยาม', docNumber: '3/2569', agency: 'นายก อบต.', date: '2026-01-10', status: 'toString' },
    { id: 'd', category: 'order', title: 'คำสั่งเก่ามาก', docNumber: '1/2530', date: '1987-05-01' },
    { id: 'e', category: 'memo', title: 'แต่งตั้งในบันทึกข้อความ', docNumber: 'บ 1/2565', date: '2022-03-15' },
  ];
  run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "memo", name: "บันทึกข้อความ" }]; renderCategoryOptions()`);
  run(`allDocuments = ${JSON.stringify(saved)}`);
  const lookup = elements.get('orderLookup'), search = elements.get('orderSearch'), year = elements.get('orderSearchYear');
  const results = elements.get('orderSearchResults');
  const note = () => elements.get('orderSearchNote').textContent;
  const hits = () => (results.hidden ? [] : [...results.innerHTML.matchAll(/order-hit-number mono">([^<]*)</g)].map((m) => m[1]));
  const years = () => [...year.innerHTML.matchAll(/<option value="([^"]*)">([^<]*)</g)].map((m) => m[2]);
  const type = (text) => { search.value = text; return search.fire('input'); };
  const pick = (value) => { year.value = value; return year.fire('change'); };
  const thisYear = new Date().getFullYear() + 543;

  run('openDocModal()');
  assert.equal(lookup.hidden, true, 'the document form has no order search');
  run('openDocModal(null, { order: true })');
  assert.equal(lookup.hidden, false);
  assert.deepEqual([...years().slice(0, 2), ...years().slice(-2)], ['ทุกปี', `พ.ศ. ${thisYear}`, `พ.ศ. ${thisYear - 30}`, 'พ.ศ. 2530'],
    'the years of the date picker, plus older orders');
  assert.deepEqual([year.value, hits(), note()], ['', [], 'มีคำสั่งที่บันทึกไว้แล้ว 4 รายการ พิมพ์คำค้นหรือเลือกปี พ.ศ. เพื่อดูรายการ']);

  await type('แต่งตั้ง');
  assert.deepEqual([hits(), note()], [['45/2565', '12/2565'], 'พบ 2 คำสั่ง'], 'orders only, the latest order date first');
  assert.match(results.innerHTML, /แต่งตั้งคณะทำงาน &lt;b&gt;ป้องกันภัย&lt;\/b&gt;/);
  assert.match(results.innerHTML, /<span class="order-hit-sub">นายก อบต\.<\/span>/, 'who gave the order, and no status after it');
  await pick('2569');
  assert.deepEqual([hits(), note(), results.hidden], [[], 'ไม่พบคำสั่งที่ตรงกันในปี พ.ศ. 2569', true]);
  await type('');
  assert.deepEqual([hits(), note()], [['3/2569'], 'พบ 1 คำสั่งในปี พ.ศ. 2569'], 'a year alone lists that year');
  assert.doesNotMatch(results.innerHTML, /function|native code|toString/, 'a status left on the record adds nothing');
  await pick('2565');
  await type('ปลัด');
  assert.deepEqual(hits(), ['45/2565'], 'ผู้สั่ง is searched too');

  // Enter would submit the order form, and Esc would close it and lose what was typed
  const press = async (key) => {
    const event = { key, prevented: false, stopped: false };
    await search.fire('keydown', { ...event, preventDefault() { event.prevented = true; }, stopPropagation() { event.stopped = true; } });
    return event;
  };
  assert.equal((await press('Enter')).prevented, true);
  const escape = await press('Escape');
  assert.deepEqual([escape.stopped, search.value, hits()], [true, '', ['45/2565', '12/2565']], 'Esc clears the search and keeps the chosen year');
  assert.equal((await press('Escape')).stopped, false, 'with the search empty, Esc closes the form as before');

  // an order saved meanwhile (here or on another computer) shows up while the form is open
  run('attachFirestoreListeners()');
  const later = { id: 'f', category: 'order', title: 'แต่งตั้งเพิ่มเติม', docNumber: '46/2565', date: '2022-12-01' };
  subscriptions.find((s) => s.deleted === false).receive({
    docs: [...saved, later].map((d) => ({ id: d.id, data: () => d })), metadata: { fromCache: false, hasPendingWrites: false },
  });
  assert.deepEqual(hits(), ['46/2565', '45/2565', '12/2565']);

  // the next order starts with an empty search
  run('openDocModal(null, { order: true })');
  assert.deepEqual([search.value, year.value, hits()], ['', '', []]);
});

test('editing an order opens the order form locked to คำสั่ง, and a status the order still carries is left as it was', async () => {
  const edit = async (existing) => {
    const app = setup({ authMode: 'ready' });
    const toasts = recordToasts(app);
    app.context.existing = existing;
    app.run(`allCategories = [{ id: "order", name: "คำสั่ง" }, { id: "memo", name: "บันทึกข้อความ" }]; allDocuments = [existing]; openDocModal(existing)`);
    const { elements } = app;
    const form = { title: elements.get('docModalTitle').textContent, locked: 'locked' in elements.get('docCategory').dataset };
    const saving = elements.get('docForm').fire('submit');
    await flush();
    app.complete();
    await saving;
    return { form, write: app.writes[0], toasts };
  };
  const order = { id: 'o1', title: 'คำสั่งเดิม', category: 'order', status: 'completed' };
  const saved = await edit(order);
  assert.deepEqual(saved.form, { title: 'แก้ไขคำสั่ง', locked: true });
  assert.deepEqual([saved.write.category, 'status' in saved.write], ['order', false]);
  assert.deepEqual(saved.toasts, [{ message: 'แก้ไขคำสั่งสำเร็จ', type: 'success' }]);

  const urgent = await edit({ ...order, status: 'approved', urgency: 'most-urgent' });
  assert.equal(urgent.write.urgency, '', 'orders have no urgency, so an earlier level is cleared');
  assert.equal('status' in urgent.write, false);

  // records in other categories still open the document form
  const memo = await edit({ id: 'm1', title: 'บันทึก', category: 'memo', status: 'approved' });
  assert.deepEqual(memo.form, { title: 'แก้ไขเอกสาร', locked: false });
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

test('a title with a PDF has a red PDF icon and opens the file; one without a file has a grey icon and is not a button', () => {
  const app = setup();
  app.run(`allCategories = [{ id: "in", name: "หนังสือรับ" }]; renderCategoryOptions();
    allDocuments = [
      { id: "r2", category: "in", title: "คำวินิจฉัย", description: "กองคลัง", fileName: "2373.pdf", storageKey: "${STORAGE_KEY}", createdAtMs: 3 },
      { id: "legacy", category: "in", title: "หนังสือเดิม", fileName: "<b>x</b>.pdf", fileData: "data:application/pdf;base64,JVBERi0=", urgency: "urgent", createdAtMs: 2 },
      { id: "none", category: "in", title: "ยังไม่ได้แนบไฟล์", description: "กองช่าง", fileName: "ค้างจากเดิม.pdf", createdAtMs: 1 },
    ]; renderDocsTable(); renderRecentList()`);
  const cells = [...app.elements.get('docGroups').innerHTML.matchAll(/<td class="doc-title-cell">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  assert.equal(cells.length, 3);
  // with a file: one button holding the red icon, the title and "หมายเหตุ · ชื่อไฟล์"
  assert.match(cells[0], /^<button class="doc-open" data-view-file="r2"><svg class="doc-ico is-pdf"[^>]*aria-hidden="true">[\s\S]*<text[^>]*>PDF<\/text><\/svg>/);
  assert.match(cells[0], /<span class="doc-open-title">คำวินิจฉัย<\/span><span class="doc-sub" title="กองคลัง · 2373\.pdf">กองคลัง · 2373\.pdf<\/span><\/span><\/button>$/);
  assert.match(cells[1], /data-view-file="legacy"/, 'a legacy base64 PDF opens too');
  assert.match(cells[1], /<span class="doc-open-title"><span class="urgency urgency-urgent">ด่วน<\/span>หนังสือเดิม<\/span>/);
  assert.match(cells[1], />&lt;b&gt;x&lt;\/b&gt;\.pdf<\/span>/, 'file names are escaped');
  // without a file: a grey sheet and plain text, and a leftover file name is not shown
  assert.match(cells[2], /^<div class="doc-open"><svg class="doc-ico is-none"/);
  assert.doesNotMatch(cells[2], /<button|data-view-file|PDF<\/text>|ค้างจากเดิม/);
  assert.match(cells[2], /<span class="doc-sub" title="กองช่าง">กองช่าง<\/span>/);

  // the dashboard's latest list opens a file the same way: the whole row is the button, and only when there is a file
  const rows = [...app.elements.get('recentList').innerHTML.matchAll(/<li>\s*(<(?:button|div)[^>]*>)/g)].map((m) => m[1]);
  assert.deepEqual(rows, [
    '<button type="button" class="recent-item" data-view-file="r2">',
    '<button type="button" class="recent-item" data-view-file="legacy">',
    '<div class="recent-item">',
  ]);
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
  const markup = app.elements.get('docGroups').innerHTML;
  // no PDF: the buttons are disabled instead of reporting a broken file when pressed
  assert.match(markup, /data-preview="none" title="ดูตัวอย่าง \(ไม่มีไฟล์ PDF\)" disabled>/);
  assert.match(markup, /data-download="none" title="ดาวน์โหลด \(ไม่มีไฟล์ PDF\)" disabled>/);
  for (const id of ['r2', 'legacy']) {
    assert.match(markup, new RegExp(`data-preview="${id}" title="ดูตัวอย่าง">`));
    assert.match(markup, new RegExp(`data-download="${id}" title="ดาวน์โหลด">`));
  }
  assert.ok(markup.includes('<span class="doc-open-title">-</span>'), 'a missing title shows "-" like the other columns');

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
  assert.match(elements.get('categoryGrid').innerHTML, /<b>1<\/b> เอกสาร/);
  assert.equal(toasts.length, 0);
  subscriptions[0].fail(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
  subscriptions[1].fail(Object.assign(new Error('Quota exceeded.'), { code: 'resource-exhausted' }));
  assert.deepEqual(toasts, [
    { message: 'โหลดข้อมูลล้มเหลว: ไม่มีสิทธิ์อ่านข้อมูลเอกสาร', type: 'error' },
    { message: 'โหลดข้อมูลล้มเหลว: มีการใช้งานฐานข้อมูลเกินโควตา กรุณาลองใหม่ภายหลัง', type: 'error' },
  ]);
});

test('the monthly chart covers the last 12 months by the day each record was added, not its issue date, and has a table view', async () => {
  const { run, context, elements } = setup();
  const painted = {};
  context.Chart = { defaults: { font: {} } };
  context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  context.capture = (id, type, data, options) => { painted[id] = { type, data, options }; };
  // one record this month (issued long ago), two last month, one 11 months back, one 12 months back (outside the chart)
  run(`paintChart = capture;
    const at = (monthsBack) => monthStart(-monthsBack).getTime() + 86400000;
    allDocuments = [
      { id: "a", date: "2000-01-01", createdAt: Date.now() },
      { id: "b", createdAtMs: at(1) }, { id: "c", createdAt: { seconds: at(1) / 1000 } },
      { id: "d", createdAtMs: at(11) }, { id: "e", createdAtMs: at(12) }, { id: "f" },
    ]; renderCharts()`);
  const chart = painted.chartTrend;
  assert.equal(chart.type, 'line');
  // arrays made inside the app's sandbox are copied out before comparing
  assert.deepEqual([...chart.data.datasets[0].data], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1]);
  const label = (monthsBack) => run(`monthStart(-${monthsBack}).toLocaleDateString("th-TH", { month: "short", year: "2-digit" })`);
  assert.deepEqual([chart.data.labels[0], chart.data.labels.at(-1)], [label(11), label(0)]);
  // numbers above the points: the busiest month and this month
  assert.deepEqual([...chart.options.plugins.chart3d.labels], [10, 11]);
  assert.equal(run('createdAtMillis({createdAt:{seconds:123}})'), 123000);

  // the same twelve months as a table, oldest first, with the total
  const table = elements.get('trendTable').innerHTML;
  const cells = [...table.matchAll(/<tr><td>([^<]*)<\/td><td class="mono num">(\d+)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
  const long = (monthsBack) => run(`monthStart(-${monthsBack}).toLocaleDateString("th-TH", { month: "long", year: "numeric" })`);
  assert.deepEqual([cells.length, cells[0], cells.at(-2), cells.at(-1)], [13, [long(11), '1'], [long(0), '1'], ['รวม 12 เดือน', '4']]);
  const toggle = elements.get('trendViewToggle');
  run('showTrendAsTable(false)'); // the page starts on the chart (the DOM double does not read the hidden attribute)
  assert.deepEqual([elements.get('trendChartBox').hidden, elements.get('trendTable').hidden], [false, true]);
  await toggle.fire('click');
  assert.deepEqual([elements.get('trendChartBox').hidden, elements.get('trendTable').hidden, toggle.getAttribute('aria-label')], [true, false, 'ดูแบบกราฟ']);
  assert.match(toggle.innerHTML, /<span>ดูแบบกราฟ<\/span>$/);
  await toggle.fire('click');
  assert.deepEqual([elements.get('trendChartBox').hidden, elements.get('trendTable').hidden, toggle.getAttribute('aria-label')], [false, true, 'ดูแบบตาราง']);

  // nothing in the last 12 months: no numbers above the flat line
  run('allDocuments = []; renderCharts()');
  assert.deepEqual([...painted.chartTrend.options.plugins.chart3d.labels], []);
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
  app.context.file = pdf('photo.pdf', 'JFIF not a pdf', 'image/jpeg');
  await app.run('handleFile(file)');
  assert.equal(app.run('pendingFileData'), null);
  assert.match(app.elements.get('docFormError').textContent, /ไม่ใช่ PDF/);
  assert.equal(app.uploads.length, 0);
});

test('a real PDF that a phone reports as application/octet-stream is still accepted, by its content', async () => {
  const app = setup({ authMode: 'ready' });
  for (const type of ['application/octet-stream', '']) {
    app.context.file = pdf('คำสั่ง.PDF', '%PDF-1.4\n%%EOF', type);
    await app.run('handleFile(file)');
    assert.equal(app.run('fileInvalid'), false, type || 'no type');
    assert.equal(app.run('pendingFileData.name'), 'คำสั่ง.PDF');
  }
  // the picker lists .pdf files whatever type the phone gives them
  assert.match(html, /id="docFile" accept="application\/pdf,\.pdf"/);
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
      { id: "a", title: "คำสั่งแต่งตั้ง", category: "order", date: "2026-02-01" },
      { id: "b", title: "คำสั่งย้าย", category: "order" },
      { id: "c", title: "หนังสือเวียนแจ้ง", category: "own" },
    ];
    renderCategories()`);
  const markup = app.elements.get('categoryGrid').innerHTML;
  // built-in folders can't be deleted, but they still open
  assert.deepEqual([...markup.matchAll(/data-open-cat="([^"]*)"/g)].map((m) => m[1]), ['order', 'own']);
  assert.match(markup, /<button type="button" class="cat-name" aria-label="ดูเอกสารในหมวดหมู่ คำสั่ง">คำสั่ง<\/button>/);
  for (const [id, value] of [['globalSearch', 'ย้าย'], ['filterDate', '2026-01-01']]) app.elements.get(id).value = value;
  app.run('resetDocFilters("order")');
  assert.deepEqual(['globalSearch', 'filterCategory', 'filterDate'].map((id) => app.elements.get(id).value), ['', 'order', '']);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(getFilteredDocs().map((d) => d.title))')).sort(), ['คำสั่งแต่งตั้ง', 'คำสั่งย้าย'].sort());
});
test('category cards fill three columns top to bottom, with the summary and the add card in the middle one', () => {
  const app = setup();
  const columns = () => app.elements.get('categoryGrid').innerHTML.split('<div class="cat-col">').slice(1).map((col) =>
    [...col.matchAll(/class="cat-name"[^>]*>([^<]*)<|class="(cat-summary|cat-add)"/g)].map((m) => m[1] || m[2]));
  app.run(`allCategories = ["คำร้อง", "คำสั่ง", "บันทึกข้อความ", "หนังสือรับ", "หนังสือส่ง"].map((name, i) => ({ id: "c" + i, name }));
    allDocuments = [{ id: "a", category: "c3", createdAtMs: Date.UTC(2026, 9, 1, 5) }, { id: "b", category: "c3", createdAtMs: 1, updatedAt: Date.UTC(2026, 9, 9, 5) }];
    renderCategories()`);
  assert.deepEqual(columns(), [['คำร้อง', 'คำสั่ง'], ['cat-summary', 'บันทึกข้อความ', 'cat-add'], ['หนังสือรับ', 'หนังสือส่ง']]);
  const markup = app.elements.get('categoryGrid').innerHTML;
  assert.match(markup, /<b>5<\/b><small>หมวดหมู่<\/small>[\s\S]*<b>2<\/b><small>เอกสาร<\/small>/);
  assert.match(markup, /หนังสือราชการที่รับเข้าจากหน่วยงานภายนอก<\/p>\s*<p class="cat-count"><b>2<\/b> เอกสาร/);
  // the newest edit counts, not only when the record was added
  assert.match(markup, /<span>อัปเดต 9 ต\.ค\. 2569<\/span>/);
  assert.equal((markup.match(/<span>ยังไม่มีเอกสาร<\/span>/g) || []).length, 4);
  // every card can be edited (system names stay locked inside the popup)
  assert.deepEqual([...markup.matchAll(/data-edit-cat="([^"]*)"/g)].map((m) => m[1]), ['c0', 'c1', 'c2', 'c3', 'c4']);

  for (const [n, sizes] of [[0, [0, 2, 0]], [1, [1, 2, 0]], [4, [2, 2, 2]], [6, [3, 3, 2]], [7, [3, 3, 3]], [9, [4, 4, 3]]]) {
    app.run(`allCategories = Array.from({ length: ${n} }, (_, i) => ({ id: "x" + i, name: "หมวด " + i })); renderCategories()`);
    assert.deepEqual(columns().map((col) => col.length), sizes, `${n} categories`);
  }
});
test('the category popup adds a category with a description, colour and icon, starting on the first unused colour and the folder', async () => {
  const app = setup();
  const toasts = [];
  app.context.record = (message, type) => toasts.push({ message, type });
  app.run(`showToast = record; openModal = (id) => { document.getElementById(id).hidden = false; }; closeModal = (id) => { document.getElementById(id).hidden = true; };
    allCategories = ["คำร้อง", "คำสั่ง", "บันทึกข้อความ", "หนังสือรับ", "หนังสือส่ง"].map((name, i) => ({ id: "c" + i, name }))`);
  // the pickers list the same colours and icons as the popup in the mockup, in its order
  const colors = [...app.elements.get('categoryColorPicks').innerHTML.matchAll(/data-pick-color="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(colors, ['#2A78D6', '#EB6834', '#1BAF7A', '#E09A00', '#6B5BD2', '#D55181', '#0E9AA7', '#5E6A85']);
  const icons = [...app.elements.get('categoryIconPicks').innerHTML.matchAll(/data-pick-icon="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(icons, ['chat', 'inbox', 'clipboard', 'stamp', 'send', 'folder', 'building', 'tag', 'archive', 'copy']);

  app.run('openAddCategory()');
  assert.equal(app.elements.get('categoryModalTitle').textContent, 'เพิ่มหมวดหมู่');
  assert.deepEqual([app.elements.get('categoryName').value, app.elements.get('categoryName').readOnly, app.elements.get('categoryNameHint').hidden], ['', false, true]);
  // blue, orange, green, amber and purple are taken by the five main categories
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(categoryPick)')), { color: '#D55181', icon: 'folder' });

  app.elements.get('categoryName').value = ' หนังสือรับ ';
  await app.elements.get('categoryForm').fire('submit');
  assert.equal(app.writes.length, 0);
  assert.equal(toasts.pop().message, 'มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น');

  app.elements.get('categoryName').value = ' ประกาศ ';
  app.elements.get('categoryDescription').value = ' ประกาศของ อบต. ';
  app.run('pickCategoryLook({ color: "#0E9AA7" }); pickCategoryLook({ icon: "tag" })');
  const adding = app.elements.get('categoryForm').fire('submit');
  const { createdAt, ...written } = app.writes[0];
  assert.equal(typeof createdAt, 'number');
  assert.deepEqual({ ...written }, { name: 'ประกาศ', description: 'ประกาศของ อบต.', color: '#0E9AA7', icon: 'tag' });
  app.complete();
  await adding;
  assert.equal(toasts.pop().message, 'เพิ่มหมวดหมู่แล้ว');
  assert.equal(app.elements.get('categoryModalOverlay').hidden, true);

  // no description: none is written, and the card says it is one you added
  app.run('openAddCategory()');
  app.elements.get('categoryName').value = 'งานพัสดุ';
  const plain = app.elements.get('categoryForm').fire('submit');
  assert.equal('description' in app.writes[1], false);
  app.complete();
  await plain;
});
test('the saved colour, icon and description show on the card, the dashboard and the latest list', () => {
  const app = setup();
  app.run(`allCategories = [{ id: "own", name: "ประกาศ", color: "#0E9AA7", icon: "tag", description: "ประกาศของ อบต." },
      { id: "recv", name: "หนังสือรับ", color: "#5E6A85", icon: "archive" }, { id: "odd", name: "งานเก่า", color: "#123456", icon: "rocket", description: "  " }];
    allDocuments = [{ id: "a", title: "ประกาศรับสมัคร", category: "own", createdAtMs: 2 }]`);
  const look = (id) => JSON.parse(app.run(`JSON.stringify(categoryLook("${id}"))`));
  assert.deepEqual(look('own'), { color: '#0E9AA7', iconKey: 'tag', icon: app.run('CATEGORY_ICONS.tag'), desc: 'ประกาศของ อบต.' });
  // a main category keeps its default description until one is saved
  assert.deepEqual(look('recv'), { color: '#5E6A85', iconKey: 'archive', icon: app.run('CATEGORY_ICONS.archive'), desc: 'หนังสือราชการที่รับเข้าจากหน่วยงานภายนอก' });
  // values the popup can't produce fall back to the defaults (the second added category's colour)
  assert.deepEqual(look('odd'), { color: '#5E6A85', iconKey: 'folder', icon: app.run('CATEGORY_ICONS.folder'), desc: 'หมวดหมู่ที่เพิ่มเอง' });
  app.run('renderCategories(); renderRecentList(); renderCategoryBreakdown()');
  assert.match(app.elements.get('categoryGrid').innerHTML, /data-open-cat="own" style="--c:#0E9AA7">[\s\S]*?<p class="cat-desc">ประกาศของ อบต\.<\/p>/);
  assert.match(app.elements.get('recentList').innerHTML, /<span class="recent-ico" style="--c:#0E9AA7"[^>]*><svg viewBox="0 0 24 24"><path d="M3 4a1 1 0 0 1 1-1h7\.6/);
  assert.match(app.elements.get('categoryBreakdown').innerHTML, /<i class="bd-dot" style="--c:#5E6A85"><\/i><span>หนังสือรับ<\/span>/);
});
test('editing a category writes only what changed; a main category keeps its name but can change the rest', async () => {
  const app = setup();
  const toasts = [];
  app.context.record = (message, type) => toasts.push({ message, type });
  app.run(`showToast = record; openModal = (id) => { document.getElementById(id).hidden = false; }; closeModal = (id) => { document.getElementById(id).hidden = true; };
    allCategories = [{ id: "recv", name: "หนังสือรับ" }, { id: "own", name: "งานพัสดุ", color: "#D55181", icon: "folder" }, { id: "other", name: "งานคลัง" }]`);
  const submit = async () => {
    const saving = app.elements.get('categoryForm').fire('submit');
    if (app.writes.length) app.complete();
    await saving;
  };

  app.run('openEditCategory("recv")');
  assert.equal(app.elements.get('categoryModalTitle').textContent, 'แก้ไขหมวดหมู่');
  assert.deepEqual([app.elements.get('categoryName').value, app.elements.get('categoryName').readOnly, app.elements.get('categoryNameHint').hidden], ['หนังสือรับ', true, false]);
  assert.equal(app.elements.get('categoryDescription').value, 'หนังสือราชการที่รับเข้าจากหน่วยงานภายนอก');
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(categoryPick)')), { color: '#2A78D6', icon: 'inbox' });
  // saved untouched: nothing is written, so the defaults keep applying
  await submit();
  assert.equal(app.writes.length, 0);
  assert.equal(app.elements.get('categoryModalOverlay').hidden, true);

  app.run('openEditCategory("recv")');
  app.run('pickCategoryLook({ icon: "archive" })');
  await submit();
  assert.deepEqual(JSON.parse(JSON.stringify(app.writes)), [{ icon: 'archive' }]);
  assert.equal(toasts.pop().message, 'บันทึกหมวดหมู่แล้ว');

  app.run('openEditCategory("own")');
  assert.deepEqual([app.elements.get('categoryName').readOnly, app.elements.get('categoryNameHint').hidden], [false, true]);
  assert.equal(app.elements.get('categoryDescription').value, 'หมวดหมู่ที่เพิ่มเอง');
  app.elements.get('categoryName').value = ' งานคลัง ';
  await submit();
  assert.equal(app.writes.length, 1);
  assert.equal(toasts.pop().message, 'มีหมวดหมู่นี้แล้ว กรุณาใช้ชื่ออื่น');

  app.elements.get('categoryName').value = ' งานพัสดุและครุภัณฑ์ ';
  app.elements.get('categoryDescription').value = 'จัดซื้อจัดจ้าง';
  app.run('pickCategoryLook({ color: "#5E6A85" })');
  await submit();
  assert.deepEqual(JSON.parse(JSON.stringify(app.writes[1])), { name: 'งานพัสดุและครุภัณฑ์', description: 'จัดซื้อจัดจ้าง', color: '#5E6A85' });
});
test('the category popup, CATEGORY_COLORS/CATEGORY_ICONS and firestore.rules agree on the fields and their values', () => {
  const { run } = setup();
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8').split('function validCategory')[1];
  const listed = (field) => [...rules.match(new RegExp(`data\\.${field} in \\[([^\\]]*)\\]`))[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(listed('color'), JSON.parse(run('JSON.stringify(CATEGORY_COLORS)')));
  assert.deepEqual(listed('icon'), JSON.parse(run('JSON.stringify(Object.keys(CATEGORY_ICONS))')));
  // every default look is one the popup can choose, so opening a main category shows its colour and icon picked
  for (const look of JSON.parse(run('JSON.stringify(Object.values(CATEGORY_LOOK))'))) {
    assert.ok(listed('color').includes(look.color) && listed('icon').includes(look.icon), JSON.stringify(look));
  }
  assert.match(rules.match(/hasOnly\(\[([^\]]*)\]/)[1], /'description', 'color', 'icon'/);
  assert.equal(html.match(/id="categoryDescription" maxlength="(\d+)"/)[1], rules.match(/data\.description\.size\(\) <= (\d+)/)[1]);
});

test('the status colours\' r, g, b channels come from the theme, so the 3D cards follow them', () => {
  const { run } = setup();
  for (const mode of ['light', 'dark']) {
    const vars = JSON.parse(run(`JSON.stringify(deriveVars(APPEARANCE_DEFAULTS.${mode}, ${mode === 'dark'}))`));
    for (const name of ['success', 'warning', 'danger']) {
      assert.equal(vars[`--${name}-rgb`], run(`rgbList(APPEARANCE_DEFAULTS.${mode}.${name})`), `${mode} ${name}`);
    }
  }
  // the stylesheet's own values (used before the script runs) match, and the cards read the variables
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const light = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="dark"] {'));
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  for (const [block, mode] of [[light, 'light'], [dark, 'dark']]) {
    for (const name of ['success', 'warning', 'danger']) {
      assert.equal(block.match(new RegExp(`--${name}-rgb: ([^;]+);`))[1], run(`rgbList(APPEARANCE_DEFAULTS.${mode}.${name})`), `${mode} ${name} in style.css`);
    }
  }
  assert.match(css, /\[data-tone="green"\] \{[^}]*--tone-rgb: var\(--success-rgb\)/);
});

/* การ์ดสรุปนับเลขขึ้นทีละเฟรม ในชุดทดสอบให้ทุกเฟรมจบทันที ตัวเลขจึงเป็นค่าสุดท้าย
   วันนี้ตั้งได้ (ปี, เดือนแบบ JavaScript, วัน, ชั่วโมง) ตามเวลาเครื่อง ให้การนับเดือนนี้กับเดือนก่อนไม่ขึ้นกับวันที่รันชุดทดสอบ */
function setupDashboard(...today) {
  const app = setup();
  app.context.requestAnimationFrame = (step) => { step(1e9); return 1; };
  if (today.length) {
    app.context.today = today;
    app.run(`const RealDate = Date;
      Date = class extends RealDate {
        constructor(...args) { if (args.length) super(...args); else super(...today); }
        static now() { return new RealDate(...today).getTime(); }
      }`);
  }
  return app;
}
const cardText = (elements, ...ids) => ids.map((id) => elements.get(id).textContent);
const at = (...date) => new Date(...date).getTime();

test('the summary cards count every document, those added this month against the same days of last month, the urgent ones and those with a file', () => {
  const { run, elements, context } = setupDashboard(2026, 9, 9, 15); // 9 ต.ค. 2569
  context.docs = [
    { id: 'a', createdAtMs: at(2026, 9, 9, 10), urgency: 'most-urgent', storageKey: STORAGE_KEY },
    { id: 'b', createdAtMs: at(2026, 9, 1), urgency: 'urgent' },
    { id: 'h', createdAt: { seconds: at(2026, 9, 5) / 1000 }, urgency: 'most-urgent', fileData: 'data:application/pdf;base64,JVBERi0=' },
    // last month: 1–9 ก.ย. counts, 10 ก.ย. onwards is past today's date
    { id: 'c', createdAtMs: at(2026, 8, 9, 23) }, { id: 'e', createdAtMs: at(2026, 8, 1) }, { id: 'd', createdAtMs: at(2026, 8, 10) },
    { id: 'f', createdAtMs: 1, urgency: 'toString', fileName: 'ชื่อไฟล์อย่างเดียว.pdf' },
  ];
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "out", name: "หนังสือส่ง" }, { id: "order", name: "คำสั่ง" }];
    allDocuments = docs; renderStats()`);
  assert.deepEqual(cardText(elements, 'statTotal', 'statTotalNote'), ['7', 'ใน 3 หมวดหมู่']);
  assert.equal(elements.get('statMonth').textContent, '3');
  assert.equal(elements.get('statMonthNote').innerHTML,
    '<span class="delta"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>+1</span><span>เทียบวันที่ 1–9 ก.ย.</span>');
  // ด่วน 1, ด่วนมาก 0, ด่วนที่สุด 2 on one bar; an unknown level is not urgent
  assert.equal(elements.get('statUrgent').textContent, '3');
  const urgent = elements.get('statUrgentNote').innerHTML;
  assert.match(urgent, /<span class="urg-bar" role="img" aria-label="ด่วน 1 ฉบับ, ด่วนมาก 0 ฉบับ, ด่วนที่สุด 2 ฉบับ">/);
  assert.deepEqual([...urgent.matchAll(/<i class="urg-key-([a-z-]+)" style="flex-grow:(\d+)"><\/i>/g)].map((m) => [m[1], m[2]]),
    [['urgent', '1'], ['most-urgent', '2']], 'only the levels in use take part of the bar');
  assert.match(urgent, /ด่วนมาก <b class="mono">0<\/b>/, 'the legend still names every level');
  // a file in R2 or an older base64 file counts; a file name alone does not
  assert.deepEqual(cardText(elements, 'statFiles', 'statFilesNote'), ['29', '2 จาก 7 ฉบับ']);
  assert.equal(elements.get('meterFiles').style.width, '29%');
  assert.equal(elements.get('meterFiles').classList.contains('is-empty'), false);
});

test('this month is compared with the same days of a shorter last month, and on the 1st with that one day', () => {
  // 31 มี.ค. 2570: กุมภาพันธ์มี 28 วัน จึงเทียบทั้งเดือน และ 1 มี.ค. นับเป็นเดือนนี้
  const march = setupDashboard(2027, 2, 31, 12);
  march.context.docs = [{ id: 'a', createdAtMs: at(2027, 1, 28, 23) }, { id: 'b', createdAtMs: at(2027, 2, 1) }];
  march.run('allDocuments = docs; renderStats()');
  assert.deepEqual([march.elements.get('statMonth').textContent, march.elements.get('statMonthNote').innerHTML], ['1', '<span>เท่ากับวันที่ 1–28 ก.พ.</span>']);
  // 1 ต.ค.: only 1 ก.ย. is compared, and fewer than then points the arrow down
  const first = setupDashboard(2026, 9, 1, 8);
  first.context.docs = [{ id: 'a', createdAtMs: at(2026, 8, 1, 10) }, { id: 'b', createdAtMs: at(2026, 8, 1, 16) }, { id: 'c', createdAtMs: at(2026, 8, 2) }];
  first.run('allDocuments = docs; renderStats()');
  assert.deepEqual([first.elements.get('statMonth').textContent, first.elements.get('statMonthNote').innerHTML],
    ['0', '<span class="delta"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>−2</span><span>เทียบวันที่ 1 ก.ย.</span>']);
});

test('the summary cards say so when nothing is urgent, an empty file meter has no glow, and shares are not rounded to 0% or 100%', () => {
  const { run, elements } = setupDashboard(2026, 9, 9, 15);
  run('allCategories = []; allDocuments = []; renderStats()');
  assert.deepEqual(cardText(elements, 'statTotal', 'statTotalNote', 'statMonth', 'statUrgent', 'statFiles', 'statFilesNote'),
    ['0', 'ใน 0 หมวดหมู่', '0', '0', '0', '0 จาก 0 ฉบับ']);
  assert.equal(elements.get('statMonthNote').innerHTML, '<span>เท่ากับวันที่ 1–9 ก.ย.</span>');
  assert.equal(elements.get('statUrgentNote').innerHTML, '<span>ไม่มีเอกสารด่วน</span>');
  assert.equal(elements.get('meterFiles').classList.contains('is-empty'), true);
  // a share is never rounded up to 100% while a file is missing, nor down to 0% while one is there
  assert.deepEqual(JSON.parse(run('JSON.stringify([sharePercent(199, 200), sharePercent(1, 1000), sharePercent(3, 3), sharePercent(0, 5), sharePercent(1, 3), sharePercent(1, 0)])')),
    [99, 1, 100, 0, 33, 0]);
  run(`allDocuments = [{ id: "a", storageKey: "${STORAGE_KEY}" }]; renderStats()`);
  assert.deepEqual([elements.get('statFiles').textContent, elements.get('meterFiles').classList.contains('is-empty')], ['100', false]);
});

test('the เอกสารทั้งหมด card opens every document, clearing the filters, so the list matches its number', async () => {
  const { run, elements } = setupDashboard();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }]; renderCategoryOptions(); allDocuments = [{ id: "a", category: "in" }, { id: "b" }]`);
  for (const [id, value] of [['globalSearch', 'ไม่มีคำนี้'], ['filterCategory', 'in'], ['filterDate', '2026-01-01']]) elements.get(id).value = value;
  await elements.get('statTotalCard').fire('click');
  assert.deepEqual(['globalSearch', 'filterCategory', 'filterDate'].map((id) => elements.get(id).value), ['', '', '']);
  assert.equal(elements.get('pageTitle').textContent, 'เอกสารทั้งหมด');
  assert.equal(elements.get('resultCount').textContent, 'พบ 2 จาก 2 รายการ');
});

test('the latest list shows the five records added last, with their category icon, number · agency and date', () => {
  const { run, elements } = setupDashboard();
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }, { id: "own", name: "งานพัสดุ" }, { id: "own2", name: "ประกาศ" }];
    allDocuments = [
      { id: "old", category: "in", title: "เก่าสุด", createdAtMs: 1 },
      { id: "a", category: "in", title: "การกันเงินงบประมาณ", docNumber: "สท0023.15/ว3221", agency: "สำนักงานท้องถิ่นอำเภอ", date: "2026-10-09", createdAtMs: 9 },
      { id: "b", category: "own", title: "<b>ตัวหนา</b>", docNumber: "", agency: "  ", createdAtMs: 8 },
      { id: "c", category: "own2", title: "ประกาศรับสมัคร", agency: "อบต.วังใหญ่", createdAtMs: 7 },
      { id: "d", category: "", title: "", createdAtMs: 6 },
      { id: "e", category: "gone", title: "หมวดถูกลบ", docNumber: "ที่ 5", createdAtMs: 5 },
    ]; renderRecentList()`);
  const markup = elements.get('recentList').innerHTML;
  const items = [...markup.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  const field = (item, cls) => item.match(new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)</span>\\s*(?:<|$)`))[1];
  assert.equal(items.length, 5, 'the oldest of six is left out');
  assert.deepEqual(items.map((item) => field(item, 'recent-title')), ['การกันเงินงบประมาณ', '&lt;b&gt;ตัวหนา&lt;/b&gt;', 'ประกาศรับสมัคร', '-', 'หมวดถูกลบ']);
  assert.deepEqual(items.map((item) => field(item, 'recent-meta')), ['สท0023.15/ว3221 · สำนักงานท้องถิ่นอำเภอ', '-', 'อบต.วังใหญ่', '-', 'ที่ 5']);
  assert.deepEqual(items.map((item) => field(item, 'recent-date')), [run('formatDate("2026-10-09")'), '-', '-', '-', '-']);
  // the icon names the category: หนังสือรับ in its own colour, staff-made folders in the next colours, none in grey
  const icons = items.map((item) => item.match(/<span class="recent-ico"([^>]*)>/)[1]);
  assert.deepEqual(icons.map((attrs) => [attrs.match(/--c:([^"]*)"/)?.[1] ?? null, attrs.match(/aria-label="([^"]*)"/)[1]]), [
    ['#2A78D6', 'หนังสือรับ'], ['#D55181', 'งานพัสดุ'], ['#5E6A85', 'ประกาศ'], [null, 'ไม่ระบุหมวดหมู่'], [null, 'ไม่ระบุหมวดหมู่'],
  ]);
  run('allDocuments = []; renderRecentList()');
  assert.equal(elements.get('recentList').innerHTML, '<li class="dash-empty">ยังไม่มีเอกสาร</li>');
});

test('แยกตามหมวดหมู่ lists every category in documents-page order with its count and share, and a row opens that category', async () => {
  const { run, elements } = setupDashboard();
  run(`allCategories = ["คำร้อง", "คำสั่ง", "งานพัสดุ", "บันทึกข้อความ", "หนังสือรับ", "หนังสือส่ง"].map((name) => ({ id: name, name }));
    renderCategoryOptions();
    allDocuments = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: "r" + i, category: "หนังสือรับ" })),
      { id: "o1", category: "คำสั่ง" }, { id: "o2", category: "คำสั่ง" }, { id: "o3", category: "คำสั่ง" },
      { id: "x", category: "" }, { id: "y", category: "หมวดที่ถูกลบแล้ว" }, { id: "p", category: "งานพัสดุ" },
    ]; renderCategoryBreakdown()`);
  const markup = elements.get('categoryBreakdown').innerHTML;
  const rows = [...markup.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(([, row]) => [
    row.match(/<span class="bd-name"><i class="bd-dot"[^>]*><\/i><span>([^<]*)<\/span>/)[1],
    row.match(/<b class="mono">(\d+)<\/b><small class="mono">(\d+)%<\/small>/).slice(1).join(' '),
    row.match(/class="bd-fill" style="width:([\d.]+)%"/)[1],
    row.match(/data-show-cat="([^"]*)"/)?.[1] ?? null,
  ]);
  assert.deepEqual(rows, [
    ['หนังสือรับ', '6 50', '100', 'หนังสือรับ'], ['หนังสือส่ง', '0 0', '0', 'หนังสือส่ง'], ['คำสั่ง', '3 25', '50', 'คำสั่ง'],
    ['บันทึกข้อความ', '0 0', '0', 'บันทึกข้อความ'], ['คำร้อง', '0 0', '0', 'คำร้อง'], ['งานพัสดุ', '1 8', '16.666666666666664', 'งานพัสดุ'],
    // records without a category (or whose category was deleted) close the list in grey, and cannot be filtered on their own
    ['ไม่ระบุหมวดหมู่', '2 17', '33.33333333333333', null],
  ]);
  assert.match(markup, /<div class="bd-row is-none">/);
  assert.match(markup, /aria-label="หนังสือรับ 6 ฉบับ \(50%\) กดเพื่อดูเอกสาร"/);

  // pressing a row opens the documents page filtered to it, the other filters cleared
  elements.get('globalSearch').value = 'ค้างไว้';
  await elements.get('categoryBreakdown').fire('click', { target: { closest: (selector) => (selector === '[data-show-cat]' ? { dataset: { showCat: 'คำสั่ง' } } : null) } });
  assert.deepEqual([elements.get('filterCategory').value, elements.get('globalSearch').value, elements.get('pageTitle').textContent], ['คำสั่ง', '', 'เอกสารทั้งหมด']);
  assert.deepEqual(docBoxes(elements).map((box) => [box.title, box.tag]), [['คำสั่ง', '3 รายการ']], 'the same count as the row');

  run('allCategories = []; allDocuments = []; renderCategoryBreakdown()');
  assert.equal(elements.get('categoryBreakdown').innerHTML, '<li class="dash-empty">ยังไม่มีหมวดหมู่</li>');
});

test('the note under a title shows its first 60 characters, and the tooltip carries the whole note and the file name', () => {
  const { run } = setup();
  const note = 'ขอความอนุเคราะห์ตรวจสอบเอกสารประกอบการเบิกจ่ายงบประมาณประจำปี พ.ศ. 2569 ภายในวันที่ 15';
  run(`allDocuments = [{ id: "a", title: "หนังสือ", description: ${JSON.stringify(note)}, fileName: "2373.pdf", storageKey: "${STORAGE_KEY}" }]`);
  const markup = run('docTitle(allDocuments[0])');
  const [, tooltip, shown] = markup.match(/<span class="doc-sub" title="([^"]*)">([^<]*)<\/span>/);
  assert.equal(tooltip, `${note} · 2373.pdf`);
  assert.equal(shown, `${note.slice(0, 60)}… · 2373.pdf`);
  assert.equal(run('hasAttachment(allDocuments[0])'), true);
  assert.equal(run('hasAttachment({ fileName: "เหลือแต่ชื่อ.pdf" })'), false, 'a file name alone is no attachment');
});

test('the menu\'s trash count turns red while the trash has something, from either list stream', () => {
  const { run, elements } = setup();
  const badge = elements.get('navCountTrash');
  const state = () => [badge.textContent, badge.classList.contains('is-alert')];
  run('allTrash = [{ id: "a" }, { id: "b" }]; renderTrash()');
  assert.deepEqual(state(), ['2', true]);
  run('allTrash = []; renderStats()');
  assert.deepEqual(state(), ['0', false]);
  run('allTrash = [{ id: "a" }]; renderStats()');
  assert.deepEqual(state(), ['1', true]);
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

test('phones on iOS before 15.4 (no Object.hasOwn or Array#at) still render and switch pages', () => {
  const { run, elements } = setup({ legacyBrowser: true });
  assert.equal(run('typeof Object.hasOwn'), 'function');
  assert.deepEqual(run('JSON.stringify([[1, 2, 3].at(-1), [1, 2, 3].at(0), [1, 2, 3].at(5)])'), '[3,1,null]');
  assert.match(run('urgencyBadge("urgent")'), /ด่วน/);
  assert.equal(run('urgencyBadge("toString")'), '', 'inherited names are still not urgency levels');
  run('openDocModal({ id: "a", urgency: "most-urgent" })');
  assert.equal(elements.get('docUrgency').value, 'most-urgent');
  // the dashboard draws its cards, list and breakdown with these too
  run(`allCategories = [{ id: "in", name: "หนังสือรับ" }]; allDocuments = [{ id: "d", category: "in", title: "ทดสอบ", urgency: "urgent", createdAtMs: 1 }]; renderAll()`);
  assert.match(elements.get('recentList').innerHTML, /<span class="urgency urgency-urgent">ด่วน<\/span>ทดสอบ/);
  assert.match(elements.get('categoryBreakdown').innerHTML, /data-show-cat="in"/);
  run('switchView("documents")');
  assert.equal(elements.get('pageTitle').textContent, 'เอกสารทั้งหมด');
});

// A custom property set straight to color-mix() is kept by browsers that do not know it, and every
// background that reads it then drops out (iOS before 16.2 showed the category folders as blank white).
test('custom properties only use color-mix() inside @supports, so older browsers keep a fallback', () => {
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const unguarded = [];
  const stack = [];
  let block = '';
  for (const ch of css) {
    if (ch === '{') { stack.push(/@supports[^{]*color-mix/.test(block)); block = ''; }
    else if (ch === '}') { stack.pop(); block = ''; }
    else if (ch === ';') {
      const m = block.match(/(--[\w-]+)\s*:\s*color-mix\(/);
      if (m && !stack.includes(true)) unguarded.push(m[1]);
      block = '';
    } else block += ch;
  }
  assert.deepEqual(unguarded, []);
});

// sunflower.js on its own: the timing rules of the game, without a page (the browser suite drives the page).
function sunflowerSandbox() {
  const storage = new Map();
  const context = vm.createContext({
    document: { querySelector: () => null },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sunflower.js'), 'utf8'), context);
  return { storage, run: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

test('the sunflower changes every 5 minutes without water, dies at 25, stops growing when dead, and pausing freezes it', () => {
  const { storage, run } = sunflowerSandbox();
  const MINUTE = 60000;

  assert.deepEqual(run('[0, 4.9, 5, 9.9, 10, 15, 20, 24.9, 25, 300].map((m) => SUNFLOWER_WILT_LABELS[sunflowerWiltStage(m)])'),
    ['สดชื่น', 'สดชื่น', 'เริ่มเฉา', 'เริ่มเฉา', 'คอตก', 'สีเริ่มเปลี่ยน', 'เหี่ยวมาก', 'เหี่ยวมาก', 'ตายแล้ว', 'ตายแล้ว']);
  assert.deepEqual(run('[0, 1.9, 2, 5, 9, 12, 13, 99].map(sunflowerGrowthLabel)'),
    ['เมล็ด', 'เมล็ด', 'ต้นอ่อน', 'กำลังโต', 'ดอกตูม', 'กำลังบาน', 'บานเต็มที่', 'บานเต็มที่']);
  assert.deepEqual(run('[[0.5, 99], [12.7, 99], [1, 3], [25, 99]].map(([dry, grown]) => sunflowerStatus({ dry, grown }))'), [
    'สดชื่น · เพิ่งรดน้ำ', 'คอตก · รดน้ำล่าสุด 12 นาทีที่แล้ว', 'ต้นอ่อน · สดชื่น · รดน้ำล่าสุด 1 นาทีที่แล้ว', 'ทานตะวันตายแล้ว กดปลูกใหม่ได้เลย',
  ]);

  // the pose changes a little at a time between the marks, and the bloomed, watered plant is the original drawing
  const pose = (dry, grown = 99) => run(`sunflowerPose(${dry}, ${grown})`);
  const look = ({ bend, neck, face, leafDroop, colour, petals }) => [bend, neck, face, leafDroop, colour, petals];
  assert.deepEqual(look(pose(4.9)), look(pose(0)), 'nothing wilts in the first 5 minutes');
  assert.deepEqual([pose(0).bend, pose(0).neck, pose(0).face, pose(0).stem, pose(0).bloom, pose(0).bud, pose(0).seed], [0, 0, 1, 47, 1, 1, 0]);
  assert.ok(pose(10).neck < pose(12.5).neck && pose(12.5).neck < pose(15).neck);
  assert.ok(pose(15).colour === 0 && pose(17.5).colour > 0, 'the colour starts to change at 15 minutes');
  assert.deepEqual([pose(24.9).dead, pose(25).dead, pose(25).innerPetals], [false, true, 0]);
  assert.deepEqual([pose(0, 0).seed, pose(0, 0).stem, pose(0, 3).sprout, pose(0, 10.5).bud > 0, pose(0, 10.5).bloomOpacity], [1, 0, 1, true, 0]);

  // a plant left 40 minutes died at 25, so it stopped growing then
  const ages = (state, now) => run(`sunflowerAges(${JSON.stringify(state)}, ${now})`);
  assert.deepEqual(ages({ on: true, plantedAt: 0, wateredAt: 0, pausedAt: null }, 40 * MINUTE), { dry: 40, grown: 25 });
  // switched off at minute 10 and on again at minute 60: still 7 minutes dry and 10 minutes grown
  const off = run(`sunflowerSwitched({ on: true, plantedAt: 0, wateredAt: ${3 * MINUTE}, pausedAt: null }, false, ${10 * MINUTE})`);
  assert.deepEqual(off, { on: false, plantedAt: 0, wateredAt: 3 * MINUTE, pausedAt: 10 * MINUTE });
  assert.deepEqual(ages(off, 500 * MINUTE), { dry: 7, grown: 10 });
  const on = run(`sunflowerSwitched(${JSON.stringify(off)}, true, ${60 * MINUTE})`);
  assert.deepEqual([on, ages(on, 60 * MINUTE)], [{ on: true, plantedAt: 50 * MINUTE, wateredAt: 53 * MINUTE, fertilizedAt: null, bitten: 0, pausedAt: null }, { dry: 7, grown: 10 }]);

  // a new device, or storage with something unreadable, starts with a bloomed plant watered now
  const fresh = { on: true, plantedAt: 1000 * MINUTE - 13 * MINUTE, wateredAt: 1000 * MINUTE, fertilizedAt: null, bitten: 0, pausedAt: null };
  assert.deepEqual(run(`sunflowerLoad(${1000 * MINUTE})`), fresh);
  storage.set('govdocs-sunflower', '{"on":true,"plantedAt":"soon"}');
  assert.deepEqual(run(`sunflowerLoad(${1000 * MINUTE})`), fresh);
  storage.set('govdocs-sunflower', JSON.stringify({ on: false, plantedAt: 5, wateredAt: 6 }));
  assert.deepEqual(run(`sunflowerLoad(${1000 * MINUTE})`), { on: false, plantedAt: 5, wateredAt: 6, fertilizedAt: null, bitten: 0, pausedAt: 1000 * MINUTE }, 'paused without a pause time: paused from now');
});

test('fertilizer makes the sunflower grow 13 minutes of growth in 1, once per planting, and only while it is still growing', () => {
  const { storage, run } = sunflowerSandbox();
  const MINUTE = 60000;
  const ages = (state, now) => run(`sunflowerAges(${JSON.stringify(state)}, ${now})`);
  const planted = { on: true, plantedAt: 0, wateredAt: 0, fertilizedAt: null, pausedAt: null };

  // fertilized at planting: fully grown after 1 minute instead of 13, and the water clock is untouched
  assert.deepEqual(ages(planted, 1 * MINUTE), { dry: 1, grown: 1 });
  assert.deepEqual(ages({ ...planted, fertilizedAt: 0 }, 1 * MINUTE), { dry: 1, grown: 13 });
  assert.deepEqual(ages({ ...planted, fertilizedAt: 0 }, 0.5 * MINUTE), { dry: 0.5, grown: 6.5 });
  // fertilized after 3 minutes of normal growth: the 3 minutes before count once, the half minute after counts 13 times
  assert.deepEqual(ages({ ...planted, fertilizedAt: 3 * MINUTE }, 3.5 * MINUTE), { dry: 3.5, grown: 9.5 });
  assert.deepEqual(ages({ ...planted, fertilizedAt: 3 * MINUTE }, 2 * MINUTE), { dry: 2, grown: 2 }, 'a clock before the fertilizer was put on adds nothing');
  // dying stops the growth, fertilized or not
  const dead = { ...planted, fertilizedAt: 0 };
  assert.deepEqual(ages(dead, 40 * MINUTE).grown, ages(dead, 25 * MINUTE).grown);

  // the game clock stops while the game is off, and putting the fertilizer on is shifted out with everything else
  const off = run(`sunflowerSwitched(${JSON.stringify({ ...planted, fertilizedAt: 2 * MINUTE })}, false, ${4 * MINUTE})`);
  assert.deepEqual(ages(off, 500 * MINUTE), ages(off, 4 * MINUTE));
  const on = run(`sunflowerSwitched(${JSON.stringify(off)}, true, ${60 * MINUTE})`);
  assert.deepEqual([on.plantedAt, on.fertilizedAt, ages(on, 60 * MINUTE)], [56 * MINUTE, 58 * MINUTE, ages(off, 4 * MINUTE)]);
  assert.equal(run(`sunflowerSwitched(${JSON.stringify({ ...off, fertilizedAt: null })}, true, ${60 * MINUTE})`).fertilizedAt, null);

  // saved with the plant; a value that is not a time means not fertilized
  storage.set('govdocs-sunflower', JSON.stringify({ on: true, plantedAt: 5, wateredAt: 6, fertilizedAt: 7 }));
  assert.equal(run(`sunflowerLoad(${1000 * MINUTE})`).fertilizedAt, 7);
  storage.set('govdocs-sunflower', JSON.stringify({ on: true, plantedAt: 5, wateredAt: 6, fertilizedAt: 'later' }));
  assert.equal(run(`sunflowerLoad(${1000 * MINUTE})`).fertilizedAt, null);

  // allowed only for a living plant that has not bloomed and has not been fertilized yet, with the reason otherwise
  const can = (state, dry, grown) => run(`[sunflowerCanFertilize(${JSON.stringify(state)}, { dry: ${dry}, grown: ${grown} }), sunflowerFertilizerHint(${JSON.stringify(state)}, { dry: ${dry}, grown: ${grown} })]`);
  assert.deepEqual(can(planted, 0, 0), [true, 'ใส่ปุ๋ย · ต้นจะโตเร็วขึ้น 13 เท่า']);
  assert.deepEqual(can(planted, 12, 12.9), [true, 'ใส่ปุ๋ย · ต้นจะโตเร็วขึ้น 13 เท่า']);
  assert.deepEqual(can(planted, 0, 13), [false, 'ทานตะวันบานเต็มที่แล้ว ไม่ต้องใส่ปุ๋ย']);
  assert.deepEqual(can({ ...planted, fertilizedAt: 0 }, 1, 2), [false, 'ใส่ปุ๋ยแล้ว ต้นกำลังโตเร็วขึ้น']);
  assert.deepEqual(can(planted, 25, 4), [false, 'ทานตะวันตายแล้ว ใส่ปุ๋ยไม่ได้']);
  assert.equal(can({ ...planted, on: false }, 0, 0)[0], false, 'switched off');
  assert.deepEqual(run('[[1, 3], [1, 99], [12.7, 6]].map(([dry, grown]) => sunflowerStatus({ dry, grown }, true))'),
    ['ต้นอ่อน · ใส่ปุ๋ยแล้ว · สดชื่น · รดน้ำล่าสุด 1 นาทีที่แล้ว', 'สดชื่น · รดน้ำล่าสุด 1 นาทีที่แล้ว', 'กำลังโต · ใส่ปุ๋ยแล้ว · คอตก · รดน้ำล่าสุด 12 นาทีที่แล้ว']);
});

test('butterflies add dryness on top of the time since watering, which brings death closer but not the watering time shown', () => {
  const { storage, run } = sunflowerSandbox();
  const MINUTE = 60000;
  const ages = (state, now) => run(`sunflowerAges(${JSON.stringify(state)}, ${now})`);
  const bitten = { on: true, plantedAt: 0, wateredAt: 0, fertilizedAt: null, bitten: 5 * MINUTE, pausedAt: null };

  assert.deepEqual(ages(bitten, 3 * MINUTE), { dry: 8, grown: 3 });
  // dead 5 minutes early, and it stopped growing then
  assert.deepEqual([ages(bitten, 19.9 * MINUTE).dry < 25, ages(bitten, 20 * MINUTE).dry, ages(bitten, 40 * MINUTE).grown], [true, 25, 20]);
  // the wilt follows the bites, the minutes since watering do not
  assert.equal(run('sunflowerStatus({ dry: 8, grown: 99 }, false, 5)'), 'เริ่มเฉา · รดน้ำล่าสุด 3 นาทีที่แล้ว');
  // kept when the game is switched off and on, and saved with the plant; anything else is no bites
  const on = run(`sunflowerSwitched(sunflowerSwitched(${JSON.stringify(bitten)}, false, ${2 * MINUTE}), true, ${60 * MINUTE})`);
  assert.deepEqual([on.bitten, ages(on, 60 * MINUTE)], [5 * MINUTE, ages(bitten, 2 * MINUTE)]);
  storage.set('govdocs-sunflower', JSON.stringify({ on: true, plantedAt: 5, wateredAt: 6, bitten: 700 }));
  assert.equal(run(`sunflowerLoad(${1000 * MINUTE})`).bitten, 700);
  for (const value of ['"lots"', '-3', 'null']) {
    storage.set('govdocs-sunflower', `{"on":true,"plantedAt":5,"wateredAt":6,"bitten":${value}}`);
    assert.equal(run(`sunflowerLoad(${1000 * MINUTE})`).bitten, 0, value);
  }
});

test('index.html loads sunflower.js after script.js, and the browser suite serves it', () => {
  assert.match(html, /<script src="script\.js"><\/script>\s*<script src="sunflower\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(__dirname, 'browser.test.cjs'), 'utf8'), /'\/sunflower\.js': 'sunflower\.js'/);
});
