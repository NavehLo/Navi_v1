// The water sources discovered for a trail, kept on the device.
//
// Same shape and same reasoning as poiCache.ts, and the same trailCacheKey, so
// the two caches agree on what counts as the same trail. The reason for keeping
// it at all is sharper here than it is for points of interest: Overpass failing
// makes a trail look like it has no water on it, and "no water" is a statement
// somebody might plan an August walk around. Holding the last good answer means
// an outage shows the previous list rather than an empty one.

import { trailCacheKey } from './poiCache';
import type { WaterSource } from '../app/api/water/route';

export { trailCacheKey };

const PREFIX = 'navi:water:';
const MAX_ENTRIES = 20;

interface CacheEntry {
  savedAt: number;
  sources: WaterSource[];
}

export function readCachedWater(key: string | null): WaterSource[] | null {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return Array.isArray(entry?.sources) ? entry.sources : null;
  } catch {
    return null;
  }
}

// Unlike the POI cache, an empty result is worth keeping here. A trail with no
// water in reach is a real and common answer — נחל צאלים עליון has none for
// nine kilometres — and refusing to cache it would send every visit back to
// Overpass to be told the same thing. What distinguishes it from a failure is
// that only an 'ok' status ever reaches this function; see useSummerConditions.
export function writeCachedWater(key: string | null, sources: WaterSource[]): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), sources } satisfies CacheEntry));
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
