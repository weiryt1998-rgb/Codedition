// Test backend. Only the profile survives reloads, like the real shared document.
const fixtureControls = {
  authMode: 'ok', profileWriteMode: 'ok',
  ...JSON.parse(sessionStorage.getItem('fixture-controls') || '{}'),
};
function configureFixture(changes) {
  Object.assign(fixtureControls, changes);
  sessionStorage.setItem('fixture-controls', JSON.stringify(fixtureControls));
}
let releaseFixtureAuth = () => {};
const auth = {
  currentUser: null,
  async signInAnonymously() {
    if (fixtureControls.authMode === 'delayed') await new Promise((resolve) => { releaseFixtureAuth = resolve; });
    this.currentUser = { uid: 'browser-test' };
    return { user: this.currentUser };
  },
};
const fixturePdf = (() => {
  let pdf = '%PDF-1.4\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  return pdf + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
})();
const fixtureStore = {
  settings: JSON.parse(sessionStorage.getItem('fixture-profile') || '[]'),
  categories: [{ id: 'cat-a', name: 'หนังสือเข้า' }, { id: 'cat-b', name: 'หนังสือออก' }],
  documents: Array.from({ length: 12 }, (_, i) => ({
    id: `seed-${i}`, title: `เอกสารทดสอบ ${i + 1}`, docNumber: `ทดสอบ/${i + 1}`,
    category: i % 2 ? 'cat-b' : 'cat-a', agency: 'หน่วยงานทดสอบ', date: '2026-09-10',
    status: ['approved', 'pending', 'rejected'][i % 3], deleted: false,
    createdAtMs: Date.now() - i * 1000, fileName: 'sample.pdf', fileSize: fixturePdf.length,
    fileData: 'data:application/pdf;base64,' + btoa(fixturePdf),
  })),
};
const fixtureSubscriptions = [];
const fixtureProfileWriteAttempts = [];
const fixturePendingProfileWrites = [];
let fixtureId = 0;
function emitFixture() { fixtureSubscriptions.forEach((notify) => notify()); }
function releaseFixtureProfileWrites() { fixturePendingProfileWrites.splice(0).forEach((resolve) => resolve()); }
async function beforeProfileWrite(operation, payload) {
  fixtureProfileWriteAttempts.push({ operation, payload, signedIn: !!auth.currentUser });
  if (fixtureControls.profileWriteMode === 'denied') {
    throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  }
  if (fixtureControls.profileWriteMode === 'delayed') {
    await new Promise((resolve) => fixturePendingProfileWrites.push(resolve));
  }
}
function persistFixtureProfile() { sessionStorage.setItem('fixture-profile', JSON.stringify(fixtureStore.settings)); }
function subscribeFixture(notify) {
  fixtureSubscriptions.push(notify);
  queueMicrotask(notify);
  return () => { const index = fixtureSubscriptions.indexOf(notify); if (index !== -1) fixtureSubscriptions.splice(index, 1); };
}
const db = {
  collection(name) {
    let condition = null;
    const query = {
      where(field, operator, value) { condition = { field, value }; return query; },
      orderBy() { return query; },
      onSnapshot(options, callback) {
        if (typeof options === 'function') callback = options;
        const notify = () => callback({
          docs: fixtureStore[name].filter((d) => !condition || d[condition.field] === condition.value)
            .map(({ id, ...data }) => ({ id, data: () => structuredClone(data) })),
          metadata: { fromCache: false, hasPendingWrites: false },
        });
        return subscribeFixture(notify);
      },
      async add(payload) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        fixtureStore[name].push({ ...payload, id: `added-${++fixtureId}` });
        emitFixture();
      },
      doc(id) {
        return {
          onSnapshot(options, callback) {
            if (typeof options === 'function') callback = options;
            return subscribeFixture(() => {
              const record = fixtureStore[name].find((d) => d.id === id);
              callback({
                exists: !!record,
                data: () => { if (!record) return undefined; const { id: ignored, ...data } = record; return structuredClone(data); },
                metadata: { fromCache: false, hasPendingWrites: false },
              });
            });
          },
          async set(payload) {
            if (name === 'settings') await beforeProfileWrite('set', payload);
            const index = fixtureStore[name].findIndex((d) => d.id === id);
            const record = { ...structuredClone(payload), id };
            if (index === -1) fixtureStore[name].push(record);
            else fixtureStore[name][index] = record;
            if (name === 'settings') persistFixtureProfile();
            emitFixture();
          },
          async update(payload) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            const record = fixtureStore[name].find((d) => d.id === id);
            if (!record) throw new Error('Missing test record');
            Object.assign(record, payload);
            emitFixture();
          },
          async delete() {
            if (name === 'settings') await beforeProfileWrite('delete');
            await new Promise((resolve) => setTimeout(resolve, 30));
            fixtureStore[name] = fixtureStore[name].filter((d) => d.id !== id);
            if (name === 'settings') persistFixtureProfile();
            emitFixture();
          },
        };
      },
    };
    return query;
  },
};
