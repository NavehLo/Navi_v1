// The points of interest discovered for a trail, kept on the device.
//
// Discovery goes out to OpenStreetMap through Overpass, which is a free public
// service that throttles, times out and occasionally refuses outright. Every
// one of those failures used to land in the same place: an empty result, which
// is indistinguishable from "this trail genuinely has no points", so the app
// quietly fell back to the three synthetic start/midway/end points. A trail
// that had shown eight named places showed three generic ones instead, with
// nothing on screen to say why, and the narrations already downloaded for the
// other five no longer matched anything on the list.
//
// Caching the last successful discovery makes that failure invisible in the
// other direction: the list stays, and it also means opening the same trail
// twice does not ask Overpass twice.

export interface DiscoveredPOI {
  lat: number;
  lon: number;
  type: string;
  name: string | null;
  osmType: string | null;
  osmId: number | null;
  tags: Record<string, string>;
}

const PREFIX = 'navi:pois:';
const MAX_ENTRIES = 20;

interface CacheEntry {
  savedAt: number;
  pois: DiscoveredPOI[];
}

// Identifies a trail well enough to reuse its points: same name, same number of
// track points, same two ends. A different GPX matching all three is not a
// case worth designing around — and the worst outcome is a stale list that the
// next successful discovery replaces.
export function trailCacheKey(name: string, coords: Array<[number, number] | number[]>): string | null {
  if (!name || coords.length < 2) return null;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return `${name}|${coords.length}|${first[0].toFixed(4)},${first[1].toFixed(4)}|${last[0].toFixed(4)},${last[1].toFixed(4)}`;
}

export function readCachedPois(key: string | null): DiscoveredPOI[] | null {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return Array.isArray(entry?.pois) && entry.pois.length > 0 ? entry.pois : null;
  } catch {
    return null;
  }
}

// Only a non-empty discovery is worth keeping: an empty one is exactly what a
// failure looks like, and storing it would cache the problem.
export function writeCachedPois(key: string | null, pois: DiscoveredPOI[]): void {
  if (typeof window === 'undefined' || !key || pois.length === 0) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), pois } satisfies CacheEntry));
    prune();
  } catch {
    // Storage full or blocked — discovery simply runs again next time.
  }
}

function prune(): void {
  try {
    const entries: Array<{ storageKey: string; savedAt: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(PREFIX)) continue;
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(localStorage.getItem(storageKey) || '{}') as CacheEntry).savedAt ?? 0;
      } catch {
        // Unreadable entry — oldest by definition, so it goes first.
      }
      entries.push({ storageKey, savedAt });
    }
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a.savedAt - b.savedAt);
    for (const e of entries.slice(0, entries.length - MAX_ENTRIES)) localStorage.removeItem(e.storageKey);
  } catch {
    // Pruning is housekeeping; failing at it is not worth reporting.
  }
}
