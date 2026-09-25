const firebaseConfig = {
  apiKey: "AIzaSyD_tsHLCUssvoFAL-jOuSZHhmxl4Z9KDwM",
  authDomain: "project2-ff906.firebaseapp.com",
  projectId: "project2-ff906",
  storageBucket: "project2-ff906.firebasestorage.app",
  messagingSenderId: "319198063949",
  appId: "1:319198063949:web:99e308e2c0e899022a9b04"
};

// ที่อยู่ Cloudflare Worker ที่รับ/ส่งไฟล์ PDF กับ R2 (ไม่ใช่ข้อมูลลับ ห้ามใส่ key/secret ใด ๆ ที่นี่)
// กรอกหลัง deploy Worker แล้ว เช่น "https://govdocs-pdf-api.<subdomain>.workers.dev"
// เว้นว่าง = ยังแนบไฟล์ใหม่ไม่ได้ แต่เอกสารเดิมยังค้นหาและเปิดดูได้ตามปกติ
const PDF_API_URL = "";

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
