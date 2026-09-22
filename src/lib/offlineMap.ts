// The map, kept on the device for walking a trail with no reception.
//
// The map itself does not change: it is the same Mapbox map, the same style
// and the same tiles. What changes is where they come from. Every request the
// map makes to Mapbox goes through the service worker (public/sw.js), which
// answers from a cache when it can. This module fills that cache ahead of
// time — the corridor of tiles along a trail, the style, the fonts — and
// keeps a record of what was saved for which trail.
//
// Two things about Mapbox's Product Terms shape this file. Section 2.8.1
// allows content delivered by their APIs to be cached on the end user's
// device for thirty days, provided the device fetched it from the API itself.
// So the download runs here, in the browser, straight from api.mapbox.com —
// never through a server of ours — and every entry is stamped with the time
// so the worker can refuse anything older than thirty days. And section 2.14
// forbids interfering with what the SDK reports back, so the billing
// endpoints are never cached or answered for; they simply fail when there is
// no network, and the map carries on.

import type mapboxgl from 'mapbox-gl';
import type { Coordinate3D } from '../utils/trailUtils';
import type { TrailData, TrailKind } from '../hooks/useTrailData';
import { MAP_PACK_STORE, openDb, promisify } from './offlineAudio';
import { planCorridor, type CorridorPlan, type TileXYZ } from './tileCorridor';

// Mirrored in public/sw.js, which cannot import them. A change here is a
// change there.
export const MAP_CACHE = 'navi-map-v1';
export const MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHED_AT_HEADER = 'x-navi-cached-at';
// Set only by this module: the size of the body, so a pack's footprint can be
// added up without reading every body back.
export const BYTES_HEADER = 'x-navi-bytes';

export const RTL_PLUGIN_URL =
  'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js';

// Passive entries — tiles the map happened to load — are kept up to this many
// beyond what the packs hold. Above it the oldest go first.
const PASSIVE_CACHE_CAP = 3000;

// Terrain tiles are lossless 512px PNGs (see demFetchTemplate) and weigh
// four times what a satellite tile does; there are far fewer of them, and
// they stop a zoom level short (DEM_MAX_ZOOM).
const BYTES_PER_TILE: Record<string, number> = { raster: 70_000, vector: 25_000, 'raster-dem': 330_000 };

// The map's terrain source goes to zoom 14. The pack stops at 13: the top
// level is half the terrain tiles and a third of the pack's weight, for a
// change in relief the eye cannot find on a phone. Where a zoom-14 tile is
// missing the SDK drapes the zoom-13 parent over it. Below zoom 10 there is
// no terrain in the pack at all: relief at country scale is not what a walk
// needs, and those tiles are the heaviest of the lot.
const DEM_MIN_ZOOM = 10;
const DEM_MAX_ZOOM = 13;
const GLYPH_RANGES = ['0-255', '256-511', '1280-1535', '1536-1791', '8192-8447'];
const CONCURRENCY = 6;

export function isMapboxHost(hostname: string): boolean {
  return hostname === 'api.mapbox.com' || hostname.endsWith('.tiles.mapbox.com');
}

// The cache key is the path alone: no host, no query. See the note in
// public/sw.js — the same tile is asked for under different hosts and with
// different session tokens, and the path is what stays the same.
export function mapKey(url: string): string {
  return 'https://navi-map.local' + new URL(url).pathname;
}

export function isOfflineMapSupported(): boolean {
  return typeof caches !== 'undefined' && typeof indexedDB !== 'undefined';
}

// ── What the map actually asks for ───────────────────────────────────────────
//
// The download must produce exactly the URLs the map will request later, or
// the cache will never be hit: `@2x` or not, `.webp` or `.png`, `/v4/` or
// `/raster/v1/`. Rather than re-implement the SDK's rules, the map's own
// requests are watched (Map.tsx passes recordMapboxRequest as
// transformRequest) and the shape of each tileset's URL is remembered.

interface Registry {
  tileTemplates: Map<string, string>; // tileset id -> url with {z}/{x}/{y}
  glyphTemplate: string | null;       // url with {fontstack}/{range}
  fontstacks: Set<string>;            // as they appear in urls (percent-encoded)
  assets: Set<string>;                // style, icons, tilejson… without token
}

const registry: Registry = {
  tileTemplates: new Map(),
  glyphTemplate: null,
  fontstacks: new Set(),
  assets: new Set(),
};

const TILE_PATH = /^(\/(?:v4|raster\/v1)\/)([^/]+)\/(\d+)\/(\d+)\/(\d+)(.*)$/;
const GLYPH_PATH = /^\/fonts\/v1\/([^/]+)\/([^/]+)\/(\d+-\d+)\.pbf$/;

// Drops the parts of a query that identify a session or a token. What is
// left (`secure`, `sdk`…) is kept so a re-fetch gets the same answer.
function stripSecrets(u: URL): string {
  const params = new URLSearchParams(u.search);
  params.delete('access_token');
  params.delete('sku');
  const q = params.toString();
  return u.origin + u.pathname + (q ? `?${q}` : '');
}

export function recordMapboxRequest(url: string, resourceType?: string): { url: string } {
  try {
    const u = new URL(url);
    if (!isMapboxHost(u.hostname) || u.pathname.startsWith('/map-sessions')) return { url };
    const tile = u.pathname.match(TILE_PATH);
    if (tile) {
      const [, prefix, tileset, , , , suffix] = tile;
      registry.tileTemplates.set(tileset, `${u.origin}${prefix}${tileset}/{z}/{x}/{y}${suffix}`);
      return { url };
    }
    const glyph = u.pathname.match(GLYPH_PATH);
    if (glyph) {
      const [, owner, stack] = glyph;
      registry.glyphTemplate = `${u.origin}/fonts/v1/${owner}/{fontstack}/{range}.pbf`;
      registry.fontstacks.add(stack);
      return { url };
    }
    if (resourceType !== 'Tile' && resourceType !== 'Glyphs') registry.assets.add(stripSecrets(u));
  } catch {
    // Not a URL we understand; the map gets it back untouched.
  }
  return { url };
}

// ── Pack records ─────────────────────────────────────────────────────────────

export interface MapPack {
  trailSlug: string;
  trailName: string;
  kind: TrailKind;
  // Which of the app's map styles the tiles belong to. Offline, this is the
  // only style that has anything to show.
  styleKey: string;
  // The trail itself, so a trail that came from a URL, a file or Waymarked
  // Trails can be opened again with nothing but the pack.
  coords: Coordinate3D[];
  // Where it came from, when that was a URL — what a save to the personal
  // area records.
  sourceUrl: string | null;
  savedAt: number;
  expiresAt: number;
  tileCount: number;
  bytes: number;
  maxZoom: number;
  trimmed: boolean;
  failed: number;
  keys: string[];
}

export async function getMapPack(trailSlug: string): Promise<MapPack | null> {
  if (!isOfflineMapSupported()) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(MAP_PACK_STORE, 'readonly');
    const rec = await promisify(tx.objectStore(MAP_PACK_STORE).get(trailSlug) as IDBRequest<MapPack | undefined>);
    return rec ?? null;
  } catch (e) {
    console.error('Map pack read failed:', e);
    return null;
  }
}

export async function listMapPacks(): Promise<MapPack[]> {
  if (!isOfflineMapSupported()) return [];
  try {
    const db = await openDb();
    const tx = db.transaction(MAP_PACK_STORE, 'readonly');
    const all = await promisify(tx.objectStore(MAP_PACK_STORE).getAll() as IDBRequest<MapPack[]>);
    return all.sort((a, b) => b.savedAt - a.savedAt);
  } catch (e) {
    console.error('Map pack list failed:', e);
    return [];
  }
}

async function putMapPack(pack: MapPack): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MAP_PACK_STORE, 'readwrite');
  await promisify(tx.objectStore(MAP_PACK_STORE).put(pack) as IDBRequest);
}

// Removes the pack and the cache entries only it was holding. A tile shared
// with another trail's pack stays for that trail.
export async function deleteMapPack(trailSlug: string): Promise<void> {
  if (!isOfflineMapSupported()) return;
  try {
    const packs = await listMapPacks();
    const gone = packs.find((p) => p.trailSlug === trailSlug);
    if (!gone) return;
    const keep = new Set<string>();
    for (const p of packs) if (p.trailSlug !== trailSlug) for (const k of p.keys) keep.add(k);
    const cache = await caches.open(MAP_CACHE);
    await Promise.all(gone.keys.filter((k) => !keep.has(k)).map((k) => cache.delete(k)));
    const db = await openDb();
    const tx = db.transaction(MAP_PACK_STORE, 'readwrite');
    await promisify(tx.objectStore(MAP_PACK_STORE).delete(trailSlug) as IDBRequest);
  } catch (e) {
    console.error('Map pack delete failed:', e);
  }
}

export function daysLeft(pack: MapPack, now = Date.now()): number {
  return Math.ceil((pack.expiresAt - now) / (24 * 60 * 60 * 1000));
}

export function isPackExpired(pack: MapPack, now = Date.now()): boolean {
  return pack.expiresAt <= now;
}

// ── Estimating before downloading ────────────────────────────────────────────

interface SourcePlan {
  id: string;
  type: string;
  tileset: string;
  // The URL the map will ask for — what the cache key is made from.
  template: string;
  // The URL the download fetches. The same, except for terrain: see
  // demFetchTemplate.
  fetchTemplate: string;
  minzoom: number;
  maxzoom: number;
  tiles: TileXYZ[];
}

function tilesetOf(url: string | undefined): string | null {
  if (!url || !url.startsWith('mapbox://')) return null;
  return url.slice('mapbox://'.length);
}

function fallbackTemplate(type: string, tileset: string): string {
  const ratio = typeof window !== 'undefined' && window.devicePixelRatio > 1 ? '@2x' : '';
  if (type === 'vector') return `https://api.mapbox.com/v4/${tileset}/{z}/{x}/{y}.vector.pbf`;
  if (type === 'raster-dem') return `https://api.mapbox.com/raster/v1/${tileset}/{z}/{x}/{y}.webp`;
  return `https://api.mapbox.com/v4/${tileset}/{z}/{x}/{y}${ratio}.webp`;
}

// The map fetches terrain (mapbox-terrain-dem-v1) from `/raster/v1/`, an
// endpoint that answers only requests carrying the SDK's session token — a
// direct request gets a 401 — and Mapbox documents that tileset as available
// to the SDKs only. What `/v4/` returns for it is not the same data: tested
// against the SDK's own tiles, one pixel in ten jumps by more than thirty
// metres, and the terrain renders as a field of spikes.
//
// Its predecessor, Terrain-RGB, is a public Raster Tiles API tileset with the
// same encoding (height = -10000 + rgb * 0.1) and smooth data, so the pack
// stores Terrain-RGB tiles under the keys the map will ask the DEM source
// for. Heights differ slightly from the online map; the shape of the land
// does not. `.pngraw` is the lossless form — a lossy elevation tile is spikes
// again — and `@2x` the 512px size the source declares. The size is not a
// choice: the SDK stitches the borders of neighbouring terrain tiles and
// throws on a dimension mismatch, and the tiles it fetched itself are 512.
// It adds the one-pixel border itself when a tile arrives without one.
function demFetchTemplate(): string {
  return 'https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}@2x.pngraw';
}

// Every Mapbox tile source in the current style, with the tiles of the
// corridor it would need. Sources that are not Mapbox's (the trail overlay
// from Waymarked Trails, the app's own GeoJSON) are not part of a pack.
function planSources(map: mapboxgl.Map, coords: Coordinate3D[]): { plan: CorridorPlan; sources: SourcePlan[] } {
  const plan = planCorridor(coords);
  const style = map.getStyle();
  const sources: SourcePlan[] = [];
  const specs = (style && style.sources) || {};
  for (const [id, spec] of Object.entries(specs)) {
    const s = spec as { type: string; url?: string; minzoom?: number; maxzoom?: number };
    if (s.type !== 'raster' && s.type !== 'vector' && s.type !== 'raster-dem') continue;
    const tileset = tilesetOf(s.url);
    if (!tileset) continue;
    const impl = map.getSource(id) as unknown as { minzoom?: number; maxzoom?: number } | undefined;
    let minzoom = s.minzoom ?? impl?.minzoom ?? 0;
    let maxzoom = s.maxzoom ?? impl?.maxzoom ?? (s.type === 'raster-dem' ? 14 : 22);
    if (s.type === 'raster-dem') {
      minzoom = Math.max(minzoom, DEM_MIN_ZOOM);
      maxzoom = Math.min(maxzoom, DEM_MAX_ZOOM);
    }
    const template = registry.tileTemplates.get(tileset) ?? fallbackTemplate(s.type, tileset);
    sources.push({
      id,
      type: s.type,
      tileset,
      template,
      fetchTemplate: s.type === 'raster-dem' ? demFetchTemplate() : template,
      minzoom,
      maxzoom,
      tiles: plan.tiles.filter((t) => t.z >= minzoom && t.z <= maxzoom),
    });
  }
  return { plan, sources };
}

export interface PackEstimate {
  tiles: number;
  bytes: number;
  maxZoom: number;
  trimmed: boolean;
}

export function estimateMapPack(map: mapboxgl.Map, coords: Coordinate3D[]): PackEstimate {
  const { plan, sources } = planSources(map, coords);
  let tiles = 0;
  let bytes = 0;
  for (const s of sources) {
    tiles += s.tiles.length;
    bytes += s.tiles.length * (BYTES_PER_TILE[s.type] ?? 30_000);
  }
  return { tiles, bytes, maxZoom: plan.maxZoom, trimmed: plan.trimmed };
}

// ── Downloading ──────────────────────────────────────────────────────────────

export interface MapPackProgress {
  done: number;
  total: number;
  bytes: number;
  failed: number;
}

export interface DownloadMapPackOptions {
  map: mapboxgl.Map;
  token: string;
  trail: TrailData;
  styleKey: string;
  sourceUrl?: string | null;
  onProgress?: (p: MapPackProgress) => void;
  signal?: AbortSignal;
}

export class MapPackError extends Error {
  constructor(public code: 'unsupported' | 'no-space' | 'network' | 'aborted', message: string) {
    super(message);
  }
}

function withToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  return u.toString();
}

function fill(template: string, t: TileXYZ): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}

async function wrapForCache(res: Response): Promise<Response> {
  const body = await res.arrayBuffer();
  const headers = new Headers();
  const type = res.headers.get('content-type');
  if (type) headers.set('content-type', type);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  headers.set(BYTES_HEADER, String(body.byteLength));
  return new Response(body, { status: 200, headers });
}

function isFresh(res: Response): boolean {
  const t = Number(res.headers.get(CACHED_AT_HEADER));
  return Number.isFinite(t) && Date.now() - t < MAP_TTL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// The map has settled: every tile for the current view is in, and so is every
// template the registry can learn from it.
function whenIdle(map: mapboxgl.Map): Promise<void> {
  if (map.loaded() && !map.isMoving()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    map.once('idle', done);
    setTimeout(done, 4000);
  });
}

// One entry of the pack: a tile, a glyph range, the style… fetched by the
// device from Mapbox and stored under the path the map will ask for.
type Entry = { url: string; key: string };

export async function downloadMapPack(opts: DownloadMapPackOptions): Promise<MapPack> {
  const { map, token, trail, styleKey, sourceUrl = null, onProgress, signal } = opts;
  if (!isOfflineMapSupported()) throw new MapPackError('unsupported', 'הדפדפן הזה לא תומך בשמירת מפה למצב אופליין.');

  await whenIdle(map);
  const { plan, sources } = planSources(map, trail.coords);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  const push = (keyUrl: string, fetchUrl: string = keyUrl) => {
    const key = mapKey(keyUrl);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ url: fetchUrl, key });
  };

  // Style, icons, TileJSON, the RTL plugin: small, and nothing renders
  // without them.
  push(RTL_PLUGIN_URL);
  for (const a of registry.assets) push(a);
  if (registry.glyphTemplate) {
    for (const stack of registry.fontstacks) {
      for (const range of GLYPH_RANGES) {
        push(registry.glyphTemplate.replace('{fontstack}', stack).replace('{range}', range));
      }
    }
  }
  const smallCount = entries.length;
  for (const s of sources) for (const t of s.tiles) push(fill(s.template, t), fill(s.fetchTemplate, t));

  // Room for it? The estimate is rough, so only a clear shortfall stops the
  // download here; a real quota error further down is reported as well.
  const estimate = sources.reduce((sum, s) => sum + s.tiles.length * (BYTES_PER_TILE[s.type] ?? 30_000), 0);
  const room = await storageRoom();
  if (room !== null && room < estimate * 1.3) {
    throw new MapPackError('no-space', 'אין מספיק מקום פנוי במכשיר לשמירת המפה.');
  }
  await requestPersistentStorage();

  const cache = await caches.open(MAP_CACHE);
  const progress: MapPackProgress = { done: 0, total: entries.length, bytes: 0, failed: 0 };
  const report = () => onProgress?.({ ...progress });
  report();

  // Why entries failed, for the console: a pack that comes back short
  // should say which tiles and with what status.
  const failures: Record<string, number> = {};
  const noteFailure = (entry: Entry, reason: string) => {
    failures[reason] = (failures[reason] || 0) + 1;
    progress.failed++;
    progress.done++;
    if (progress.failed <= 5) console.warn('Map pack: could not fetch', entry.key, reason);
  };

  const fetchOne = async (entry: Entry): Promise<void> => {
    if (signal?.aborted) return;
    const hit = await cache.match(entry.key);
    if (hit && isFresh(hit)) {
      progress.bytes += Number(hit.headers.get(BYTES_HEADER)) || 0;
      progress.done++;
      return;
    }
    const url = withToken(entry.url, token);
    const attempts = 5;
    let lastReason = 'network';
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) return;
      try {
        const res = await fetch(url, { signal });
        if (res.status === 404 || res.status === 204) {
          // Nothing there — a tile over open sea, a font range with no glyphs.
          progress.done++;
          return;
        }
        if (res.status === 429 || res.status >= 500) {
          // Rate limited or a hiccup upstream: back off and try again.
          lastReason = `HTTP ${res.status}`;
          await sleep(1500 * Math.pow(2, attempt));
          continue;
        }
        if (!res.ok) {
          // A 401 or 403 will not improve with waiting.
          noteFailure(entry, `HTTP ${res.status}`);
          return;
        }
        const wrapped = await wrapForCache(res);
        const bytes = Number(wrapped.headers.get(BYTES_HEADER)) || 0;
        try {
          await cache.put(entry.key, wrapped);
        } catch {
          // The one error cache.put raises in practice is the quota.
          throw new MapPackError('no-space', 'אין מספיק מקום פנוי במכשיר לשמירת המפה.');
        }
        progress.bytes += bytes;
        progress.done++;
        return;
      } catch (e) {
        if (e instanceof MapPackError) throw e;
        if (signal?.aborted) return;
        lastReason = e instanceof Error ? e.message : 'network';
        await sleep(500 * Math.pow(2, attempt));
      }
    }
    noteFailure(entry, lastReason);
  };

  // A small pool of workers over one shared queue. When nothing at all gets
  // through, or most of it fails, the download stops rather than spending
  // minutes on tiles nobody will see.
  let next = 0;
  let stop: MapPackError | null = null;
  const worker = async () => {
    while (next < entries.length && !stop) {
      const i = next++;
      try {
        await fetchOne(entries[i]);
      } catch (e) {
        stop = e instanceof MapPackError ? e : new MapPackError('network', 'שגיאה בהורדת המפה.');
        return;
      }
      if (progress.failed >= 3 && progress.failed === progress.done) {
        stop = new MapPackError('network', 'אין חיבור ל-Mapbox. בדוק את הקליטה ונסה שוב.');
        return;
      }
      if (progress.failed >= 25 && progress.failed * 2 > progress.done) {
        stop = new MapPackError('network', 'החיבור נקטע באמצע ההורדה. נסה שוב כשיש קליטה טובה.');
        return;
      }
      report();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stop) throw stop;
  if (signal?.aborted) throw new MapPackError('aborted', 'ההורדה בוטלה.');
  if (progress.failed > 0) console.warn('Map pack: entries not fetched, by reason:', failures);

  const now = Date.now();
  const pack: MapPack = {
    trailSlug: trail.name,
    trailName: trail.name,
    kind: trail.kind,
    styleKey,
    coords: trail.coords,
    sourceUrl,
    savedAt: now,
    expiresAt: now + MAP_TTL_MS,
    tileCount: entries.length - smallCount,
    bytes: progress.bytes,
    maxZoom: plan.maxZoom,
    trimmed: plan.trimmed,
    failed: progress.failed,
    keys: entries.map((e) => e.key),
  };
  await putMapPack(pack);
  report();
  void trimMapCache();
  return pack;
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

async function storageRoom(): Promise<number | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (usage == null || quota == null) return null;
    return quota - usage;
  } catch {
    return null;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    if (usage == null || quota == null) return null;
    return { usage, quota };
  } catch {
    return null;
  }
}

let persistAsked = false;
async function requestPersistentStorage(): Promise<void> {
  if (persistAsked) return;
  persistAsked = true;
  try {
    // Chrome grants this to installed apps and heavily used sites, and it is
    // what keeps the packs out of the eviction queue. Safari has no such
    // switch — there, adding the app to the home screen is what protects it.
    await navigator.storage?.persist?.();
  } catch {
    // Not offered; nothing to do.
  }
}

// Drops entries past thirty days (the worker already refuses to serve them)
// and keeps the passive part of the cache — tiles the map loaded on its own
// — from growing without bound.
export async function trimMapCache(): Promise<void> {
  if (!isOfflineMapSupported()) return;
  try {
    const packs = await listMapPacks();
    const held = new Set<string>();
    for (const p of packs) for (const k of p.keys) held.add(k);
    const cache = await caches.open(MAP_CACHE);
    const requests = await cache.keys();
    const passive: { url: string; at: number }[] = [];
    for (const req of requests) {
      const res = await cache.match(req);
      if (!res) continue;
      const at = Number(res.headers.get(CACHED_AT_HEADER));
      if (!Number.isFinite(at) || Date.now() - at >= MAP_TTL_MS) {
        await cache.delete(req);
        continue;
      }
      if (!held.has(req.url)) passive.push({ url: req.url, at });
    }
    if (passive.length > PASSIVE_CACHE_CAP) {
      passive.sort((a, b) => a.at - b.at);
      const extra = passive.slice(0, passive.length - PASSIVE_CACHE_CAP);
      await Promise.all(extra.map((p) => cache.delete(p.url)));
    }
  } catch (e) {
    console.error('Map cache trim failed:', e);
  }
}

// The app's own files, fetched once more so the service worker holds them.
// On a first visit the worker takes control only after the page has loaded,
// and the scripts that were loaded before that were never seen by it.
export async function precacheShell(extraUrls: string[] = []): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const urls = new Set<string>(['/', '/manifest.webmanifest', '/trails.json', '/icon-192.png', '/icon-512.png']);
  for (const u of extraUrls) if (u.startsWith('/')) urls.add(u);
  for (const s of Array.from(document.scripts)) if (s.src.startsWith(location.origin)) urls.add(s.src);
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    if (l.href.startsWith(location.origin)) urls.add(l.href);
  }
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    if (e.name.startsWith(location.origin) && /\.(js|css|woff2?)(\?|$)/.test(e.name)) urls.add(e.name);
  }
  const list = Array.from(urls);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const url = list[next++];
      try {
        await fetch(url, { cache: 'no-store' });
      } catch {
        // Offline already, or a file that no longer exists — either way the
        // worker keeps whatever it has.
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

// ── Testing without pulling the plug ─────────────────────────────────────────

const SIMULATE_KEY = 'navi:simulate-offline';

export function readSimulateOffline(): boolean {
  try {
    return localStorage.getItem(SIMULATE_KEY) === '1';
  } catch {
    return false;
  }
}

// Tells both halves — the page, through localStorage, and the worker,
// through a message — to behave as if there were no network.
export async function setSimulateOffline(on: boolean): Promise<void> {
  try {
    if (on) localStorage.setItem(SIMULATE_KEY, '1');
    else localStorage.removeItem(SIMULATE_KEY);
  } catch {
    // Storage blocked; the worker side still applies.
  }
  const reg = await navigator.serviceWorker?.ready.catch(() => null);
  const target = navigator.serviceWorker?.controller ?? reg?.active;
  target?.postMessage({ type: 'navi-simulate-offline', on });
  window.dispatchEvent(new Event(on ? 'offline' : 'online'));
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true;
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
