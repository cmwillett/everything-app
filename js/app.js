import { Store } from './store.js';
import { messaging, adminStats } from './cloud.js';

(function () {
  'use strict';

  /* --------------------------------------------------------- settings -- */
  // Rename the two task buckets here if you'd rather say "Current" / "Backlog".
  var LABEL_NOW = 'Today';
  var LABEL_LATER = 'Later';
  var HOME_ROWS = 6;
  var HOME_NOTES = 4;
  var DEFAULT_DAILY = ['Review Tasks', 'Move any Notes into Tasks if needed'];

  var state = {
    tasks: [], notes: [], links: [], reminders: [],
    statuses: Store.STATUSES,
    colors: Store.COLORS,
    tab: 'home',
    taskFilter: 'All',
    archiveOpen: false,
    homeBucket: 'now'
  };
  var saveTimers = {};
  var pendingSaves = {};

  /* --------------------------------------------------------- plumbing -- */
  // Store calls are synchronous; wrapping them keeps every mutation behind
  // one error path, the same as google.script.run did.
  function run(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    try { return Promise.resolve(Store[fn].apply(Store, args)); }
    catch (e) { return Promise.reject(e); }
  }
  function fail(err) { toast(err && err.message ? err.message : String(err), true); }

  var toastTimer;
  function toast(message, isError) {
    var t = document.getElementById('toast');
    t.textContent = message;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-visible'); }, 2800);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function replaceIn(list, item) {
    for (var i = 0; i < list.length; i++) if (list[i].id === item.id) { list[i] = item; return; }
    list.push(item);
  }
  // Saved notes are rich text (HTML); RichText cleans them before showing.
  function mdInto(node, text) { return RichText.renderInto(node, text); }
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /* ------------------------------------------------------- keyboard -- */
  // Ctrl/⌘+Enter submits a form, since plain Enter adds a new line in details.
  function submitOnCmdEnter(form) {
    form.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  /* ------------------------------------------------------------- tabs -- */
  var TABS = ['home', 'tasks', 'reminders', 'links', 'notebook'];
  function showTab(name, fromHash) {
    if (TABS.indexOf(name) === -1) name = 'home';
    state.tab = name;
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('is-active', v.dataset.view === name);
    });
    if (!fromHash && location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'home') renderHome();
    window.scrollTo(0, 0);
  }

  /* ----------------------------------------------------------- dialog -- */
  var dialog = document.getElementById('editor');
  var dialogForm = document.getElementById('editor-form');
  var pendingSave = null;

  var richFields = {};
  function openEditor(title, fields, onSave) {
    richFields = {};
    document.getElementById('editor-title').textContent = title;
    var host = clear(document.getElementById('editor-fields'));
    fields.forEach(function (field) {
      var wrap = el('div', 'field');
      var label = el('label', null, field.label);
      label.setAttribute('for', 'f-' + field.name);
      wrap.appendChild(label);
      var input;
      if (field.type === 'rich') {
        var rte = RichText.create({ value: field.value, placeholder: field.placeholder || '', minHeight: 140 });
        rte.editor.id = 'f-' + field.name;
        rte.el.dataset.richName = field.name;
        richFields[field.name] = rte;
        wrap.appendChild(rte.el);
        if (field.hint) wrap.appendChild(el('div', 'hint', field.hint));
        host.appendChild(wrap);
        return;
      }
      if (field.type === 'textarea') input = el('textarea');
      else if (field.type === 'select') {
        input = el('select');
        field.options.forEach(function (o) { var opt = el('option', null, o); opt.value = o; input.appendChild(opt); });
      } else { input = el('input'); input.type = field.type === 'date' || field.type === 'time' ? field.type : 'text'; }
      input.id = 'f-' + field.name;
      input.name = field.name;
      input.value = field.value == null ? '' : field.value;
      wrap.appendChild(input);
      if (field.hint) wrap.appendChild(el('div', 'hint', field.hint));
      host.appendChild(wrap);
    });
    pendingSave = onSave;
    dialog.showModal();
    var first = host.querySelector('input, textarea, select, [contenteditable]');
    if (first) first.focus();
  }
  submitOnCmdEnter(dialogForm);
  dialogForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var values = {};
    dialogForm.querySelectorAll('[name]').forEach(function (i) { values[i.name] = i.value; });
    Object.keys(richFields).forEach(function (k) { values[k] = richFields[k].getValue(); });
    var handler = pendingSave;
    pendingSave = null;
    dialog.close();
    if (handler) handler(values);
  });
  document.getElementById('editor-cancel').addEventListener('click', function () {
    pendingSave = null; dialog.close();
  });

  /* -------------------------------------------------------- sortable -- */
  // Pointer events instead of HTML5 drag-and-drop, which doesn't fire on
  // phones. Dragging only starts from the ⠿ handle, so inputs, selects and
  // page scrolling everywhere else behave normally.
  function attachHandle(node, handle, container, itemSelector, table, isGrid) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      node.classList.add('dragging');
      var moved = false;

      function onMove(e) {
        var after = dropTarget(container, itemSelector, node, e.clientX, e.clientY, isGrid);
        if (after === undefined) return;
        var next = after ? after : null;
        if (node.nextElementSibling === next) return;
        container.insertBefore(node, next);
        moved = true;
        autoScroll(e.clientY);
      }
      function onUp() {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        node.classList.remove('dragging');
        if (!moved) return;
        var ids = Array.prototype.map.call(container.querySelectorAll(itemSelector), function (c) { return c.dataset.id; });
        var full = mergeOrder(state[table], ids);
        reorderLocal(table, full);
        run('reorder', table, full).then(function () { if (state.tab !== 'home') renderHome(); }).catch(fail);
      }
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  // Returns the element to insert before, null for "at the end", or
  // undefined when the pointer is outside the container.
  function dropTarget(container, selector, dragging, x, y, isGrid) {
    var items = Array.prototype.filter.call(container.querySelectorAll(selector),
      function (n) { return n !== dragging; });
    var box = container.getBoundingClientRect();
    if (y < box.top - 40 || y > box.bottom + 40) return undefined;
    for (var i = 0; i < items.length; i++) {
      var b = items[i].getBoundingClientRect();
      if (isGrid) {
        if (y < b.top) return items[i];
        if (y < b.bottom && x < b.left + b.width / 2) return items[i];
      } else if (y < b.top + b.height / 2) {
        return items[i];
      }
    }
    return null;
  }

  function autoScroll(y) {
    var edge = 60;
    if (y < edge) window.scrollBy(0, -12);
    else if (y > window.innerHeight - edge) window.scrollBy(0, 12);
  }

  // The container only holds a subset (a section, a filter), so slot the new
  // order back into the gaps those items already occupied.
  function mergeOrder(fullList, movedIds) {
    var moved = Object.create(null);
    movedIds.forEach(function (id) { moved[id] = true; });
    var queue = movedIds.slice();
    return fullList.map(function (item) { return moved[item.id] ? queue.shift() : item.id; });
  }
  function reorderLocal(table, ids) {
    var lookup = {};
    state[table].forEach(function (i) { lookup[i.id] = i; });
    state[table] = ids.map(function (id) { return lookup[id]; }).filter(Boolean);
  }

  /* ------------------------------------------------------------- home -- */
  // A personal checklist that resets every day. Synced with your account;
  // checks are stored against today's date, so a new day always starts blank.
  function dailyItems() {
    var s = Store.getSettings();
    return Array.isArray(s.dailyItems) ? s.dailyItems : DEFAULT_DAILY;
  }
  function dailyChecks() {
    var s = Store.getSettings();
    var today = dayKey();
    var checked = s.dailyChecks && s.dailyChecks.date === today ? (s.dailyChecks.checked || {}) : {};
    return {
      checked: checked,
      save: function () { Store.saveSettings({ dailyChecks: { date: today, checked: checked } }); }
    };
  }

  function renderDailyTasks() {
    var host = clear(document.getElementById('daily-tasks'));
    var items = dailyItems();
    var store = dailyChecks();
    var panel = el('article', 'panel daily-tasks-panel');
    var head = el('header', 'panel-head');
    head.appendChild(el('h2', null, 'Daily checklist'));
    var edit = el('button', 'link-btn', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', function () {
      openEditor('Daily checklist', [{
        name: 'items', label: 'One item per line', type: 'textarea',
        value: items.join('\n'), hint: 'Checks reset every morning.'
      }], function (v) {
        Store.saveSettings({
          dailyItems: v.items.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
          dailyChecks: { date: dayKey(), checked: {} }
        });
        renderDailyTasks();
      });
    });
    head.appendChild(edit);
    panel.appendChild(head);

    var body = el('div', 'panel-body daily-tasks-body');
    if (!items.length) body.appendChild(el('p', 'empty', 'No daily items. Tap Edit to add some.'));
    items.forEach(function (label) {
      var row = el('label', 'daily-task' + (store.checked[label] ? ' is-done' : ''));
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!store.checked[label];
      box.addEventListener('change', function () {
        store.checked[label] = box.checked;
        store.save();
        row.classList.toggle('is-done', box.checked);
      });
      row.appendChild(box);
      row.appendChild(document.createTextNode(label));
      body.appendChild(row);
    });
    panel.appendChild(body);
    host.appendChild(panel);
  }

  function renderHome() {
    renderDailyTasks();
    var live = state.tasks.filter(function (t) { return !t.archived; });
    var nowTasks = live.filter(function (t) { return t.today; });

    var stats = clear(document.getElementById('home-stats'));
    stats.appendChild(statCard(nowTasks.filter(function (t) { return t.status !== 'Done'; }).length,
      LABEL_NOW + ' (open)', 'tasks', null, true));
    state.statuses.forEach(function (status) {
      stats.appendChild(statCard(live.filter(function (t) { return t.status === status; }).length,
        status, 'tasks', status));
    });
    stats.appendChild(statCard(upcomingReminders().length, 'Reminders', 'reminders', null));
    stats.appendChild(statCard(state.links.length, 'Links', 'links', null));
    stats.appendChild(statCard(state.notes.length, 'Notes', 'notebook', null));

    var buckets = [
      { key: 'now', label: LABEL_NOW, empty: 'Nothing planned for ' + LABEL_NOW.toLowerCase() + '.', tasks: nowTasks },
      { key: 'later', label: LABEL_LATER, empty: 'Nothing waiting.', tasks: live.filter(function (t) { return !t.today; }) },
      { key: 'archived', label: 'Archived', empty: 'Nothing archived yet.', tasks: state.tasks.filter(function (t) { return t.archived; }) }
    ];
    var current = buckets.filter(function (b) { return b.key === state.homeBucket; })[0] || buckets[0];

    var tabs = clear(document.getElementById('home-task-tabs'));
    buckets.forEach(function (bucket) {
      var tab = el('button', 'panel-tab' + (bucket === current ? ' is-active' : ''));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', bucket === current ? 'true' : 'false');
      tab.appendChild(document.createTextNode(bucket.label));
      tab.appendChild(el('span', 'panel-tab-count', String(bucket.tasks.length)));
      tab.addEventListener('click', function () { state.homeBucket = bucket.key; renderHome(); });
      tabs.appendChild(tab);
    });

    var taskHost = clear(document.getElementById('home-tasks'));
    if (!current.tasks.length) taskHost.appendChild(el('p', 'empty', current.empty));
    current.tasks.slice(0, HOME_ROWS).forEach(function (task) {
      var row = el('div', 'mini mini-task');
      var text = el('div', 'mini-text');
      text.appendChild(el('div', 'mini-title' + (task.status === 'Done' ? ' is-done' : ''), task.name || '(untitled)'));
      text.appendChild(el('div', 'mini-sub', task.status));
      row.appendChild(text);
      if (!task.archived) {
        var star = iconButton(task.today ? 'Move to ' + LABEL_LATER : 'Move to ' + LABEL_NOW,
          task.today ? '★' : '☆', function () { update('tasks', task.id, { today: !task.today }); });
        if (task.today) star.classList.add('is-today');
        row.appendChild(star);
      }
      taskHost.appendChild(row);
    });
    var hidden = current.tasks.length - HOME_ROWS;
    if (hidden > 0) {
      var more = el('button', 'link-btn more-link', '+' + hidden + ' more');
      more.type = 'button';
      more.addEventListener('click', function () { showTab('tasks'); });
      taskHost.appendChild(more);
    }

    var noteHost = clear(document.getElementById('home-notes'));
    if (!state.notes.length) noteHost.appendChild(el('p', 'empty', 'No notes yet.'));
    state.notes.slice(0, HOME_NOTES).forEach(function (note) {
      var row = el('button', 'mini mini-note');
      row.type = 'button';
      var isList = note.kind === 'list';
      row.appendChild(el('div', 'mini-title', (isList ? '☑ ' : '') + (note.title || (isList ? '(untitled list)' : '(untitled note)'))));
      if (isList) row.appendChild(listPreview(note.items || []));
      else if (String(note.body || '').trim()) row.appendChild(notePreview(note.body));
      row.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        showTab('notebook');
        var card = document.querySelector('.note[data-id="' + note.id + '"]');
        if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); setTimeout(function () { card.classList.remove('flash'); }, 900); }
      });
      noteHost.appendChild(row);
    });
  }

  function listPreview(items) {
    var box = el('div', 'mini-sub mini-list');
    var open = items.filter(function (i) { return !i.done && i.text.trim(); });
    var done = items.filter(function (i) { return i.done; }).length;
    open.slice(0, 4).forEach(function (i) { box.appendChild(el('div', null, '☐ ' + i.text)); });
    if (open.length > 4) box.appendChild(el('div', null, '+' + (open.length - 4) + ' more'));
    if (items.length) box.appendChild(el('div', 'mini-list-count', done + ' of ' + items.length + ' done'));
    else box.appendChild(el('div', null, 'Empty list'));
    return box;
  }

  function notePreview(body) {
    var box = mdInto(el('div', 'mini-sub md'), body);
    function check() {
      if (!box.clientHeight) return;
      box.classList.toggle('is-cut', box.scrollHeight > box.clientHeight + 1);
    }
    if (window.ResizeObserver) new ResizeObserver(check).observe(box);
    requestAnimationFrame(check);
    return box;
  }

  function statCard(count, label, tab, filter, highlight) {
    var card = el('button', 'stat' + (highlight ? ' is-highlight' : ''));
    card.type = 'button';
    card.appendChild(el('div', 'num', String(count)));
    card.appendChild(el('div', 'label', label));
    card.addEventListener('click', function () {
      if (tab === 'tasks') { state.taskFilter = filter || 'All'; renderTasks(); }
      showTab(tab);
    });
    return card;
  }

  /* ------------------------------------------------------------ tasks -- */
  function renderTasks() {
    var filters = clear(document.getElementById('task-filters'));
    ['All'].concat(state.statuses).forEach(function (name) {
      var chip = el('button', 'chip' + (state.taskFilter === name ? ' is-active' : ''), name);
      chip.type = 'button';
      chip.addEventListener('click', function () { state.taskFilter = name; renderTasks(); });
      filters.appendChild(chip);
    });

    var host = clear(document.getElementById('task-list'));
    var visible = state.tasks.filter(function (t) { return state.taskFilter === 'All' || t.status === state.taskFilter; });
    if (!visible.length) {
      host.appendChild(el('p', 'empty', state.tasks.length ? 'No tasks match this filter.' : 'No tasks yet. Add one above.'));
      return;
    }
    var live = visible.filter(function (t) { return !t.archived; });
    var archived = visible.filter(function (t) { return t.archived; });
    taskSection(host, LABEL_NOW, live.filter(function (t) { return t.today; }), 'Nothing planned for ' + LABEL_NOW.toLowerCase() + '. Tap ☆ on a task to move it here.');
    taskSection(host, LABEL_LATER, live.filter(function (t) { return !t.today; }), 'Nothing waiting.');
    if (archived.length) archiveSection(host, archived);
  }

  function taskSection(host, label, tasks, emptyText) {
    var head = el('h3', 'group-head');
    head.appendChild(document.createTextNode(label + ' '));
    head.appendChild(el('span', 'group-count', String(tasks.length)));
    host.appendChild(head);
    var list = el('div', 'list');
    if (!tasks.length) list.appendChild(el('p', 'empty', emptyText));
    tasks.forEach(function (t) { list.appendChild(taskRow(t, list)); });
    host.appendChild(list);
  }

  function archiveSection(host, tasks) {
    var box = el('details', 'archive');
    box.open = state.archiveOpen;
    box.addEventListener('toggle', function () { state.archiveOpen = box.open; });
    box.appendChild(el('summary', 'group-head', 'Archive (' + tasks.length + ')'));
    var list = el('div', 'list');
    tasks.forEach(function (t) { list.appendChild(taskRow(t, list)); });
    box.appendChild(list);
    host.appendChild(box);
  }

  function taskRow(task, list) {
    var row = el('div', 'row');
    row.dataset.id = task.id;
    var handle = el('span', 'handle', '⠿');
    handle.title = 'Drag to reorder';
    row.appendChild(handle);

    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-title' + (task.status === 'Done' ? ' is-done' : ''), task.name || '(untitled)'));
    if (task.notes) main.appendChild(mdInto(el('div', 'row-sub md'), task.notes));

    // Status sits under the title, leaving the right-hand side for the buttons.
    var select = el('select', 'status-select');
    select.setAttribute('aria-label', 'Status');
    state.statuses.forEach(function (status) {
      var o = el('option', null, status);
      o.value = status;
      if (status === task.status) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', function () { update('tasks', task.id, { status: select.value }); });
    var statusRow = el('div', 'row-status');
    statusRow.appendChild(select);
    main.appendChild(statusRow);
    row.appendChild(main);

    // Icon + word buttons: a column of big targets on phones, a compact icon row on desktop.
    var actions = el('div', 'task-actions');
    if (!task.archived) {
      var star = actionButton(task.today ? 'Move to ' + LABEL_LATER : 'Move to ' + LABEL_NOW,
        task.today ? '★' : '☆', task.today ? LABEL_NOW : LABEL_NOW,
        function () { update('tasks', task.id, { today: !task.today }); });
      if (task.today) star.classList.add('is-on');
      actions.appendChild(star);
    }
    // Archiving clears "today" so a restored task comes back to Later.
    actions.appendChild(actionButton(task.archived ? 'Restore' : 'Archive', task.archived ? '⇧' : '⇩',
      task.archived ? 'Restore' : 'Archive', function () {
        update('tasks', task.id, task.archived ? { archived: false } : { archived: true, today: false });
      }));
    actions.appendChild(actionButton('Edit', '✎', 'Edit', function () { editTask(task.id); }));
    var del = actionButton('Delete', '✕', 'Delete', function () { remove('tasks', task.id, task.name); });
    del.classList.add('danger');
    actions.appendChild(del);
    row.appendChild(actions);

    attachHandle(row, handle, list, '.row', 'tasks', false);
    return row;
  }

  function actionButton(label, glyph, word, onClick) {
    var b = el('button', 'act-btn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.appendChild(el('span', 'act-icon', glyph));
    b.appendChild(el('span', 'act-label', word));
    b.addEventListener('click', onClick);
    return b;
  }

  function editTask(id) {
    var task = byId(state.tasks, id);
    if (!task) return;
    openEditor('Edit task', [
      { name: 'name', label: 'Task name', value: task.name },
      { name: 'notes', label: 'Details', type: 'rich', value: task.notes, placeholder: 'Add details…' },
      { name: 'status', label: 'Status', type: 'select', options: state.statuses, value: task.status }
    ], function (values) { update('tasks', id, values); });
  }

  /* -------------------------------------------------------- reminders -- */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateInputValue(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function timeInputValue(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  // Date + time fields → a moment in the phone's own time zone.
  function fromInputs(dateStr, timeStr) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    var t = /^(\d{1,2}):(\d{2})/.exec(timeStr || '');
    if (!d || !t) return NaN;
    return new Date(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0, 0).getTime();
  }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function whenLabel(ms) {
    var d = new Date(ms);
    var days = Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86400000);
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    var day;
    if (days === 0) day = 'Today';
    else if (days === 1) day = 'Tomorrow';
    else if (days === -1) day = 'Yesterday';
    else if (days > 1 && days < 7) day = d.toLocaleDateString(undefined, { weekday: 'long' });
    else day = d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
    });
    return day + ' · ' + time;
  }
  function upcomingReminders() {
    return state.reminders.filter(function (r) { return r.status !== 'sent'; })
      .sort(function (a, b) { return a.dueAtMs - b.dueAtMs; });
  }
  function sentReminders() {
    return state.reminders.filter(function (r) { return r.status === 'sent'; })
      .sort(function (a, b) { return b.dueAtMs - a.dueAtMs; });
  }

  // Sensible defaults: today, at the next whole hour.
  function resetReminderForm() {
    var next = new Date();
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    document.getElementById('rem-title').value = '';
    document.getElementById('rem-desc').value = '';
    document.getElementById('rem-date').value = dateInputValue(next);
    document.getElementById('rem-time').value = timeInputValue(next);
  }

  var remOpenSent = false;
  function renderReminders() {
    renderPushBanner();
    var host = clear(document.getElementById('rem-list'));
    var upcoming = upcomingReminders();
    var sent = sentReminders();

    var head = el('h3', 'group-head');
    head.appendChild(document.createTextNode('Upcoming '));
    head.appendChild(el('span', 'group-count', String(upcoming.length)));
    host.appendChild(head);
    var list = el('div', 'list');
    if (!upcoming.length) list.appendChild(el('p', 'empty', 'No reminders coming up.'));
    upcoming.forEach(function (r) { list.appendChild(reminderRow(r)); });
    host.appendChild(list);

    if (sent.length) {
      var box = el('details', 'archive');
      box.open = remOpenSent;
      box.addEventListener('toggle', function () { remOpenSent = box.open; });
      var summary = el('summary', 'group-head', 'Sent (' + sent.length + ')');
      box.appendChild(summary);
      var sentList = el('div', 'list');
      sent.forEach(function (r) { sentList.appendChild(reminderRow(r)); });
      var clearAll = el('button', 'ghost danger rem-clear', 'Clear sent reminders');
      clearAll.type = 'button';
      clearAll.addEventListener('click', function () {
        if (!window.confirm('Delete all ' + sent.length + ' sent reminder' + (sent.length === 1 ? '' : 's') + '?')) return;
        sent.forEach(function (r) { Store.remove('reminders', r.id); });
        state.reminders = state.reminders.filter(function (r) { return r.status !== 'sent'; });
        rerender('reminders');
      });
      sentList.appendChild(clearAll);
      box.appendChild(sentList);
      host.appendChild(box);
    }
  }

  function reminderRow(r) {
    var sent = r.status === 'sent';
    var overdue = !sent && r.dueAtMs < Date.now() - 90 * 1000;
    var row = el('div', 'row rem-row' + (sent ? ' is-sent' : ''));
    row.dataset.id = r.id;
    row.appendChild(el('span', 'rem-icon', sent ? '✓' : '🔔'));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-title', r.title || '(untitled)'));
    if (r.description) main.appendChild(el('div', 'row-sub', r.description));
    var when = el('div', 'rem-when-label', whenLabel(r.dueAtMs));
    if (overdue) when.appendChild(el('span', 'pill rem-late', 'Sending…'));
    main.appendChild(when);
    row.appendChild(main);
    var actions = el('div', 'row-actions');
    actions.appendChild(iconButton(sent ? 'Remind me again' : 'Edit', sent ? '↻' : '✎', function () { editReminder(r.id); }));
    actions.appendChild(iconButton('Delete', '✕', function () { remove('reminders', r.id, r.title); }, true));
    row.appendChild(actions);
    return row;
  }

  function editReminder(id) {
    var r = byId(state.reminders, id);
    if (!r) return;
    var due = new Date(r.status === 'sent' ? Math.max(r.dueAtMs, Date.now() + 3600000) : r.dueAtMs);
    openEditor(r.status === 'sent' ? 'Remind me again' : 'Edit reminder', [
      { name: 'title', label: 'Remind me to…', value: r.title },
      { name: 'description', label: 'Details (optional)', type: 'textarea', value: r.description },
      { name: 'date', label: 'Date', type: 'date', value: dateInputValue(due) },
      { name: 'time', label: 'Time', type: 'time', value: timeInputValue(due) }
    ], function (v) {
      var ms = fromInputs(v.date, v.time);
      if (!v.title.trim()) { toast('Give the reminder a title', true); return; }
      if (!Number.isFinite(ms)) { toast('Pick a date and time', true); return; }
      if (ms <= Date.now()) { toast('That time has already passed', true); return; }
      update('reminders', id, { title: v.title.trim(), description: v.description.trim(), dueAtMs: ms });
    });
  }

  document.getElementById('rem-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = document.getElementById('rem-title');
    var ms = fromInputs(document.getElementById('rem-date').value, document.getElementById('rem-time').value);
    if (!title.value.trim()) { toast('What should I remind you about?', true); title.focus(); return; }
    if (!Number.isFinite(ms)) { toast('Pick a date and time', true); return; }
    if (ms <= Date.now()) { toast('That time has already passed', true); return; }
    create('reminders', { title: title.value.trim(), description: document.getElementById('rem-desc').value.trim(), dueAtMs: ms })
      .then(function () {
        toast('Reminder set for ' + whenLabel(ms).replace(' · ', ' at '));
        if (pushState() === 'off') pulseBanner();
      });
    resetReminderForm();
    title.focus();
  });
  resetReminderForm();

  // Keep "Today/Tomorrow" and "Sending…" labels current.
  setInterval(function () {
    if (document.hidden || state.tab !== 'reminders' || isEditing()) return;
    renderReminders();
  }, 30000);

  /* ------------------------------------------- notifications (push) -- */
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }
  function tokenKey() { return 'everything-app:push-token:' + (currentUid || ''); }
  function savedToken() { try { return localStorage.getItem(tokenKey()); } catch (e) { return null; } }
  function saveToken(t) { try { if (t) localStorage.setItem(tokenKey(), t); else localStorage.removeItem(tokenKey()); } catch (e) { /* ignore */ } }

  // 'on' | 'off' | 'denied' | 'install' (iPhone, not the Home Screen app) | 'unsupported'
  function pushState() {
    if (isIOS && !isStandalone()) return 'install';
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission === 'granted' && savedToken()) return 'on';
    return 'off';
  }

  function deviceLabel() {
    var ua = navigator.userAgent;
    var what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device';
    var browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return what + (browser ? ' · ' + browser : '') + (isStandalone() ? ' (app)' : '');
  }

  async function getPushToken() {
    var api = await messaging();
    if (!api) throw new Error('This browser can\'t receive notifications.');
    if (!api.vapidKey || /^PASTE/.test(api.vapidKey)) throw new Error('Notifications aren\'t set up yet — the Web Push key is missing from js/push-config.js.');
    var reg = await navigator.serviceWorker.ready;
    return api.m.getToken(api.messaging, { vapidKey: api.vapidKey, serviceWorkerRegistration: reg });
  }

  async function enablePush() {
    // Must run straight from the tap, or iPhone ignores the request.
    var permission = await Notification.requestPermission();
    if (permission !== 'granted') { renderPushBanner(); return; }
    var token = await getPushToken();
    await Store.registerDevice(token, deviceLabel());
    saveToken(token);
    setBannerDismissed(false);
    renderPushBanner();
    toast('Notifications are on for this device');
  }

  async function disablePush() {
    await forgetDevice();
    renderPushBanner();
    toast('Notifications are off for this device');
  }

  // Tokens can change; re-register quietly each time the app opens.
  async function refreshPush() {
    if (pushState() !== 'on') { renderPushBanner(); return; }
    try {
      var token = await getPushToken();
      var old = savedToken();
      if (token !== old) {
        if (old) Store.unregisterDevice(old).catch(function () {});
        saveToken(token);
      }
      await Store.registerDevice(token, deviceLabel());
    } catch (e) { /* offline or blocked — try again next launch */ }
    renderPushBanner();
  }

  async function forgetDevice() {
    var token = savedToken();
    if (!token) return;
    saveToken(null);
    try {
      var timeout = new Promise(function (resolve) { setTimeout(resolve, 4000); });
      await Promise.race([Store.unregisterDevice(token), timeout]);
      var api = await messaging();
      if (api) await Promise.race([api.m.deleteToken(api.messaging), timeout]);
    } catch (e) { /* ignore */ }
  }

  function sendTest() {
    var ms = Date.now() + 60 * 1000;
    create('reminders', { title: 'Test reminder', description: 'If you can see this, reminders are working.', dueAtMs: ms })
      .then(function () { toast('Test reminder set — it should arrive within about a minute. You can close the app.'); });
  }

  function pulseBanner() {
    var b = document.querySelector('#push-banner .push-banner');
    if (!b) return;
    b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
  }

  function renderPushMenu(st) {
    var host = clear(document.getElementById('menu-push'));
    function item(label, fn) {
      var b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', function () {
        closeMenu();
        Promise.resolve().then(fn).catch(fail);
      });
      host.appendChild(b);
    }
    if (st === 'on') {
      host.appendChild(el('div', 'menu-note', '🔔 Notifications on for this device'));
      item('Send a test notification', sendTest);
      item('Turn off notifications here', disablePush);
    } else if (st === 'off') {
      item('🔔 Turn on notifications here', enablePush);
    }
    if (host.childNodes.length) host.appendChild(el('div', 'menu-divider'));
  }

  function renderPushBanner() {
    var host = clear(document.getElementById('push-banner'));
    var st = pushState();
    var box = el('div', 'push-banner is-' + st);
    var text = el('div', 'push-text');
    var actions = el('div', 'push-actions');
    function button(label, cls, fn) {
      var b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', function () {
        b.disabled = true;
        Promise.resolve().then(fn).catch(fail).finally(function () { b.disabled = false; });
      });
      actions.appendChild(b);
    }
    renderPushMenu(st);
    // Once it's on there's nothing to say; the controls live in the account menu.
    if (st === 'on') return;
    // Dismissed on this device: stay quiet (the account menu can still turn it on).
    if (bannerDismissed()) return;
    if (st === 'off') {
      text.appendChild(el('strong', null, 'Turn on notifications'));
      text.appendChild(el('span', null, ' so reminders pop up on this device, even when the app is closed.'));
      button('Turn on', 'primary', enablePush);
    } else if (st === 'denied') {
      text.appendChild(el('strong', null, 'Notifications are blocked'));
      text.appendChild(el('span', null, isIOS
        ? ' — open iPhone Settings → Notifications → Everything, and allow them.'
        : ' — click the icon left of the address bar (or open site settings) and allow Notifications, then reload.'));
    } else if (st === 'install') {
      text.appendChild(el('strong', null, 'To get reminder notifications on iPhone,'));
      text.appendChild(el('span', null, ' open the Everything app from your Home Screen (Safari → Share → Add to Home Screen) and turn them on there.'));
    } else {
      text.appendChild(el('strong', null, 'This browser can\'t show notifications.'));
      text.appendChild(el('span', null, ' Reminders will still sync — turn notifications on from your phone or another browser.'));
    }
    button('Not on this device', 'link-btn push-dismiss', function () {
      setBannerDismissed(true);
      renderPushBanner();
      toast('OK — you can still turn them on from the account menu');
    });
    box.appendChild(text);
    box.appendChild(actions);
    host.appendChild(box);
  }

  function dismissKey() { return 'everything-app:push-dismissed:' + (currentUid || ''); }
  function bannerDismissed() { try { return localStorage.getItem(dismissKey()) === '1'; } catch (e) { return false; } }
  function setBannerDismissed(on) {
    try { if (on) localStorage.setItem(dismissKey(), '1'); else localStorage.removeItem(dismissKey()); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ links -- */
  function isSafeUrl(url) { return /^https?:\/\//i.test(String(url || '')); }

  function groupLinks() {
    var groups = {};
    state.links.forEach(function (link) {
      var c = link.category || 'General';
      (groups[c] || (groups[c] = [])).push(link);
    });
    return groups;
  }

  function renderLinks() {
    var host = clear(document.getElementById('link-groups'));
    var groups = groupLinks();
    var categories = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    var datalist = clear(document.getElementById('link-categories'));
    categories.forEach(function (c) { var o = el('option'); o.value = c; datalist.appendChild(o); });
    if (!categories.length) { host.appendChild(el('p', 'empty', 'No links yet. Add one above.')); return; }
    categories.forEach(function (category) {
      var head = el('h3', 'group-head');
      head.appendChild(document.createTextNode(category + ' '));
      head.appendChild(el('span', 'group-count', String(groups[category].length)));
      host.appendChild(head);
      var list = el('div', 'list');
      groups[category].forEach(function (link) { list.appendChild(linkRow(link, list)); });
      host.appendChild(list);
    });
  }

  function linkRow(link, list) {
    var row = el('div', 'row');
    row.dataset.id = link.id;
    var handle = el('span', 'handle', '⠿');
    handle.title = 'Drag to reorder';
    row.appendChild(handle);
    var main = el('div', 'row-main');
    if (isSafeUrl(link.url)) {
      var a = el('a', 'row-title', link.title || link.url);
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      main.appendChild(a);
      var host = '';
      try { host = new URL(link.url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
      if (host && link.title) main.appendChild(el('div', 'row-host', host));
    } else {
      main.appendChild(el('div', 'row-title', link.title || '(no title)'));
    }
    if (link.notes) main.appendChild(el('div', 'row-sub', link.notes));
    row.appendChild(main);
    var actions = el('div', 'row-actions');
    actions.appendChild(iconButton('Edit', '✎', function () { editLink(link.id); }));
    actions.appendChild(iconButton('Delete', '✕', function () { remove('links', link.id, link.title); }, true));
    row.appendChild(actions);
    attachHandle(row, handle, list, '.row', 'links', false);
    return row;
  }

  function editLink(id) {
    var link = byId(state.links, id);
    if (!link) return;
    openEditor('Edit link', [
      { name: 'title', label: 'Label', value: link.title },
      { name: 'url', label: 'URL', value: link.url },
      { name: 'category', label: 'Category', value: link.category },
      { name: 'notes', label: 'Description', type: 'textarea', value: link.notes }
    ], function (values) {
      if (!values.url.trim()) { toast('A URL is required', true); return; }
      update('links', id, values);
    });
  }

  /* --------------------------------------------------------- notebook -- */
  function renderNotes() {
    var grid = clear(document.getElementById('note-grid'));
    if (!state.notes.length) { grid.appendChild(el('p', 'empty', 'Nothing here yet. Start a note or a list.')); return; }
    state.notes.forEach(function (n) { grid.appendChild(noteCard(n, grid)); });
  }

  function noteCard(note, grid) {
    var color = note.color || state.colors[0];
    var card = el('div', 'note c-' + color);
    card.dataset.id = note.id;

    var bar = el('div', 'note-bar');
    var handle = el('span', 'handle', '⠿');
    handle.title = 'Drag to reorder';
    bar.appendChild(handle);
    var swatches = el('div', 'swatches');
    state.colors.forEach(function (name) {
      var sw = el('button', 'swatch c-' + name + (name === color ? ' is-active' : ''));
      sw.type = 'button';
      sw.title = name;
      sw.setAttribute('aria-label', 'Colour ' + name);
      sw.addEventListener('click', function () {
        note.color = name;
        card.className = 'note c-' + name;
        Array.prototype.forEach.call(swatches.children, function (s) { s.classList.toggle('is-active', s.title === name); });
        update('notes', note.id, { color: name }, true);
      });
      swatches.appendChild(sw);
    });
    bar.appendChild(swatches);
    bar.appendChild(iconButton('Delete', '✕', function () { remove('notes', note.id, note.title); }, true));
    card.appendChild(bar);

    var title = el('input', 'note-title');
    title.type = 'text';
    title.placeholder = note.kind === 'list' ? 'List name' : 'Title';
    title.value = note.title || '';
    title.addEventListener('input', function () { queueSave(note.id, 'notes', { title: title.value }); });
    card.appendChild(title);

    if (note.kind === 'list') {
      card.classList.add('is-list');
      card.appendChild(listBody(note, card));
      card.addEventListener('focusout', function () {
        // A redraw briefly removes the focused field; only save once focus has
        // really left the card.
        setTimeout(function () { if (!card.contains(document.activeElement)) flushSave(note.id); }, 0);
      });
      attachHandle(card, handle, grid, '.note', 'notes', true);
      return card;
    }

    var body = RichText.create({
      value: note.body,
      placeholder: 'Write something…',
      toolbar: 'focus',
      className: 'note-rte',
      onInput: function (html) { queueSave(note.id, 'notes', { body: html }); }
    });
    // Save as soon as focus leaves the note (toolbar clicks don't count).
    card.addEventListener('focusout', function (e) {
      if (card.contains(e.relatedTarget)) return;
      setTimeout(function () { if (!card.contains(document.activeElement)) flushSave(note.id); }, 0);
    });
    card.appendChild(body.el);

    attachHandle(card, handle, grid, '.note', 'notes', true);
    return card;
  }

  /* ----------------------------------------------------------- lists -- */
  function newItem(text) {
    return { id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), text: text || '', done: false };
  }

  // A checklist inside a note card. Unchecked items first (in their own
  // order), checked ones below, struck through.
  function listBody(note, card) {
    note.items = Array.isArray(note.items) ? note.items : [];
    var wrap = el('div', 'list-body');
    var itemsHost = el('div', 'list-items');
    var footer = el('div', 'list-footer');
    wrap.appendChild(itemsHost);

    var adder = el('div', 'list-adder');
    adder.appendChild(el('span', 'list-plus', '＋'));
    var addInput = el('input', 'list-add-input');
    addInput.type = 'text';
    addInput.placeholder = 'Add an item';
    addInput.setAttribute('enterkeyhint', 'next');
    adder.appendChild(addInput);
    wrap.appendChild(adder);
    wrap.appendChild(footer);

    function save(now) {
      queueSave(note.id, 'notes', { items: note.items.map(function (i) { return { id: i.id, text: i.text, done: i.done }; }) });
      if (now) flushSave(note.id);
    }

    function addFromText(text, afterId) {
      var lines = String(text).split(/\r?\n/).map(function (l) { return l.replace(/^\s*(?:[-*•]|\[[ xX]?\]|\d+[.)])\s*/, '').trim(); })
        .filter(Boolean);
      if (!lines.length) return null;
      var at = afterId ? note.items.findIndex(function (i) { return i.id === afterId; }) + 1 : note.items.length;
      var made = lines.map(function (l) { return newItem(l); });
      note.items.splice.apply(note.items, [at, 0].concat(made));
      return made[made.length - 1];
    }

    function draw(focusId, caretEnd) {
      clear(itemsHost);
      var open = note.items.filter(function (i) { return !i.done; });
      var done = note.items.filter(function (i) { return i.done; });
      open.concat(done).forEach(function (item) { itemsHost.appendChild(itemRow(item)); });
      clear(footer);
      if (note.items.length) {
        footer.appendChild(el('span', 'list-count', done.length + ' of ' + note.items.length + ' done'));
        if (done.length) {
          var clr = el('button', 'link-btn', 'Clear checked');
          clr.type = 'button';
          clr.addEventListener('click', function () {
            note.items = note.items.filter(function (i) { return !i.done; });
            save(true);
            draw();
          });
          footer.appendChild(clr);
        }
      }
      if (focusId) {
        var f = itemsHost.querySelector('[data-item="' + focusId + '"] .list-text');
        if (f) { f.focus(); var n = caretEnd === false ? 0 : f.value.length; f.setSelectionRange(n, n); }
      }
    }

    function itemRow(item) {
      var row = el('div', 'list-item' + (item.done ? ' is-done' : ''));
      row.dataset.item = item.id;
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.done;
      box.setAttribute('aria-label', 'Done');
      box.addEventListener('change', function () {
        item.done = box.checked;
        save(true);
        row.classList.toggle('is-done', item.done);
        // Let the tick show for a moment before the item moves.
        setTimeout(function () { draw(); }, 250);
      });
      var text = el('input', 'list-text');
      text.type = 'text';
      text.value = item.text;
      text.setAttribute('enterkeyhint', 'next');
      text.addEventListener('input', function () { item.text = text.value; save(); });
      text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var made = newItem('');
          var at = note.items.indexOf(item) + 1;
          note.items.splice(at, 0, made);
          save();
          draw(made.id);
        } else if (e.key === 'Backspace' && !text.value) {
          e.preventDefault();
          var visible = Array.prototype.map.call(itemsHost.querySelectorAll('.list-item'), function (r) { return r.dataset.item; });
          var prev = visible[visible.indexOf(item.id) - 1];
          note.items = note.items.filter(function (i) { return i !== item; });
          save();
          if (prev) draw(prev); else { draw(); addInput.focus(); }
        }
      });
      text.addEventListener('blur', function () {
        // Empty items tidy themselves away.
        if (!item.text.trim() && document.activeElement !== text) {
          setTimeout(function () {
            if (card.contains(document.activeElement) && document.activeElement.closest('[data-item="' + item.id + '"]')) return;
            if (note.items.indexOf(item) === -1 || item.text.trim()) return;
            note.items = note.items.filter(function (i) { return i !== item; });
            save();
            draw(document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-item]')
              ? document.activeElement.closest('[data-item]').dataset.item : null);
          }, 0);
        }
      });
      text.addEventListener('paste', function (e) {
        var t = e.clipboardData && e.clipboardData.getData('text/plain');
        if (!t || t.indexOf('\n') === -1) return;
        e.preventDefault();
        var last = addFromText(t, item.id);
        if (!item.text.trim()) note.items = note.items.filter(function (i) { return i !== item; });
        save();
        draw(last && last.id);
      });
      var del = iconButton('Remove item', '✕', function () {
        note.items = note.items.filter(function (i) { return i !== item; });
        save(true);
        draw();
      });
      del.classList.add('list-del');
      row.appendChild(box);
      row.appendChild(text);
      row.appendChild(del);
      return row;
    }

    addInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!addInput.value.trim()) return;
      addFromText(addInput.value);
      addInput.value = '';
      save();
      draw();
      addInput.focus();
    });
    addInput.addEventListener('blur', function () {
      if (!addInput.value.trim()) return;
      addFromText(addInput.value);
      addInput.value = '';
      save();
      draw();
    });
    addInput.addEventListener('paste', function (e) {
      var t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!t || t.indexOf('\n') === -1) return;
      e.preventDefault();
      addFromText(t);
      save();
      draw();
      addInput.focus();
    });

    draw();
    return wrap;
  }

  /* ------------------------------------------------- help & version -- */
  var APP_VERSION = window.APP_VERSION || '';
  document.getElementById('app-version').textContent = APP_VERSION;
  document.getElementById('help-version').textContent = 'You\u2019re on version ' + APP_VERSION + '.';
  var helpDialog = document.getElementById('help');
  document.getElementById('help-open').addEventListener('click', function () { helpDialog.showModal(); });
  document.getElementById('help-close').addEventListener('click', function () { helpDialog.close(); });
  document.getElementById('help-done').addEventListener('click', function () { helpDialog.close(); });
  helpDialog.addEventListener('click', function (e) { if (e.target === helpDialog) helpDialog.close(); });

  /* ----------------------------------------------------------- admin -- */
  // Only decides whether to show the menu item; the server does the real check.
  var ADMIN_EMAILS = ['craig.willett@gmail.com'];
  var adminDialog = document.getElementById('admin');

  function isAdmin(user) {
    return !!user && !!user.email && ADMIN_EMAILS.indexOf(user.email.toLowerCase()) !== -1;
  }

  function fmtWhen(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d)) return '—';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var days = Math.round((startOfDay(Date.now()) - startOfDay(d.getTime())) / 86400000);
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (days === 0) return 'today ' + time;
    if (days === 1) return 'yesterday ' + time;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function n(v) { return v == null ? '?' : String(v); }

  function statTile(icon, label, total, today, extra) {
    var t = el('div', 'admin-stat');
    var top = el('div', 'admin-stat-top');
    top.appendChild(el('span', 'admin-stat-num', n(total)));
    if (today) top.appendChild(el('span', 'admin-stat-today', '+' + today + ' today'));
    t.appendChild(top);
    t.appendChild(el('div', 'admin-stat-label', icon + ' ' + label));
    if (extra) t.appendChild(el('div', 'admin-stat-extra', extra));
    return t;
  }

  function renderAdmin(data) {
    var host = clear(document.getElementById('admin-body'));
    var users = data.users || [];
    var sum = function (f) { return users.reduce(function (a, u) { return a + (Number(f(u)) || 0); }, 0); };

    var totals = el('div', 'admin-totals');
    [['Accounts', users.length],
      ['Tasks', sum(function (u) { return u.tasks.total; })],
      ['Notes & lists', sum(function (u) { return u.notes.total; })],
      ['Reminders', sum(function (u) { return u.reminders.total; })],
      ['Added today', sum(function (u) { return u.tasks.today + u.notes.today + u.reminders.today + u.links.today; })]
    ].forEach(function (p) {
      var b = el('div', 'admin-total');
      b.appendChild(el('div', 'admin-total-num', String(p[1])));
      b.appendChild(el('div', 'admin-total-label', p[0]));
      totals.appendChild(b);
    });
    host.appendChild(totals);

    users.forEach(function (u) {
      var card = el('div', 'admin-user');
      var head = el('div', 'admin-user-head');
      var avatar = el('span', 'admin-avatar', ((u.name || u.email || '?').trim()[0] || '?').toUpperCase());
      head.appendChild(avatar);
      var who = el('div', 'admin-who');
      who.appendChild(el('div', 'admin-name', u.name || (u.email || '').split('@')[0] || '(no name)'));
      who.appendChild(el('div', 'admin-email', u.email + (u.provider === 'google.com' ? ' · Google' : ' · email & password')));
      head.appendChild(who);
      var seen = el('div', 'admin-seen');
      seen.appendChild(el('div', null, 'Active ' + fmtWhen(u.lastSignIn)));
      seen.appendChild(el('div', 'admin-joined', 'Joined ' + fmtWhen(u.created)));
      head.appendChild(seen);
      card.appendChild(head);

      var grid = el('div', 'admin-stats');
      grid.appendChild(statTile('✅', 'Tasks', u.tasks.total, u.tasks.today,
        n(u.tasks.inToday) + ' in Today · ' + n(u.tasks.done) + ' done · ' + n(u.tasks.archived) + ' archived'));
      grid.appendChild(statTile('📝', 'Notes & lists', u.notes.total, u.notes.today,
        n(u.notes.lists) + ' list' + (u.notes.lists === 1 ? '' : 's')));
      grid.appendChild(statTile('🔔', 'Reminders', u.reminders.total, u.reminders.today,
        n(u.reminders.upcoming) + ' upcoming'));
      grid.appendChild(statTile('🔗', 'Links', u.links.total, u.links.today, ''));
      grid.appendChild(statTile('📱', 'Notified devices', u.devices, 0, u.devices ? 'getting reminders' : 'notifications off'));
      card.appendChild(grid);
      host.appendChild(card);
    });
    host.appendChild(el('p', 'hint admin-foot', 'Updated ' + fmtWhen(data.generatedAt) +
      '. "Today" means since midnight Eastern. Counts are what exists now — deleted items aren\u2019t counted.'));
  }

  function loadAdmin() {
    var host = clear(document.getElementById('admin-body'));
    host.appendChild(el('p', 'empty', 'Loading…'));
    var btn = document.getElementById('admin-refresh');
    btn.disabled = true;
    adminStats().then(renderAdmin).catch(function (e) {
      clear(host).appendChild(el('p', 'admin-error',
        (e && e.code && /permission-denied/.test(e.code)) ? 'Only the app admin can see this page.'
          : (e && /not-found|internal/.test(e.code || '') ? 'The admin function isn\u2019t deployed yet — run: firebase deploy --only functions'
            : 'Couldn\u2019t load the numbers: ' + (e && e.message ? e.message : e))));
    }).finally(function () { btn.disabled = false; });
  }

  document.getElementById('admin-open').addEventListener('click', function () {
    closeMenu();
    adminDialog.showModal();
    loadAdmin();
  });
  document.getElementById('admin-refresh').addEventListener('click', loadAdmin);
  document.getElementById('admin-close').addEventListener('click', function () { adminDialog.close(); });
  adminDialog.addEventListener('click', function (e) { if (e.target === adminDialog) adminDialog.close(); });

  /* ------------------------------------------------------ appearance -- */
  var appearanceDialog = document.getElementById('appearance');
  var appearanceSaveTimer = null;

  // Saved with the account so it follows you to your other devices. The colour
  // picker fires on every drag, so those writes are batched.
  function saveAppearance(a, batched) {
    Appearance.apply(a);
    clearTimeout(appearanceSaveTimer);
    function commit() { if (currentUid) Store.saveSettings({ appearance: Appearance.get() }); }
    if (batched) appearanceSaveTimer = setTimeout(commit, 400); else commit();
  }

  function applySavedAppearance() {
    var saved = Store.getSettings().appearance;
    if (saved) Appearance.apply(saved);
  }

  function segmented(options, value, onPick) {
    var row = el('div', 'seg');
    options.forEach(function (o) {
      var b = el('button', 'seg-btn' + (o.value === value ? ' is-active' : ''));
      b.type = 'button';
      if (o.html) b.innerHTML = o.html; else b.textContent = o.label;
      b.setAttribute('aria-pressed', o.value === value ? 'true' : 'false');
      if (o.title) b.title = o.title;
      b.addEventListener('click', function () { onPick(o.value); });
      row.appendChild(b);
    });
    return row;
  }

  function renderAppearance() {
    var a = Appearance.get();
    var host = clear(document.getElementById('appearance-body'));
    function section(label) {
      var sec = el('div', 'ap-section');
      sec.appendChild(el('div', 'ap-label', label));
      host.appendChild(sec);
      return sec;
    }
    function set(k, v) { var next = Appearance.get(); next[k] = v; saveAppearance(next); renderAppearance(); }

    var themes = el('div', 'ap-themes');
    Appearance.THEMES.forEach(function (t) {
      var b = el('button', 'ap-theme' + (t.id === a.theme ? ' is-active' : ''));
      b.type = 'button';
      var sw = el('span', 'ap-theme-swatch');
      sw.style.background = t.swatch[0];
      var dot = el('span', 'ap-theme-dot');
      dot.style.background = t.swatch[1];
      sw.appendChild(dot);
      b.appendChild(sw);
      b.appendChild(el('span', null, t.label));
      // Picking a theme clears a custom accent so the theme shows as designed.
      b.addEventListener('click', function () {
        var next = Appearance.get(); next.theme = t.id; next.accent = ''; saveAppearance(next); renderAppearance();
      });
      themes.appendChild(b);
    });
    section('Theme').appendChild(themes);

    section('Light or dark').appendChild(segmented([
      { value: 'auto', label: 'Auto', title: 'Follow the phone’s setting' },
      { value: 'light', label: '☀️ Light' },
      { value: 'dark', label: '🌙 Dark' }
    ], a.mode, function (v) { set('mode', v); }));

    var accents = el('div', 'ap-accents');
    var none = el('button', 'ap-accent ap-accent-none' + (!a.accent ? ' is-active' : ''), 'Theme');
    none.type = 'button';
    none.title = 'Use the theme’s own colour';
    none.addEventListener('click', function () { set('accent', ''); });
    accents.appendChild(none);
    Appearance.ACCENTS.forEach(function (hex) {
      var b = el('button', 'ap-accent' + (a.accent === hex ? ' is-active' : ''));
      b.type = 'button';
      b.style.background = hex;
      b.setAttribute('aria-label', 'Accent ' + hex);
      b.addEventListener('click', function () { set('accent', hex); });
      accents.appendChild(b);
    });
    var custom = el('label', 'ap-accent ap-accent-custom' + (a.accent && Appearance.ACCENTS.indexOf(a.accent) === -1 ? ' is-active' : ''));
    custom.title = 'Pick any colour';
    var picker = document.createElement('input');
    picker.type = 'color';
    picker.value = a.accent || '#e0518c';
    picker.addEventListener('input', function () { var next = Appearance.get(); next.accent = picker.value; saveAppearance(next, true); });
    picker.addEventListener('change', function () { renderAppearance(); });
    custom.appendChild(picker);
    custom.appendChild(el('span', null, '🎨'));
    accents.appendChild(custom);
    section('Accent colour').appendChild(accents);

    section('Background').appendChild(segmented([
      { value: 'plain', label: 'Plain' },
      { value: 'gradient', label: 'Glow' },
      { value: 'hearts', label: '♡ Hearts' },
      { value: 'dots', label: '• Dots' }
    ], a.bg, function (v) { set('bg', v); }));

    section('Font').appendChild(segmented([
      { value: 'default', label: 'Standard' },
      { value: 'rounded', html: '<span style="font-family:Quicksand,ui-rounded,system-ui">Rounded</span>' }
    ], a.font, function (v) { set('font', v); }));
  }

  document.getElementById('appearance-open').addEventListener('click', function () {
    closeMenu();
    renderAppearance();
    appearanceDialog.showModal();
  });
  document.getElementById('appearance-done').addEventListener('click', function () { appearanceDialog.close(); });
  document.getElementById('appearance-reset').addEventListener('click', function () {
    saveAppearance(Appearance.DEFAULTS);
    renderAppearance();
  });
  appearanceDialog.addEventListener('click', function (e) { if (e.target === appearanceDialog) appearanceDialog.close(); });

  // One timer per record; fields typed inside the same window accumulate.
  function queueSave(id, table, values) {
    var pending = pendingSaves[id] || (pendingSaves[id] = { table: table, values: {} });
    Object.keys(values).forEach(function (k) { pending.values[k] = values[k]; });
    clearTimeout(saveTimers[id]);
    saveTimers[id] = setTimeout(function () { flushSave(id); }, 600);
  }
  function flushSave(id) {
    var pending = pendingSaves[id];
    if (!pending) return;
    clearTimeout(saveTimers[id]);
    delete pendingSaves[id];
    var local = byId(state[pending.table], id);
    if (local) Object.keys(pending.values).forEach(function (k) { local[k] = pending.values[k]; });
    run('update', pending.table, id, pending.values).catch(fail);
  }
  function flushAll() { Object.keys(pendingSaves).forEach(flushSave); }

  /* ------------------------------------------------------- mutations -- */
  function iconButton(label, glyph, onClick, danger) {
    var b = el('button', 'icon-btn' + (danger ? ' danger' : ''), glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }
  function create(table, values) {
    return run('create', table, values).then(function (item) {
      // A live update may already have added it; don't show it twice.
      if (!byId(state[table], item.id)) state[table].unshift(item);
      rerender(table);
      return item;
    }).catch(fail);
  }
  function update(table, id, values, silent) {
    return run('update', table, id, values).then(function (item) {
      replaceIn(state[table], item);
      if (!silent) rerender(table);
      else if (state.tab === 'home') renderHome();
    }).catch(fail);
  }
  function remove(table, id, label) {
    if (!window.confirm('Delete "' + (label || 'this item') + '"?')) return;
    run('remove', table, id).then(function () {
      state[table] = state[table].filter(function (i) { return i.id !== id; });
      rerender(table);
      toast('Deleted');
    }).catch(fail);
  }
  function rerender(table) {
    if (table === 'tasks') renderTasks();
    if (table === 'notes') renderNotes();
    if (table === 'links') renderLinks();
    if (table === 'reminders') renderReminders();
    if (state.tab === 'home') renderHome();
  }

  /* ----------------------------------------------------- backup / data -- */
  function exportBackup() {
    var blob = new Blob([Store.exportJson()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'everything-app-backup-' + dayKey() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    closeMenu();
  }
  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      if (!window.confirm('Replace everything in this app with the contents of "' + file.name + '"?')) return;
      Store.importJson(String(reader.result)).then(function (counts) {
        load();
        toast('Imported ' + counts.tasks + ' tasks, ' + counts.links + ' links and ' + counts.notes + ' notes');
      }).catch(fail);
    };
    reader.readAsText(file);
  }
  function closeMenu() { document.querySelector('.menu').open = false; }

  /* ------------------------------------------------------------- boot -- */
  function load() {
    pendingRender = false;
    applySavedAppearance();
    var data = Store.loadAll();
    state.tasks = data.tasks;
    state.notes = data.notes;
    state.links = data.links;
    state.reminders = data.reminders;
    renderTasks();
    renderReminders();
    renderLinks();
    renderNotes();
    renderHome();
  }

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { showTab(tab.dataset.tab); });
  });
  document.querySelectorAll('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.dataset.goto); });
  });
  window.addEventListener('hashchange', function () { showTab(location.hash.slice(1), true); });

  var taskForm = document.getElementById('task-add');
  var taskNotes = RichText.create({ placeholder: 'Details (optional)', minHeight: 70, className: 'quick-add-rte' });
  document.getElementById('task-add-notes').appendChild(taskNotes.el);
  var taskToday = document.getElementById('task-add-today');
  taskToday.parentNode.lastChild.textContent = ' Add to ' + LABEL_NOW;
  submitOnCmdEnter(taskForm);
  taskForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('task-add-name');
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    create('tasks', { name: name, notes: taskNotes.getValue(), status: state.statuses[0], today: taskToday.checked });
    input.value = '';
    taskNotes.setValue('');
    input.focus();
  });

  document.getElementById('link-add').addEventListener('submit', function (event) {
    event.preventDefault();
    var title = document.getElementById('link-add-title');
    var url = document.getElementById('link-add-url');
    var category = document.getElementById('link-add-category');
    var notes = document.getElementById('link-add-notes');
    if (!url.value.trim()) { toast('A URL is required', true); url.focus(); return; }
    if (/^[a-z][a-z0-9+.\-]*:/i.test(url.value.trim()) && !isSafeUrl(url.value.trim())) {
      toast('Only http(s) links are allowed', true); url.focus(); return;
    }
    create('links', {
      title: title.value.trim() || url.value.trim(),
      url: url.value.trim(),
      category: category.value.trim() || 'General',
      notes: notes.value.trim()
    });
    title.value = ''; url.value = ''; notes.value = '';
    title.focus();
  });

  // New notes start in a colour that suits the chosen theme.
  function themeNoteColor() {
    return { blush: 'pink', lavender: 'purple', mint: 'green', sky: 'blue' }[Appearance.get().theme] || state.colors[0];
  }

  document.getElementById('list-add').addEventListener('click', function () {
    create('notes', { title: '', kind: 'list', items: [], color: themeNoteColor() }).then(function () {
      var first = document.querySelector('#note-grid .note .note-title');
      if (first) first.focus();
    });
  });

  document.getElementById('note-add').addEventListener('click', function () {
    create('notes', { title: '', body: '', color: themeNoteColor() }).then(function () {
      var first = document.querySelector('#note-grid .note .note-title');
      if (first) first.focus();
    });
  });

  document.getElementById('export').addEventListener('click', exportBackup);
  document.getElementById('import').addEventListener('click', function () {
    closeMenu();
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });
  document.addEventListener('click', function (e) {
    var menu = document.querySelector('.menu');
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  // Never lose a half-typed note when the app is backgrounded or closed.
  document.addEventListener('visibilitychange', function () { if (document.hidden) flushAll(); });
  window.addEventListener('pagehide', flushAll);

  /* ------------------------------------------------------- live sync -- */
  // An update arrived (from this or another device). Redraw — unless you're
  // in the middle of typing or editing, in which case wait until you're done
  // so the field doesn't get yanked out from under you.
  var pendingRender = false;
  function isEditing() {
    if (dialog.open) return true;
    // Only fields inside the redrawn lists count; the add forms are static.
    var a = document.activeElement;
    if (!a || !(/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return false;
    return !!a.closest('#task-list, #link-groups, #note-grid, #home-tasks, #home-notes, #daily-tasks, #rem-list');
  }
  function scheduleRender() {
    if (isEditing() || document.querySelector('.dragging')) { pendingRender = true; return; }
    load();
  }
  document.addEventListener('focusout', function () {
    if (!pendingRender) return;
    setTimeout(function () { if (pendingRender && !isEditing()) { flushAll(); load(); } }, 50);
  });
  dialog.addEventListener('close', function () { if (pendingRender) setTimeout(scheduleRender, 0); });

  function updateNetBadge() { document.getElementById('net').hidden = navigator.onLine; }
  window.addEventListener('online', updateNetBadge);
  window.addEventListener('offline', updateNetBadge);

  /* ------------------------------------------------------------- PWA -- */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support unavailable */ });
    });
  }
  var installPrompt = null;
  var installBtn = document.getElementById('install');
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.finally(function () { installPrompt = null; installBtn.hidden = true; });
  });
  window.addEventListener('appinstalled', function () { installBtn.hidden = true; });

  /* ---------------------------------------------------------- sign in -- */
  var authView = document.getElementById('auth');
  var shell = document.querySelector('.shell');
  var bootView = document.getElementById('boot');
  var authMode = 'signin';

  function show(which) {
    bootView.hidden = which !== 'boot';
    authView.hidden = which !== 'auth';
    shell.hidden = which !== 'app';
    document.getElementById('setup').hidden = which !== 'setup';
  }
  function authError(e) {
    var code = (e && e.code) || '';
    var messages = {
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'No account with that email — tap "Create an account".',
      'auth/invalid-email': 'That email address doesn\'t look right.',
      'auth/email-already-in-use': 'There\'s already an account with that email. Sign in instead.',
      'auth/weak-password': 'Use at least 6 characters for the password.',
      'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
      'auth/network-request-failed': 'No connection. Connect to the internet to sign in.',
      'auth/popup-closed-by-user': '',
      'auth/cancelled-popup-request': '',
      'auth/popup-blocked': 'The sign-in window was blocked. Allow pop-ups, or use email and password.',
      'auth/operation-not-supported-in-this-environment': 'Google sign-in isn\'t supported here. Use email and password on this device.',
      'auth/unauthorized-domain': 'This website isn\'t authorized in Firebase yet — add it under Authentication → Settings → Authorized domains.',
      'auth/operation-not-allowed': 'That sign-in method isn\'t turned on in Firebase (Authentication → Sign-in method).'
    };
    var text = Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : (e && e.message) || String(e);
    document.getElementById('auth-error').textContent = text;
  }
  function setAuthMode(mode) {
    authMode = mode;
    document.getElementById('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    document.getElementById('auth-toggle').textContent = mode === 'signup' ? 'I already have an account' : 'Create an account';
    document.getElementById('auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    document.getElementById('auth-error').textContent = '';
  }
  function busy(on) {
    authView.querySelectorAll('button, input').forEach(function (b) { b.disabled = on; });
  }

  document.getElementById('auth-google').addEventListener('click', function () {
    document.getElementById('auth-error').textContent = '';
    busy(true);
    Store.signInWithGoogle().catch(authError).finally(function () { busy(false); });
  });
  document.getElementById('auth-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = document.getElementById('auth-email').value.trim();
    var password = document.getElementById('auth-password').value;
    if (!email || !password) { authError({ message: 'Enter your email and a password.' }); return; }
    document.getElementById('auth-error').textContent = '';
    busy(true);
    (authMode === 'signup' ? Store.createAccount(email, password) : Store.signInWithEmail(email, password))
      .catch(authError).finally(function () { busy(false); });
  });
  document.getElementById('auth-toggle').addEventListener('click', function () {
    setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
  });
  document.getElementById('auth-reset').addEventListener('click', function () {
    var email = document.getElementById('auth-email').value.trim();
    if (!email) { authError({ message: 'Type your email above first, then tap "Forgot password?".' }); return; }
    Store.resetPassword(email).then(function () {
      document.getElementById('auth-error').textContent = '';
      toast('Password reset email sent to ' + email);
    }).catch(authError);
  });
  document.getElementById('signout').addEventListener('click', function () {
    closeMenu();
    flushAll();
    if (!window.confirm('Sign out of this device?')) return;
    // Stop this device getting the signed-out person's reminders.
    forgetDevice().finally(function () { Store.signOut(); });
  });

  function maybeOfferLegacy(user) {
    var count = Store.legacySummary();
    if (!count || Store.legacyHandled(user.uid)) return;
    Store.markLegacyHandled(user.uid);
    if (!window.confirm('This device has ' + count + ' item' + (count === 1 ? '' : 's') +
      ' (tasks, links and notes) saved from before you signed in.\n\nCopy them into your account?')) return;
    var n = Store.migrateLegacy();
    load();
    toast('Copied ' + n + ' item' + (n === 1 ? '' : 's') + ' into your account');
  }

  function showUser(user) {
    var label = user.displayName || user.email || 'Signed in';
    document.getElementById('account-name').textContent = label;
    document.getElementById('account-email').textContent = user.email || '';
    document.getElementById('account-initial').textContent = (label.trim()[0] || '?').toUpperCase();
    document.getElementById('admin-open').hidden = !isAdmin(user);
  }

  var currentUid = null;
  function boot() {
    if (!Store.configured) { show('setup'); return; }
    show('boot');
    updateNetBadge();
    Store.init().then(function () {
      Store.onAuth(function (user) {
        if (!user) {
          currentUid = null;
          Store.stop();
          state.tasks = []; state.notes = []; state.links = []; state.reminders = [];
          if (appearanceDialog.open) appearanceDialog.close();
          if (adminDialog.open) adminDialog.close();
          document.getElementById('admin-open').hidden = true;
          Appearance.reset();
          setAuthMode('signin');
          document.getElementById('auth-password').value = '';
          show('auth');
          return;
        }
        if (user.uid === currentUid) return;
        currentUid = user.uid;
        showUser(user);
        show('boot');
        Store.start(user.uid, scheduleRender, fail).then(function () {
          load();
          show('app');
          showTab(location.hash.slice(1) || 'home', true);
          maybeOfferLegacy(user);
          refreshPush();
        });
      });
    }).catch(function (e) {
      bootView.textContent = navigator.onLine
        ? 'Couldn\'t start: ' + (e && e.message ? e.message : e)
        : 'You\'re offline and the app hasn\'t been opened online on this device yet. Connect once to finish setting up.';
    });
  }

  boot();
})();
