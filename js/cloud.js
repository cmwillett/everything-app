// The only file that imports Firebase. If you ever upgrade the SDK, change
// SDK_VERSION here and in sw.js.
import { firebaseConfig } from './firebase-config.js';

export const SDK_VERSION = '13.1.0';
const BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';

import { vapidKey } from './push-config.js';

export const configured = !!firebaseConfig.apiKey && !/^PASTE/.test(firebaseConfig.apiKey);

let api = null;

export async function connect() {
  if (api) return api;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(BASE + 'firebase-app.js'),
    import(BASE + 'firebase-auth.js'),
    import(BASE + 'firebase-firestore.js')
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // Keeps a copy on the device so the app opens and works offline, and
    // lets several open tabs share it.
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
    });
  } catch (e) {
    db = fsMod.getFirestore(app);
  }
  api = { app, auth, db, a: authMod, f: fsMod };
  return api;
}

// Push notifications for reminders. Loaded only when needed, since not every
// browser supports it (iPhone: only the Home Screen app, iOS 16.4+).
let messagingApi = null;
export async function messaging() {
  if (messagingApi) return messagingApi;
  const base = await connect();
  const m = await import(BASE + 'firebase-messaging.js');
  const supported = await m.isSupported().catch(() => false);
  if (!supported) return null;
  messagingApi = { m, messaging: m.getMessaging(base.app), vapidKey };
  return messagingApi;
}

// Admin dashboard numbers (only works for the admin account — the server checks).
export async function adminStats() {
  const base = await connect();
  const fn = await import(BASE + 'firebase-functions.js');
  const functions = fn.getFunctions(base.app, 'us-central1');
  const res = await fn.httpsCallable(functions, 'adminStats')();
  return res.data;
}
