const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Minimal DOM doubles: these exercise application logic, not browser layout.
function setup({ storageThrows = false, storageWriteThrows = false, legacyTheme = null, storageValues = {}, authMode = 'missing', databaseAvailable = true } = {}) {
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
            delete: () => { deletes.push(`${name}/${id}`); return Promise.resolve(); },
            onSnapshot(options, receive, fail) { return subscribe({ name, doc: id }, options, receive, fail); },
          };
        },
      };
      return query;
    },
  };
  const authAttempts = [];
  const auth = {
    signInAnonymously() {
      if (authMode === 'deferred') {
        return new Promise((resolve, reject) => { authAttempts.push({ resolve, reject }); });
      }
      authAttempts.push({});
      return Promise.resolve();
    },
  };
  const context = vm.createContext({
    document, db: databaseAvailable ? db : undefined,
    auth: authMode === 'missing' ? undefined : auth,
    console: { ...console, warn: (...args) => warnings.push(args) }, Blob, Uint8Array, URL, atob, btoa,
    navigator: { onLine: true },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); },
      scrollTo() {},
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageThrows || storageWriteThrows) throw new Error('Storage blocked'); storage.set(key, String(value)); },
      removeItem(key) { if (storageThrows) throw new Error('Storage blocked'); storage.delete(key); },
    },
    performance: { now: () => 0 }, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout() {},
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  return {
    run, elements, context, subscriptions, writes, deletes, storage, warnings, authAttempts,
    authenticate: (index = authAttempts.length - 1) => authAttempts[index].resolve(),
    rejectAuthentication: (error, index = authAttempts.length - 1) => authAttempts[index].reject(error),
    complete: (index = pendingWrites.length - 1) => pendingWrites[index].resolve(),
    rejectWrite: (error, index = pendingWrites.length - 1) => pendingWrites[index].reject(error),
    fireWindow: (name) => (windowEvents[name] || []).forEach((fn) => fn()),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const PHOTO_A = 'data:image/jpeg;base64,AAAA';
const PHOTO_B = 'data:image/png;base64,BBBB';
const PROFILE_KEY = 'govdocs-profile-photo';
const savedProfile = (app) => JSON.parse(app.storage.get(PROFILE_KEY));
const profileSnapshot = (photo, metadata = {}) => ({
  exists: photo !== null,
  data: () => ({ photo, updatedAt: 123 }),
  metadata: { fromCache: false, hasPendingWrites: false, ...metadata },
});

function pdf(name = 'document.pdf', content = '%PDF-1.7\n%%EOF', type = 'application/pdf') {
  const bytes = new TextEncoder().encode(content);
  return { name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer };
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
  assert.deepEqual(seed([]).map((w) => w.name), ['หนังสือคำสั่ง']);
  assert.deepEqual(seed([{ id: 'c', data: () => ({ name: ' หนังสือคำสั่ง ' }) }]), []);
});

test('profile photo only renders a real image data URL', () => {
  const { run, subscriptions, elements } = setup();
  run('attachFirestoreListeners()');
  const stream = subscriptions.find((s) => s.doc === 'profile');
  const avatar = elements.get('officerPhotoBtn');

  stream.receive({ exists: false, data: () => ({}) });
  assert.equal(avatar.classList.contains('has-photo'), false);

  stream.receive({ exists: true, data: () => ({ photo: 'javascript:alert(1)' }) });
  assert.equal(avatar.classList.contains('has-photo'), false);
  assert.equal(elements.get('officerPhoto').src, undefined);

  stream.receive({ exists: true, data: () => ({ photo: 'data:image/jpeg;base64,AAAA' }) });
  assert.equal(avatar.classList.contains('has-photo'), true);
  assert.equal(elements.get('officerPhoto').src, 'data:image/jpeg;base64,AAAA');
});

test('removing the profile photo is confirmed first and restores the default icon', async () => {
  const { subscriptions, elements, deletes } = setup({ authMode: 'ready' });
  await flush();
  const stream = subscriptions.find((s) => s.doc === 'profile');
  stream.receive({ exists: true, data: () => ({ photo: 'data:image/png;base64,AAAA' }) });
  assert.equal(elements.get('officerPhotoRemove').hidden, false);

  await elements.get('officerPhotoRemove').fire('click');
  assert.deepEqual(deletes, []); // ยังไม่ลบจนกว่าจะกดยืนยัน
  await elements.get('confirmActionBtn').fire('click');
  await flush();

  assert.deepEqual(deletes, ['settings/profile']);
  assert.equal(elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(elements.get('officerPhotoRemove').hidden, true);
});

test('profile photo upload rejects non-images and oversized files before writing', async () => {
  const { run, elements, writes, context } = setup();
  const toasts = [];
  context.record = (message) => toasts.push(message);
  run('showToast = record; attachFirestoreListeners()');
  const input = elements.get('officerPhotoInput');

  input.files = [{ type: 'application/pdf', size: 10 }];
  await input.fire('change');
  input.files = [{ type: 'image/png', size: 6 * 1024 * 1024 }];
  await input.fire('change');

  assert.deepEqual(writes, []);
  assert.equal(toasts.length, 2);
  assert.match(toasts[0], /PNG, JPG หรือ WebP/);
  assert.match(toasts[1], /ไฟล์ใหญ่เกินไป/);
  assert.equal(elements.get('officerPhotoBtn').classList.contains('is-busy'), false);
});

test('a photo saved without Firebase is visible immediately and survives reload', async () => {
  const app = setup({ databaseAvailable: false });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).pending, true);
  await flush();
  assert.deepEqual(app.writes, []);
  assert.match(app.elements.get('officerPhotoStatus').textContent, /บันทึกในเครื่องแล้ว/);

  const reloaded = setup({ databaseAvailable: false, storageValues: Object.fromEntries(app.storage) });
  assert.equal(reloaded.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(reloaded.elements.get('officerPhotoBtn').classList.contains('has-photo'), true);
  assert.equal(reloaded.elements.get('officerPhotoStatus').hidden, false);
  assert.equal(savedProfile(reloaded).pending, true);
});

test('denied cloud writes retain the local photo across failed listeners and reload', async () => {
  const app = setup({ authMode: 'ready' });
  await flush();
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  await flush();
  const denied = Object.assign(new Error('Permission denied'), { code: 'permission-denied' });
  app.rejectWrite(denied);
  await flush();
  app.subscriptions.find((s) => s.doc === 'profile').fail(denied);
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).pending, true);
  assert.match(app.elements.get('officerPhotoStatus').textContent, /บันทึกในเครื่องแล้ว.*ยังซิงก์ไม่ได้/);

  const reloaded = setup({ storageValues: Object.fromEntries(app.storage) });
  assert.equal(reloaded.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(reloaded).photo, PHOTO_A);
  assert.equal(savedProfile(reloaded).pending, true);
});

test('server snapshots cannot replace a pending selection or restore a pending removal', async () => {
  const app = setup();
  await flush();
  const stream = app.subscriptions.find((s) => s.doc === 'profile');
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  stream.receive(profileSnapshot(PHOTO_B));
  stream.receive(profileSnapshot(null));
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).photo, PHOTO_A);

  app.run('saveProfilePhoto(null)');
  stream.receive(profileSnapshot(PHOTO_A));
  await flush();
  assert.equal(app.elements.get('officerPhoto').src, undefined);
  assert.equal(app.elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(savedProfile(app).photo, null);
  assert.equal(savedProfile(app).pending, true);

  const reloaded = setup({ storageValues: Object.fromEntries(app.storage) });
  await flush();
  reloaded.subscriptions.find((s) => s.doc === 'profile').receive(profileSnapshot(PHOTO_A));
  assert.equal(reloaded.elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(savedProfile(reloaded).photo, null);
});

test('profile cloud writes wait for authentication while the local preview stays usable', async () => {
  const app = setup({ authMode: 'deferred' });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  await flush();
  assert.deepEqual(app.writes, []);
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).pending, true);

  app.authenticate();
  await flush();
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].photo, PHOTO_A);
  app.complete();
  await flush();
  assert.equal(savedProfile(app).pending, false);
  assert.equal(app.elements.get('officerPhotoStatus').hidden, true);
});

test('failed authentication leaves a locally saved photo pending without attempting a cloud write', async () => {
  const app = setup({ authMode: 'deferred' });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  app.rejectAuthentication(new Error('Authentication unavailable'));
  await flush();
  assert.deepEqual(app.writes, []);
  assert.equal(savedProfile(app).photo, PHOTO_A);
  assert.equal(savedProfile(app).pending, true);
  assert.match(app.elements.get('officerPhotoStatus').textContent, /บันทึกในเครื่องแล้ว/);
});

test('connectivity recovery retries failed authentication before syncing and replaces old listeners once', async () => {
  const app = setup({ authMode: 'deferred' });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  app.rejectAuthentication(new Error('Offline during startup'));
  await flush();
  assert.equal(app.authAttempts.length, 1);
  assert.deepEqual(app.writes, []);
  assert.equal(app.subscriptions.filter((s) => s.active).length, 4);

  app.fireWindow('online');
  app.fireWindow('online');
  await flush();
  assert.equal(app.authAttempts.length, 2);
  assert.deepEqual(app.writes, []);
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).pending, true);

  app.authenticate();
  await flush();
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].photo, PHOTO_A);
  assert.equal(app.subscriptions.length, 8);
  assert.equal(app.subscriptions.slice(0, 4).every((s) => !s.active), true);
  assert.equal(app.subscriptions.filter((s) => s.active).length, 4);

  app.complete();
  await flush();
  assert.equal(savedProfile(app).pending, false);
  assert.equal(app.elements.get('officerPhotoStatus').hidden, true);
});

test('blocked storage reports a temporary preview rather than claiming the photo was saved', async () => {
  const app = setup({ storageThrows: true, databaseAvailable: false });
  const toasts = [];
  app.context.record = (message, type) => toasts.push({ message, type });
  app.context.photo = PHOTO_A;
  app.run('showToast = record; saveProfilePhoto(photo)');
  await flush();
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(app.storage.has(PROFILE_KEY), false);
  assert.equal(app.elements.get('officerPhotoStatus').hidden, false);
  assert.match(app.elements.get('officerPhotoStatus').textContent, /แสดงชั่วคราว.*ยังบันทึกไม่ได้/);
  assert.equal(toasts.some((toast) => toast.type === 'success'), false);
});

test('storage write failures discard an older pending cache so reload cannot reupload the old photo', async () => {
  const app = setup({
    authMode: 'deferred',
    storageWriteThrows: true,
    storageValues: { [PROFILE_KEY]: JSON.stringify({ photo: PHOTO_A, updatedAt: 100, pending: true }) },
  });
  app.context.photo = PHOTO_B;
  app.run('saveProfilePhoto(photo)');
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_B);
  assert.equal(app.storage.has(PROFILE_KEY), false);
  assert.match(app.elements.get('officerPhotoStatus').textContent, /แสดงชั่วคราว.*ยังบันทึกไม่ได้/);

  app.authenticate();
  await flush();
  assert.equal(app.writes[0].photo, PHOTO_B);
  app.complete();
  await flush();
  assert.equal(app.elements.get('officerPhotoStatus').hidden, true);
  assert.equal(app.storage.has(PROFILE_KEY), false);

  const reloaded = setup({ authMode: 'ready', storageValues: Object.fromEntries(app.storage) });
  await flush();
  assert.deepEqual(reloaded.writes, []);
  reloaded.subscriptions.find((s) => s.doc === 'profile').receive(profileSnapshot(PHOTO_B));
  assert.equal(reloaded.elements.get('officerPhoto').src, PHOTO_B);
});

test('rapid photo changes serialize cloud writes and older acknowledgements preserve the newest pending photo', async () => {
  const app = setup({ authMode: 'ready' });
  const toasts = [];
  app.context.record = (message, type) => toasts.push({ message, type });
  app.context.photoA = PHOTO_A;
  app.context.photoB = PHOTO_B;
  app.run('showToast = record; saveProfilePhoto(photoA)');
  await flush();
  app.run('saveProfilePhoto(photoB)');
  await flush();
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].photo, PHOTO_A);

  app.complete(0);
  await flush();
  assert.equal(app.writes.length, 2);
  assert.equal(app.writes[1].photo, PHOTO_B);
  app.subscriptions.find((s) => s.doc === 'profile').receive(profileSnapshot(PHOTO_A));
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_B);
  assert.equal(savedProfile(app).photo, PHOTO_B);
  assert.equal(savedProfile(app).pending, true);
  assert.equal(toasts.filter((toast) => toast.type === 'success').length, 0);

  app.complete(1);
  await flush();
  assert.equal(savedProfile(app).photo, PHOTO_B);
  assert.equal(savedProfile(app).pending, false);
  assert.equal(app.elements.get('officerPhotoStatus').hidden, true);
  assert.equal(toasts.filter((toast) => toast.type === 'success').length, 1);
});

test('a removal waits for an older photo upload and remains removed when that upload completes', async () => {
  const app = setup({ authMode: 'ready' });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  await flush();
  app.run('saveProfilePhoto(null)');
  await flush();
  assert.deepEqual(app.deletes, []);
  assert.equal(app.elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(savedProfile(app).pending, true);

  app.complete();
  await flush();
  assert.deepEqual(app.deletes, ['settings/profile']);
  assert.equal(app.elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(savedProfile(app).photo, null);
  assert.equal(savedProfile(app).pending, false);
});

test('a failed upload keeps its local change and retries successfully when connectivity returns', async () => {
  const app = setup({ authMode: 'ready' });
  app.context.photo = PHOTO_A;
  app.run('saveProfilePhoto(photo)');
  await flush();
  app.rejectWrite(Object.assign(new Error('Unavailable'), { code: 'unavailable' }));
  await flush();
  assert.equal(savedProfile(app).pending, true);
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);

  app.fireWindow('online');
  await flush();
  assert.equal(app.writes.length, 2);
  assert.equal(app.writes[1].photo, PHOTO_A);
  app.complete(1);
  await flush();
  assert.equal(savedProfile(app).pending, false);
  assert.equal(app.elements.get('officerPhotoStatus').hidden, true);
});

test('cached and optimistic snapshots preserve a saved photo until a confirmed server change arrives', async () => {
  const app = setup({
    storageValues: { [PROFILE_KEY]: JSON.stringify({ photo: PHOTO_A, updatedAt: 100, pending: false }) },
  });
  await flush();
  const stream = app.subscriptions.find((s) => s.doc === 'profile');
  assert.equal(stream.options.includeMetadataChanges, true);
  stream.receive(profileSnapshot(null, { fromCache: true }));
  stream.receive(profileSnapshot(PHOTO_B, { fromCache: true }));
  stream.receive(profileSnapshot(null, { hasPendingWrites: true }));
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_A);
  assert.equal(savedProfile(app).photo, PHOTO_A);

  stream.receive(profileSnapshot(PHOTO_B));
  assert.equal(app.elements.get('officerPhoto').src, PHOTO_B);
  assert.equal(savedProfile(app).photo, PHOTO_B);
  stream.receive(profileSnapshot(null));
  assert.equal(app.elements.get('officerPhotoBtn').classList.contains('has-photo'), false);
  assert.equal(savedProfile(app).photo, null);
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
