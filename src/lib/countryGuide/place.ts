// Putting a region of "אזורי טיול" on the map.
//
// "The Dolomites" or "Cinque Terre" are no province, so a province outline
// would mislead. The model names the places that define a region instead
// (towns, peaks, lakes, spread to its edges); they are found in OpenStreetMap,
// and the region is drawn as a soft outline around them. Where the region
// really is whole provinces — an island, Valle d'Aosta — their own outlines
// are drawn.
//
// Places come from Nominatim (OSM data, which may be stored, unlike Mapbox's
// geocoding results), one request a second as its usage policy asks. This
// runs only when a guide is written, never when one is read.

import { unitOutlines } from '../regions';
import type { DraftRegion } from './sources';
import type { GuidePlace, GuideShape } from './types';

const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
// How far the outline stands off the outermost places.
const MARGIN_KM = 8;

let lastCall = 0;
const memo = new Map<string, GuidePlace | null>();

async function geocode(name: string, country: string): Promise<GuidePlace | null> {
  const key = `${country}|${name}`;
  if (memo.has(key)) return memo.get(key)!;
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  let found: GuidePlace | null = null;
  try {
    const params = new URLSearchParams({ q: name, countrycodes: country.toLowerCase(), format: 'jsonv2', limit: '1', 'accept-language': 'en' });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    const data = res.ok ? await res.json() : [];
    const hit = Array.isArray(data) ? data[0] : null;
    if (hit) found = { name, lon: round(Number(hit.lon)), lat: round(Number(hit.lat)) };
  } catch { /* not found is as good as an answer here */ }
  memo.set(key, found);
  return found;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// Distances in km on a flat map around the region — plenty at this scale.
function projector(lat0: number) {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  return {
    to: ([lon, lat]: [number, number]): [number, number] => [lon * kx, lat * ky],
    from: ([x, y]: [number, number]): [number, number] => [round(x / kx), round(y / ky)],
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// A place far from all the others is more likely a namesake elsewhere in the
// country (there is a "San Martino" in every province) than the region's edge.
function withoutStrays(points: GuidePlace[]): GuidePlace[] {
  if (points.length < 4) return points;
  const lon0 = median(points.map((p) => p.lon));
  const lat0 = median(points.map((p) => p.lat));
  const p = projector(lat0);
  const [cx, cy] = p.to([lon0, lat0]);
  const dist = points.map((q) => { const [x, y] = p.to([q.lon, q.lat]); return Math.hypot(x - cx, y - cy); });
  const limit = Math.max(60, 3 * median(dist));
  return points.filter((_, i) => dist[i] <= limit);
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// Andrew's monotone chain.
function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Array<[number, number]> = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<[number, number]> = [];
  for (const q of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// The hull of the places with a margin around it: the hull of a small circle
// around each place, which rounds the corners.
function hullShape(points: GuidePlace[]): GuideShape {
  const p = projector(median(points.map((q) => q.lat)));
  const around: Array<[number, number]> = [];
  for (const q of points) {
    const [x, y] = p.to([q.lon, q.lat]);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI;
      around.push([x + MARGIN_KM * Math.cos(a), y + MARGIN_KM * Math.sin(a)]);
    }
  }
  const ring = convexHull(around).map(p.from);
  ring.push(ring[0]);
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  return {
    kind: 'hull',
    polygons: [[ring]],
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
  };
}

export interface PlacedRegion {
  shape: GuideShape | null;
  places: GuidePlace[];
  trailStarts: Array<[number, number] | null>;
  missing: string[];  // names Nominatim did not find, for the report
  strays: string[];   // found, but too far from the rest to belong
}

export async function placeRegion(country: string, r: DraftRegion): Promise<PlacedRegion> {
  const missing: string[] = [];
  const found: GuidePlace[] = [];
  for (const name of r.anchors) {
    const g = await geocode(name, country);
    if (g) found.push(g); else missing.push(name);
  }
  const places = withoutStrays(found);
  const strays = found.filter((f) => !places.includes(f)).map((f) => f.name);

  const trailStarts: Array<[number, number] | null> = [];
  for (const t of r.trails) {
    const g = t.start ? await geocode(t.start, country) : null;
    trailStarts.push(g ? [g.lon, g.lat] : null);
  }

  let shape: GuideShape | null = null;
  const units = r.provinces.length ? unitOutlines(country, r.provinces) : null;
  if (units) {
    shape = {
      kind: 'units',
      polygons: units.rings.map((ring) => [ring.map(([lon, lat]) => [round(lon), round(lat)])]),
      bbox: units.bbox.map(round) as [number, number, number, number],
    };
  } else if (places.length >= 2) {
    shape = hullShape(places);
  }
  return { shape, places, trailStarts, missing, strays };
}
