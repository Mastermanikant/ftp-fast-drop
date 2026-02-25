// FastDrop Service Worker — minimal, for PWA installability only
const CACHE = 'fastdrop-v1';
const PRECACHE = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    // Network first — always get freshest content; fall back to cache offline
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});
