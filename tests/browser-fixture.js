// Test backend. In-memory only, so every reload starts from the same seed data.
const auth = {
  currentUser: null,
  async signInAnonymously() {
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
let fixtureId = 0;
function emitFixture() { fixtureSubscriptions.forEach((notify) => notify()); }
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
          async update(payload) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            const record = fixtureStore[name].find((d) => d.id === id);
            if (!record) throw new Error('Missing test record');
            Object.assign(record, payload);
            emitFixture();
          },
          async delete() {
            await new Promise((resolve) => setTimeout(resolve, 30));
            fixtureStore[name] = fixtureStore[name].filter((d) => d.id !== id);
            emitFixture();
          },
        };
      },
    };
    return query;
  },
};
