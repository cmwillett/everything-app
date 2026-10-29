/*
 * A small rich text editor (no library) plus the sanitizer that makes it safe.
 *
 * Saved values are HTML. Anything saved by the earlier Markdown version is
 * recognised and converted on the fly, so old notes still look right and turn
 * into rich text the first time they're edited.
 *
 * Every value goes through sanitize() both when it's saved and when it's
 * shown, so only a short list of harmless tags can ever reach the page.
 */
(function (global) {
  'use strict';

  // Tags kept as-is (after renaming the synonyms below). Everything else is
  // either unwrapped (its text kept) or dropped entirely.
  var KEEP = { P: 1, BR: 1, STRONG: 1, EM: 1, U: 1, S: 1, UL: 1, OL: 1, LI: 1, A: 1,
    H1: 1, H2: 1, H3: 1, CODE: 1, PRE: 1, BLOCKQUOTE: 1 };
  var RENAME = { B: 'STRONG', I: 'EM', DEL: 'S', STRIKE: 'S', INS: 'U', TT: 'CODE' };
  // Block containers that should become paragraphs so line breaks survive.
  var TO_P = { DIV: 1, SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, ASIDE: 1,
    H4: 1, H5: 1, H6: 1, FIGURE: 1, FIGCAPTION: 1, ADDRESS: 1, DT: 1, DD: 1, TR: 1 };
  // Dropped with everything inside them.
  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, HEAD: 1, META: 1, LINK: 1,
    TITLE: 1, SVG: 1, MATH: 1, IMG: 1, PICTURE: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, FORM: 1,
    INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, NOSCRIPT: 1, TEMPLATE: 1, XML: 1 };
  var BLOCK = { P: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, PRE: 1, BLOCKQUOTE: 1 };

  function safeHref(href) {
    var h = String(href || '').trim();
    if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
    return null;
  }

  // Pasted text from Google Docs / Word carries formatting in style="" rather
  // than tags, so translate the few styles that matter before discarding them.
  function styleWrappers(node) {
    var st = node.style || {};
    var out = [];
    var w = String(st.fontWeight || '');
    if (w === 'bold' || w === 'bolder' || Number(w) >= 600) out.push('STRONG');
    if (String(st.fontStyle) === 'italic') out.push('EM');
    var deco = String(st.textDecoration || st.textDecorationLine || '');
    if (deco.indexOf('underline') !== -1) out.push('U');
    if (deco.indexOf('line-through') !== -1) out.push('S');
    return out;
  }
  function explicitlyNotBold(node) {
    var w = String((node.style && node.style.fontWeight) || '');
    return w === 'normal' || (w && Number(w) < 600);
  }

  function cleanChildren(from, to, doc) {
    Array.prototype.forEach.call(from.childNodes, function (child) { cleanNode(child, to, doc); });
  }

  function cleanNode(node, parent, doc) {
    if (node.nodeType === 3) { parent.appendChild(doc.createTextNode(node.nodeValue)); return; }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toUpperCase();
    if (DROP[tag]) return;

    // Google Docs wraps a whole paste in <b style="font-weight:normal">.
    if (tag === 'B' && explicitlyNotBold(node)) { cleanChildren(node, parent, doc); return; }
    tag = RENAME[tag] || tag;

    var target = parent;
    if (KEEP[tag]) {
      var el = doc.createElement(tag);
      if (tag === 'A') {
        var href = safeHref(node.getAttribute('href'));
        if (!href) { cleanChildren(node, parent, doc); return; }
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      parent.appendChild(el);
      target = el;
    } else if (TO_P[tag] && !hasBlockChild(node)) {
      var p = doc.createElement('P');
      parent.appendChild(p);
      target = p;
    } else if (tag === 'TD' || tag === 'TH') {
      parent.appendChild(doc.createTextNode(' '));
    }

    // Formatting expressed only as styles (spans, or the tag itself).
    styleWrappers(node).forEach(function (wrap) {
      if (wrap === tag) return;
      var w = doc.createElement(wrap);
      target.appendChild(w);
      target = w;
    });

    cleanChildren(node, target, doc);
  }

  function hasBlockChild(node) {
    return Array.prototype.some.call(node.children || [], function (c) {
      var t = c.tagName.toUpperCase();
      return BLOCK[t] || TO_P[t] || t === 'TABLE';
    });
  }

  // Text typed straight into an empty editor isn't inside a paragraph. Wrap
  // every run of loose inline content so saved values always start with a
  // block tag (that's also how saved rich text is told apart from old Markdown).
  function wrapLooseInline(root, doc) {
    var run = null;
    Array.prototype.slice.call(root.childNodes).forEach(function (n) {
      var block = n.nodeType === 1 && BLOCK[n.tagName];
      if (block) { run = null; return; }
      if (!run) {
        if (n.nodeType === 3 && !n.nodeValue.trim()) return;
        run = doc.createElement('P');
        root.insertBefore(run, n);
      }
      run.appendChild(n);
    });
  }

  // Strip empty inline wrappers and trailing empty paragraphs left by editing.
  function tidy(root) {
    // Empty paragraphs with no <br> are editing leftovers, not blank lines.
    root.querySelectorAll('p').forEach(function (p) {
      if (!p.textContent.trim() && !p.querySelector('br')) p.remove();
    });
    root.querySelectorAll('strong, em, u, s, code, a').forEach(function (n) {
      if (!n.textContent && !n.querySelector('br')) n.remove();
    });
    while (root.childNodes.length > 1) {
      var last = root.lastChild;
      var emptyText = last.nodeType === 3 && !last.nodeValue.trim();
      var emptyBlock = last.nodeType === 1 && (last.tagName === 'P' || last.tagName === 'BR') && !last.textContent.trim();
      if (!emptyText && !emptyBlock) break;
      last.remove();
    }
  }

  function sanitize(html) {
    var doc = document.implementation.createHTMLDocument('');
    var src = doc.createElement('div');
    src.innerHTML = String(html == null ? '' : html);   // inert document: nothing runs or loads
    var out = doc.createElement('div');
    cleanChildren(src, out, doc);
    wrapLooseInline(out, doc);
    tidy(out);
    return isBlank(out) ? '' : out.innerHTML;
  }

  function isBlank(node) {
    return !node.textContent.trim() && !node.querySelector('li');
  }

  function isHtml(value) { return /^\s*</.test(String(value || '')); }

  // Any stored value (HTML, old Markdown, or plain text) → clean HTML.
  function toHtml(value) {
    var v = String(value == null ? '' : value);
    if (!v.trim()) return '';
    return sanitize(isHtml(v) ? v : global.Markdown.render(v));
  }

  function renderInto(node, value) {
    node.innerHTML = toHtml(value);
    return node;
  }

  function toPlain(value) {
    var div = document.createElement('div');
    div.innerHTML = toHtml(value).replace(/<\/(p|li|h\d)>/g, ' </$1>');
    return div.textContent.replace(/\s+/g, ' ').trim();
  }

  /* ------------------------------------------------------------ editor -- */
  var BUTTONS = [
    { cmd: 'bold', label: 'Bold (Ctrl+B)', html: '<b>B</b>' },
    { cmd: 'italic', label: 'Italic (Ctrl+I)', html: '<i>I</i>' },
    { cmd: 'underline', label: 'Underline (Ctrl+U)', html: '<u>U</u>' },
    { cmd: 'strikeThrough', label: 'Strikethrough', html: '<s>S</s>' },
    { sep: true },
    { cmd: 'insertUnorderedList', label: 'Bulleted list', html: listIcon(false) },
    { cmd: 'insertOrderedList', label: 'Numbered list', html: listIcon(true) },
    { cmd: 'outdent', label: 'Decrease indent', html: '⇤', listOnly: true },
    { cmd: 'indent', label: 'Increase indent', html: '⇥', listOnly: true },
    { sep: true },
    { cmd: 'link', label: 'Add link', html: '🔗' },
    { cmd: 'removeFormat', label: 'Clear formatting', html: '<span class="rte-clear">T<sub>×</sub></span>' }
  ];

  function listIcon(numbered) {
    var marks = numbered
      ? '<text x="1" y="5.5" font-size="5">1</text><text x="1" y="10.5" font-size="5">2</text><text x="1" y="15.5" font-size="5">3</text>'
      : '<circle cx="2.5" cy="4" r="1.3"/><circle cx="2.5" cy="9" r="1.3"/><circle cx="2.5" cy="14" r="1.3"/>';
    return '<svg viewBox="0 0 18 18" width="16" height="16" fill="currentColor" aria-hidden="true">' + marks +
      '<rect x="6" y="3.2" width="11" height="1.6" rx=".8"/><rect x="6" y="8.2" width="11" height="1.6" rx=".8"/>' +
      '<rect x="6" y="13.2" width="11" height="1.6" rx=".8"/></svg>';
  }

  var configured = false;
  function configureOnce() {
    if (configured) return;
    configured = true;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }
    try { document.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
  }

  function inList(editor) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return false;
    var n = sel.anchorNode;
    while (n && n !== editor) { if (n.nodeName === 'LI') return true; n = n.parentNode; }
    return false;
  }

  function selectionInside(editor) {
    var sel = window.getSelection();
    return sel.rangeCount && editor.contains(sel.anchorNode);
  }

  /*
   * create({ value, placeholder, onInput, minHeight, toolbar: 'always'|'focus' })
   * → { el, editor, getValue(), setValue(v), focus(), isEmpty() }
   */
  function create(opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'rte' + (opts.toolbar === 'focus' ? ' rte-toolbar-on-focus' : '') + (opts.className ? ' ' + opts.className : '');

    var bar = document.createElement('div');
    bar.className = 'rte-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Formatting');
    var buttons = [];
    BUTTONS.forEach(function (b) {
      if (b.sep) { var s = document.createElement('span'); s.className = 'rte-sep'; bar.appendChild(s); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rte-btn';
      btn.innerHTML = b.html;
      btn.title = b.label;
      btn.setAttribute('aria-label', b.label);
      btn.dataset.cmd = b.cmd;
      if (b.listOnly) btn.dataset.listOnly = '1';
      // mousedown, not click, so the text selection isn't lost first.
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function () { run(b.cmd); });
      bar.appendChild(btn);
      buttons.push(btn);
    });

    var editor = document.createElement('div');
    editor.className = 'rte-editor md';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    if (opts.placeholder) { editor.dataset.placeholder = opts.placeholder; editor.setAttribute('aria-label', opts.placeholder); }
    if (opts.minHeight) editor.style.minHeight = opts.minHeight + 'px';
    editor.innerHTML = toHtml(opts.value);

    wrap.appendChild(bar);
    wrap.appendChild(editor);

    function changed() {
      refresh();
      if (opts.onInput) opts.onInput(api.getValue());
    }

    function run(cmd) {
      configureOnce();
      if (!selectionInside(editor)) editor.focus();
      if (cmd === 'link') { addLink(); return; }
      if ((cmd === 'indent' || cmd === 'outdent') && !inList(editor)) return;
      document.execCommand(cmd, false, null);
      if (cmd === 'removeFormat') document.execCommand('unlink', false, null);
      changed();
    }

    function addLink() {
      var sel = window.getSelection();
      var range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      var existing = currentLink();
      var answer = window.prompt('Link address (web page):', existing ? existing.getAttribute('href') : 'https://');
      editor.focus();
      if (range) { sel.removeAllRanges(); sel.addRange(range); }
      if (answer === null) return;
      answer = answer.trim();
      if (!answer || answer === 'https://') { if (existing) { document.execCommand('unlink', false, null); changed(); } return; }
      if (!/^[a-z][a-z0-9+.\-]*:/i.test(answer)) answer = 'https://' + answer;
      if (!safeHref(answer)) { window.alert('Only web links (http or https) can be added.'); return; }
      if (sel.isCollapsed && !existing) {
        document.execCommand('insertHTML', false, '<a href="' + answer.replace(/"/g, '&quot;') + '">' +
          answer.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</a>&nbsp;');
      } else {
        document.execCommand('createLink', false, answer);
      }
      editor.querySelectorAll('a').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
      changed();
    }

    function currentLink() {
      var sel = window.getSelection();
      if (!sel.rangeCount) return null;
      var n = sel.anchorNode;
      while (n && n !== editor) { if (n.nodeName === 'A') return n; n = n.parentNode; }
      return null;
    }

    function refresh() {
      if (!selectionInside(editor)) return;
      var listy = inList(editor);
      buttons.forEach(function (btn) {
        var cmd = btn.dataset.cmd;
        if (btn.dataset.listOnly) { btn.disabled = !listy; return; }
        var on = false;
        try { on = cmd === 'link' ? !!currentLink() : document.queryCommandState(cmd); } catch (e) { /* ignore */ }
        btn.classList.toggle('is-on', !!on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    editor.addEventListener('focus', configureOnce);
    editor.addEventListener('input', changed);
    editor.addEventListener('keyup', refresh);
    editor.addEventListener('mouseup', refresh);
    document.addEventListener('selectionchange', function () { if (document.activeElement === editor) refresh(); });

    editor.addEventListener('keydown', function (e) {
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey && inList(editor)) {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent', false, null);
        changed();
        return;
      }
      if (e.key === 'Escape') editor.blur();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); addLink(); }
    });

    // Paste: keep the useful formatting, lose the rest.
    editor.addEventListener('paste', function (e) {
      var cd = e.clipboardData;
      if (!cd) return;
      e.preventDefault();
      configureOnce();
      var html = cd.getData('text/html');
      var clean;
      if (html) clean = sanitize(html);
      else {
        var text = cd.getData('text/plain') || '';
        clean = text.split(/\r?\n/).map(function (line) {
          return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }).join('<br>');
      }
      document.execCommand('insertHTML', false, clean);
      changed();
    });

    // Dropping files/images would embed them; only allow text drops.
    editor.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) e.preventDefault();
    });

    // Links inside an editor: Ctrl/⌘+click (or a tap while not typing) opens them.
    var hadFocus = false;
    editor.addEventListener('pointerdown', function () { hadFocus = document.activeElement === editor; });
    editor.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (!a || !editor.contains(a)) return;
      if (e.ctrlKey || e.metaKey || !hadFocus) {
        e.preventDefault();
        var href = safeHref(a.getAttribute('href'));
        if (href) window.open(href, '_blank', 'noopener');
        editor.blur();
      }
    });

    function resetButtons() {
      buttons.forEach(function (btn) { btn.classList.remove('is-on'); btn.setAttribute('aria-pressed', 'false'); btn.disabled = false; });
    }
    editor.addEventListener('blur', function () {
      if (isBlank(editor)) editor.innerHTML = '';
      resetButtons();
    });

    var api = {
      el: wrap,
      editor: editor,
      getValue: function () { return sanitize(editor.innerHTML); },
      setValue: function (v) { editor.innerHTML = toHtml(v); resetButtons(); },
      focus: function () {
        editor.focus();
        var range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      },
      isEmpty: function () { return isBlank(editor); }
    };
    return api;
  }

  global.RichText = {
    create: create,
    sanitize: sanitize,
    toHtml: toHtml,
    toPlain: toPlain,
    renderInto: renderInto,
    isHtml: isHtml
  };
})(window);
