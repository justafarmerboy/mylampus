'use strict';

// Service worker: makes the app installable and keeps the app shell available
// on a flaky connection. Pages and scripts are network-first so updates show up
// immediately; live data (/api/) is never cached.

const CACHE = 'mylampus-v3';
const SHELL = [
  '/', '/owner', '/firefly.css', '/map.js', '/owner.js', '/pwa.js', '/feedback.js',
  '/vendor/leaflet/leaflet.css', '/vendor/leaflet/leaflet.js',
  '/icon.svg', '/icons/icon-192.png', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Uploaded photos never change (random names): serve from cache when we have them.
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })));
    return;
  }

  // Everything else: network first, cached copy when offline.
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match(req.mode === 'navigate' ? '/' : req))));
});
