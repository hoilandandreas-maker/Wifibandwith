'use strict';

/* WiFi Survey service worker — keeps the app shell available offline.
 * Bump VERSION on every deploy so clients pick up new assets. */
const VERSION = '1.0.0';
const CACHE = 'wifisurvey-' + VERSION;
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Never touch speed-test traffic: only same-origin GETs are handled.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Page loads: network first (so updates arrive), cached shell offline.
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put('index.html', copy));
          return resp;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  // Static assets: cache first.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) =>
      hit ||
      fetch(req).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }),
    ),
  );
});
