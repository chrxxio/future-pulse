// Offline shell: the app loads instantly and shows the last data when offline.
// Market data is always fetched from the network first.
const CACHE = 'fp-v2';
const SHELL = ['./', './index.html', './holo.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !url.hostname.endsWith('gstatic.com') && !url.hostname.endsWith('googleapis.com')) return;
  // network first for data and the page itself, cache fallback
  if (url.pathname.endsWith('/data/market.json') || e.request.mode === 'navigate') {
    const key = url.pathname.endsWith('/data/market.json') ? './data/market.json' : './index.html';
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key)));
    return;
  }
  // cache first for static assets and fonts
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  })));
});
