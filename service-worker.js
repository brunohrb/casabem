// ============================================================
// casa BEM · Service Worker
// ------------------------------------------------------------
// Cache-first para shell estático (HTML, logo, manifest).
// Network-first para tudo mais (scripts externos, Supabase).
// ------------------------------------------------------------
// Atualize `CACHE_VERSION` a cada release que afete o shell —
// o SW antigo expira e o novo toma conta no próximo load.
// ============================================================

const CACHE_VERSION = 'casabem-v1';
const SHELL_ASSETS = [
  './',
  './index.html',
  './logo.png',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install cache error', err)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca interceptamos Supabase (dados realtime, edge functions, websockets).
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) {
    return;
  }

  // Cross-origin (CDN do Supabase JS etc.) → network-first.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Mesma origem → cache-first com fallback pra rede.
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Refresh em background
        fetch(req).then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE_VERSION).then(c => c.put(req, res.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    }),
  );
});
