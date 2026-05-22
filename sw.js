// Cache version — replaced by CI with $GITHUB_SHA on deploy
const CACHE_VERSION = '1ae474c62c69759240e078452973ec22b537bb3b';
const CACHE_NAME = 'neverina-' + CACHE_VERSION;

// App shell files (network-first)
const APP_SHELL = [
  './',
  'index.html',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// CDN resources (cache-first — URLs are version-pinned)
const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'cdn.tailwindcss.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('neverina-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and chrome-extension / BLE internals
  if (event.request.method !== 'GET') return;

  // CDN resources: cache-first (version-pinned URLs don't change)
  if (CDN_ORIGINS.some((origin) => url.hostname === origin)) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
      )
    );
    return;
  }

  // App shell: network-first with cache fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
});

// Allow the page to trigger skipWaiting
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
