/*
 * Appearance: theme, light/dark, accent colour, background and font.
 *
 * Loaded as a plain script in <head> so the saved look is applied before the
 * page paints (no flash of the default colours). The choice is saved with the
 * signed-in account (so it follows you between devices) and cached on the
 * device for a fast start.
 */
(function (global) {
  'use strict';

  var KEY = 'everything-app:appearance';
  var DEFAULTS = { theme: 'classic', mode: 'auto', accent: '', bg: 'plain', font: 'default' };

  // swatch: [page background, accent] used for the picker previews.
  var THEMES = [
    { id: 'classic', label: 'Classic', swatch: ['#f4f5f7', '#2f6fed'] },
    { id: 'blush', label: 'Blush', swatch: ['#fff4f7', '#e0518c'] },
    { id: 'lavender', label: 'Lavender', swatch: ['#f7f4ff', '#8758f0'] },
    { id: 'peach', label: 'Peach', swatch: ['#fff6f1', '#ec6a45'] },
    { id: 'mint', label: 'Mint', swatch: ['#f1faf6', '#1f9d74'] },
    { id: 'sky', label: 'Sky', swatch: ['#f1f8ff', '#2a8ad6'] }
  ];
  var MODES = ['auto', 'light', 'dark'];
  var BGS = ['plain', 'gradient', 'hearts', 'dots'];
  var FONTS = ['default', 'rounded'];
  var ACCENTS = ['#e0518c', '#ff6fa8', '#c2185b', '#8758f0', '#b388ff', '#ec6a45', '#f4a261', '#1f9d74', '#2a8ad6', '#2f6fed', '#455a64'];

  var current = clean(read());
  var media = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try { return JSON.parse(global.localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function cache(a) {
    try { global.localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* ignore */ }
  }
  function isHex(v) { return /^#[0-9a-f]{6}$/i.test(String(v || '')); }
  function oneOf(v, list, fallback) { return list.indexOf(v) !== -1 ? v : fallback; }

  function clean(a) {
    a = a || {};
    return {
      theme: oneOf(a.theme, THEMES.map(function (t) { return t.id; }), DEFAULTS.theme),
      mode: oneOf(a.mode, MODES, DEFAULTS.mode),
      accent: isHex(a.accent) ? a.accent.toLowerCase() : '',
      bg: oneOf(a.bg, BGS, DEFAULTS.bg),
      font: oneOf(a.font, FONTS, DEFAULTS.font)
    };
  }

  // Dark or light text on a custom accent, whichever reads better.
  function textOn(hex) {
    var n = parseInt(hex.slice(1), 16);
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 0.45 ? '#1b1b1f' : '#ffffff';
  }

  var fontLoaded = false;
  function loadRoundedFont() {
    if (fontLoaded || !global.document) return;
    fontLoaded = true;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
  }

  function isDark(a) {
    return a.mode === 'dark' || (a.mode === 'auto' && !!(media && media.matches));
  }

  function apply(a) {
    a = clean(a);
    current = a;
    var root = document.documentElement;
    if (a.theme === 'classic') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', a.theme);
    if (isDark(a)) root.setAttribute('data-dark', ''); else root.removeAttribute('data-dark');
    if (a.accent) {
      root.style.setProperty('--accent', a.accent);
      root.style.setProperty('--on-accent', textOn(a.accent));
      root.style.setProperty('--accent-soft', 'color-mix(in srgb, ' + a.accent + ' 18%, var(--surface))');
      root.setAttribute('data-custom-accent', '');
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--on-accent');
      root.style.removeProperty('--accent-soft');
      root.removeAttribute('data-custom-accent');
    }
    if (a.bg === 'plain') root.removeAttribute('data-bg'); else root.setAttribute('data-bg', a.bg);
    if (a.font === 'rounded') { root.setAttribute('data-font', 'rounded'); loadRoundedFont(); }
    else root.removeAttribute('data-font');
    updateThemeColor();
    cache(a);
    return a;
  }

  // The phone's status bar / browser bar follows the page background.
  function updateThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var bg = global.getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }

  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (current.mode === 'auto') apply(current); });
  }

  global.Appearance = {
    THEMES: THEMES, MODES: MODES, BGS: BGS, FONTS: FONTS, ACCENTS: ACCENTS, DEFAULTS: DEFAULTS,
    get: function () { return JSON.parse(JSON.stringify(current)); },
    apply: apply,
    clean: clean,
    reset: function () { return apply(DEFAULTS); },
    isDark: function () { return isDark(current); }
  };

  apply(current);
})(window);
