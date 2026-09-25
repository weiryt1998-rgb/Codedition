# PDF Worker (Cloudflare Worker + R2)

ตัวกลางระหว่างหน้าเว็บกับ Cloudflare R2 สำหรับไฟล์ PDF ของระบบจัดเก็บเอกสาร

```
Browser ── metadata ──────────────────────────────► Firestore (collection "documents")
   │
   └── PDF + Firebase ID token ──► Worker ──(R2 binding)──► R2 bucket (private)
                                     │
                                     └─ อ่านเอกสารจาก Firestore ด้วย token ของผู้ใช้คนนั้น
```

- **ไม่มี secret เลย**: Worker เข้าถึง R2 ผ่าน binding (`PDF_BUCKET`) และตรวจ Firebase ID token ด้วย public key ของ Google
  ไม่ต้องสร้าง R2 Access Key / Secret Key และไม่ต้องมีไฟล์ `.env`
- bucket เป็น private: ไม่ต้องเปิด public access, r2.dev หรือ custom domain ใด ๆ
- ทุก endpoint ต้องมี `Authorization: Bearer <Firebase ID token>` ที่ออกให้โปรเจกต์ `FIREBASE_PROJECT_ID`

| Endpoint | หน้าที่ |
|---|---|
| `POST /api/files` | อัปโหลด PDF (≤ 20 MB, ตรวจ `%PDF-`) → `{ storageKey, size }` |
| `GET /api/documents/:docId/file` | ส่งไฟล์ของเอกสาร (Worker อ่าน `storageKey` จาก Firestore เอง) |
| `DELETE /api/documents/:docId/file` | ลบไฟล์ของเอกสารที่อยู่ในถังขยะเท่านั้น |
| `DELETE /api/files/:storageKey` | ลบไฟล์ที่ไม่มีเอกสารใดอ้างถึง (ไฟล์ค้างจากการบันทึกไม่สำเร็จ / ไฟล์เดิมที่ถูกแทนที่) |

Object key: `documents/<ปี ค.ศ.>/<UUID>.pdf` สร้างใน Worker ด้วย `crypto.randomUUID()` ชื่อไฟล์เดิมเก็บใน Firestore ช่อง `fileName`

## ตั้งค่าและ deploy

ต้องมี Node.js (ใช้ `npx` เรียก wrangler / firebase-tools ได้โดยไม่ต้องติดตั้งถาวร)

1. เข้าสู่ระบบ Cloudflare และเปิดใช้ R2 ใน Dashboard (R2 → เปิดใช้งาน)
   ```
   cd worker
   npx wrangler login
   ```
2. Bucket แบบ private: สร้างแล้วชื่อ `government-documents` (Standard, ปิด Public Access)
   และตั้งไว้ใน `wrangler.toml` แล้ว ตรวจว่าบัญชีที่ login เห็น bucket นี้:
   ```
   npx wrangler r2 bucket list
   ```
3. `ALLOWED_ORIGINS` ใน `worker/wrangler.toml` ตั้งเป็นโดเมนของ Firebase Hosting แล้ว
   (`https://project2-ff906.web.app`, `https://project2-ff906.firebaseapp.com`)
   ถ้าเปิดเว็บจากโดเมนอื่นด้วย ให้เพิ่มคั่นด้วย `,` แล้ว deploy Worker ใหม่
4. Deploy Worker แล้วจด URL ที่ได้ (เช่น `https://govdocs-pdf-api.<subdomain>.workers.dev`)
   ```
   npx wrangler deploy
   ```
5. ใส่ URL นั้นใน `firebase-config.js` → `const PDF_API_URL = "https://...";`
6. Deploy Firestore Rules และหน้าเว็บขึ้น Firebase Hosting พร้อมกัน
   (rules ใหม่ไม่รับการเขียน base64 แล้ว เว็บเวอร์ชันเก่าจึงเพิ่มเอกสารไม่ได้หลัง rules ใหม่ขึ้น)
   ```
   cd ..
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules,hosting
   ```
   Hosting เผยแพร่เฉพาะไฟล์หน้าเว็บ (`index.html`, `style.css`, `script.js`, `firebase-config.js`, `assets/`)
   ส่วน `tests/`, `worker/`, rules และไฟล์ที่ขึ้นต้นด้วยจุดถูกยกเว้นใน `firebase.json`

ทดสอบในเครื่อง: `npx wrangler dev` (R2 จำลองในเครื่อง) แล้วตั้ง `PDF_API_URL = "http://localhost:8787"`
และใส่ origin ของหน้าเว็บในเครื่องไว้ใน `ALLOWED_ORIGINS`

ทดสอบโค้ด (ไม่ต้องมีบัญชี Cloudflare): `node --test tests/worker.test.mjs`

## แผนย้ายเอกสารเก่า (ยังไม่ได้ทำ — รออนุมัติ)

เอกสารเก่าเก็บ PDF เป็น base64 ในช่อง `fileData` ระบบใหม่ยังเปิด/ดาวน์โหลด/ลบเอกสารเหล่านี้ได้ด้วยวิธีเดิม
จึงย้ายเมื่อไรก็ได้ ไม่เร่งด่วน

1. **สำรองก่อน**: export collection `documents` ทั้งหมด (Firebase Console → Firestore → Import/Export หรือ `gcloud firestore export`)
2. **นับจำนวน**: หาเอกสารที่มี `fileData` แต่ไม่มี `storageKey` แล้วรายงานจำนวนและขนาดรวม (dry run ไม่แก้อะไร)
3. **ย้ายทีละเอกสาร** ด้วยสคริปต์ที่ผู้ดูแลรันเอง (Firebase Admin SDK):
   1. ถอด base64 → ตรวจว่าขึ้นต้นด้วย `%PDF-` และขนาดตรงกับ `fileSize`
   2. อัปโหลดเข้า R2 ด้วย key รูปแบบเดียวกัน (`documents/<ปี>/<UUID>.pdf`)
   3. ดาวน์โหลดกลับมาเทียบ SHA-256 ให้ตรงกับต้นฉบับ
   4. ใน transaction: ถ้า `fileData` ยังเหมือนเดิม → ตั้ง `storageKey`, `mimeType`, ลบ `fileData`; ถ้าถูกแก้ระหว่างนั้น → ข้ามและลบไฟล์ใน R2 ที่เพิ่งอัปโหลด
4. **ตรวจผล**: เปิดสุ่มเอกสารที่ย้ายแล้วจากหน้าเว็บ และตรวจว่าไม่มีไฟล์ใน R2 ที่ไม่มีเอกสารอ้างถึง
5. **ย้อนกลับได้**: ข้อมูล base64 เดิมอยู่ในไฟล์สำรองจากข้อ 1

สคริปต์ย้ายต้องใช้สิทธิ์ผู้ดูแล (service account ของ Firebase และสิทธิ์เขียน R2) ซึ่งต้องเก็บไว้ในเครื่องผู้รันเท่านั้น ห้าม commit
