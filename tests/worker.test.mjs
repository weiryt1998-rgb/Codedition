// Tests for the Cloudflare Worker (worker/src/index.js) in Node — no Cloudflare account needed.
// R2 and Firestore are in-memory stand-ins; Firebase ID tokens are signed with a test RSA key
// whose public half is served where the Worker expects Google's keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { MAX_PDF_BYTES } from '../worker/src/index.js';

const PROJECT = 'project2-ff906';
const ORIGIN = 'https://app.example';
const KEY_PATTERN = /^documents\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const KEY_A = 'documents/2026/123e4567-e89b-42d3-a456-426614174000.pdf';
const KEY_B = 'documents/2026/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf';

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
const { privateKey: strangerKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);

const b64url = (data) => Buffer.from(data).toString('base64url');
async function idToken(claims = {}, { key = privateKey, kid = 'test-key' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'user-1',
    iat: now - 10, exp: now + 3600, auth_time: now - 10, ...claims,
  }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

class FakeBucket {
  objects = new Map();
  failPut = false;
  async put(key, bytes, options) {
    if (this.failPut) throw new Error('R2 unavailable');
    this.objects.set(key, { bytes: new Uint8Array(bytes), options });
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { body: new Blob([object.bytes]).stream(), size: object.bytes.byteLength } : null;
  }
  async delete(key) { this.objects.delete(key); }
}

// Firestore documents by id; the Worker reads them over REST with the caller's token.
let firestoreDocs;
let firestoreDenies;
let firestoreCalls;
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')) {
    return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  }
  firestoreCalls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
  if (firestoreDenies) return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
  if (url === `${FIRESTORE}:runQuery`) {
    const key = JSON.parse(init.body).structuredQuery.where.fieldFilter.value.stringValue;
    const rows = [...firestoreDocs].filter(([, doc]) => doc.storageKey === key)
      .map(([id]) => ({ document: { name: `projects/${PROJECT}/databases/(default)/documents/documents/${id}` } }));
    return Response.json(rows.length ? rows : [{ readTime: '2026-01-01T00:00:00Z' }]);
  }
  if (url.startsWith(`${FIRESTORE}/documents/`)) {
    const doc = firestoreDocs.get(url.slice(`${FIRESTORE}/documents/`.length));
    if (!doc) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
    const fields = { fileName: { stringValue: doc.fileName }, deleted: { booleanValue: doc.deleted } };
    if (doc.storageKey) fields.storageKey = { stringValue: doc.storageKey };
    return Response.json({ name: 'x', fields });
  }
  throw new Error(`Unexpected fetch ${url}`);
};

let env;
test.beforeEach(() => {
  firestoreDocs = new Map();
  firestoreDenies = false;
  firestoreCalls = [];
  env = { FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:5500`, PDF_BUCKET: new FakeBucket() };
});

async function call(method, path, { token, body, headers = {}, origin = ORIGIN } = {}) {
  const request = new Request(`https://pdf-api.example${path}`, {
    method,
    body,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const response = await worker.fetch(request, env);
  const text = response.headers.get('Content-Type')?.startsWith('application/json') ? await response.text() : null;
  return { response, status: response.status, json: text ? JSON.parse(text) : null };
}
const pdfBytes = (size = 64) => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  return bytes;
};
const upload = async (body, extra = {}) =>
  call('POST', '/api/files', { token: await idToken(), body, headers: { 'Content-Type': 'application/pdf' }, ...extra });

test('every endpoint rejects missing, forged, foreign and expired tokens', async () => {
  const forged = await idToken({}, { key: strangerKey });
  const otherProject = await idToken({ aud: 'someone-else', iss: 'https://securetoken.google.com/someone-else' });
  const expired = await idToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
  const unknownKid = await idToken({}, { kid: 'not-a-google-key' });
  for (const [method, path] of [['POST', '/api/files'], ['GET', '/api/documents/doc-1/file'], ['DELETE', '/api/documents/doc-1/file'], ['DELETE', `/api/files/${KEY_A}`]]) {
    assert.equal((await call(method, path)).json.error, 'missing-token');
    assert.equal((await call(method, path, { token: 'not.a.jwt' })).status, 401);
    assert.equal((await call(method, path, { token: forged })).json.error, 'invalid-token');
    assert.equal((await call(method, path, { token: otherProject })).json.error, 'invalid-token');
    assert.equal((await call(method, path, { token: expired })).json.error, 'token-expired');
    assert.equal((await call(method, path, { token: unknownKid })).status, 401);
  }
  assert.equal(env.PDF_BUCKET.objects.size, 0);
  assert.equal(firestoreCalls.length, 0, 'nothing reaches Firestore without a valid token');
});

test('only listed browser origins may call the Worker', async () => {
  const blocked = await call('POST', '/api/files', { origin: 'https://evil.example', token: await idToken() });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.response.headers.get('Access-Control-Allow-Origin'), null);

  const preflight = await call('OPTIONS', '/api/files');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(preflight.response.headers.get('Access-Control-Allow-Headers'), /Authorization/);

  env.ALLOWED_ORIGINS = '';
  assert.equal((await call('OPTIONS', '/api/files')).status, 403, 'an empty list allows no browser origin');

  env.ALLOWED_ORIGINS = 'HTTPS://APP.EXAMPLE/ ';
  assert.equal((await call('OPTIONS', '/api/files')).status, 204, 'case and a trailing slash in the config do not matter');
});

test('every response to an allowed origin carries CORS headers, errors included', async () => {
  const token = await idToken();
  const responses = [
    await upload(pdfBytes()),                                         // 201
    await call('POST', '/api/files'),                                 // 401 missing token
    await call('DELETE', '/api/files/not-a-key', { token }),          // 400
    await call('GET', '/api/documents/missing/file', { token }),      // 404
    await call('PUT', '/api/files', { token }),                       // 405
  ];
  firestoreDenies = true;
  responses.push(await call('GET', '/api/documents/doc-1/file', { token })); // 403
  env.PDF_BUCKET = undefined;
  responses.push(await upload(pdfBytes()));                                 // 500
  assert.deepEqual(responses.map((r) => r.status), [201, 401, 400, 404, 405, 403, 500]);
  for (const { response } of responses) {
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, DELETE, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
    assert.equal(response.headers.get('Vary'), 'Origin');
  }
});

test('a normal PDF is stored under a generated key and never under the user file name', async () => {
  const { status, json, response } = await upload(pdfBytes());
  assert.equal(status, 201);
  assert.match(json.storageKey, KEY_PATTERN);
  assert.equal(json.storageKey.startsWith(`documents/${new Date().getUTCFullYear()}/`), true);
  assert.equal(json.size, 64);
  const stored = env.PDF_BUCKET.objects.get(json.storageKey);
  assert.equal(stored.options.httpMetadata.contentType, 'application/pdf');
  assert.equal(stored.options.customMetadata.uploadedBy, 'user-1', 'uploader comes from the verified token');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const second = await upload(pdfBytes());
  assert.notEqual(second.json.storageKey, json.storageKey);
});

test('a PDF of exactly 20 MB is accepted and anything larger is refused', async () => {
  const nearLimit = await upload(pdfBytes(MAX_PDF_BYTES));
  assert.equal(nearLimit.status, 201);
  assert.equal(nearLimit.json.size, MAX_PDF_BYTES);

  const tooBig = await upload(pdfBytes(MAX_PDF_BYTES + 1)); // size counted while streaming
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error, 'file-too-large');
  const declaredTooBig = await upload(pdfBytes(10), { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(MAX_PDF_BYTES + 1) } });
  assert.equal(declaredTooBig.status, 413);
  assert.equal(env.PDF_BUCKET.objects.size, 1);
});

test('files that are not PDF are refused even if the browser check was skipped', async () => {
  const wrongType = await call('POST', '/api/files', { token: await idToken(), body: pdfBytes(), headers: { 'Content-Type': 'text/html' } });
  assert.deepEqual([wrongType.status, wrongType.json.error], [415, 'not-pdf']);
  const disguised = await upload(new TextEncoder().encode('<script>alert(1)</script>'));
  assert.deepEqual([disguised.status, disguised.json.error], [415, 'not-pdf']);
  const empty = await upload(new Uint8Array(0));
  assert.equal(empty.status, 400);
  assert.equal(env.PDF_BUCKET.objects.size, 0);
});

test('an R2 failure is reported as a storage error', async () => {
  env.PDF_BUCKET.failPut = true;
  const { status, json } = await upload(pdfBytes());
  assert.deepEqual([status, json.error], [502, 'storage-error']);
});

test('a document PDF streams from R2 after Firestore confirms the document with the caller token', async () => {
  const token = await idToken();
  env.PDF_BUCKET.objects.set(KEY_A, { bytes: pdfBytes(100) });
  firestoreDocs.set('doc-1', { storageKey: KEY_A, fileName: "คำสั่ง (ฉบับจริง)'s.pdf", deleted: false });
  const { status, response } = await call('GET', '/api/documents/doc-1/file', { token });
  assert.equal(status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/pdf');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Content-Disposition'),
    "inline; filename*=UTF-8''%E0%B8%84%E0%B8%B3%E0%B8%AA%E0%B8%B1%E0%B9%88%E0%B8%87%20%28%E0%B8%89%E0%B8%9A%E0%B8%B1%E0%B8%9A%E0%B8%88%E0%B8%A3%E0%B8%B4%E0%B8%87%29%27s.pdf");
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  assert.deepEqual(firestoreCalls.map((c) => [c.method, c.auth]), [['GET', `Bearer ${token}`]]);
});

test('files are not served for legacy, missing, forbidden or orphaned documents', async () => {
  const token = await idToken();
  firestoreDocs.set('legacy', { fileName: 'old.pdf', deleted: false });
  firestoreDocs.set('lost', { storageKey: KEY_B, fileName: 'lost.pdf', deleted: false });
  assert.equal((await call('GET', '/api/documents/legacy/file', { token })).json.error, 'no-stored-file');
  assert.equal((await call('GET', '/api/documents/missing/file', { token })).json.error, 'document-not-found');
  assert.equal((await call('GET', '/api/documents/lost/file', { token })).json.error, 'file-not-found');
  assert.equal((await call('GET', '/api/documents/..%2Fsecret/file', { token })).status, 400);
  firestoreDenies = true;
  assert.equal((await call('GET', '/api/documents/legacy/file', { token })).status, 403);
});

test('deleting a document file needs the document in the trash and reads the key from Firestore', async () => {
  const token = await idToken();
  env.PDF_BUCKET.objects.set(KEY_A, { bytes: pdfBytes() });
  firestoreDocs.set('doc-1', { storageKey: KEY_A, fileName: 'a.pdf', deleted: false });
  const live = await call('DELETE', '/api/documents/doc-1/file', { token });
  assert.deepEqual([live.status, live.json.error], [409, 'not-in-trash']);
  assert.equal(env.PDF_BUCKET.objects.has(KEY_A), true);

  firestoreDocs.get('doc-1').deleted = true;
  const trashed = await call('DELETE', '/api/documents/doc-1/file', { token });
  assert.deepEqual([trashed.status, trashed.json.deleted], [200, true]);
  assert.equal(env.PDF_BUCKET.objects.has(KEY_A), false);
  // Retrying after a Firestore hiccup is safe: the file is already gone.
  assert.equal((await call('DELETE', '/api/documents/doc-1/file', { token })).status, 200);
});

test('a file shared by another document is kept when one of them is purged', async () => {
  const token = await idToken();
  env.PDF_BUCKET.objects.set(KEY_A, { bytes: pdfBytes() });
  firestoreDocs.set('doc-1', { storageKey: KEY_A, fileName: 'a.pdf', deleted: true });
  firestoreDocs.set('doc-2', { storageKey: KEY_A, fileName: 'a.pdf', deleted: false });
  const { status, json } = await call('DELETE', '/api/documents/doc-1/file', { token });
  assert.deepEqual([status, json.deleted], [200, false]);
  assert.equal(env.PDF_BUCKET.objects.has(KEY_A), true);
});

test('a raw key can only be deleted when no document refers to it', async () => {
  const token = await idToken();
  env.PDF_BUCKET.objects.set(KEY_A, { bytes: pdfBytes() });
  env.PDF_BUCKET.objects.set(KEY_B, { bytes: pdfBytes() });
  firestoreDocs.set('doc-1', { storageKey: KEY_A, fileName: 'a.pdf', deleted: false });
  const inUse = await call('DELETE', `/api/files/${KEY_A}`, { token });
  assert.deepEqual([inUse.status, inUse.json.error], [409, 'file-in-use']);
  assert.equal(env.PDF_BUCKET.objects.has(KEY_A), true);

  const orphan = await call('DELETE', `/api/files/${KEY_B}`, { token });
  assert.equal(orphan.status, 200);
  assert.equal(env.PDF_BUCKET.objects.has(KEY_B), false);

  for (const key of ['documents/../secret.pdf', 'other/2026/x.pdf', 'documents/2026/not-a-uuid.pdf']) {
    assert.equal((await call('DELETE', `/api/files/${key}`, { token })).status, 400);
  }
});

test('a Worker without its bucket binding or project refuses to run', async () => {
  const token = await idToken();
  env.PDF_BUCKET = undefined;
  assert.equal((await upload(pdfBytes())).json.error, 'worker-not-configured');
  env.PDF_BUCKET = new FakeBucket();
  env.FIREBASE_PROJECT_ID = '';
  assert.equal((await call('GET', '/api/documents/doc-1/file', { token })).json.error, 'worker-not-configured');
});
