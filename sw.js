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
    await cache.addAll(ASSETS);
    // Best effort: if these fail now they'll be cached on first use.
    await Promise.all(SDK_FILES.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('everything-app-') && k !== CACHE).map((k) => caches.delete(k))))
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
  event.respondWith(
    fetch(req)
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
  event.waitUntil(self.registration.showNotification(title, options));
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
