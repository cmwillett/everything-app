/*
 * Local data store — the stand-in for the Google Sheet.
 *
 * Same shape as the Apps Script API (create / update / remove / reorder per
 * table) so app.js reads almost exactly like the original. Everything lives in
 * the browser's localStorage under one key, which means:
 *   - it works fully offline and needs no server or account;
 *   - data is per device + per browser. Use Data → Export / Import to move it
 *     or back it up.
 * If you later want sync, this is the only file that needs to change.
 */
(function (global) {
  'use strict';

  var KEY = 'everything-app:v1';
  var MAX_FIELD_LENGTH = 20000;

  var STATUSES = ['To Do', 'In Progress', 'Blocked', 'Done'];
  var COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];

  var TABLES = {
    tasks: {
      editable: ['name', 'notes', 'status', 'today', 'archived'],
      booleans: ['today', 'archived']
    },
    notes: {
      editable: ['title', 'body', 'color'],
      booleans: []
    },
    links: {
      editable: ['title', 'url', 'category', 'notes'],
      booleans: []
    }
  };
  var TABLE_NAMES = Object.keys(TABLES);

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function empty() { return { tasks: [], notes: [], links: [] }; }

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return empty();
      var data = JSON.parse(raw);
      var out = empty();
      TABLE_NAMES.forEach(function (t) { if (Array.isArray(data[t])) out[t] = data[t]; });
      return out;
    } catch (e) {
      return empty();
    }
  }

  var db = read();

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
    } catch (e) {
      throw new Error('Could not save — browser storage is full or disabled.');
    }
  }

  function assertTable(table) {
    if (!Object.prototype.hasOwnProperty.call(TABLES, table)) {
      throw new Error('Unknown table: ' + table);
    }
  }

  function isTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }

  function defaultFor(table, field) {
    if (TABLES[table].booleans.indexOf(field) !== -1) return false;
    if (table === 'tasks' && field === 'status') return STATUSES[0];
    if (table === 'notes' && field === 'color') return COLORS[0];
    if (table === 'links' && field === 'category') return 'General';
    return '';
  }

  function sanitize(table, values) {
    var config = TABLES[table];
    var clean = {};
    config.editable.forEach(function (field) {
      if (values[field] === undefined || values[field] === null) return;
      if (config.booleans.indexOf(field) !== -1) clean[field] = isTrue(values[field]);
      else clean[field] = String(values[field]).slice(0, MAX_FIELD_LENGTH);
    });
    if (table === 'tasks' && clean.status !== undefined && STATUSES.indexOf(clean.status) === -1) {
      clean.status = STATUSES[0];
    }
    if (table === 'notes' && clean.color !== undefined && COLORS.indexOf(clean.color) === -1) {
      clean.color = COLORS[0];
    }
    if (table === 'links') {
      if (clean.url !== undefined) clean.url = normalizeUrl(clean.url);
      if (clean.category !== undefined && !clean.category.trim()) clean.category = 'General';
    }
    return clean;
  }

  // Anything that isn't plainly http(s) is dropped, so a stored
  // "javascript:" value can never become a live link.
  function normalizeUrl(raw) {
    var url = String(raw).trim();
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(url)) return '';
    return 'https://' + url;
  }

  function sorted(table) {
    return db[table].slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var Store = {
    STATUSES: STATUSES,
    COLORS: COLORS,

    loadAll: function () {
      var out = {};
      TABLE_NAMES.forEach(function (t) { out[t] = clone(sorted(t)); });
      return out;
    },

    // New items go to the top, same as the original.
    create: function (table, values) {
      assertTable(table);
      var list = db[table];
      var top = list.length
        ? Math.min.apply(null, list.map(function (i) { return i.sortOrder; })) - 1
        : 0;
      var clean = sanitize(table, values || {});
      var now = new Date().toISOString();
      var record = { id: uuid(), sortOrder: top, created: now, updated: now };
      TABLES[table].editable.forEach(function (field) {
        record[field] = clean[field] === undefined ? defaultFor(table, field) : clean[field];
      });
      list.push(record);
      persist();
      return clone(record);
    },

    update: function (table, id, values) {
      assertTable(table);
      var item = db[table].filter(function (i) { return i.id === id; })[0];
      if (!item) throw new Error('No item with id ' + id);
      var clean = sanitize(table, values || {});
      Object.keys(clean).forEach(function (k) { item[k] = clean[k]; });
      item.updated = new Date().toISOString();
      persist();
      return clone(item);
    },

    remove: function (table, id) {
      assertTable(table);
      db[table] = db[table].filter(function (i) { return i.id !== id; });
      persist();
      return true;
    },

    reorder: function (table, orderedIds) {
      assertTable(table);
      var rank = {};
      orderedIds.forEach(function (id, i) { rank[id] = i; });
      db[table].forEach(function (item) {
        item.sortOrder = Object.prototype.hasOwnProperty.call(rank, item.id)
          ? rank[item.id] : orderedIds.length;
      });
      persist();
      return true;
    },

    exportJson: function () {
      return JSON.stringify({ app: 'everything-app', version: 1,
        exported: new Date().toISOString(), tasks: db.tasks, notes: db.notes, links: db.links }, null, 2);
    },

    // Replaces everything. Each row is re-sanitized so a hand-edited file
    // can't smuggle in odd fields or values.
    importJson: function (text) {
      var data = JSON.parse(text);
      if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.notes)) {
        throw new Error('That file is not an Everything App backup.');
      }
      var next = empty();
      TABLE_NAMES.forEach(function (table) {
        // Older backups have no links — that's fine.
        (Array.isArray(data[table]) ? data[table] : []).forEach(function (row, i) {
          var clean = sanitize(table, row || {});
          var rec = {
            id: String(row.id || uuid()),
            sortOrder: Number(row.sortOrder) || i,
            created: String(row.created || new Date().toISOString()),
            updated: String(row.updated || new Date().toISOString())
          };
          TABLES[table].editable.forEach(function (f) {
            rec[f] = clean[f] === undefined ? defaultFor(table, f) : clean[f];
          });
          next[table].push(rec);
        });
      });
      db = next;
      persist();
      return { tasks: db.tasks.length, notes: db.notes.length, links: db.links.length };
    },

    // Another tab of the app wrote — pick up its copy.
    reloadFromDisk: function () { db = read(); },
    KEY: KEY
  };

  global.Store = Store;
})(window);
