// The only file that imports Firebase. If you ever upgrade the SDK, change
// SDK_VERSION here and in sw.js.
import { firebaseConfig } from './firebase-config.js';

export const SDK_VERSION = '13.1.0';
const BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';

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
