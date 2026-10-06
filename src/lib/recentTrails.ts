import type { TrailData, TrailSource } from '../hooks/useTrailData';
import type { WmtRouteSummary } from './waymarked';
import type { Coordinate3D } from '../utils/trailUtils';

// The last few trails looked at — opened on the map, or a world trail tapped
// and its card shown — for the history button on the home screen. Kept on the
// device only; nothing here is sent anywhere.
//
// A trail opened on the map keeps its points, so it reopens without the
// network. A long one is thinned to fit: storage is about 5 MB for the whole
// site, shared with the open trail (openTrailMemory) and the personal area's
// copy. A thinned trail that has a source to fetch again from is fetched again
// when there is reception (page.tsx).

const KEY = 'navi:recentTrails.v1';
export const RECENT_MAX = 5;
const MAX_POINTS = 3000;

interface Base {
  // One entry per trail: the same trail looked at again moves to the top.
  key: string;
  name: string;
  at: number;
}

export type RecentTrail =
  // A world trail whose card was shown, not opened: reopening shows the card.
  | (Base & { type: 'world'; id: number; summary: WmtRouteSummary | null })
  | (Base & {
      type: 'trail';
      kind: TrailData['kind'];
      // A file's text is dropped — it is the same points again.
      source: TrailSource;
      coords: Coordinate3D[];
      thinned: boolean;
    });

function keyOf(source: TrailSource, name: string): string | null {
  switch (source.kind) {
    case 'url': return `url:${source.url}`;
    case 'wmt': return `wmt:${source.id}`;
    case 'pack': return `pack:${source.slug}`;
    case 'file': return `file:${name}`;
    // A drive is not a trail looked at; it has its own planner.
    case 'drive': return null;
  }
}

// Read once from storage, then kept here; the button subscribes to changes
// (useSyncExternalStore), so it needs no state of the page's.
let cache: RecentTrail[] | null = null;
const EMPTY: RecentTrail[] = [];
const listeners = new Set<() => void>();

export function listRecentTrails(): RecentTrail[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(list) ? list.slice(0, RECENT_MAX) : [];
  } catch {
    cache = [];
  }
  return cache!;
}

export function recentTrailsOnServer(): RecentTrail[] {
  return EMPTY;
}

export function subscribeRecentTrails(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function push(entry: RecentTrail): void {
  const list = [entry, ...listRecentTrails().filter((e) => e.key !== entry.key)].slice(0, RECENT_MAX);
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: keep the newest alone rather than nothing.
    try { localStorage.setItem(KEY, JSON.stringify([entry])); } catch {}
  }
  listeners.forEach((l) => l());
}

export function rememberRecentTrail(trail: TrailData, source: TrailSource): void {
  if (trail.kind === 'drive') return;
  const key = keyOf(source, trail.name);
  if (!key || trail.coords.length < 2) return;
  const step = Math.ceil(trail.coords.length / MAX_POINTS);
  const kept = step > 1
    ? trail.coords.filter((_, i) => i % step === 0 || i === trail.coords.length - 1)
    : trail.coords;
  push({
    type: 'trail',
    key,
    name: trail.name,
    at: Date.now(),
    kind: trail.kind,
    source: source.kind === 'file' ? { kind: 'file', content: '' } : source,
    // Five decimals is about a metre.
    coords: kept.map(([lat, lon, ele]) => [
      Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, Math.round(ele || 0),
    ]),
    thinned: step > 1,
  });
}

export function rememberRecentWorldTrail(id: number, name: string, summary: WmtRouteSummary | null): void {
  push({ type: 'world', key: `wmt:${id}`, name, at: Date.now(), id, summary });
}

// "לפני 5 דקות", for the list.
export function agoText(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return min === 1 ? 'לפני דקה' : `לפני ${min} דקות`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
  const d = Math.round(h / 24);
  return d === 1 ? 'אתמול' : d === 2 ? 'לפני יומיים' : `לפני ${d} ימים`;
}
