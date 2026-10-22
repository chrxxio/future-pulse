// Offline support: the app and the last data stay available when offline.
// Same-site files (page, scripts, data) are fetched from the network first so updates
// show up right away; the cached copy is only used when the network fails.
// Fonts are cached first, since they never change.
const CACHE = 'fp-v4';
const SHELL = ['./', './index.html', './holo.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
  if (url.origin !== location.origin && !isFont) return;
  if (isFont) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    })));
    return;
  }
  // cache key ignores the ?t= cache-buster on market.json
  const key = url.pathname.endsWith('/data/market.json') ? './data/market.json' : e.request.mode === 'navigate' ? './index.html' : e.request;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key)));
});
