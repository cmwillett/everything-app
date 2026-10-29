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
    tasks: [], notes: [],
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
  function mdInto(node, text) { node.innerHTML = Markdown.render(text); return node; }
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ } }

  /* ---------------------------------------------------- editing keys -- */
  // Tab indents inside a markdown field rather than moving focus.
  function enableIndentKeys(field) {
    var INDENT = Markdown.INDENT;
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { field.blur(); return; }
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      var value = field.value;
      var from = value.lastIndexOf('\n', field.selectionStart - 1) + 1;
      var to = value.indexOf('\n', field.selectionEnd);
      if (to === -1) to = value.length;
      var head = 0, total = 0;
      var lines = value.slice(from, to).split('\n').map(function (line, i) {
        var shift;
        if (event.shiftKey) {
          var lead = /^ {1,2}/.exec(line);
          shift = lead ? -lead[0].length : 0;
          line = lead ? line.slice(lead[0].length) : line;
        } else {
          shift = INDENT.length;
          line = INDENT + line;
        }
        if (i === 0) head = shift;
        total += shift;
        return line;
      });
      var start = field.selectionStart, end = field.selectionEnd;
      replaceRange(field, from, to, lines.join('\n'));
      field.setSelectionRange(Math.max(from, start + head), Math.max(from, end + total));
    });
  }
  function replaceRange(field, from, to, text) {
    if (document.activeElement === field && document.execCommand) {
      field.setSelectionRange(from, to);
      if (document.execCommand('insertText', false, text)) return;
    }
    field.value = field.value.slice(0, from) + text + field.value.slice(to);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function submitOnCmdEnter(form) {
    form.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  var MD_SAMPLES = [
    ['**bold**', 'bold text'], ['*italic*', 'italic text'], ['~~strike~~', 'strikethrough'],
    ['`code`', 'inline code'], ['[label](https://example.com)', 'link'],
    ['- item', 'bullet list'], ['  - item', 'sub-bullet — Tab to indent, Shift+Tab to undo'],
    ['1. item', 'numbered list'], ['# Heading', 'heading (## and ### are smaller)']
  ];
  function markdownHelp() {
    var box = el('details', 'md-help');
    box.appendChild(el('summary', null, 'Markdown cheat sheet'));
    var grid = el('div', 'md-help-grid');
    MD_SAMPLES.forEach(function (s) {
      grid.appendChild(el('code', null, s[0]));
      grid.appendChild(el('span', null, s[1]));
    });
    box.appendChild(grid);
    return box;
  }

  /* ------------------------------------------------------------- tabs -- */
  var TABS = ['home', 'tasks', 'notebook'];
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

  function openEditor(title, fields, onSave) {
    document.getElementById('editor-title').textContent = title;
    var host = clear(document.getElementById('editor-fields'));
    fields.forEach(function (field) {
      var wrap = el('div', 'field');
      var label = el('label', null, field.label);
      label.setAttribute('for', 'f-' + field.name);
      wrap.appendChild(label);
      var input;
      if (field.type === 'textarea') input = el('textarea');
      else if (field.type === 'select') {
        input = el('select');
        field.options.forEach(function (o) { var opt = el('option', null, o); opt.value = o; input.appendChild(opt); });
      } else { input = el('input'); input.type = 'text'; }
      input.id = 'f-' + field.name;
      input.name = field.name;
      input.value = field.value == null ? '' : field.value;
      wrap.appendChild(input);
      if (field.markdown) { enableIndentKeys(input); wrap.appendChild(markdownHelp()); }
      if (field.hint) wrap.appendChild(el('div', 'hint', field.hint));
      host.appendChild(wrap);
    });
    pendingSave = onSave;
    dialog.showModal();
    var first = host.querySelector('input, textarea, select');
    if (first) first.focus();
  }
  submitOnCmdEnter(dialogForm);
  dialogForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var values = {};
    dialogForm.querySelectorAll('[name]').forEach(function (i) { values[i.name] = i.value; });
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
  // A personal checklist that resets every day. Not stored with tasks —
  // checks live under today's date so a new day always starts blank.
  function dailyItems() { return lsGet('everything-app:daily-items', DEFAULT_DAILY); }
  function dailyChecks() {
    var key = 'everything-app:daily:' + dayKey();
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf('everything-app:daily:') === 0 && k !== key) localStorage.removeItem(k);
      });
    } catch (e) { /* ignore */ }
    return { key: key, checked: lsGet(key, {}) };
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
        lsSet('everything-app:daily-items', v.items.split('\n').map(function (s) { return s.trim(); }).filter(Boolean));
        lsSet(store.key, {});
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
        lsSet(store.key, store.checked);
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
      row.appendChild(el('div', 'mini-title', note.title || '(untitled note)'));
      if (String(note.body || '').trim()) row.appendChild(notePreview(note.body));
      row.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        showTab('notebook');
        var card = document.querySelector('.note[data-id="' + note.id + '"]');
        if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); setTimeout(function () { card.classList.remove('flash'); }, 900); }
      });
      noteHost.appendChild(row);
    });
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
    row.appendChild(main);

    var controls = el('div', 'row-controls');
    var select = el('select', 'status-select');
    select.setAttribute('aria-label', 'Status');
    state.statuses.forEach(function (status) {
      var o = el('option', null, status);
      o.value = status;
      if (status === task.status) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', function () { update('tasks', task.id, { status: select.value }); });
    controls.appendChild(select);

    var actions = el('div', 'row-actions');
    var star = iconButton(task.today ? 'Move to ' + LABEL_LATER : 'Move to ' + LABEL_NOW,
      task.today ? '★' : '☆', function () { update('tasks', task.id, { today: !task.today }); });
    if (task.today) star.classList.add('is-today');
    if (task.archived) { star.classList.add('is-blank'); star.tabIndex = -1; star.setAttribute('aria-hidden', 'true'); }
    actions.appendChild(star);
    // Archiving clears "today" so a restored task comes back to Later.
    actions.appendChild(iconButton(task.archived ? 'Restore' : 'Archive', task.archived ? '⇧' : '⇩', function () {
      update('tasks', task.id, task.archived ? { archived: false } : { archived: true, today: false });
    }));
    actions.appendChild(iconButton('Edit', '✎', function () { editTask(task.id); }));
    actions.appendChild(iconButton('Delete', '✕', function () { remove('tasks', task.id, task.name); }, true));
    controls.appendChild(actions);
    row.appendChild(controls);

    attachHandle(row, handle, list, '.row', 'tasks', false);
    return row;
  }

  function editTask(id) {
    var task = byId(state.tasks, id);
    if (!task) return;
    openEditor('Edit task', [
      { name: 'name', label: 'Task name', value: task.name },
      { name: 'notes', label: 'Notes', type: 'textarea', value: task.notes, markdown: true },
      { name: 'status', label: 'Status', type: 'select', options: state.statuses, value: task.status }
    ], function (values) { update('tasks', id, values); });
  }

  /* --------------------------------------------------------- notebook -- */
  function renderNotes() {
    var grid = clear(document.getElementById('note-grid'));
    if (!state.notes.length) { grid.appendChild(el('p', 'empty', 'No notes yet. Hit "New note".')); return; }
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
    title.placeholder = 'Title';
    title.value = note.title || '';
    title.addEventListener('input', function () { queueSave(note.id, 'notes', { title: title.value }); });
    card.appendChild(title);

    var preview = el('div', 'note-md md');
    var body = el('textarea', 'note-body');
    body.placeholder = 'Write something…';
    body.value = note.body || '';
    function showPreview() {
      if (body.value.trim()) mdInto(preview, body.value);
      else clear(preview).appendChild(el('span', 'md-placeholder', 'Write something…'));
      preview.hidden = false;
      body.hidden = true;
    }
    function showEditor() {
      preview.hidden = true;
      body.hidden = false;
      body.focus();
      body.setSelectionRange(body.value.length, body.value.length);
    }
    preview.addEventListener('click', function (e) { if (e.target.closest('a')) return; showEditor(); });
    body.addEventListener('input', function () { queueSave(note.id, 'notes', { body: body.value }); });
    body.addEventListener('blur', function () { flushSave(note.id); showPreview(); });
    title.addEventListener('blur', function () { flushSave(note.id); });
    enableIndentKeys(body);
    card.appendChild(preview);
    card.appendChild(body);
    showPreview();

    attachHandle(card, handle, grid, '.note', 'notes', true);
    return card;
  }

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
      state[table].unshift(item);
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
      try {
        var counts = Store.importJson(String(reader.result));
        load();
        toast('Imported ' + counts.tasks + ' tasks and ' + counts.notes + ' notes');
      } catch (e) { fail(e); }
    };
    reader.readAsText(file);
  }
  function closeMenu() { document.querySelector('.menu').open = false; }

  /* ------------------------------------------------------------- boot -- */
  function load() {
    var data = Store.loadAll();
    state.tasks = data.tasks;
    state.notes = data.notes;
    renderTasks();
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
  var taskNotes = document.getElementById('task-add-notes');
  var taskToday = document.getElementById('task-add-today');
  taskToday.parentNode.lastChild.textContent = ' Add to ' + LABEL_NOW;
  enableIndentKeys(taskNotes);
  submitOnCmdEnter(taskForm);
  document.getElementById('task-add-help').appendChild(markdownHelp());
  taskForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('task-add-name');
    var name = input.value.trim();
    if (!name) { input.focus(); return; }
    create('tasks', { name: name, notes: taskNotes.value.trim(), status: state.statuses[0], today: taskToday.checked });
    input.value = '';
    taskNotes.value = '';
    input.focus();
  });

  document.getElementById('note-add').addEventListener('click', function () {
    create('notes', { title: '', body: '', color: state.colors[0] }).then(function () {
      var first = document.querySelector('#note-grid .note .note-title');
      if (first) first.focus();
    });
  });
  document.getElementById('note-help').appendChild(markdownHelp());

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

  // Keep two open tabs/windows of the app in step.
  window.addEventListener('storage', function (e) {
    if (e.key !== Store.KEY) return;
    Store.reloadFromDisk();
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    load();
  });

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

  load();
  showTab(location.hash.slice(1) || 'home', true);
})();
