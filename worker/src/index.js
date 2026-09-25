/* Cloudflare Worker: ตัวกลางระหว่างเว็บระบบจัดเก็บเอกสารกับ Cloudflare R2 (เก็บไฟล์ PDF)
 *
 * - ไม่มี secret ในโค้ดหรือใน config: เข้าถึง R2 ผ่าน R2 binding (env.PDF_BUCKET)
 * - ทุก request ต้องแนบ Firebase ID token; ตรวจลายเซ็นด้วย public key ของ Google
 *   และตรวจ aud/iss ว่าออกให้โปรเจกต์นี้ (env.FIREBASE_PROJECT_ID) เท่านั้น
 * - ข้อมูลเอกสารอ่านจาก Firestore ด้วย ID token ของผู้ใช้คนนั้นเอง
 *   Firestore Rules จึงยังเป็นตัวตัดสินสิทธิ์ Worker ไม่มีสิทธิ์เกินกว่าผู้ใช้
 * - เว็บไม่เคยส่ง key ของไฟล์มาให้ลบตามใจ: ลบไฟล์ของเอกสารได้เฉพาะเอกสารในถังขยะ
 *   (Worker อ่าน storageKey จาก Firestore เอง) และลบ key ตรง ๆ ได้เฉพาะไฟล์ที่ไม่มีเอกสารใดอ้างถึง
 *
 * Endpoints
 *   POST   /api/files                    อัปโหลด PDF (body = ไฟล์ดิบ, Content-Type: application/pdf) → { storageKey, size }
 *   GET    /api/documents/:docId/file    ส่งไฟล์ PDF ของเอกสาร
 *   DELETE /api/documents/:docId/file    ลบไฟล์ของเอกสารที่อยู่ในถังขยะ (เว็บลบข้อมูลใน Firestore ต่อเอง)
 *   DELETE /api/files/:storageKey        ลบไฟล์ที่ไม่มีเอกสารใดอ้างถึง (อัปโหลดแล้วบันทึกไม่สำเร็จ / ไฟล์เดิมที่ถูกแทนที่)
 */

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDF_MIME = "application/pdf";
const STORAGE_KEY = /^documents\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[a-z0-9-]{4,40}$/;
const GOOGLE_KEYS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_SECONDS = 60;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return json(403, { error: "origin-not-allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      response = err instanceof HttpError ? json(err.status, { error: err.code }) : json(500, { error: "internal-error" });
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },
};

/* ไม่มี Origin = ไม่ได้เรียกจากเบราว์เซอร์ (เช่น curl) ยังต้องมี token อยู่ดี
   มี Origin = ต้องอยู่ใน ALLOWED_ORIGINS เท่านั้น */
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return {};
  // เทียบแบบไม่สนตัวพิมพ์และ "/" ท้าย กันค่าใน config พิมพ์ต่างจาก Origin ที่เบราว์เซอร์ส่งมาเล็กน้อย
  const normalize = (value) => value.trim().replace(/\/+$/, "").toLowerCase();
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(normalize).filter(Boolean);
  if (!allowed.includes(normalize(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Content-Disposition",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function route(request, env) {
  if (!PROJECT_ID.test(String(env.FIREBASE_PROJECT_ID || "")) || !env.PDF_BUCKET) {
    throw new HttpError(500, "worker-not-configured");
  }
  let segments;
  try {
    segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(400, "bad-path");
  }
  const [api, resource, ...rest] = segments;
  if (api !== "api" || !["files", "documents"].includes(resource)) throw new HttpError(404, "not-found");

  const user = await verifyFirebaseToken(request, env);
  const { method } = request;

  if (resource === "files" && rest.length === 0) {
    if (method === "POST") return uploadPdf(request, env, user);
  } else if (resource === "files") {
    if (method === "DELETE") return discardUnusedPdf(env, user, rest.join("/"));
  } else if (rest.length === 2 && rest[1] === "file") {
    const docId = rest[0];
    if (!DOC_ID.test(docId)) throw new HttpError(400, "bad-document-id");
    if (method === "GET") return sendDocumentPdf(env, user, docId);
    if (method === "DELETE") return deleteDocumentPdf(env, user, docId);
  } else {
    throw new HttpError(404, "not-found");
  }
  throw new HttpError(405, "method-not-allowed");
}

/* =========================================================
   Firebase ID token
   ========================================================= */
let googleKeys = { keys: new Map(), expires: 0, fetchedAt: 0 };

async function refreshGoogleKeys() {
  let res;
  try {
    res = await fetch(GOOGLE_KEYS_URL);
  } catch {
    throw new HttpError(503, "auth-keys-unavailable");
  }
  if (!res.ok) throw new HttpError(503, "auth-keys-unavailable");
  const { keys = [] } = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1]) || 3600;
  const imported = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    imported.set(jwk.kid, await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  googleKeys = { keys: imported, expires: Date.now() + maxAge * 1000, fetchedAt: Date.now() };
}

async function googleKey(kid) {
  const expired = Date.now() >= googleKeys.expires;
  // kid ที่ไม่รู้จักอาจเป็นกุญแจที่ Google เพิ่งหมุนเวียน แต่ไม่ดึงใหม่ถี่กว่านาทีละครั้ง
  const unknownKid = !googleKeys.keys.has(kid) && Date.now() - googleKeys.fetchedAt > 60_000;
  if (expired || unknownKid) await refreshGoogleKeys();
  return googleKeys.keys.get(kid);
}

function base64UrlBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function verifyFirebaseToken(request, env) {
  const invalid = new HttpError(401, "invalid-token");
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(request.headers.get("Authorization") || "");
  if (!match) throw new HttpError(401, "missing-token");
  const token = match[1];
  const [headerPart, payloadPart, signaturePart] = token.split(".");

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlBytes(headerPart)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(payloadPart)));
  } catch {
    throw invalid;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)
    || !payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid;
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw invalid;

  const key = await googleKey(header.kid);
  if (!key) throw invalid;
  let signatureOk = false;
  try {
    signatureOk = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, base64UrlBytes(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  } catch {
    throw invalid;
  }
  if (!signatureOk) throw invalid;

  const project = env.FIREBASE_PROJECT_ID;
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== project || payload.iss !== `https://securetoken.google.com/${project}`) throw invalid;
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 128) throw invalid;
  if (!(payload.iat <= now + CLOCK_SKEW_SECONDS)) throw invalid;
  if (payload.auth_time !== undefined && !(payload.auth_time <= now + CLOCK_SKEW_SECONDS)) throw invalid;
  if (!(payload.exp > now - CLOCK_SKEW_SECONDS)) throw new HttpError(401, "token-expired");

  // uid มาจาก token ที่ตรวจแล้วเท่านั้น ไม่เชื่อค่าที่เว็บส่งมาเอง
  return { uid: payload.sub, token };
}

/* =========================================================
   Firestore (REST, ใช้ ID token ของผู้ใช้ → Firestore Rules บังคับใช้ตามปกติ)
   ========================================================= */
async function firestoreRequest(env, user, path, init = {}) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    });
  } catch {
    throw new HttpError(502, "firestore-unavailable");
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(403, "forbidden");
  return res;
}

async function readDocument(env, user, docId) {
  const res = await firestoreRequest(env, user, `/documents/${docId}`);
  if (res.status === 404) throw new HttpError(404, "document-not-found");
  if (!res.ok) throw new HttpError(502, "firestore-error");
  const { fields = {} } = await res.json();
  return {
    storageKey: fields.storageKey?.stringValue ?? null,
    fileName: fields.fileName?.stringValue ?? "",
    deleted: fields.deleted?.booleanValue === true,
  };
}

/* id ของเอกสารที่อ้างถึงไฟล์นี้ (นับทั้งเอกสารปกติและในถังขยะ) */
async function documentsUsing(env, user, storageKey, limit) {
  const res = await firestoreRequest(env, user, ":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "documents" }],
        where: { fieldFilter: { field: { fieldPath: "storageKey" }, op: "EQUAL", value: { stringValue: storageKey } } },
        limit,
      },
    }),
  });
  if (!res.ok) throw new HttpError(502, "firestore-error");
  const rows = await res.json();
  return rows.filter((row) => row.document).map((row) => row.document.name.split("/").pop());
}

/* =========================================================
   R2
   ========================================================= */
async function readPdfBody(request) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_PDF_BYTES) throw new HttpError(413, "file-too-large");
  if (!request.body) throw new HttpError(400, "empty-file");
  // นับขนาดระหว่างอ่านด้วย ไม่เชื่อ Content-Length อย่างเดียว
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "file-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function uploadPdf(request, env, user) {
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== PDF_MIME) throw new HttpError(415, "not-pdf");
  const bytes = await readPdfBody(request);
  if (bytes.byteLength === 0) throw new HttpError(400, "empty-file");
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new HttpError(415, "not-pdf");

  // key สร้างที่นี่ทั้งหมด ไม่ใช้ชื่อไฟล์ของผู้ใช้ (ชื่อเดิมเก็บใน Firestore ช่อง fileName)
  const storageKey = `documents/${new Date().getUTCFullYear()}/${crypto.randomUUID()}.pdf`;
  try {
    await env.PDF_BUCKET.put(storageKey, bytes, {
      httpMetadata: { contentType: PDF_MIME },
      customMetadata: { uploadedBy: user.uid },
    });
  } catch (err) {
    console.error("R2 put failed", err);
    throw new HttpError(502, "storage-error");
  }
  return json(201, { storageKey, size: bytes.byteLength });
}

function contentDisposition(fileName) {
  const name = fileName || "document.pdf";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename*=UTF-8''${encoded}`;
}

async function sendDocumentPdf(env, user, docId) {
  const doc = await readDocument(env, user, docId);
  if (!doc.storageKey) throw new HttpError(404, "no-stored-file");
  if (!STORAGE_KEY.test(doc.storageKey)) throw new HttpError(422, "invalid-storage-key");
  let object;
  try {
    object = await env.PDF_BUCKET.get(doc.storageKey);
  } catch (err) {
    console.error("R2 get failed", err);
    throw new HttpError(502, "storage-error");
  }
  if (!object) throw new HttpError(404, "file-not-found");
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": PDF_MIME,
      "Content-Length": String(object.size),
      "Content-Disposition": contentDisposition(doc.fileName),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function deleteR2Object(env, storageKey) {
  try {
    await env.PDF_BUCKET.delete(storageKey); // ไม่มี object อยู่แล้วก็ถือว่าสำเร็จ จึงกดลบซ้ำได้
  } catch (err) {
    console.error("R2 delete failed", err);
    throw new HttpError(502, "storage-error");
  }
}

async function deleteDocumentPdf(env, user, docId) {
  const doc = await readDocument(env, user, docId);
  if (!doc.deleted) throw new HttpError(409, "not-in-trash");
  if (!doc.storageKey) return json(200, { deleted: false });
  if (!STORAGE_KEY.test(doc.storageKey)) throw new HttpError(422, "invalid-storage-key");
  // ถ้ามีเอกสารอื่นอ้างไฟล์เดียวกันอยู่ ห้ามลบไฟล์ (ลบได้แค่ข้อมูลของเอกสารนี้)
  const users = await documentsUsing(env, user, doc.storageKey, 2);
  if (users.some((id) => id !== docId)) return json(200, { deleted: false });
  await deleteR2Object(env, doc.storageKey);
  return json(200, { deleted: true });
}

async function discardUnusedPdf(env, user, storageKey) {
  if (!STORAGE_KEY.test(storageKey)) throw new HttpError(400, "invalid-storage-key");
  if ((await documentsUsing(env, user, storageKey, 1)).length) throw new HttpError(409, "file-in-use");
  await deleteR2Object(env, storageKey);
  return json(200, { deleted: true });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
