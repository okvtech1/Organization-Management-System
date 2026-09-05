/* =====================================================================================
   OKV Organization Management System (Online/Subscribe) — Service Worker
   -------------------------------------------------------------------------------------
   Same cache-first + runtime-caching strategy as the offline app: the app shell and
   CDN libraries get cached as they're used, so app.html keeps working offline between
   syncs. Logging in (login.html's API call) and syncing still require a real
   connection — only the already-loaded UI and previously-synced data work offline.

   Bump CACHE_NAME whenever you change any HTML/JS file during development so the old
   cached version doesn't shadow your edits.
===================================================================================== */
const CACHE_NAME = 'okv-oms-online-cache-v4';

const APP_SHELL = [
  './',
  'index.html',
  'login.html',
  'app.html',
  'super-admin.html',
  'install.html',
  'signup.html',
  'pricing.html',
  'demo.html',
  'reset-password.html',
  'payment-callback.html',
  'shared.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(err => console.warn('SW install: could not pre-cache app shell', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return; // never intercept API POSTs — those need a real network round-trip

  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(res => {
          if(res && (res.ok || res.type === 'opaque')){
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(()=>{});
          }
          return res;
        })
        .catch(() => {
          if(req.mode === 'navigate') return caches.match('app.html');
          return cached;
        });
      return cached || networkFetch;
    })
  );
});
