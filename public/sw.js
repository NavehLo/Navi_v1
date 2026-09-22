// Minimal service worker: makes the app installable, serves a cached shell
// when offline, holds on to narration audio, and keeps the map's tiles for
// walking a trail with no reception.
//
// Bump SW_VERSION whenever this file or the shell changes. The cache name is
// derived from it, so activate() clears the old one — with a fixed name the
// old cache lived on across deploys and nothing here could ever be retired.
const SW_VERSION = 3;
const CACHE = `navi-v${SW_VERSION}`;
const SHELL = ['/', '/icon-192.png', '/icon-512.png'];

// Narration clips are immutable: the filename is a hash of the text and the
// voice, so a given url's content never changes. Cache-first is exactly right,
// and it is what lets a narration play with no reception. (The device's
// IndexedDB store is the primary offline copy — see lib/offlineAudio — this
// is a second layer that also covers points played without downloading first.)
const NARRATION_PATH = '/narrations/';

// ── Map tiles ────────────────────────────────────────────────────────────────
//
// Everything the map fetches from Mapbox — tiles, the style, fonts, icons —
// is kept in its own cache, which survives service-worker upgrades: a trail
// downloaded for the field must not vanish because a deploy bumped
// SW_VERSION. The page fills this cache (lib/offlineMap downloads a trail's
// corridor of tiles into it); this file only answers from it.
//
// Mapbox's Product Terms (§2.8.1) allow content delivered by their APIs to be
// cached on the end user's device for thirty days, as long as that device
// fetched it from the API itself. Both halves are enforced here: entries are
// written by this device from api.mapbox.com and stamped with the time, and
// nothing older than thirty days is ever served — an expired entry is deleted
// on the way to the network, never returned. The billing endpoints
// (map-sessions, events.mapbox.com) are never touched.
//
// These constants are mirrored in src/lib/offlineMap.ts. The worker is
// plain JavaScript and cannot import them, so a change here is a change there.
const MAP_CACHE = 'navi-map-v1';
const MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHED_AT = 'x-navi-cached-at';
const BYTES = 'x-navi-bytes';

// A flag the settings screen can set to make this worker behave as if the
// network were gone, so the field experience can be checked in a browser
// without pulling the plug. Kept in a cache rather than a variable: the
// worker is stopped and restarted at will, and a variable would not survive.
const FLAGS_CACHE = 'navi-flags';
const SIMULATE_OFFLINE_KEY = 'https://navi-flags.local/simulate-offline';

function isMapboxHost(hostname) {
  return hostname === 'api.mapbox.com' || hostname.endsWith('.tiles.mapbox.com');
}

// The cache key is the path alone. The TileJSON names a.tiles.mapbox.com and
// b.tiles.mapbox.com, the map itself asks api.mapbox.com, and every request
// carries a session (`sku`) and token in the query that differ between the
// map's own requests and a download — the path is the one part that is the
// same wherever a given tile is asked for.
function mapKey(url) {
  return 'https://navi-map.local' + new URL(url).pathname;
}

function isFresh(res) {
  const t = Number(res.headers.get(CACHED_AT));
  return Number.isFinite(t) && Date.now() - t < MAP_TTL_MS;
}

let simulateOffline = null;

async function readSimulateOffline() {
  if (simulateOffline !== null) return simulateOffline;
  try {
    const flags = await caches.open(FLAGS_CACHE);
    simulateOffline = !!(await flags.match(SIMULATE_OFFLINE_KEY));
  } catch (_) {
    simulateOffline = false;
  }
  return simulateOffline;
}

async function writeSimulateOffline(on) {
  simulateOffline = !!on;
  const flags = await caches.open(FLAGS_CACHE);
  if (on) await flags.put(SIMULATE_OFFLINE_KEY, new Response('1'));
  else await flags.delete(SIMULATE_OFFLINE_KEY);
}

// Every trip to the network goes through here, so one flag can cut them all.
async function netFetch(request) {
  if (await readSimulateOffline()) throw new TypeError('Simulated offline');
  return fetch(request);
}

// A copy of a Mapbox response, stripped to its body and content type and
// stamped with the time it was fetched. The stamp is what the thirty-day rule
// is checked against; the original Cache-Control (twelve hours) is dropped so
// the map's own internal cache does not hold a second copy.
async function wrapForCache(res) {
  const body = await res.arrayBuffer();
  const headers = new Headers();
  const type = res.headers.get('content-type');
  if (type) headers.set('content-type', type);
  headers.set(CACHED_AT, String(Date.now()));
  headers.set(BYTES, String(body.byteLength));
  return new Response(body, { status: 200, headers });
}

async function handleMapbox(event, request) {
  const cache = await caches.open(MAP_CACHE);
  const key = mapKey(request.url);
  const hit = await cache.match(key);
  if (hit) {
    if (isFresh(hit)) return hit;
    await cache.delete(key);
  }
  try {
    const res = await netFetch(request);
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(wrapForCache(copy).then((wrapped) => cache.put(key, wrapped)).catch(() => {}));
    }
    return res;
  } catch (_) {
    // No fresh copy and no network. An expired copy is not an option: it was
    // deleted above, and serving it would be exactly what the terms forbid.
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== MAP_CACHE && k !== FLAGS_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'navi-simulate-offline') {
    event.waitUntil(writeSimulateOffline(data.on));
  }
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
        return netFetch(event.request).then((res) => {
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

  // The map's requests to Mapbox. The billing session is left alone: it must
  // reach Mapbox or fail honestly, never be answered from here.
  if (isMapboxHost(url.hostname)) {
    if (url.pathname.startsWith('/map-sessions')) return;
    event.respondWith(handleMapbox(event, event.request));
    return;
  }

  // Never intercept other cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API calls are never cached. They are only intercepted at all so that the
  // offline simulation can cut them like everything else.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      netFetch(event.request).catch(() => new Response('', { status: 504, statusText: 'Offline' }))
    );
    return;
  }

  // Network-first with cache fallback for same-origin GETs
  event.respondWith(
    netFetch(event.request)
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
