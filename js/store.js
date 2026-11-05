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
  reminders: { editable: ['title', 'description', 'dueAtMs', 'repeat', 'repeatDays', 'repeatAnchor', 'repeatTime', 'repeatUntil', 'tz'],
    booleans: [], numbers: ['dueAtMs'],
    passthrough: ['status', 'sentAt', 'delivery', 'deliveryNote', 'pushedTo', 'emailedAt', 'ackedAt', 'lastSentAt', 'lastDueAtMs'] }
};
const TABLE_NAMES = Object.keys(TABLES);

let fb = null;            // { auth, db, a: authModule, f: firestoreModule }
let uid = null;
let mirror = empty();          // your own items
let sharedMirror = empty();    // items shared with you (or by you)
let invites = { out: [], in: [] };
let me = { email: '', name: '' };
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
  // Server-written receipts: { uid: { state, note } } for each person it's for.
  if (row.deliveries && typeof row.deliveries === 'object') rec.deliveries = JSON.parse(JSON.stringify(row.deliveries));
  // Sharing details (only on items in the shared collection).
  if (Array.isArray(row.members)) {
    rec.shared = true;
    rec.owner = String(row.owner || '');
    rec.members = row.members.map(String);
    rec.memberInfo = row.memberInfo && typeof row.memberInfo === 'object' ? JSON.parse(JSON.stringify(row.memberInfo)) : {};
  }
  return rec;
}

function all(table) { return mirror[table].concat(sharedMirror[table]); }
function sorted(table) { return all(table).sort(function (a, b) { return a.sortOrder - b.sortOrder; }); }
function find(table, id) { return all(table).filter(function (i) { return i.id === id; })[0] || null; }
function sharedRef(id) { return fb.f.doc(fb.db, 'shared', id); }
// Where an item lives: your own space, or the shared collection.
function refFor(table, item) { return item && item.shared ? sharedRef(item.id) : ref(table, item.id); }
function nameFromEmail(email) {
  const n = String(email || '').split('@')[0].split(/[._+-]/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
}
function myName() { return me.name || nameFromEmail(me.email) || 'Someone'; }

/* ------------------------------------------------------- firestore -- */
function col(table) { return fb.f.collection(fb.db, 'users', uid, table); }
function ref(table, id) { return fb.f.doc(fb.db, 'users', uid, table, id); }
function settingsRef() { return fb.f.doc(fb.db, 'users', uid, 'meta', 'settings'); }
// nextAtMs is what the reminder sender looks for: present only while a
// reminder is still waiting to go out.
function body(table, rec) {
  const o = Object.assign({}, rec);
  delete o.id;
  delete o.shared;       // worked out on load, not stored
  delete o.deliveries;   // written by the server only
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
  start(userId, onChange, onError, email, name) {
    this.stop();
    uid = userId;
    me = { email: String(email || '').toLowerCase(), name: String(name || '') };
    mirror = empty();
    sharedMirror = empty();
    invites = { out: [], in: [] };
    settings = {};
    changeHandler = onChange || changeHandler;
    if (onError) errorHandler = onError;
    return new Promise(function (resolve) {
      const pending = new Set(TABLE_NAMES.concat(['settings', 'shared', 'invitesOut', 'invitesIn']));
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
      // Everything shared with you (and by you).
      unsubs.push(fb.f.onSnapshot(fb.f.query(fb.f.collection(fb.db, 'shared'), fb.f.where('members', 'array-contains', uid)), function (snap) {
        const next = empty();
        snap.docs.forEach(function (d, i) {
          const data = d.data();
          if (!TABLES[data.table]) return;
          next[data.table].push(normalizeRecord(data.table, Object.assign({ id: d.id }, data), i));
        });
        sharedMirror = next;
        arrived('shared');
      }, function (e) { errorHandler(e); arrived('shared'); }));
      // Connection requests you've sent, and ones sent to you.
      const inviteCol = fb.f.collection(fb.db, 'invites');
      unsubs.push(fb.f.onSnapshot(fb.f.query(inviteCol, fb.f.where('fromUid', '==', uid)), function (snap) {
        invites.out = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        arrived('invitesOut');
      }, function (e) { errorHandler(e); arrived('invitesOut'); }));
      if (me.email) {
        unsubs.push(fb.f.onSnapshot(fb.f.query(inviteCol, fb.f.where('toEmail', '==', me.email)), function (snap) {
          invites.in = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
          arrived('invitesIn');
        }, function (e) { errorHandler(e); arrived('invitesIn'); }));
      } else arrived('invitesIn');
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
    sharedMirror = empty();
    invites = { out: [], in: [] };
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
    const every = all(table);
    const top = every.length ? Math.min.apply(null, every.map(function (i) { return i.sortOrder; })) - 1 : 0;
    const now = new Date().toISOString();
    const rec = normalizeRecord(table, Object.assign({}, values, { id: uuid(), sortOrder: top, created: now, updated: now }));
    list.push(rec);
    send(fb.f.setDoc(ref(table, rec.id), body(table, rec)));
    return clone(rec);
  },

  update(table, id, values) {
    assertTable(table); assertSignedIn();
    const item = find(table, id);
    if (!item) throw new Error('That item no longer exists — it may have been deleted on another device.');
    const clean = sanitize(table, values || {});
    clean.updated = new Date().toISOString();
    const write = Object.assign({}, clean);
    if (table === 'reminders' && clean.dueAtMs !== undefined) {
      // A new time re-arms it, even if it had already gone off.
      clean.status = 'pending';
      write.status = 'pending';
      write.nextAtMs = clean.dueAtMs;
      // (lastSentAt / lastDueAtMs stay: they describe the previous time it went off.)
      ['sentAt', 'delivery', 'deliveryNote', 'pushedTo', 'emailedAt', 'ackedAt', 'ackKey', 'emailDueMs',
        'deliveries', 'ackKeys', 'emailPending'].forEach(function (f) {
        write[f] = fb.f.deleteField();
        delete item[f];
      });
    }
    Object.assign(item, clean);
    send(fb.f.setDoc(refFor(table, item), write, { merge: true }));
    return clone(item);
  },

  remove(table, id) {
    assertTable(table); assertSignedIn();
    const item = find(table, id);
    if (item && item.shared && item.owner !== uid) return this.leave(table, id);
    mirror[table] = mirror[table].filter(function (i) { return i.id !== id; });
    sharedMirror[table] = sharedMirror[table].filter(function (i) { return i.id !== id; });
    send(fb.f.deleteDoc(item ? refFor(table, item) : ref(table, id)));
    return true;
  },

  /* ---- sharing ---- */
  myUid() { return uid; },

  // Share an item with these people (uids of your connections). An empty
  // list un-shares it (owner only), moving it back into your own space.
  setSharing(table, id, uids) {
    assertTable(table); assertSignedIn();
    const item = find(table, id);
    if (!item) throw new Error('That item no longer exists.');
    if (item.shared && item.owner !== uid) throw new Error('Only the person who made it can change who it\u2019s shared with.');
    const people = this.connections();
    const others = uids.filter(function (u) { return u !== uid && people.some(function (p) { return p.uid === u; }); });
    const info = {};
    info[uid] = { name: myName(), email: me.email };
    people.forEach(function (p) { if (others.indexOf(p.uid) !== -1) info[p.uid] = { name: p.name, email: p.email }; });
    const batch = fb.f.writeBatch(fb.db);
    if (!item.shared && others.length) {
      const rec = Object.assign({}, item, { owner: uid, members: [uid].concat(others), memberInfo: info });
      batch.set(sharedRef(id), Object.assign(body(table, rec), { table: table }));
      batch.delete(ref(table, id));
      mirror[table] = mirror[table].filter(function (i) { return i.id !== id; });
      rec.shared = true;
      sharedMirror[table].push(rec);
    } else if (item.shared && others.length) {
      batch.set(sharedRef(id), { members: [uid].concat(others), memberInfo: info }, { merge: true });
      item.members = [uid].concat(others);
      item.memberInfo = info;
    } else if (item.shared && !others.length) {
      const rec = Object.assign({}, item);
      delete rec.owner; delete rec.members; delete rec.memberInfo; delete rec.shared;
      const data = body(table, rec);
      delete data.table;
      batch.set(ref(table, id), data);
      batch.delete(sharedRef(id));
      sharedMirror[table] = sharedMirror[table].filter(function (i) { return i.id !== id; });
      mirror[table].push(rec);
    } else {
      return true;
    }
    send(batch.commit());
    return true;
  },

  // Take yourself off something someone else shared with you.
  leave(table, id) {
    assertTable(table); assertSignedIn();
    sharedMirror[table] = sharedMirror[table].filter(function (i) { return i.id !== id; });
    send(fb.f.updateDoc(sharedRef(id), { members: fb.f.arrayRemove(uid) }));
    return true;
  },

  /* ---- connections ---- */
  invitesIn() { return clone(invites.in.filter(function (i) { return i.status === 'pending'; })); },
  invitesOut() { return clone(invites.out.filter(function (i) { return i.status === 'pending'; })); },
  connections() {
    const seen = {};
    const out = [];
    invites.out.forEach(function (i) {
      if (i.status !== 'accepted' || !i.toUid || seen[i.toUid]) return;
      seen[i.toUid] = true;
      out.push({ uid: i.toUid, name: i.toName || nameFromEmail(i.toEmail), email: i.toEmail, inviteId: i.id });
    });
    invites.in.forEach(function (i) {
      if (i.status !== 'accepted' || !i.fromUid || seen[i.fromUid]) return;
      seen[i.fromUid] = true;
      out.push({ uid: i.fromUid, name: i.fromName || nameFromEmail(i.fromEmail), email: i.fromEmail, inviteId: i.id });
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  },
  invite(email) {
    assertSignedIn();
    const to = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('That doesn\u2019t look like an email address.');
    if (to === me.email) throw new Error('That\u2019s your own email address.');
    if (invites.out.some(function (i) { return i.toEmail === to && i.status !== 'declined'; })) throw new Error('You\u2019ve already invited ' + to + '.');
    if (invites.in.some(function (i) { return i.fromEmail && i.fromEmail.toLowerCase() === to && i.status === 'accepted'; })) throw new Error('You\u2019re already connected.');
    return fb.f.addDoc(fb.f.collection(fb.db, 'invites'), {
      fromUid: uid, fromName: myName(), fromEmail: me.email, toEmail: to,
      status: 'pending', created: new Date().toISOString()
    });
  },
  respond(inviteId, accept) {
    assertSignedIn();
    return fb.f.updateDoc(fb.f.doc(fb.db, 'invites', inviteId), {
      status: accept ? 'accepted' : 'declined', toUid: uid, toName: myName(), respondedAt: new Date().toISOString()
    });
  },
  removeInvite(inviteId) {
    assertSignedIn();
    return fb.f.deleteDoc(fb.f.doc(fb.db, 'invites', inviteId));
  },

  reorder(table, orderedIds) {
    assertTable(table); assertSignedIn();
    const rank = {};
    orderedIds.forEach(function (id, i) { rank[id] = i; });
    const ops = [];
    all(table).forEach(function (item) {
      const next = Object.prototype.hasOwnProperty.call(rank, item.id) ? rank[item.id] : orderedIds.length;
      if (item.sortOrder === next) return;
      item.sortOrder = next;
      const where = refFor(table, item);
      ops.push(function (batch) { batch.set(where, { sortOrder: next }, { merge: true }); });
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
      // Shared items belong to everyone they're shared with; a backup restores only your own.
      const rows = (Array.isArray(data[table]) ? data[table] : []).filter(function (row) { return row && !row.shared && !Array.isArray(row.members); }).map(function (row, i) {
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
