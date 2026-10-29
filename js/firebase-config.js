// Paste the config from Firebase console → Project settings → General →
// "Your apps" → Web app → SDK setup and configuration → Config.
//
// These values are NOT secrets — every Firebase web app ships them to the
// browser. What keeps your data private is the Firestore security rule in
// firestore.rules, so make sure you publish that.
export const firebaseConfig = {
  apiKey: 'PASTE_API_KEY_HERE',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.firebasestorage.app',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000000000'
};
