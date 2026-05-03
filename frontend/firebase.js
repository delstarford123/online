import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getDatabase } from "firebase/database";

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyDmVlYzX3jdWWJw1RVbXoJYGTgGbxUKa1w",
  authDomain: "online-3db34.firebaseapp.com",
  databaseURL: "https://online-3db34-default-rtdb.firebaseio.com",
  projectId: "online-3db34",
  storageBucket: "online-3db34.firebasestorage.app",
  messagingSenderId: "205486517910",
  appId: "1:205486517910:web:f471f5051dfeeb38dbdcb7",
  measurementId: "G-03R3CX03JS"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app);

export { app, analytics, db };
