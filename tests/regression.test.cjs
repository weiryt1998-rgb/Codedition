const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Minimal DOM doubles: these exercise application logic, not browser layout.
function setup({ storageThrows = false, legacyTheme = null } = {}) {
  const elements = new Map();
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
  document = {
    getElementById(id) { assert.ok(elements.has(id), `Unknown DOM id: ${id}`); return elements.get(id); },
    querySelector(selector) { return elements.get(selector.slice(1)) || new Element(); },
    querySelectorAll(selector) {
      if (selector === '.modal-overlay') return [...elements.values()].filter((el) => el.id.endsWith('Overlay'));
      if (selector === '.view') return [...elements.values()].filter((el) => el.id.startsWith('view-'));
      return [];
    },
    documentElement: new Element(), body: new Element(), activeElement: new Element('trigger'),
    createElement: () => new Element(), addEventListener() {},
  };
  const subscriptions = [];
  const writes = [];
  let completeWrite;
  const db = {
    collection(name) {
      const query = {
        where(field, operator, value) { this.deleted = value; return this; },
        orderBy() { return this; },
        onSnapshot(options, receive, fail) { subscriptions.push({ name, deleted: this.deleted, options, receive, fail }); },
        add(payload) { writes.push(payload); return new Promise((resolve) => { completeWrite = resolve; }); },
        doc() { return { update: (payload) => query.add(payload) }; },
      };
      return query;
    },
  };
  const context = vm.createContext({
    document, db, console, Blob, Uint8Array, URL, atob, btoa,
    navigator: { onLine: true },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {}, scrollTo() {} },
    localStorage: { getItem(key) { if (storageThrows) throw new Error('Storage blocked'); return key === 'govdocs-theme' ? legacyTheme : null; }, setItem() {} },
    performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout() {},
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  return { run, elements, context, subscriptions, writes, complete: () => completeWrite() };
}

function pdf(name = 'document.pdf', content = '%PDF-1.7\n%%EOF', type = 'application/pdf') {
  const bytes = new TextEncoder().encode(content);
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

test('startup survives blocked storage and unavailable Firebase', () => {
  const app = setup({ storageThrows: true });
  assert.equal(app.run('appearance.mode'), 'system');
  assert.match(app.elements.get('connText').textContent, /โหลดฐานข้อมูลไม่สำเร็จ/);
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

test('attachment storage includes trash and numeric sizes', () => {
  const { run, elements } = setup();
  run('allDocuments = [{fileSize:"1024"}]; allTrash = [{fileSize:2048}]; renderStats()');
  assert.equal(elements.get('storageText').textContent, '3 KB');
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
  context.file = { ...pdf(), size: 700 * 1024 + 1 };
  await run('handleFile(file)');
  assert.equal(run('fileInvalid'), true);
  context.file = { ...pdf(), arrayBuffer: async () => { throw new Error('Read failed'); } };
  await run('handleFile(file)');
  assert.equal(elements.get('docSaveBtn').disabled, false);
  assert.match(elements.get('docFormError').textContent, /Read failed/);
});

test('document save prevents duplicate submissions and closing during the write', async () => {
  const app = setup();
  const { run, elements, context } = app;
  run('openDocModal()');
  elements.get('docTitle').value = 'Test';
  elements.get('docNumber').value = '001';
  elements.get('docDate').value = '2026-09-10';
  context.file = pdf();
  await run('handleFile(file)');
  const saving = elements.get('docForm').fire('submit');
  await elements.get('docForm').fire('submit');
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
  const { run, subscriptions, elements } = setup();
  run('attachFirestoreListeners()');
  const snap = (docs) => ({ docs, metadata: { fromCache: false, hasPendingWrites: false } });
  subscriptions.find((s) => s.name === 'categories').receive(snap([{ id: 'cat', data: () => ({ name: 'Category' }) }]));
  subscriptions.find((s) => s.deleted === false).receive(snap([{ id: 'actual-id', data: () => ({ id: 'bad-id', title: 'Test', category: 'cat' }) }]));
  subscriptions.find((s) => s.deleted === true).receive(snap([]));
  assert.equal(run('allDocuments[0].id'), 'actual-id');
  assert.match(elements.get('categoryGrid').innerHTML, /1 เอกสาร/);
  assert.match(elements.get('connText').textContent, /เชื่อมต่อแล้ว/);
  subscriptions[0].fail(new Error('Permission denied'));
  assert.match(elements.get('connText').textContent, /โหลดข้อมูลบางส่วนไม่สำเร็จ/);
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
