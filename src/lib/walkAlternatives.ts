import type { Coordinate3D } from '../utils/trailUtils';
import { getDistance } from '../utils/trailUtils';
import { walkRequest, DirectionsError, type WalkRoute } from './mapboxDirections';

// Up to three genuinely different walking routes between two points.
//
// Asking Mapbox for `alternatives` is not enough on its own: it only offers a
// second route when it is close to the best one in length and shares little
// of it, and on a walk of a few kilometres that is rarely true — so it would
// answer with one route where the map plainly shows two or three ways round.
//
// So it is also asked for the walk *through* a point on each side of the
// straight line, a quarter and a half of the distance out. Each of those is
// a real walkable route, but a forced one can do silly things: walk up a dead
// end to touch the point and come back, or add a loop. Those detours are cut
// out, what is left is compared with the routes already found, and anything
// that is mostly the same walk, or far longer than the best, is dropped.

const MAX_ROUTES = 3;
const MAX_LENGTH_RATIO = 1.8;       // longer than this × the shortest is not an option, it is a detour
const SAME_ROUTE_OVERLAP = 0.75;    // this much of one lying on another = the same walk
const NEAR_M = 20;

export interface WalkResult {
  routes: WalkRoute[];
  start: [number, number] | null; // [lon, lat], snapped onto a walkable way
  end: [number, number] | null;
}

function lengthKm(c: Coordinate3D[]): number {
  let d = 0;
  for (let i = 1; i < c.length; i++) d += getDistance(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  return d;
}

// Cuts out every stretch that comes back to where it already was: a dead-end
// out-and-back, or a loop. What remains goes from start to end without
// revisiting anything.
function removeLoops(c: Coordinate3D[]): Coordinate3D[] {
  if (c.length < 4) return c;
  const kx = 111.32 * Math.cos(c[0][0] * Math.PI / 180), ky = 110.574;
  const near = (a: Coordinate3D, b: Coordinate3D) => {
    const dx = (a[1] - b[1]) * kx, dy = (a[0] - b[0]) * ky;
    return dx * dx + dy * dy < 0.012 * 0.012; // 12 m
  };
  const acc = [0];
  for (let i = 1; i < c.length; i++) acc.push(acc[i - 1] + getDistance(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
  const out: Coordinate3D[] = [];
  let i = 0;
  while (i < c.length) {
    out.push(c[i]);
    let jump = -1;
    for (let j = c.length - 1; j > i + 1; j--) {
      if (acc[j] - acc[i] > 0.04 && near(c[i], c[j])) { jump = j; break; }
    }
    i = jump > 0 ? jump + 1 : i + 1;
  }
  return out;
}

// How much of `a` (0..1, by length) lies within NEAR_M of `b`. The points of
// `b` go into a grid of NEAR_M cells, so each point of `a` looks at nine cells
// rather than at every point of `b` — routes run to a thousand points, and
// every pair of candidates is compared both ways.
function overlap(a: Coordinate3D[], b: Coordinate3D[]): number {
  const lat0 = a[0]?.[0] ?? 0;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574; // metres per degree
  const cell = (x: number) => Math.floor(x / NEAR_M);
  const grid = new Map<string, [number, number][]>();
  for (const p of b) {
    const x = p[1] * kx, y = p[0] * ky;
    const k = `${cell(x)},${cell(y)}`;
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push([x, y]);
  }
  const isNear = (p: Coordinate3D) => {
    const x = p[1] * kx, y = p[0] * ky, cx = cell(x), cy = cell(y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [qx, qy] of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if ((qx - x) ** 2 + (qy - y) ** 2 < NEAR_M * NEAR_M) return true;
      }
    }
    return false;
  };
  let on = 0, total = 0;
  for (let i = 1; i < a.length; i++) {
    const seg = getDistance(a[i - 1][0], a[i - 1][1], a[i][0], a[i][1]);
    total += seg;
    if (isNear(a[i])) on += seg;
  }
  return total > 0 ? on / total : 1;
}

function sameWalk(a: Coordinate3D[], b: Coordinate3D[]): boolean {
  return overlap(a, b) > SAME_ROUTE_OVERLAP && overlap(b, a) > SAME_ROUTE_OVERLAP;
}

// Points beside the straight line from `from` to `to`, [lon, lat].
function sidePoints(from: [number, number], to: [number, number]): [number, number][] {
  const lat0 = (from[1] + to[1]) / 2;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
  const dx = (to[0] - from[0]) * kx, dy = (to[1] - from[1]) * ky;
  const L = Math.hypot(dx, dy);
  if (L < 0.2) return []; // a few hundred metres: there is no "other way round" worth asking for
  const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
  const nx = -dy / L, ny = dx / L; // unit normal, in km
  return [0.25, -0.25, 0.5, -0.5].map((f) => [mx + (nx * f * L) / kx, my + (ny * f * L) / ky]);
}

export async function findWalkRoutes(from: [number, number], to: [number, number]): Promise<WalkResult> {
  // The direct request decides whether there is a route at all; its failure
  // is the answer. The detour requests are extras and may fail quietly.
  const [direct, ...forced] = await Promise.all([
    walkRequest([from, to], true),
    ...sidePoints(from, to).map((v) => walkRequest([from, v, to], false).catch(() => null)),
  ]);

  const candidates: WalkRoute[] = [...direct.routes];
  for (const r of forced) {
    const route = r?.routes[0];
    if (!route) continue;
    const coords = removeLoops(route.coords);
    const km = lengthKm(coords);
    const origKm = lengthKm(route.coords) || 1;
    candidates.push({ coords, distanceKm: route.distanceKm * (km / origKm), durationSec: route.durationSec * (km / origKm) });
  }
  if (!candidates.length) throw new DirectionsError('no-route');

  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const shortest = candidates[0].distanceKm;
  const kept: WalkRoute[] = [];
  for (const c of candidates) {
    if (kept.length >= MAX_ROUTES) break;
    if (c.distanceKm > shortest * MAX_LENGTH_RATIO) break;
    if (kept.some((k) => sameWalk(k.coords, c.coords))) continue;
    kept.push(c);
  }
  return { routes: kept, start: direct.start, end: direct.end };
}
