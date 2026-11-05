import { Store } from './store.js';
import { messaging, adminStats } from './cloud.js';
import { nextOccurrence, describe as describeRule, isRepeating } from './recur.js';

(function () {
  'use strict';

  /* --------------------------------------------------------- settings -- */
  // Rename the two task buckets here if you'd rather say "Current" / "Backlog".
  var LABEL_NOW = 'Today';
  var LABEL_LATER = 'Later';
  var HOME_ROWS = 6;
  var HOME_NOTES = 4;
  var DEFAULT_DAILY = ['Make today a GREAT day!', 'Complete today\'s tasks!'];
  // Repeating reminders
  var LOCAL_TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'America/New_York';
  var REPEAT_OPTIONS = [
    ['none', 'Doesn’t repeat'], ['daily', 'Every day'], ['weekdays', 'Weekdays (Mon–Fri)'],
    ['weekly', 'Every week'], ['biweekly', 'Every 2 weeks'], ['monthly', 'Every month'],
    ['yearly', 'Every year'], ['days', 'Specific days…']
  ];
  var DAY_CHIPS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

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
  var stepFields = {};
  function openEditor(title, fields, onSave) {
    richFields = {};
    stepFields = {};
    document.getElementById('editor-title').textContent = title;
    var host = clear(document.getElementById('editor-fields'));
    fields.forEach(function (field) {
      var wrap = el('div', 'field');
      var label = el('label', null, field.label);
      label.setAttribute('for', 'f-' + field.name);
      wrap.appendChild(label);
      var input;
      if (field.type === 'custom') {
        wrap.removeChild(label);
        field.render(wrap);
        host.appendChild(wrap);
        return;
      }
      if (field.type === 'steps') {
        wrap.removeChild(label);
        var se = stepsEditor(field.value);
        stepFields[field.name] = se;
        wrap.appendChild(se.el);
        if (field.after) field.after(wrap, se);
        host.appendChild(wrap);
        return;
      }
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
    Object.keys(stepFields).forEach(function (k) { values[k] = stepFields[k].getItems(); });
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
    renderInvites();
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
      var sp = stepsProgress(Array.isArray(task.steps) ? task.steps : []);
      text.appendChild(el('div', 'mini-sub', task.status + (sp.total ? ' · ' + sp.done + ' of ' + sp.total + ' steps' : '')));
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
    var tb = shareBadge(task);
    if (tb) main.appendChild(tb);
    if (task.notes) main.appendChild(mdInto(el('div', 'row-sub md'), task.notes));
    var stepsBox = taskSteps(task);
    if (stepsBox) main.appendChild(stepsBox);

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
    var shareBtn = actionButton('Share', '👥', task.shared ? 'Shared' : 'Share', function () { openShare('tasks', task.id); });
    if (task.shared) shareBtn.classList.add('is-on');
    actions.appendChild(shareBtn);
    var mine = isMine(task);
    var del = actionButton(mine ? 'Delete' : 'Leave', '✕', mine ? 'Delete' : 'Leave', function () { removeOrLeave('tasks', task, task.name); });
    del.classList.add('danger');
    actions.appendChild(del);
    row.appendChild(actions);

    attachHandle(row, handle, list, '.row', 'tasks', false);
    return row;
  }

  /* ----------------------------------------------------------- steps -- */
  function stepId() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(); }
  function splitLines(text) {
    return String(text).split(/\r?\n/)
      .map(function (l) { return l.replace(/^\s*(?:[-*•]|\[[ xX]?\]|\d+[.)])\s*/, '').trim(); })
      .filter(Boolean);
  }
  function cleanSteps(items) {
    return (items || []).filter(function (i) { return String(i.text || '').trim(); })
      .map(function (i) { return { id: i.id || stepId(), text: String(i.text).trim(), done: !!i.done }; });
  }

  // An editable list of steps for the add form and the edit window.
  function stepsEditor(initial) {
    var items = (initial || []).map(function (i) { return { id: i.id, text: i.text, done: !!i.done }; });
    var wrap = el('div', 'steps-editor');
    var head = el('div', 'steps-editor-head', 'Steps (optional)');
    var listHost = el('div', 'steps-editor-list');
    var adder = el('div', 'steps-adder');
    adder.appendChild(el('span', 'list-plus', '＋'));
    var add = el('input', 'steps-add-input');
    add.type = 'text';
    add.placeholder = 'Add a step, press Enter';
    add.setAttribute('enterkeyhint', 'next');
    adder.appendChild(add);
    wrap.appendChild(head);
    wrap.appendChild(listHost);
    wrap.appendChild(adder);

    function addLines(text, at) {
      var made = splitLines(text).map(function (t) { return { id: stepId(), text: t, done: false }; });
      if (at == null) at = items.length;
      items.splice.apply(items, [at, 0].concat(made));
      return made;
    }

    function draw(focusId) {
      clear(listHost);
      items.forEach(function (item) {
        var row = el('div', 'steps-editor-item' + (item.done ? ' is-done' : ''));
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = item.done;
        box.setAttribute('aria-label', 'Done');
        box.addEventListener('change', function () { item.done = box.checked; row.classList.toggle('is-done', item.done); });
        var text = el('input', 'steps-text');
        text.type = 'text';
        text.value = item.text;
        text.dataset.step = item.id;
        text.addEventListener('input', function () { item.text = text.value; });
        text.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var made = { id: stepId(), text: '', done: false };
            items.splice(items.indexOf(item) + 1, 0, made);
            draw(made.id);
          } else if (e.key === 'Backspace' && !text.value) {
            e.preventDefault();
            var i = items.indexOf(item);
            items.splice(i, 1);
            var prev = items[i - 1];
            draw(prev ? prev.id : null);
            if (!prev) add.focus();
          }
        });
        text.addEventListener('paste', function (e) {
          var t = e.clipboardData && e.clipboardData.getData('text/plain');
          if (!t || t.indexOf('\n') === -1) return;
          e.preventDefault();
          var i = items.indexOf(item);
          var made = addLines(t, i + 1);
          if (!item.text.trim()) items.splice(i, 1);
          draw(made.length ? made[made.length - 1].id : null);
        });
        var del = iconButton('Remove step', '✕', function () {
          items.splice(items.indexOf(item), 1);
          draw();
        });
        del.classList.add('list-del');
        row.appendChild(box);
        row.appendChild(text);
        row.appendChild(del);
        listHost.appendChild(row);
      });
      if (focusId) {
        var f = listHost.querySelector('[data-step="' + focusId + '"]');
        if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
      }
    }

    function takeAdder() {
      if (!add.value.trim()) return false;
      addLines(add.value);
      add.value = '';
      draw();
      return true;
    }
    // Enter would otherwise submit the whole form.
    add.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      takeAdder();
      add.focus();
    });
    add.addEventListener('paste', function (e) {
      var t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!t || t.indexOf('\n') === -1) return;
      e.preventDefault();
      addLines(t);
      draw();
      add.focus();
    });

    draw();
    return {
      el: wrap,
      getItems: function () { takeAdder(); return cleanSteps(items); },
      setItems: function (list) { items = (list || []).slice(); add.value = ''; draw(); },
      addTexts: function (texts) { texts.forEach(function (t) { items.push({ id: stepId(), text: t, done: false }); }); draw(); }
    };
  }

  // Steps shown on a task card, tickable right there.
  var STEPS_SHOWN = 4;
  var stepsExpanded = {};
  function stepsProgress(steps) {
    var done = steps.filter(function (s) { return s.done; }).length;
    return { done: done, total: steps.length };
  }
  function progressBar(p) {
    var bar = el('div', 'steps-bar');
    var fill = el('div', 'steps-bar-fill');
    fill.style.width = (p.total ? Math.round(p.done / p.total * 100) : 0) + '%';
    bar.appendChild(fill);
    return bar;
  }

  function taskSteps(task) {
    var steps = Array.isArray(task.steps) ? task.steps : [];
    var box = el('div', 'task-steps');
    if (!steps.length) return null;

    function render() {
      clear(box);
      var p = stepsProgress(steps);
      var head = el('div', 'steps-head');
      head.appendChild(el('span', 'steps-count' + (p.done === p.total ? ' is-complete' : ''),
        (p.done === p.total ? '✓ ' : '') + p.done + ' of ' + p.total + ' steps'));
      head.appendChild(progressBar(p));
      box.appendChild(head);

      var open = steps.filter(function (s) { return !s.done; });
      var done = steps.filter(function (s) { return s.done; });
      var ordered = open.concat(done);
      var expanded = !!stepsExpanded[task.id];
      var shown = expanded ? ordered : open.slice(0, STEPS_SHOWN);
      var list = el('div', 'steps-list');
      shown.forEach(function (step) {
        var row = el('label', 'step' + (step.done ? ' is-done' : ''));
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = step.done;
        cb.addEventListener('change', function () { toggleStep(task, steps, step, cb.checked, render); });
        row.appendChild(cb);
        row.appendChild(el('span', 'step-text', step.text));
        list.appendChild(row);
      });
      box.appendChild(list);

      var hidden = ordered.length - shown.length;
      if (hidden > 0 || expanded) {
        var more = el('button', 'link-btn steps-more', expanded ? 'Show less'
          : (open.length > STEPS_SHOWN ? '+' + (open.length - STEPS_SHOWN) + ' more' : '') +
            (open.length > STEPS_SHOWN && done.length ? ' · ' : '') +
            (done.length ? 'show ' + done.length + ' done' : ''));
        more.type = 'button';
        more.addEventListener('click', function () {
          if (expanded) delete stepsExpanded[task.id]; else stepsExpanded[task.id] = true;
          render();
        });
        box.appendChild(more);
      }
    }
    render();
    return box;
  }

  function toggleStep(task, steps, step, checked, render) {
    step.done = checked;
    var payload = steps.map(function (s) { return { id: s.id, text: s.text, done: s.done }; });
    // Let the tick show for a moment before the step moves down.
    setTimeout(render, 220);
    update('tasks', task.id, { steps: payload }, true).then(function () {
      var p = stepsProgress(steps);
      if (checked && p.done === p.total && task.status !== 'Done') {
        setTimeout(function () {
          if (window.confirm('All steps done for "' + (task.name || 'this task') + '". Mark the task Done?')) {
            update('tasks', task.id, { status: 'Done' });
          }
        }, 300);
      }
    });
  }

  // Bullet points in the details → steps (used by the edit window).
  function bulletsIn(html) {
    var div = document.createElement('div');
    div.innerHTML = RichText.toHtml(html);
    return Array.prototype.map.call(div.querySelectorAll('li'), function (li) {
      var copy = li.cloneNode(true);
      copy.querySelectorAll('ul, ol').forEach(function (n) { n.remove(); });
      return copy.textContent.trim();
    }).filter(Boolean);
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
      { name: 'steps', type: 'steps', value: task.steps, after: function (wrap, se) {
        // Offer to turn a bulleted list already written in the details into steps.
        var btn = el('button', 'ghost steps-convert', '☑ Turn bullet points into steps');
        btn.type = 'button';
        function sync() { btn.hidden = !bulletsIn(richFields.notes ? richFields.notes.getValue() : '').length; }
        btn.addEventListener('click', function () {
          var rte = richFields.notes;
          var texts = bulletsIn(rte.getValue());
          if (!texts.length) return;
          se.addTexts(texts);
          // Take the list out of the details so it isn't there twice.
          var div = document.createElement('div');
          div.innerHTML = RichText.toHtml(rte.getValue());
          div.querySelectorAll('ul, ol').forEach(function (n) { if (!n.parentElement.closest('ul, ol')) n.remove(); });
          rte.setValue(div.innerHTML);
          sync();
          toast('Moved ' + texts.length + ' bullet' + (texts.length === 1 ? '' : 's') + ' into steps');
        });
        wrap.appendChild(btn);
        setTimeout(function () {
          sync();
          if (richFields.notes) richFields.notes.editor.addEventListener('input', sync);
        }, 0);
      } },
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
  var remRepeat = repeatPicker({}, function () {
    return { date: document.getElementById('rem-date').value, time: document.getElementById('rem-time').value };
  });
  document.getElementById('rem-repeat').appendChild(remRepeat.el);
  document.getElementById('rem-date').addEventListener('input', function () { remRepeat.refresh(); });
  document.getElementById('rem-time').addEventListener('input', function () { remRepeat.refresh(); });

  function resetReminderForm() {
    var next = new Date();
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    document.getElementById('rem-title').value = '';
    document.getElementById('rem-desc').value = '';
    document.getElementById('rem-date').value = dateInputValue(next);
    document.getElementById('rem-time').value = timeInputValue(next);
    if (typeof remRepeat !== 'undefined') remRepeat.reset();
  }

  var remOpenSent = false;
  function renderReminders() {
    renderPushBanner();
    renderBackupSetting();
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
    row.appendChild(el('span', 'rem-icon', sent ? '✓' : (isRepeating(ruleOf(r)) ? '🔁' : '🔔')));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-title', r.title || '(untitled)'));
    var rb = shareBadge(r);
    if (rb) main.appendChild(rb);
    if (r.description) main.appendChild(el('div', 'row-sub', r.description));
    var rule = ruleOf(r);
    var repeating = isRepeating(rule);
    var when = el('div', 'rem-when-label', (repeating && !sent ? 'Next: ' : '') + whenLabel(r.dueAtMs));
    if (overdue) when.appendChild(el('span', 'pill rem-late', 'Sending…'));
    main.appendChild(when);
    if (repeating) main.appendChild(el('div', 'rem-repeat-label', '🔁 ' + describeRule(rule) + (sent ? ' — finished' : '')));
    // Sent ones show how they reached you; repeating ones show how the last one did.
    if (sent || (repeating && r.lastSentAt)) {
      var receipt = deliveryReceipt(r);
      if (receipt) {
        if (repeating && !sent) receipt.textContent = 'Last time (' + whenLabel(Number(r.lastDueAtMs) || Date.parse(r.lastSentAt)) + '): ' + receipt.textContent;
        main.appendChild(receipt);
      }
    }
    row.appendChild(main);
    var actions = el('div', 'row-actions');
    if (repeating && !sent) actions.appendChild(iconButton('Skip the next one', '⏭', function () { skipNext(r); }));
    actions.appendChild(iconButton(sent ? 'Remind me again' : 'Edit', sent ? '↻' : '✎', function () { editReminder(r.id); }));
    var rs = iconButton(r.shared ? 'Shared — change who' : 'Share', '👥', function () { openShare('reminders', r.id); });
    if (r.shared) rs.classList.add('is-today');
    actions.appendChild(rs);
    actions.appendChild(iconButton(isMine(r) ? 'Delete' : 'Remove from my list', '✕', function () { removeOrLeave('reminders', r, r.title); }, true));
    row.appendChild(actions);
    return row;
  }

  /* ------------------------------------------------- repeating reminders -- */

  function ruleOf(r) {
    return { repeat: r.repeat, days: r.repeatDays, anchor: r.repeatAnchor, time: r.repeatTime, until: r.repeatUntil, tz: r.tz || LOCAL_TZ };
  }

  // Repeat picker: a dropdown, day chips (for "Specific days") and an "Until" date.
  // getDateTime() supplies the date/time fields it sits next to.
  function repeatPicker(initial, getDateTime) {
    initial = initial || {};
    var wrap = el('div', 'repeat-picker');
    var row = el('div', 'repeat-row');
    var label = el('label', 'rem-field repeat-field');
    label.appendChild(el('span', null, 'Repeat'));
    var sel = el('select', 'repeat-select');
    REPEAT_OPTIONS.forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0];
      if (o[0] === (initial.repeat || 'none')) opt.selected = true;
      sel.appendChild(opt);
    });
    label.appendChild(sel);
    row.appendChild(label);
    var untilLabel = el('label', 'rem-field repeat-until');
    untilLabel.appendChild(el('span', null, 'Until (optional)'));
    var until = el('input');
    until.type = 'date';
    until.value = initial.repeatUntil || '';
    untilLabel.appendChild(until);
    row.appendChild(untilLabel);
    wrap.appendChild(row);

    var chips = el('div', 'day-chips');
    var chosen = String(initial.repeatDays || '').split(',').filter(function (x) { return x !== ''; }).map(Number);
    DAY_CHIPS.forEach(function (dc) {
      var b = el('button', 'day-chip' + (chosen.indexOf(dc[0]) !== -1 ? ' is-on' : ''), dc[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', chosen.indexOf(dc[0]) !== -1 ? 'true' : 'false');
      b.addEventListener('click', function () {
        var i = chosen.indexOf(dc[0]);
        if (i === -1) chosen.push(dc[0]); else chosen.splice(i, 1);
        b.classList.toggle('is-on', i === -1);
        b.setAttribute('aria-pressed', i === -1 ? 'true' : 'false');
        summary();
      });
      chips.appendChild(b);
    });
    wrap.appendChild(chips);
    var note = el('div', 'hint repeat-note');
    wrap.appendChild(note);

    function rule() {
      var dt = getDateTime();
      return { repeat: sel.value, days: chosen.join(','), anchor: dt.date, time: dt.time, until: until.value, tz: LOCAL_TZ };
    }
    function summary() {
      var on = sel.value !== 'none';
      chips.hidden = sel.value !== 'days';
      untilLabel.hidden = !on;
      if (!on) { note.textContent = ''; return; }
      var r = rule();
      var first = firstOccurrence(r);
      note.textContent = isRepeating(r)
        ? '🔁 ' + describeRule(r) + (first ? ' · first: ' + whenLabel(first).replace(' · ', ' at ') : ' · it has already ended')
        : (sel.value === 'days' ? 'Tap the days it should repeat on.' : '');
    }
    sel.addEventListener('change', summary);
    until.addEventListener('change', summary);
    wrap.addEventListener('refresh', summary);
    summary();

    return {
      el: wrap,
      refresh: summary,
      reset: function () { sel.value = 'none'; until.value = ''; chosen = []; chips.querySelectorAll('.day-chip').forEach(function (c) { c.classList.remove('is-on'); c.setAttribute('aria-pressed', 'false'); }); summary(); },
      // Fields to save, or { error } when it can't be saved.
      values: function () {
        if (sel.value === 'none') return { repeat: 'none', repeatDays: '', repeatAnchor: '', repeatTime: '', repeatUntil: '', tz: LOCAL_TZ };
        var r = rule();
        if (sel.value === 'days' && !chosen.length) return { error: 'Pick at least one day to repeat on' };
        if (r.until && r.until < r.anchor) return { error: 'The "until" date is before the first date' };
        return { repeat: r.repeat, repeatDays: r.days, repeatAnchor: r.anchor, repeatTime: r.time, repeatUntil: r.until, tz: r.tz };
      }
    };
  }

  // The first time a rule fires at or after its chosen date and time — or, if
  // that's already passed, the next one after now.
  function firstOccurrence(rule) {
    if (!isRepeating(rule)) return null;
    var chosen = fromInputs(rule.anchor, rule.time);
    return nextOccurrence(rule, Math.max(Date.now(), chosen - 60000));
  }

  // Work out dueAtMs for a new/edited reminder from its form values.
  function scheduleFromForm(date, time, rep) {
    if (rep.repeat === 'none') {
      var ms = fromInputs(date, time);
      if (!Number.isFinite(ms)) return { error: 'Pick a date and time' };
      if (ms <= Date.now()) return { error: 'That time has already passed' };
      return { dueAtMs: ms };
    }
    var first = firstOccurrence({ repeat: rep.repeat, days: rep.repeatDays, anchor: rep.repeatAnchor, time: rep.repeatTime, until: rep.repeatUntil, tz: rep.tz });
    if (!first) return { error: 'That repeat has no times left — check the "until" date' };
    return { dueAtMs: first };
  }

  function skipNext(r) {
    var next = nextOccurrence(ruleOf(r), r.dueAtMs);
    if (!next) { toast('That’s the last one — delete it instead if you don’t need it', true); return; }
    update('reminders', r.id, { dueAtMs: next }).then(function () {
      toast('Skipped — next one is ' + whenLabel(next).replace(' · ', ' at '));
    });
  }

  /* --------------------------------------------------------- sharing -- */
  var peopleDialog = document.getElementById('people');
  var shareDialog = document.getElementById('share');

  function personName(item, uid) {
    if (uid === Store.myUid()) return 'You';
    var c = Store.connections().filter(function (p) { return p.uid === uid; })[0];
    if (c) return c.name;
    var info = item && item.memberInfo && item.memberInfo[uid];
    return (info && (info.name || info.email)) || 'Someone';
  }
  function isMine(item) { return !item.shared || item.owner === Store.myUid(); }

  // "👥 Shared with Kristen" / "👥 From Craig · with you and Cody"
  function shareBadge(item) {
    if (!item.shared) return null;
    var others = (item.members || []).filter(function (u) { return u !== Store.myUid(); });
    var text;
    if (item.owner === Store.myUid()) text = 'Shared with ' + others.map(function (u) { return personName(item, u); }).join(', ');
    else {
      var rest = others.filter(function (u) { return u !== item.owner; }).map(function (u) { return personName(item, u); });
      text = 'From ' + personName(item, item.owner) + (rest.length ? ' · also ' + rest.join(', ') : '');
    }
    return el('span', 'share-badge', '👥 ' + text);
  }

  // Delete for your own things; "Leave" for things others shared with you.
  function removeOrLeave(table, item, label) {
    if (isMine(item)) { remove(table, item.id, label); return; }
    if (!window.confirm('Remove "' + (label || 'this') + '" from your list?\n\nIt stays with ' + personName(item, item.owner) + '.')) return;
    run('leave', table, item.id).then(function () { load(); toast('Removed from your list'); }).catch(fail);
  }

  function openShare(table, id) {
    var item = byId(state[table], id);
    if (!item) return;
    var noun = { tasks: 'task', reminders: 'reminder', notes: item.kind === 'list' ? 'list' : 'note' }[table];
    document.getElementById('share-title').textContent = '👥 Share this ' + noun;
    var body = clear(document.getElementById('share-body'));
    var actions = clear(document.getElementById('share-actions'));
    function btn(label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); actions.appendChild(b); return b; }

    if (!isMine(item)) {
      body.appendChild(el('p', null, personName(item, item.owner) + ' shared this with you. You can edit it, tick things off and complete it; only ' + personName(item, item.owner) + ' can delete it or change who it’s shared with.'));
      var others = (item.members || []).filter(function (u) { return u !== Store.myUid() && u !== item.owner; });
      if (others.length) body.appendChild(el('p', 'hint', 'Also shared with ' + others.map(function (u) { return personName(item, u); }).join(', ') + '.'));
      btn('Leave', 'ghost danger', function () { shareDialog.close(); removeOrLeave(table, item, item.title || item.name); });
      btn('Done', 'primary', function () { shareDialog.close(); });
      shareDialog.showModal();
      return;
    }

    var people = Store.connections();
    if (!people.length) {
      body.appendChild(el('p', null, 'You haven’t connected with anyone yet. Invite someone first — once they accept, you can share with them.'));
      btn('Cancel', 'ghost', function () { shareDialog.close(); });
      btn('Invite someone…', 'primary', function () { shareDialog.close(); openPeople(); });
      shareDialog.showModal();
      return;
    }
    var chosen = (item.members || []).filter(function (u) { return u !== Store.myUid(); });
    var list = el('div', 'share-list');
    people.forEach(function (p) {
      var row = el('label', 'share-person');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.indexOf(p.uid) !== -1;
      cb.addEventListener('change', function () {
        if (cb.checked) chosen.push(p.uid); else chosen = chosen.filter(function (u) { return u !== p.uid; });
      });
      row.appendChild(cb);
      var who = el('span', 'share-who');
      who.appendChild(el('strong', null, p.name));
      who.appendChild(el('span', 'hint', p.email));
      row.appendChild(who);
      list.appendChild(row);
    });
    body.appendChild(list);
    if (table === 'reminders') body.appendChild(el('p', 'hint', 'Everyone it’s shared with gets the reminder on their own phone.'));
    btn('Cancel', 'ghost', function () { shareDialog.close(); });
    btn('Save', 'primary', function () {
      var was = item.shared;
      shareDialog.close();
      run('setSharing', table, item.id, chosen).then(function () {
        load();
        toast(chosen.length ? 'Shared with ' + chosen.map(function (u) { return personName(item, u); }).join(', ') : (was ? 'No longer shared' : 'Not shared'));
      }).catch(fail);
    });
    shareDialog.showModal();
  }
  shareDialog.addEventListener('click', function (e) { if (e.target === shareDialog) shareDialog.close(); });

  function renderPeople() {
    var host = clear(document.getElementById('people-body'));
    var incoming = Store.invitesIn();
    var outgoing = Store.invitesOut();
    var people = Store.connections();
    function section(title) { host.appendChild(el('h3', 'group-head', title)); var l = el('div', 'people-list'); host.appendChild(l); return l; }
    function person(listEl, name, email, buttons) {
      var row = el('div', 'people-row');
      row.appendChild(el('span', 'admin-avatar', (name || email || '?').trim()[0].toUpperCase()));
      var who = el('div', 'share-who');
      who.appendChild(el('strong', null, name || email));
      if (name && email) who.appendChild(el('span', 'hint', email));
      row.appendChild(who);
      var acts = el('div', 'people-actions');
      buttons.forEach(function (b) {
        var x = el('button', b[1], b[0]); x.type = 'button';
        x.addEventListener('click', function () { x.disabled = true; Promise.resolve().then(b[2]).catch(fail).finally(function () { x.disabled = false; }); });
        acts.appendChild(x);
      });
      row.appendChild(acts);
      listEl.appendChild(row);
    }
    if (incoming.length) {
      var inList = section('Wants to connect with you');
      incoming.forEach(function (i) {
        person(inList, i.fromName, i.fromEmail, [
          ['Decline', 'ghost', function () { return Store.respond(i.id, false); }],
          ['Accept', 'primary', function () { return Store.respond(i.id, true).then(function () { toast('Connected with ' + (i.fromName || i.fromEmail)); }); }]
        ]);
      });
    }
    var conn = section('Connected');
    if (!people.length) conn.appendChild(el('p', 'empty', 'Nobody yet — invite someone below.'));
    people.forEach(function (p) {
      person(conn, p.name, p.email, [['Disconnect', 'link-btn danger-text', function () {
        if (!window.confirm('Disconnect from ' + p.name + '?\n\nThings already shared stay shared until the owner stops sharing them. You won’t be able to share anything new with each other.')) return;
        return Store.removeInvite(p.inviteId);
      }]]);
    });
    if (outgoing.length) {
      var outList = section('Invited — waiting for them');
      outgoing.forEach(function (i) {
        person(outList, '', i.toEmail, [['Cancel', 'link-btn', function () { return Store.removeInvite(i.id); }]]);
      });
    }
  }

  function openPeople() { closeMenu(); renderPeople(); peopleDialog.showModal(); }
  document.getElementById('people-open').addEventListener('click', openPeople);
  document.getElementById('people-close').addEventListener('click', function () { peopleDialog.close(); });
  peopleDialog.addEventListener('click', function (e) { if (e.target === peopleDialog) peopleDialog.close(); });
  document.getElementById('invite-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = document.getElementById('invite-email');
    var email = input.value.trim();
    if (!email) { input.focus(); return; }
    Promise.resolve().then(function () { return Store.invite(email); }).then(function () {
      input.value = '';
      toast('Invite sent to ' + email.toLowerCase());
    }).catch(fail);
  });

  // Invites waiting for you: a card on Home and a dot on your avatar.
  function renderInvites() {
    var incoming = Store.invitesIn();
    document.getElementById('avatar-dot').hidden = !incoming.length;
    var badge = document.getElementById('people-badge');
    badge.hidden = !incoming.length;
    badge.textContent = incoming.length ? String(incoming.length) : '';
    var host = clear(document.getElementById('invite-cards'));
    incoming.forEach(function (i) {
      var card = el('div', 'invite-card');
      var text = el('div', 'invite-text');
      text.appendChild(el('strong', null, '👥 ' + (i.fromName || i.fromEmail)));
      text.appendChild(el('span', null, ' wants to connect so you can share tasks, reminders and lists.'));
      card.appendChild(text);
      var acts = el('div', 'people-actions');
      [['Not now', 'ghost', false], ['Accept', 'primary', true]].forEach(function (b) {
        var x = el('button', b[1], b[0]); x.type = 'button';
        x.addEventListener('click', function () {
          x.disabled = true;
          Store.respond(i.id, b[2]).then(function () { if (b[2]) toast('Connected with ' + (i.fromName || i.fromEmail)); }).catch(fail);
        });
        acts.appendChild(x);
      });
      card.appendChild(acts);
      host.appendChild(card);
    });
    if (peopleDialog.open) renderPeople();
  }

  // How a sent reminder reached you.
  function deliveryReceipt(r) {
    var mine = r.deliveries && r.deliveries[Store.myUid()];
    if (mine) r = Object.assign({}, r, { delivery: mine.state, deliveryNote: mine.note, emailedAt: mine.emailed ? 'yes' : '' });
    var d = r.delivery;
    var map = {
      shown: ['ok', '✓ Shown on your phone'],
      emailed: ['mail', '✉ Emailed to you' + (r.deliveryNote ? ' — ' + r.deliveryNote : '')],
      pushed: ['wait', r.emailedAt ? '✓ Sent to your phone and emailed' : '… Sent to your phone, waiting for it to confirm'],
      sending: ['wait', '… Sending'],
      unconfirmed: ['bad', '⚠ Your phone didn\u2019t confirm, and the backup email failed' + (r.deliveryNote ? ' (' + r.deliveryNote + ')' : '')],
      failed: ['bad', '⚠ Not delivered' + (r.deliveryNote ? ' — ' + r.deliveryNote : '')],
      skipped: ['bad', 'Skipped — ' + (r.deliveryNote || 'too late')]
    };
    if (!d || !map[d]) return null;
    var line = el('div', 'rem-receipt is-' + map[d][0], map[d][1]);
    // On a shared reminder, a short word on how it reached the others.
    if (r.shared && r.deliveries) {
      var others = Object.keys(r.deliveries).filter(function (u) { return u !== Store.myUid(); }).map(function (u) {
        var st = r.deliveries[u].state;
        var word = { shown: '✓', emailed: '✉', pushed: '…', sending: '…', failed: '⚠', unconfirmed: '⚠', skipped: '–' }[st] || '?';
        return personName(r, u) + ' ' + word;
      });
      if (others.length) line.appendChild(el('span', 'rem-receipt-others', ' · ' + others.join(' · ')));
    }
    return line;
  }

  function renderBackupSetting() {
    var host = clear(document.getElementById('rem-backup'));
    var mode = Store.getSettings().reminderEmail || 'backup';
    var row = el('label', 'rem-backup');
    row.appendChild(el('span', null, '✉ Email backup:'));
    var sel = el('select', 'status-select');
    [['backup', 'Email me if my phone misses it'], ['always', 'Always email me too'], ['off', 'Never email']].forEach(function (o) {
      var opt = el('option', null, o[1]); opt.value = o[0]; if (o[0] === mode) opt.selected = true; sel.appendChild(opt);
    });
    sel.addEventListener('change', function () {
      Store.saveSettings({ reminderEmail: sel.value });
      toast(sel.value === 'off' ? 'Reminders won\u2019t be emailed' : sel.value === 'always' ? 'Every reminder will be emailed too' : 'Reminders will be emailed if your phone misses them');
    });
    row.appendChild(sel);
    host.appendChild(row);
  }

  function editReminder(id) {
    var r = byId(state.reminders, id);
    if (!r) return;
    var repeating = isRepeating(ruleOf(r));
    var due = new Date(r.status === 'sent' ? Math.max(r.dueAtMs, Date.now() + 3600000) : r.dueAtMs);
    // A repeating reminder's date is its starting date (fixes the weekday / day of month).
    var dateValue = repeating && r.status !== 'sent' ? r.repeatAnchor : dateInputValue(due);
    var timeValue = repeating && r.status !== 'sent' ? r.repeatTime : timeInputValue(due);
    var picker = null;
    openEditor(r.status === 'sent' ? 'Remind me again' : 'Edit reminder', [
      { name: 'title', label: 'Remind me to…', value: r.title },
      { name: 'description', label: 'Details (optional)', type: 'textarea', value: r.description },
      { name: 'date', label: repeating ? 'Starting' : 'Date', type: 'date', value: dateValue },
      { name: 'time', label: 'Time', type: 'time', value: timeValue },
      { name: 'repeat', type: 'custom', render: function (wrap) {
        picker = repeatPicker(r.status === 'sent' ? {} : r, function () {
          return { date: document.getElementById('f-date').value, time: document.getElementById('f-time').value };
        });
        wrap.appendChild(picker.el);
        setTimeout(function () {
          ['f-date', 'f-time'].forEach(function (fid) { document.getElementById(fid).addEventListener('input', picker.refresh); });
        }, 0);
      } }
    ], function (v) {
      if (!v.title.trim()) { toast('Give the reminder a title', true); return; }
      var rep = picker.values();
      if (rep.error) { toast(rep.error, true); return; }
      var sched = scheduleFromForm(v.date, v.time, rep);
      if (sched.error) { toast(sched.error, true); return; }
      update('reminders', id, Object.assign({ title: v.title.trim(), description: v.description.trim(), dueAtMs: sched.dueAtMs }, rep));
    });
  }

  document.getElementById('rem-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var title = document.getElementById('rem-title');
    if (!title.value.trim()) { toast('What should I remind you about?', true); title.focus(); return; }
    var rep = remRepeat.values();
    if (rep.error) { toast(rep.error, true); return; }
    var sched = scheduleFromForm(document.getElementById('rem-date').value, document.getElementById('rem-time').value, rep);
    if (sched.error) { toast(sched.error, true); return; }
    var ms = sched.dueAtMs;
    create('reminders', Object.assign({ title: title.value.trim(), description: document.getElementById('rem-desc').value.trim(), dueAtMs: ms }, rep))
      .then(function () {
        toast((rep.repeat !== 'none' ? '🔁 Repeating — first one ' : 'Reminder set for ') + whenLabel(ms).replace(' · ', ' at '));
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

  // Re-register every few hours while the app stays open, and whenever it
  // comes back on screen, so a changed address is picked up quickly.
  setInterval(function () { if (currentUid) refreshPush(); }, 3 * 3600e3);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && currentUid) refreshPush(); });

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
    var ns = iconButton(note.shared ? 'Shared — change who' : 'Share', '👥', function () { openShare('notes', note.id); });
    if (note.shared) ns.classList.add('is-today');
    bar.appendChild(ns);
    bar.appendChild(iconButton(isMine(note) ? 'Delete' : 'Remove from my list', '✕', function () { removeOrLeave('notes', note, note.title); }, true));
    card.appendChild(bar);

    var title = el('input', 'note-title');
    title.type = 'text';
    title.placeholder = note.kind === 'list' ? 'List name' : 'Title';
    title.value = note.title || '';
    title.addEventListener('input', function () { queueSave(note.id, 'notes', { title: title.value }); });
    card.appendChild(title);
    var nb = shareBadge(note);
    if (nb) { nb.classList.add('note-share'); card.appendChild(nb); }

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
  document.getElementById('help-open').addEventListener('click', function () { helpDialog.showModal(); showDiag(); });

  // What the background part of the app (the part that shows notifications)
  // is running, and what happened with the last reminder it showed.
  function swVersion() {
    return new Promise(function (resolve) {
      var c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!c) { resolve(null); return; }
      var ch = new MessageChannel();
      var done = false;
      ch.port1.onmessage = function (e) { done = true; resolve(e.data && e.data.version); };
      c.postMessage({ type: 'version' }, [ch.port2]);
      setTimeout(function () { if (!done) resolve(null); }, 1500);
    });
  }
  function lastPushDiag() {
    if (!window.caches) return Promise.resolve(null);
    return caches.open('everything-app-diag').then(function (c) { return c.match('./__diag/last-push'); })
      .then(function (r) { return r ? r.json() : null; }).catch(function () { return null; });
  }
  function showDiag() {
    var host = document.getElementById('help-version');
    Promise.all([swVersion(), lastPushDiag()]).then(function (res) {
      var bg = res[0], d = res[1];
      var parts = ['You\u2019re on version ' + APP_VERSION + '.'];
      parts.push('Notifications part: ' + (bg ? bg + (bg === APP_VERSION ? ' ✓' : ' ⚠ out of date — close and reopen the app') : 'not running yet') + '.');
      if (d) {
        var ack = !d.hasAck ? 'no confirmation info' : d.ack && d.ack.ok ? 'confirmed ✓ (' + d.ack.how + ')' :
          d.ack ? 'confirmation failed — ' + (d.ack.note || d.ack.status || 'unknown') : 'not confirmed';
        parts.push('Last reminder on this device: ' + new Date(d.at).toLocaleString() + ' (' + (d.version || '?') + '), ' + (d.shown ? 'shown' : 'not shown') + ', ' + ack + '.');
      }
      host.textContent = parts.join(' ');
    });
  }

  // If the phone couldn't confirm a reminder in the background, try again
  // from the app the next time it's opened.
  function retryPendingAck() {
    lastPushDiag().then(function (d) {
      if (!d || !d.pending) return;
      var p = d.pending;
      fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ uid: p.uid, rid: p.rid, key: p.key, s: p.s || '' }) })
        .then(function (res) {
          d.pending = null; d.ack = { ok: res.ok, how: 'app', status: res.status };
          return caches.open('everything-app-diag').then(function (c) { return c.put('./__diag/last-push', new Response(JSON.stringify(d))); });
        }).catch(function () { /* still offline */ });
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) retryPendingAck(); });
  setTimeout(retryPendingAck, 3000);
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

  // What you saw last time, so changed numbers can be highlighted. Kept on this
  // device; "added today" numbers are only compared within the same day.
  var ADMIN_LAST_KEY = 'everything-app:admin-last';
  function loadAdminSnapshot() { try { return JSON.parse(localStorage.getItem(ADMIN_LAST_KEY)) || null; } catch (e) { return null; } }
  function saveAdminSnapshot(snap) { try { localStorage.setItem(ADMIN_LAST_KEY, JSON.stringify(snap)); } catch (e) { /* ignore */ } }

  function makeTracker(prev, todayStartsAt) {
    var values = {};
    var changed = 0;
    var sameDay = !!prev && prev.todayStartsAt === todayStartsAt;
    var before = (prev && prev.values) || {};
    return {
      values: values,
      changedCount: function () { return changed; },
      // Returns { value, delta } — delta is 0 when unchanged or not comparable.
      track: function (key, value, isTodayCount) {
        values[key] = value;
        var old = before[key];
        if (!prev || old == null || value == null || (isTodayCount && !sameDay)) return { value: value, delta: 0 };
        var delta = Number(value) - Number(old);
        if (delta) changed++;
        return { value: value, delta: delta };
      }
    };
  }

  function deltaBadge(delta) {
    return el('span', 'admin-delta ' + (delta > 0 ? 'is-up' : 'is-down'), (delta > 0 ? '▲ +' : '▼ ') + Math.abs(delta));
  }

  function numEl(cls, t) {
    var span = el('span', cls + (t.delta ? ' is-changed' : ''), n(t.value));
    return span;
  }

  // extras: [{ t: tracked, text: 'in Today' }] → "1 in Today · 2 done", changed parts coloured.
  function extraLine(parts) {
    var line = el('div', 'admin-stat-extra');
    parts.forEach(function (p, i) {
      if (i) line.appendChild(document.createTextNode(' · '));
      if (p.plain) { line.appendChild(document.createTextNode(p.plain)); return; }
      var span = el('span', p.t.delta ? 'is-changed' : null, n(p.t.value) + ' ' + p.text);
      if (p.t.delta) span.title = (p.t.delta > 0 ? '+' : '') + p.t.delta + ' since last time';
      line.appendChild(span);
    });
    return line;
  }

  function statTile(icon, label, total, today, extras) {
    var t = el('div', 'admin-stat' + (total.delta || (today && today.delta) ? ' is-changed' : ''));
    var top = el('div', 'admin-stat-top');
    top.appendChild(numEl('admin-stat-num', total));
    if (total.delta) top.appendChild(deltaBadge(total.delta));
    if (today && today.value) {
      top.appendChild(el('span', 'admin-stat-today' + (today.delta ? ' is-changed' : ''), '+' + today.value + ' today'));
    }
    t.appendChild(top);
    t.appendChild(el('div', 'admin-stat-label', icon + ' ' + label));
    if (extras && extras.length) t.appendChild(extraLine(extras));
    return t;
  }

  function renderAdmin(data) {
    var host = clear(document.getElementById('admin-body'));
    var users = data.users || [];
    var prev = loadAdminSnapshot();
    var tr = makeTracker(prev, data.todayStartsAt);
    var knownUsers = (prev && prev.users) || null;
    var sum = function (f) { return users.reduce(function (a, u) { return a + (Number(f(u)) || 0); }, 0); };

    var summary = el('div', 'admin-changes');
    host.appendChild(summary);

    var totals = el('div', 'admin-totals');
    [['accounts', 'Accounts', users.length, false],
      ['tasks', 'Tasks', sum(function (u) { return u.tasks.total; }), false],
      ['notes', 'Notes & lists', sum(function (u) { return u.notes.total; }), false],
      ['reminders', 'Reminders', sum(function (u) { return u.reminders.total; }), false],
      ['today', 'Added today', sum(function (u) { return u.tasks.today + u.notes.today + u.reminders.today + u.links.today; }), true]
    ].forEach(function (p) {
      var t = tr.track('all.' + p[0], p[2], p[3]);
      var b = el('div', 'admin-total' + (t.delta ? ' is-changed' : ''));
      var top = el('div', 'admin-total-top');
      top.appendChild(el('span', 'admin-total-num', String(t.value)));
      if (t.delta) top.appendChild(deltaBadge(t.delta));
      b.appendChild(top);
      b.appendChild(el('div', 'admin-total-label', p[1]));
      totals.appendChild(b);
    });
    host.appendChild(totals);

    var newPeople = 0;
    users.forEach(function (u) {
      var id = u.uid || u.email;
      var k = function (f) { return 'u.' + id + '.' + f; };
      var isNew = !!knownUsers && knownUsers.indexOf(id) === -1;
      if (isNew) newPeople++;
      var card = el('div', 'admin-user' + (isNew ? ' is-new' : ''));
      var head = el('div', 'admin-user-head');
      var avatar = el('span', 'admin-avatar', ((u.name || u.email || '?').trim()[0] || '?').toUpperCase());
      head.appendChild(avatar);
      var who = el('div', 'admin-who');
      var nameRow = el('div', 'admin-name', u.name || (u.email || '').split('@')[0] || '(no name)');
      if (isNew) nameRow.appendChild(el('span', 'admin-new', 'New'));
      who.appendChild(nameRow);
      who.appendChild(el('div', 'admin-email', u.email + (u.provider === 'google.com' ? ' · Google' : ' · email & password')));
      head.appendChild(who);
      var seen = el('div', 'admin-seen');
      seen.appendChild(el('div', null, 'Active ' + fmtWhen(u.lastSignIn)));
      seen.appendChild(el('div', 'admin-joined', 'Joined ' + fmtWhen(u.created)));
      head.appendChild(seen);
      card.appendChild(head);

      var grid = el('div', 'admin-stats');
      grid.appendChild(statTile('✅', 'Tasks', tr.track(k('tasks'), u.tasks.total), tr.track(k('tasksToday'), u.tasks.today, true), [
        { t: tr.track(k('inToday'), u.tasks.inToday), text: 'in Today' },
        { t: tr.track(k('done'), u.tasks.done), text: 'done' },
        { t: tr.track(k('archived'), u.tasks.archived), text: 'archived' }
      ]));
      var lists = tr.track(k('lists'), u.notes.lists);
      grid.appendChild(statTile('📝', 'Notes & lists', tr.track(k('notes'), u.notes.total), tr.track(k('notesToday'), u.notes.today, true), [
        { t: lists, text: 'list' + (u.notes.lists === 1 ? '' : 's') }
      ]));
      grid.appendChild(statTile('🔔', 'Reminders', tr.track(k('reminders'), u.reminders.total), tr.track(k('remindersToday'), u.reminders.today, true), [
        { t: tr.track(k('upcoming'), u.reminders.upcoming), text: 'upcoming' }
      ]));
      grid.appendChild(statTile('🔗', 'Links', tr.track(k('links'), u.links.total), tr.track(k('linksToday'), u.links.today, true), []));
      grid.appendChild(statTile('📱', 'Notified devices', tr.track(k('devices'), u.devices), null, [
        { plain: u.devices ? 'getting reminders' : 'notifications off' }
      ]));
      card.appendChild(grid);
      host.appendChild(card);
    });

    // The headline above the totals.
    var count = tr.changedCount();
    if (!prev) {
      summary.appendChild(el('span', null, 'First look on this device — changes will be highlighted from next time.'));
    } else if (count || newPeople) {
      summary.classList.add('has-changes');
      var bits = [];
      if (count) bits.push(count + ' number' + (count === 1 ? '' : 's') + ' changed');
      if (newPeople) bits.push(newPeople + ' new account' + (newPeople === 1 ? '' : 's'));
      summary.appendChild(el('strong', null, '✨ ' + bits.join(', ')));
      summary.appendChild(el('span', null, ' since you last looked (' + fmtWhen(prev.at) + ')'));
    } else {
      summary.appendChild(el('span', null, 'No changes since you last looked (' + fmtWhen(prev.at) + ').'));
    }

    host.appendChild(el('p', 'hint admin-foot', 'Updated ' + fmtWhen(data.generatedAt) +
      '. Coloured numbers changed since you last looked. "Today" means since midnight Eastern. Counts are what exists now — deleted items aren’t counted.'));

    saveAdminSnapshot({
      at: data.generatedAt || new Date().toISOString(),
      todayStartsAt: data.todayStartsAt || null,
      values: tr.values,
      users: users.map(function (u) { return u.uid || u.email; })
    });
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

    var sizes = segmented([
      { value: 'small', html: '<span class="size-a" style="font-size:12px">A</span>', title: 'Small' },
      { value: 'normal', html: '<span class="size-a" style="font-size:15px">A</span>', title: 'Normal' },
      { value: 'large', html: '<span class="size-a" style="font-size:18px">A</span>', title: 'Large' },
      { value: 'xlarge', html: '<span class="size-a" style="font-size:22px">A</span>', title: 'Extra large' }
    ], a.size, function (v) { set('size', v); });
    sizes.classList.add('seg-size');
    var sizeSec = section('Text size');
    sizeSec.appendChild(sizes);
    sizeSec.appendChild(el('div', 'hint ap-size-name', { small: 'Small', normal: 'Normal', large: 'Large', xlarge: 'Extra large' }[a.size]));

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
  var taskSteps_ = stepsEditor([]);
  document.getElementById('task-add-steps').appendChild(taskSteps_.el);
  var taskToday = document.getElementById('task-add-today');
  taskToday.parentNode.lastChild.textContent = ' Add to ' + LABEL_NOW;
  submitOnCmdEnter(taskForm);
  taskForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('task-add-name');
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    create('tasks', { name: name, notes: taskNotes.getValue(), steps: taskSteps_.getItems(), status: state.statuses[0], today: taskToday.checked });
    input.value = '';
    taskNotes.setValue('');
    taskSteps_.setItems([]);
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

  /* ------------------------------------------------------ fold forms -- */
  // The add forms show one line until you tap in; the rest opens then, and
  // folds back away after adding (or when you leave without typing anything).
  function formHasContent(form) {
    var typed = Array.prototype.some.call(form.querySelectorAll('input[type="text"], input[type="url"], textarea'),
      function (f) { return f.value.trim() !== ''; });
    var rich = Array.prototype.some.call(form.querySelectorAll('[contenteditable="true"]'),
      function (f) { return f.textContent.trim() !== ''; });
    var steps = !!form.querySelector('.steps-editor-item');
    return typed || rich || steps;
  }
  function setFolded(form, folded) {
    form.classList.toggle('is-folded', folded);
    var primary = form.querySelector('.fold-primary');
    if (primary) {
      if (!primary.dataset.openPlaceholder) primary.dataset.openPlaceholder = primary.placeholder;
      primary.placeholder = folded ? primary.dataset.foldedPlaceholder : primary.dataset.openPlaceholder;
    }
  }
  function foldForm(form) {
    setFolded(form, true);
    form.addEventListener('focusin', function () { setFolded(form, false); });
    form.addEventListener('focusout', function () {
      setTimeout(function () {
        if (form.contains(document.activeElement) || formHasContent(form)) return;
        setFolded(form, true);
      }, 150);
    });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !formHasContent(form)) {
        setFolded(form, true);
        if (document.activeElement) document.activeElement.blur();
      }
    });
    // After adding: fold back up and put the keyboard away.
    form.addEventListener('submit', function () {
      setTimeout(function () {
        if (formHasContent(form)) return;   // e.g. a missing URL — leave it open
        if (form.contains(document.activeElement)) document.activeElement.blur();
        setFolded(form, true);
      }, 60);
    });
  }
  document.querySelectorAll('.fold-form').forEach(foldForm);

  /* ------------------------------------------------------------- PWA -- */
  // Updates: look for a new version whenever the app comes back on screen, and
  // switch to it as soon as it's ready (but never in the middle of typing).
  var swReg = null;
  var updating = false;      // a newer version is being installed (not the first install)
  var updateReady = false;   // it's installed, waiting for you to stop typing
  var checkingByHand = false;

  // Anything you could be halfway through: any text box, an open editor, a drag.
  function isBusy() {
    var a = document.activeElement;
    // A focused box only counts if there's something in it to lose.
    var typing = !!a && ((/^(INPUT|TEXTAREA)$/.test(a.tagName) && /^(text|url|email|password|search|)$/.test(a.type || '') && a.value.trim() !== '') ||
      (a.isContentEditable && a.textContent.trim() !== ''));
    var draft = ['task-add-name', 'rem-title', 'rem-desc', 'link-add-title', 'link-add-url', 'link-add-notes']
      .some(function (id) { var f = document.getElementById(id); return f && f.value.trim(); }) ||
      !!document.querySelector('#task-add-notes .rte-editor:not(:empty)');
    var openDialog = Array.prototype.some.call(document.querySelectorAll('dialog'), function (d) { return d.open; });
    return typing || draft || openDialog || !!document.querySelector('.dragging');
  }

  function applyUpdate() {
    if (isBusy()) { updateReady = true; return; }
    updateReady = false;
    flushAll();
    location.reload();
  }

  function checkForUpdate(byHand) {
    if (!swReg) { if (byHand) toast('Updates aren\u2019t available in this browser'); return Promise.resolve(); }
    checkingByHand = !!byHand;
    return swReg.update().then(function () {
      if (!byHand) return;
      if (swReg.installing || swReg.waiting) toast('Downloading the new version…');
      else toast('You\u2019re on the latest version (' + (window.APP_VERSION || '') + ')');
    }).catch(function () { if (byHand) toast('Couldn\u2019t check — are you online?', true); });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      // updateViaCache 'none': always fetch sw.js and version.js fresh when checking.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        swReg = reg;
        // A new worker arriving while one is already active = an update.
        reg.addEventListener('updatefound', function () { if (reg.active) updating = true; });
        checkForUpdate(false);
      }).catch(function () { /* offline support unavailable */ });
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // The very first install also "changes controller" — that's not an update.
      if (!updating) return;
      updating = false;
      if (checkingByHand) toast('Updating…');
      applyUpdate();
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkForUpdate(false);
    });
    // Waiting for you to finish: try again when you leave a field, close a
    // dialog, or put the app in the background.
    function retryUpdate() { setTimeout(function () { if (updateReady) applyUpdate(); }, 400); }
    document.addEventListener('focusout', retryUpdate);
    document.addEventListener('close', retryUpdate, true);
    document.addEventListener('submit', retryUpdate, true);
    document.addEventListener('visibilitychange', function () { if (document.hidden) retryUpdate(); });
  }
  document.getElementById('check-update').addEventListener('click', function () {
    closeMenu();
    checkForUpdate(true);
  });
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
          if (peopleDialog.open) peopleDialog.close();
          if (shareDialog.open) shareDialog.close();
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
        Store.start(user.uid, scheduleRender, fail, user.email, user.displayName).then(function () {
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
