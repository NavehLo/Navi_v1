// Minimal service worker: makes the app installable, serves a cached shell
// when offline, and holds on to narration audio.
//
// Bump SW_VERSION whenever this file or the shell changes. The cache name is
// derived from it, so activate() clears the old one — with a fixed name the
// old cache lived on across deploys and nothing here could ever be retired.
const SW_VERSION = 2;
const CACHE = `navi-v${SW_VERSION}`;
const SHELL = ['/', '/icon-192.png', '/icon-512.png'];

// Narration clips are immutable: the filename is a hash of the text and the
// voice, so a given url's content never changes. Cache-first is exactly right,
// and it is what lets a narration play with no reception. (The device's
// IndexedDB store is the primary offline copy — see lib/offlineAudio — this
// is a second layer that also covers points played without downloading first.)
const NARRATION_PATH = '/narrations/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Narration audio, wherever it is served from: cache-first, since the
  // content behind a given url never changes.
  if (url.pathname.includes(NARRATION_PATH)) {
    event.respondWith(
      caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // Never intercept API calls, Mapbox, or other cross-origin requests
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Network-first with cache fallback for same-origin GETs
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/')))
  );
});
