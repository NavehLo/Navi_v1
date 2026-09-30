// The last forecast fetched for a trail, kept on the device.
//
// Same shape and the same trailCacheKey as waterCache.ts. Here the point is the
// field: the forecast is looked at the evening before, and read again at the
// trailhead with no signal. A bundle is a few tens of kilobytes, so fewer are
// kept than for water.

import { trailCacheKey } from './poiCache';
import type { WeatherBundle } from './weather';

export { trailCacheKey };

const PREFIX = 'navi:weather:';
const MAX_ENTRIES = 10;
const DATE_KEY = 'navi:tripDate';

// Younger than this, a cached forecast is not asked for again — Open-Meteo's
// models update every few hours, and the server caches for one anyway.
export const WEATHER_FRESH_MS = 60 * 60 * 1000;

interface CacheEntry {
  savedAt: number;
  bundle: WeatherBundle;
}

export function readCachedWeather(key: string | null): WeatherBundle | null {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    return entry?.bundle?.points?.length ? entry.bundle : null;
  } catch {
    return null;
  }
}

export function writeCachedWeather(key: string | null, bundle: WeatherBundle): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), bundle } satisfies CacheEntry));
    prune();
  } catch {
    // Storage full or blocked — the forecast is simply fetched again next time.
  }
}

// The day chosen for the trip, across trails: somebody planning for Saturday
// who opens three trails to compare wants to see Saturday on all three.
export function readTripDate(): string | null {
  try {
    return localStorage.getItem(DATE_KEY);
  } catch {
    return null;
  }
}

export function writeTripDate(date: string): void {
  try {
    localStorage.setItem(DATE_KEY, date);
  } catch {
    // Not remembered — the panel falls back to today.
  }
}

// The hour chosen to set off at, across trails and days; null for the
// default. Somebody who can only leave at eleven can only leave at eleven
// whichever trail they look at.
const START_KEY = 'navi:tripStart';

export function readTripStart(): number | null {
  try {
    const raw = localStorage.getItem(START_KEY);
    const h = raw == null ? NaN : Number(raw);
    return Number.isFinite(h) && h >= 0 && h < 24 ? h : null;
  } catch {
    return null;
  }
}

export function writeTripStart(hour: number | null): void {
  try {
    if (hour == null) localStorage.removeItem(START_KEY);
    else localStorage.setItem(START_KEY, String(hour));
  } catch {
    // Not remembered — the default start is used next time.
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
