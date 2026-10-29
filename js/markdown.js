/*
 * A deliberately small Markdown subset, ported from the Apps Script version.
 * Everything is HTML-escaped before any pattern runs, so the only tags that can
 * reach innerHTML are the ones emitted here.
 */
(function (global) {
  'use strict';

  var INDENT = '  ';

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isSafeUrl(url) { return /^https?:\/\//i.test(String(url || '')); }

  function anchorHtml(href, label) {
    return '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  }

  // Finished fragments are parked behind a placeholder so later patterns
  // cannot reach inside them.
  function stash(store, html) {
    store.push(html);
    return '\u0000' + (store.length - 1) + '\u0000';
  }

  function inlineMd(text) {
    var held = [];
    var out = escapeHtml(text)
      .replace(/`([^`]+)`/g, function (_, code) { return stash(held, '<code>' + code + '</code>'); })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (whole, label, href) {
        return isSafeUrl(href) ? stash(held, anchorHtml(href, label)) : whole;
      })
      .replace(/(^|\s)(https?:\/\/[^\s]+)/g, function (_, lead, url) {
        return lead + stash(held, anchorHtml(url, url));
      });
    return out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return held[i]; });
  }

  function renderListItems(items, start) {
    var depth = items[start].depth;
    var html = '';
    var i = start;
    while (i < items.length && items[i].depth === depth) {
      var tag = items[i].tag;
      html += '<' + tag + '>';
      while (i < items.length && items[i].depth === depth && items[i].tag === tag) {
        html += '<li>' + inlineMd(items[i].text);
        i++;
        if (i < items.length && items[i].depth > depth) {
          var child = renderListItems(items, i);
          html += child.html;
          i = child.next;
        }
        html += '</li>';
      }
      html += '</' + tag + '>';
    }
    return { html: html, next: i };
  }

  function render(text) {
    var out = [];
    var items = [];
    var levels = [];
    var fence = null;

    function flushList() {
      if (items.length) { out.push(renderListItems(items, 0).html); items = []; }
      levels = [];
    }
    function closeFence() {
      out.push('<pre><code>' + escapeHtml(fence.join('\n')) + '</code></pre>');
      fence = null;
    }

    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      if (/^\s*```/.test(line)) {
        if (fence) closeFence(); else { flushList(); fence = []; }
        return;
      }
      if (fence) { fence.push(line); return; }

      var heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flushList();
        out.push('<h' + heading[1].length + ' class="md-h">' + inlineMd(heading[2]) +
          '</h' + heading[1].length + '>');
        return;
      }

      var item = /^([ \t]*)([-*]|\d+[.)])[ \t]+(.*)$/.exec(line);
      if (item) {
        var columns = item[1].replace(/\t/g, INDENT).length;
        while (levels.length > 1 && columns < levels[levels.length - 1]) levels.pop();
        if (!levels.length || columns > levels[levels.length - 1]) levels.push(columns);
        items.push({ depth: levels.length - 1, tag: /^\d/.test(item[2]) ? 'ol' : 'ul', text: item[3] });
        return;
      }

      flushList();
      if (!line.trim()) return;
      out.push('<p>' + inlineMd(line) + '</p>');
    });

    if (fence) closeFence();
    flushList();
    return out.join('');
  }

  function toPlain(text) {
    return String(text == null ? '' : text)
      .replace(/```/g, '')
      .replace(/^\s*#{1,3}\s+/gm, '')
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, '• ')
      .replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  global.Markdown = { render: render, toPlain: toPlain, INDENT: INDENT };
})(window);
