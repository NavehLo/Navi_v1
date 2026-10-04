// Tying Komoot's routes to our trails by where they go.
//
// A Komoot route belongs to one of our trails when most of it runs along
// that trail. Names cannot do this: Komoot's are its own ("Samaria Gorge –
// Samaria Gorge Entrance loop from ΞΥΛΟΣΚΑΛΟ"), ours are the mappers', often
// in Greek. Where a route runs along several trails at once — a gorge that is
// also a stretch of the E4 — it goes to the shortest of them, the trail it
// actually is. A trail far longer than the route is never credited, even
// when it is the only one there: a famous day walk on the E4 does not make
// the whole E4 "very busy" (the long-distance paths get their standing from
// Wikipedia instead). A multi-day trail a few times the route's length — a
// day's stage of the Menalon Trail — is.

import { fetchWmt } from '../wmtServer';
import { lonLatToMercator, mercatorToLonLat } from '../waymarked';
import type { CountryTrail } from '../countryTrails';
import type { KomootRoute } from './komoot';
import type { CrowdSource } from './score';

// A route point this close to the trail counts as on it. Komoot's lines are
// drawn to 1e-4° (about 10 m); mapped trails and recorded routes differ by
// tens of metres.
const NEAR_M = 150;
// Share of the route's points that must be on the trail.
const MIN_SHARE = 0.6;
// A trail is credited only up to this many times the route's length.
const LONGER_FACTOR = 5;

type LonLat = [number, number];
interface TrailLines {
  id: number;
  km: number;
  lines: LonLat[][];
  bbox: [number, number, number, number]; // w s e n
}

// Every trail's line, from Waymarked Trails, a few dozen trails a request.
// The geometry comes back unsimplified whatever the box (checked 2026-10).
export async function trailLines(trails: CountryTrail[]): Promise<TrailLines[]> {
  if (trails.length === 0) return [];
  const lats = trails.map((t) => t.lat);
  const lons = trails.map((t) => t.lon);
  // Trails reach well past their middle point; and past the border.
  const [x0, y0] = lonLatToMercator(Math.min(...lons) - 3, Math.max(-85, Math.min(...lats) - 3));
  const [x1, y1] = lonLatToMercator(Math.max(...lons) + 3, Math.min(85, Math.max(...lats) + 3));
  const bbox = [x0, y0, x1, y1].map((n) => n.toFixed(0)).join(',');
  const km = new Map(trails.map((t) => [t.id, t.km]));

  const chunks: number[][] = [];
  for (let i = 0; i < trails.length; i += 40) chunks.push(trails.slice(i, i + 40).map((t) => t.id));
  const out: TrailLines[] = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const answers = await Promise.all(chunks.slice(i, i + 3).map((ids) =>
      fetchWmt(`/list/segments?bbox=${bbox}&relations=${ids.join(',')}`, 45_000, false) as Promise<
        { features?: Array<{ id?: number; geometry?: { type: string; coordinates: unknown } }> } | null
      >
    ));
    for (const a of answers) {
      for (const f of a?.features ?? []) {
        const id = Number(f.id);
        if (!km.has(id) || !f.geometry) continue;
        const raw = f.geometry.type === 'LineString'
          ? [f.geometry.coordinates as number[][]]
          : f.geometry.type === 'MultiLineString' ? (f.geometry.coordinates as number[][][]) : [];
        const lines = raw.map((l) => l.map((p) => mercatorToLonLat(p[0], p[1]))).filter((l) => l.length > 1);
        if (!lines.length) continue;
        const all = lines.flat();
        out.push({
          id,
          km: km.get(id)!,
          lines,
          bbox: [
            Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])),
            Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])),
          ],
        });
      }
    }
  }
  return out;
}

// Metres from a point to a line, on a plane local to the point.
function distanceTo(lat: number, lon: number, lines: LonLat[][]): number {
  const ky = 111_320;
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - lon) * kx, ay = (line[i - 1][1] - lat) * ky;
      const bx = (line[i][0] - lon) * kx, by = (line[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function routeKm(r: KomootRoute): number {
  if (r.km) return r.km;
  let m = 0;
  for (let i = 1; i < r.points.length; i++) {
    const [a, b] = [r.points[i - 1], r.points[i]];
    m += Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));
  }
  return m / 1000;
}

// The trails each route runs along.
function trailsOf(r: KomootRoute, trails: TrailLines[]): number[] {
  const pad = 0.003;
  const lats = r.points.map((p) => p[0]);
  const lons = r.points.map((p) => p[1]);
  const [w, s, e, n] = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  const on: TrailLines[] = [];
  for (const t of trails) {
    if (t.bbox[0] > e || t.bbox[2] < w || t.bbox[1] > n || t.bbox[3] < s) continue;
    // Given up on as soon as too many points are off it: a long-distance
    // path's line has thousands of segments.
    const allowedOff = r.points.length * (1 - MIN_SHARE);
    let off = 0;
    for (const [lat, lon] of r.points) {
      if (distanceTo(lat, lon, t.lines) > NEAR_M && ++off > allowedOff) break;
    }
    if (off <= allowedOff) on.push(t);
  }
  const length = routeKm(r);
  const fits = on.filter((t) => t.km <= length * LONGER_FACTOR).sort((a, b) => a.km - b.km);
  if (!fits.length) return [];
  // The shortest, and any other of comparable length (two mapped trails along
  // the same path).
  return fits.filter((t) => t.km <= fits[0].km * 1.5).map((t) => t.id);
}

// For each trail some route ran along: Komoot's numbers, from the most walked
// of its routes (the same route listed on two pages counts once).
export function matchRoutes(routes: KomootRoute[], trails: TrailLines[]): Map<number, CrowdSource> {
  const out = new Map<number, CrowdSource>();
  const seen = new Set<string>();
  for (const r of routes) {
    const key = r.points.map((p) => p.join(',')).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    for (const id of trailsOf(r, trails)) {
      const prev = out.get(id);
      if (prev && (prev.hikers ?? 0) >= r.hikers) continue;
      out.set(id, { site: 'Komoot', url: r.guide, rating: r.rating, count: r.ratings, hikers: r.hikers, route: r.name });
    }
  }
  return out;
}
