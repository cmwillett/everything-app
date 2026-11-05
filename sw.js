/*
 * Offline support. The version lives in js/version.js; bumping it there makes
 * installed copies pick up the new code on their next launch.
 */
importScripts('./js/version.js');
const VERSION = self.APP_VERSION;
const CACHE = 'everything-app-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './js/version.js',
  './css/styles.css',
  './js/markdown.js',
  './js/richtext.js',
  './js/appearance.js',
  './js/app.js',
  './js/store.js',
  './js/recur.js',
  './js/cloud.js',
  './js/firebase-config.js',
  './js/push-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// The Firebase SDK, so the app can start offline. Keep in step with cloud.js.
const SDK = '13.1.0';
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-messaging.js', 'firebase-functions.js']
  .map((f) => 'https://www.gstatic.com/firebasejs/' + SDK + '/' + f);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time: a single failed download must never block the update
    // (addAll would throw and leave the old version in charge, silently).
    await Promise.all(ASSETS.map((url) => cache.add(new Request(url, { cache: 'no-cache' })).catch(() => {})));
    // Best effort: if these fail now they'll be cached on first use.
    await Promise.all(SDK_FILES.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('everything-app-') && k !== CACHE && k !== DIAG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Versioned SDK files never change: cache first.
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // The optional rounded font: cache first once fetched.
  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // Everything else that isn't ours (Firestore, sign-in) goes straight to the network.
  if (url.origin !== self.location.origin) return;
  // Firebase's sign-in helper pages, if you ever host them here.
  if (url.pathname.includes('/__/')) return;

  // Our own files: network first so updates show up straight away when
  // online; fall back to the cache when offline.
  // 'no-cache' makes the browser re-check with GitHub instead of reusing a
  // copy it saved earlier, so a new version shows up on the next open.
  const fresh = req.mode === 'navigate'
    ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(req, { cache: 'no-cache' });
  event.respondWith(
    fresh
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

/* ------------------------------------------------ reminder notifications -- */
// The reminder sender (functions/index.js) sends a data-only push; showing
// it is up to us. iPhone requires that every push shows a notification.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  const d = payload.data || payload.notification || payload;
  const title = d.title || 'Reminder';
  const options = {
    body: d.body || '',
    tag: d.reminderId || undefined,
    renotify: !!d.reminderId,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    timestamp: Number(d.dueAtMs) || Date.now(),
    requireInteraction: true,
    data: { url: './#reminders' }
  };
  event.waitUntil((async () => {
    const diag = { at: Date.now(), version: VERSION, title, hasAck: !!(d.ackUrl && d.ackKey && d.reminderId && d.uid) };
    try {
      await self.registration.showNotification(title, options);
      diag.shown = true;
    } catch (e) { diag.shown = false; diag.showError = String(e && e.message || e); }
    // Tell the server it was shown, so it doesn't send the backup email.
    if (diag.hasAck && diag.shown) {
      diag.ack = await sendAck(d);
      if (!diag.ack.ok) diag.pending = { url: d.ackUrl, uid: d.uid, rid: d.reminderId, key: d.ackKey };
    }
    await saveDiag(diag);
  })());
});

// Try a normal request first (we can see if it worked), then a simpler one.
async function sendAck(d) {
  const body = JSON.stringify({ uid: d.uid, rid: d.reminderId, key: d.ackKey });
  try {
    const res = await fetch(d.ackUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    if (res.ok || res.status === 204) return { ok: true, how: 'post', status: res.status };
    if (res.status === 404) return { ok: false, how: 'post', status: 404, note: 'server did not recognise this reminder' };
  } catch (e) { /* fall through */ }
  try {
    const q = '?uid=' + encodeURIComponent(d.uid) + '&rid=' + encodeURIComponent(d.reminderId) + '&key=' + encodeURIComponent(d.ackKey);
    await fetch(d.ackUrl + q, { method: 'GET', mode: 'no-cors' });
    return { ok: true, how: 'get' };
  } catch (e) {
    return { ok: false, how: 'get', note: String(e && e.message || e) };
  }
}

// A small record of the last reminder notification, readable from the app.
const DIAG_CACHE = 'everything-app-diag';
async function saveDiag(diag) {
  try {
    const c = await caches.open(DIAG_CACHE);
    await c.put('./__diag/last-push', new Response(JSON.stringify(diag), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* ignore */ }
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

// Tapping the notification opens (or focuses) the app on the Reminders tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        if ('navigate' in w) { try { await w.navigate(target); } catch (e) { /* ignore */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
