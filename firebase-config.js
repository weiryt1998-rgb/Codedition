const firebaseConfig = {
  apiKey: "AIzaSyD_tsHLCUssvoFAL-jOuSZHhmxl4Z9KDwM",
  authDomain: "project2-ff906.firebaseapp.com",
  projectId: "project2-ff906",
  storageBucket: "project2-ff906.firebasestorage.app",
  messagingSenderId: "319198063949",
  appId: "1:319198063949:web:99e308e2c0e899022a9b04"
};

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
