/*
 * Offline support. Bump VERSION whenever you change any file listed in ASSETS
 * so installed copies pick up the new code on their next launch.
 */
const VERSION = 'v3';
const CACHE = 'everything-app-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/markdown.js',
  './js/app.js',
  './js/store.js',
  './js/cloud.js',
  './js/firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
// The Firebase SDK, so the app can start offline. Keep in step with cloud.js.
const SDK = '13.1.0';
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js']
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
