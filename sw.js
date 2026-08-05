// Cache version — replaced by CI with $GITHUB_SHA on deploy
const CACHE_VERSION = 'a64a9af4fda1469a38587b44f01700f28bcf2e23';
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

// Vendored third-party libs (cache-first — bundled and versioned with the app itself)
const VENDOR_ASSETS = [
  'vendor/daisyui.min.css',
  'vendor/tailwind.js',
  'vendor/alpine.min.js',
  'vendor/chart.umd.min.js',
  'vendor/chartjs-adapter-date-fns.bundle.min.js',
];

const NETWORK_TIMEOUT_MS = 3000;

function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...APP_SHELL, ...VENDOR_ASSETS]))
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

  if (url.origin !== self.location.origin) return;

  // Vendored libs: cache-first (bundled and versioned with the app itself)
  if (VENDOR_ASSETS.some((path) => url.pathname.endsWith(path))) {
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

  // App shell: network-first with cache fallback, bounded so an unreachable
  // network doesn't stall the initial load behind the OS/browser's own timeout
  event.respondWith(
    fetchWithTimeout(event.request, NETWORK_TIMEOUT_MS)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Allow the page to trigger skipWaiting
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
