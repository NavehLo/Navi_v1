// A trail's twelve months, kept on the device.
//
// Same shape and the same trailCacheKey as weatherCache.ts, but nothing here
// goes stale: the long-term climate of a place does not change between visits.
// Only a change to the rules does, and CLIMATE_VERSION is in the prefix for
// that. A verdict is well under a kilobyte, so many are kept.

import { trailCacheKey } from './poiCache';
import { CLIMATE_VERSION, type MonthVerdict } from './climate';

export { trailCacheKey };

const PREFIX = `navi:climate:v${CLIMATE_VERSION}:`;
const MAX_ENTRIES = 60;

interface CacheEntry {
  savedAt: number;
  months: MonthVerdict[];
}

export function readCachedClimate(key: string | null): MonthVerdict[] | null {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return entry?.months?.length === 12 ? entry.months : null;
  } catch {
    return null;
  }
}

export function writeCachedClimate(key: string | null, months: MonthVerdict[]): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), months } satisfies CacheEntry));
    prune();
  } catch {
    // Storage full or blocked — the months are simply asked for again next time.
  }
}

function prune(): void {
  try {
    const entries: Array<{ storageKey: string; savedAt: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith('navi:climate:')) continue;
      // An older version's entries go first, whatever their age.
      if (!storageKey.startsWith(PREFIX)) {
        entries.push({ storageKey, savedAt: -1 });
        continue;
      }
      let savedAt = 0;
      try {
        savedAt = (JSON.parse(localStorage.getItem(storageKey) || '{}') as CacheEntry).savedAt ?? 0;
      } catch {
        // Unreadable entry — oldest by definition, so it goes first.
      }
      entries.push({ storageKey, savedAt });
    }
    const stale = entries.filter((e) => e.savedAt < 0);
    for (const e of stale) localStorage.removeItem(e.storageKey);
    const live = entries.filter((e) => e.savedAt >= 0);
    if (live.length <= MAX_ENTRIES) return;
    live.sort((a, b) => a.savedAt - b.savedAt);
    for (const e of live.slice(0, live.length - MAX_ENTRIES)) localStorage.removeItem(e.storageKey);
  } catch {
    // Pruning is housekeeping; failing at it is not worth reporting.
  }
}
