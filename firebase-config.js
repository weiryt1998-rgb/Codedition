const firebaseConfig = {
  apiKey: "AIzaSyD_tsHLCUssvoFAL-jOuSZHhmxl4Z9KDwM",
  authDomain: "project2-ff906.firebaseapp.com",
  projectId: "project2-ff906",
  storageBucket: "project2-ff906.firebasestorage.app",
  messagingSenderId: "319198063949",
  appId: "1:319198063949:web:99e308e2c0e899022a9b04"
};

// ที่อยู่ Cloudflare Worker (govdocs-pdf-api) ที่รับ/ส่งไฟล์ PDF กับ R2 bucket government-documents
// ไม่ใช่ข้อมูลลับ ห้ามใส่ key/secret ใด ๆ ที่นี่
const PDF_API_URL = "https://govdocs-pdf-api.govdocs-sukhothai.workers.dev";

let app = null;
let auth = null;
let db = null;
try {
  app = firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
} catch (error) {
  console.error("Firebase initialization failed", error);
}
