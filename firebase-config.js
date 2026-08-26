const firebaseConfig = {
  apiKey: "AIzaSyD_tsHLCUssvoFAL-jOuSZHhmxl4Z9KDwM",
  authDomain: "project2-ff906.firebaseapp.com",
  projectId: "project2-ff906",
  storageBucket: "project2-ff906.firebasestorage.app",
  messagingSenderId: "319198063949",
  appId: "1:319198063949:web:99e308e2c0e899022a9b04"
};

const app = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();