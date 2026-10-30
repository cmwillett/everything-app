/*
 * Data store, backed by Cloud Firestore.
 *
 * Layout:  users/{uid}/tasks/{id}, users/{uid}/notes/{id},
 *          users/{uid}/links/{id}, users/{uid}/meta/settings
 * Each person only ever sees their own users/{uid} — see firestore.rules.
 *
 * app.js talks to a local mirror that is kept up to date by live listeners.
 * Writes update the mirror straight away and go to Firestore in the
 * background, so the UI never waits on the network and keeps working
 * offline (Firestore queues the writes and sends them when it can).
 */
import { connect, configured } from './cloud.js';

const LEGACY_KEY = 'everything-app:v1';
const MAX_FIELD_LENGTH = 100000;   // rich text is stored as HTML, which is wordier
const STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done'];
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];

const TABLES = {
  tasks: { editable: ['name', 'notes', 'status', 'today', 'archived', 'steps'], booleans: ['today', 'archived'], lists: ['steps'] },
  // kind: 'note' (rich text body) or 'list' (checklist items).
  notes: { editable: ['title', 'body', 'color', 'kind', 'items'], booleans: [], lists: ['items'] },
  links: { editable: ['title', 'url', 'category', 'notes'], booleans: [] },
  // status / sentAt are written by the reminder sender (functions/index.js);
  // they're carried through but never set from the edit form.
  reminders: { editable: ['title', 'description', 'dueAtMs'], booleans: [], numbers: ['dueAtMs'], passthrough: ['status', 'sentAt'] }
};
const TABLE_NAMES = Object.keys(TABLES);

let fb = null;            // { auth, db, a: authModule, f: firestoreModule }
let uid = null;
let mirror = empty();
let settings = {};
let unsubs = [];
let changeHandler = function () {};
let errorHandler = function (e) { console.error(e); };

function empty() { return { tasks: [], notes: [], links: [], reminders: [] }; }
function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function isTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }
function assertTable(t) { if (!TABLES[t]) throw new Error('Unknown table: ' + t); }
function assertSignedIn() { if (!uid) throw new Error('Not signed in.'); }

function defaultFor(table, field) {
  if (TABLES[table].booleans.indexOf(field) !== -1) return false;
  if (table === 'tasks' && field === 'status') return STATUSES[0];
  if (table === 'notes' && field === 'color') return COLORS[0];
  if (table === 'links' && field === 'category') return 'General';
  if ((TABLES[table].numbers || []).indexOf(field) !== -1) return 0;
  if ((TABLES[table].lists || []).indexOf(field) !== -1) return [];
  if (table === 'notes' && field === 'kind') return 'note';
  return '';
}

// Anything that isn't plainly http(s) is dropped, so a stored
// "javascript:" value can never become a live link.
function normalizeUrl(raw) {
  const url = String(raw).trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (/^[a-z][a-z0-9+.\-]*:/i.test(url)) return '';
  return 'https://' + url;
}

function sanitize(table, values) {
  const config = TABLES[table];
  const clean = {};
  config.editable.forEach(function (field) {
    if (values[field] === undefined || values[field] === null) return;
    if (config.booleans.indexOf(field) !== -1) clean[field] = isTrue(values[field]);
    else if ((config.lists || []).indexOf(field) !== -1) {
      if (Array.isArray(values[field])) clean[field] = cleanItems(values[field]);
    }
    else if ((config.numbers || []).indexOf(field) !== -1) {
      const n = Number(values[field]);
      if (Number.isFinite(n)) clean[field] = n;
    }
    else clean[field] = String(values[field]).slice(0, MAX_FIELD_LENGTH);
  });
  if (table === 'tasks' && clean.status !== undefined && STATUSES.indexOf(clean.status) === -1) clean.status = STATUSES[0];
  if (table === 'notes' && clean.kind !== undefined && clean.kind !== 'list') clean.kind = 'note';
  if (table === 'notes' && clean.color !== undefined && COLORS.indexOf(clean.color) === -1) clean.color = COLORS[0];
  if (table === 'links') {
    if (clean.url !== undefined) clean.url = normalizeUrl(clean.url);
    if (clean.category !== undefined && !clean.category.trim()) clean.category = 'General';
  }
  return clean;
}

// Checklist items: [{ id, text, done }], capped so one list can't grow huge.
function cleanItems(items) {
  return items.slice(0, 500).map(function (it) {
    it = it || {};
    return {
      id: String(it.id || uuid()).slice(0, 64),
      text: String(it.text == null ? '' : it.text).slice(0, 1000),
      done: isTrue(it.done)
    };
  });
}

// A full, clean record from anything (a Firestore doc, a backup row).
function normalizeRecord(table, row, fallbackOrder) {
  const clean = sanitize(table, row || {});
  const now = new Date().toISOString();
  const rec = {
    id: String(row.id || uuid()),
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : (fallbackOrder || 0),
    created: String(row.created || now),
    updated: String(row.updated || now)
  };
  TABLES[table].editable.forEach(function (f) { rec[f] = clean[f] === undefined ? defaultFor(table, f) : clean[f]; });
  (TABLES[table].passthrough || []).forEach(function (f) {
    if (row[f] !== undefined && row[f] !== null) rec[f] = String(row[f]);
  });
  if (table === 'reminders' && !rec.status) rec.status = 'pending';
  return rec;
}

function sorted(table) { return mirror[table].slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; }); }

/* ------------------------------------------------------- firestore -- */
function col(table) { return fb.f.collection(fb.db, 'users', uid, table); }
function ref(table, id) { return fb.f.doc(fb.db, 'users', uid, table, id); }
function settingsRef() { return fb.f.doc(fb.db, 'users', uid, 'meta', 'settings'); }
// nextAtMs is what the reminder sender looks for: present only while a
// reminder is still waiting to go out.
function body(table, rec) {
  const o = Object.assign({}, rec);
  delete o.id;
  if (table === 'reminders' && rec.status === 'pending') o.nextAtMs = rec.dueAtMs;
  return o;
}
function deviceRef(id) { return fb.f.doc(fb.db, 'users', uid, 'devices', id); }

// Writes are fire-and-forget: offline they wait in Firestore's queue, and a
// rejection (e.g. rules) is reported rather than thrown at the caller.
function send(promise) { promise.catch(function (e) { errorHandler(e); }); }

async function commitInBatches(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = fb.f.writeBatch(fb.db);
    ops.slice(i, i + 400).forEach(function (op) { op(batch); });
    await batch.commit();
  }
}

/* ----------------------------------------------------------- legacy -- */
// Data saved by the earlier, device-only version of the app.
function legacyData() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const out = empty();
    let count = 0;
    TABLE_NAMES.forEach(function (t) { if (Array.isArray(data[t])) { out[t] = data[t]; count += data[t].length; } });
    return count ? { data: out, count: count } : null;
  } catch (e) { return null; }
}

export const Store = {
  STATUSES, COLORS, configured,

  /* ---- auth ---- */
  async init() { fb = await connect(); return fb; },

  onAuth(handler) {
    return fb.a.onAuthStateChanged(fb.auth, handler);
  },
  signInWithGoogle() {
    const provider = new fb.a.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    return fb.a.signInWithPopup(fb.auth, provider);
  },
  signInWithEmail(email, password) { return fb.a.signInWithEmailAndPassword(fb.auth, email, password); },
  createAccount(email, password) { return fb.a.createUserWithEmailAndPassword(fb.auth, email, password); },
  resetPassword(email) { return fb.a.sendPasswordResetEmail(fb.auth, email); },
  signOut() { return fb.a.signOut(fb.auth); },
  currentUser() { return fb && fb.auth.currentUser; },

  /* ---- live data ---- */
  // Resolves once every collection has delivered its first snapshot (from
  // the device cache if offline). After that, onChange fires on every update
  // from any device.
  start(userId, onChange, onError) {
    this.stop();
    uid = userId;
    mirror = empty();
    settings = {};
    changeHandler = onChange || changeHandler;
    if (onError) errorHandler = onError;
    return new Promise(function (resolve) {
      const pending = new Set(TABLE_NAMES.concat(['settings']));
      function arrived(name) {
        if (pending.has(name)) { pending.delete(name); if (!pending.size) resolve(); }
        else changeHandler(name);
      }
      TABLE_NAMES.forEach(function (table) {
        unsubs.push(fb.f.onSnapshot(col(table), function (snap) {
          mirror[table] = snap.docs.map(function (d, i) {
            return normalizeRecord(table, Object.assign({ id: d.id }, d.data()), i);
          });
          arrived(table);
        }, function (e) { errorHandler(e); arrived(table); }));
      });
      unsubs.push(fb.f.onSnapshot(settingsRef(), function (snap) {
        settings = snap.exists() ? snap.data() : {};
        arrived('settings');
      }, function (e) { errorHandler(e); arrived('settings'); }));
    });
  },

  stop() {
    unsubs.forEach(function (u) { try { u(); } catch (e) { /* ignore */ } });
    unsubs = [];
    uid = null;
    mirror = empty();
    settings = {};
  },

  loadAll() {
    const out = {};
    TABLE_NAMES.forEach(function (t) { out[t] = clone(sorted(t)); });
    return out;
  },

  /* ---- mutations (same shape as the original Apps Script API) ---- */
  create(table, values) {
    assertTable(table); assertSignedIn();
    const list = mirror[table];
    const top = list.length ? Math.min.apply(null, list.map(function (i) { return i.sortOrder; })) - 1 : 0;
    const now = new Date().toISOString();
    const rec = normalizeRecord(table, Object.assign({}, values, { id: uuid(), sortOrder: top, created: now, updated: now }));
    list.push(rec);
    send(fb.f.setDoc(ref(table, rec.id), body(table, rec)));
    return clone(rec);
  },

  update(table, id, values) {
    assertTable(table); assertSignedIn();
    const item = mirror[table].filter(function (i) { return i.id === id; })[0];
    if (!item) throw new Error('That item no longer exists — it may have been deleted on another device.');
    const clean = sanitize(table, values || {});
    clean.updated = new Date().toISOString();
    const write = Object.assign({}, clean);
    if (table === 'reminders' && clean.dueAtMs !== undefined) {
      // A new time re-arms it, even if it had already gone off.
      clean.status = 'pending';
      write.status = 'pending';
      write.nextAtMs = clean.dueAtMs;
      write.sentAt = fb.f.deleteField();
      delete item.sentAt;
    }
    Object.assign(item, clean);
    send(fb.f.setDoc(ref(table, id), write, { merge: true }));
    return clone(item);
  },

  remove(table, id) {
    assertTable(table); assertSignedIn();
    mirror[table] = mirror[table].filter(function (i) { return i.id !== id; });
    send(fb.f.deleteDoc(ref(table, id)));
    return true;
  },

  reorder(table, orderedIds) {
    assertTable(table); assertSignedIn();
    const rank = {};
    orderedIds.forEach(function (id, i) { rank[id] = i; });
    const ops = [];
    mirror[table].forEach(function (item) {
      const next = Object.prototype.hasOwnProperty.call(rank, item.id) ? rank[item.id] : orderedIds.length;
      if (item.sortOrder === next) return;
      item.sortOrder = next;
      ops.push(function (batch) { batch.set(ref(table, item.id), { sortOrder: next }, { merge: true }); });
    });
    if (ops.length) send(commitInBatches(ops));
    return true;
  },

  /* ---- devices that get reminder notifications ---- */
  registerDevice(token, label) {
    assertSignedIn();
    return fb.f.setDoc(deviceRef(token), { token: token, label: String(label || '').slice(0, 200), updated: new Date().toISOString() });
  },
  unregisterDevice(token) {
    assertSignedIn();
    return fb.f.deleteDoc(deviceRef(token));
  },

  /* ---- per-person settings (daily checklist) ---- */
  getSettings() { return clone(settings); },
  saveSettings(partial) {
    assertSignedIn();
    Object.assign(settings, partial);
    send(fb.f.setDoc(settingsRef(), partial, { merge: true }));
  },

  /* ---- backups ---- */
  exportJson() {
    return JSON.stringify(Object.assign({ app: 'everything-app', version: 2, exported: new Date().toISOString() },
      this.loadAll()), null, 2);
  },

  // Replaces everything in the signed-in account.
  async importJson(text) {
    assertSignedIn();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.notes)) {
      throw new Error('That file is not an Everything App backup.');
    }
    const ops = [];
    const counts = {};
    TABLE_NAMES.forEach(function (table) {
      mirror[table].forEach(function (item) { ops.push(function (b) { b.delete(ref(table, item.id)); }); });
      const rows = (Array.isArray(data[table]) ? data[table] : []).map(function (row, i) {
        const rec = normalizeRecord(table, row, i);
        // Don't fire a pile of old reminders the moment a backup is restored.
        if (table === 'reminders' && rec.status === 'pending' && rec.dueAtMs < Date.now()) rec.status = 'sent';
        return rec;
      });
      rows.forEach(function (rec) { ops.push(function (b) { b.set(ref(table, rec.id), body(table, rec)); }); });
      mirror[table] = rows;
      counts[table] = rows.length;
    });
    send(commitInBatches(ops));
    return counts;
  },

  /* ---- one-time move from the device-only version ---- */
  legacySummary() { const l = legacyData(); return l ? l.count : 0; },
  legacyHandled(userId) { try { return !!localStorage.getItem('everything-app:legacy-handled:' + userId); } catch (e) { return true; } },
  markLegacyHandled(userId) { try { localStorage.setItem('everything-app:legacy-handled:' + userId, '1'); } catch (e) { /* ignore */ } },

  // Merges by id, so running it on two devices never creates duplicates of
  // the same item. The device copy is renamed afterwards so a different
  // person signing in on this device isn't offered it.
  migrateLegacy() {
    assertSignedIn();
    const legacy = legacyData();
    if (!legacy) return 0;
    const ops = [];
    TABLE_NAMES.forEach(function (table) {
      legacy.data[table].forEach(function (row, i) {
        const rec = normalizeRecord(table, row, i);
        const existing = mirror[table].findIndex(function (m) { return m.id === rec.id; });
        if (existing === -1) mirror[table].push(rec); else mirror[table][existing] = rec;
        ops.push(function (b) { b.set(ref(table, rec.id), body(table, rec), { merge: true }); });
      });
    });
    send(commitInBatches(ops));
    try {
      localStorage.setItem(LEGACY_KEY + ':uploaded', localStorage.getItem(LEGACY_KEY));
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) { /* ignore */ }
    return legacy.count;
  }
};

window.Store = Store;
