import type { Coordinate3D } from '../utils/trailUtils';
import { getDistance } from '../utils/trailUtils';
import { routeRequest, walkRequest, DirectionsError, type RouteOption } from './mapboxDirections';

// Up to three genuinely different routes between two points — on foot for the
// measure tool, by car for the drive planner.
//
// Asking Mapbox for `alternatives` is not enough on its own: it only offers a
// second route when it is close to the best one and shares little of it, and
// that is often not true — so it would answer with one route where the map
// plainly shows two or three ways round.
//
// So it is also asked for the route *through* a point on each side of the
// straight line. Each of those is a real route, but a forced one can do silly
// things: go up a dead end to touch the point and come back, or add a loop.
// Those detours are cut out, what is left is compared with the routes already
// found, and anything that is mostly the same route, or far longer than the
// best, is dropped.

const MAX_ROUTES = 3;

interface Tuning {
  // What "best" means: the shortest walk, the quickest drive.
  metric: 'distanceKm' | 'durationSec';
  maxRatio: number;        // more than this × the best is not an option, it is a detour
  sideFractions: number[]; // how far out the forced points sit, as a share of the straight line
  minSpanKm: number;       // shorter than this, there is no "other way round" worth asking for
  loopNearKm: number;      // a route coming back this close to itself has looped
  loopMinKm: number;       // …after at least this much road in between
  nearM: number;           // this close to another route = on it
}

const WALK: Tuning = {
  metric: 'distanceKm', maxRatio: 1.8, sideFractions: [0.25, -0.25, 0.5, -0.5],
  minSpanKm: 0.2, loopNearKm: 0.012, loopMinKm: 0.04, nearM: 20,
};
// A divided road's two carriageways are tens of metres apart, so "the same
// road" and "came back on itself" are looser for a car. The forced points sit
// closer to the line: a quarter of a 150 km drive out is a different region.
const DRIVE: Tuning = {
  metric: 'durationSec', maxRatio: 1.5, sideFractions: [0.15, -0.15, 0.3, -0.3],
  minSpanKm: 3, loopNearKm: 0.06, loopMinKm: 0.5, nearM: 60,
};

const SAME_ROUTE_OVERLAP = 0.75; // this much of one lying on another = the same route

export interface RouteResult {
  routes: RouteOption[];
  start: [number, number] | null; // [lon, lat], snapped onto the network
  end: [number, number] | null;
}
export type WalkResult = RouteResult;

function lengthKm(c: Coordinate3D[]): number {
  let d = 0;
  for (let i = 1; i < c.length; i++) d += getDistance(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  return d;
}

// Cuts out every stretch that comes back to where it already was: a dead-end
// out-and-back, or a loop. What remains goes from start to end without
// revisiting anything.
function removeLoops(c: Coordinate3D[], t: Tuning): Coordinate3D[] {
  if (c.length < 4) return c;
  const kx = 111.32 * Math.cos(c[0][0] * Math.PI / 180), ky = 110.574;
  const near = (a: Coordinate3D, b: Coordinate3D) => {
    const dx = (a[1] - b[1]) * kx, dy = (a[0] - b[0]) * ky;
    return dx * dx + dy * dy < t.loopNearKm * t.loopNearKm;
  };
  const acc = [0];
  for (let i = 1; i < c.length; i++) acc.push(acc[i - 1] + getDistance(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
  const out: Coordinate3D[] = [];
  let i = 0;
  while (i < c.length) {
    out.push(c[i]);
    let jump = -1;
    for (let j = c.length - 1; j > i + 1; j--) {
      if (acc[j] - acc[i] > t.loopMinKm && near(c[i], c[j])) { jump = j; break; }
    }
    i = jump > 0 ? jump + 1 : i + 1;
  }
  return out;
}

// How much of `a` (0..1, by length) lies within `nearM` of `b`. The points of
// `b` go into a grid of `nearM` cells, so each point of `a` looks at nine cells
// rather than at every point of `b` — routes run to thousands of points, and
// every pair of candidates is compared both ways.
function overlap(a: Coordinate3D[], b: Coordinate3D[], nearM: number): number {
  const lat0 = a[0]?.[0] ?? 0;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574; // metres per degree
  const cell = (x: number) => Math.floor(x / nearM);
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
        if ((qx - x) ** 2 + (qy - y) ** 2 < nearM * nearM) return true;
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

function sameRoute(a: Coordinate3D[], b: Coordinate3D[], nearM: number): boolean {
  return overlap(a, b, nearM) > SAME_ROUTE_OVERLAP && overlap(b, a, nearM) > SAME_ROUTE_OVERLAP;
}

// Points beside the straight line from `from` to `to`, [lon, lat].
function sidePoints(from: [number, number], to: [number, number], t: Tuning): [number, number][] {
  const lat0 = (from[1] + to[1]) / 2;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.574;
  const dx = (to[0] - from[0]) * kx, dy = (to[1] - from[1]) * ky;
  const L = Math.hypot(dx, dy);
  if (L < t.minSpanKm) return [];
  const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
  const nx = -dy / L, ny = dx / L; // unit normal, in km
  return t.sideFractions.map((f) => [mx + (nx * f * L) / kx, my + (ny * f * L) / ky]);
}

// The direct answer's routes, plus the forced ones with their detours cut
// out, filtered down to the few worth offering — best first.
function pick(direct: RouteOption[], forced: (RouteOption | undefined)[], t: Tuning): RouteOption[] {
  const candidates: RouteOption[] = [...direct];
  for (const route of forced) {
    if (!route) continue;
    const coords = removeLoops(route.coords, t);
    const scale = lengthKm(coords) / (lengthKm(route.coords) || 1);
    candidates.push({ coords, distanceKm: route.distanceKm * scale, durationSec: route.durationSec * scale });
  }
  if (!candidates.length) throw new DirectionsError('no-route');

  candidates.sort((a, b) => a[t.metric] - b[t.metric]);
  const best = candidates[0][t.metric];
  const kept: RouteOption[] = [];
  for (const c of candidates) {
    if (kept.length >= MAX_ROUTES) break;
    if (c[t.metric] > best * t.maxRatio) break;
    if (kept.some((k) => sameRoute(k.coords, c.coords, t.nearM))) continue;
    kept.push(c);
  }
  return kept;
}

export async function findWalkRoutes(from: [number, number], to: [number, number]): Promise<WalkResult> {
  // The direct request decides whether there is a route at all; its failure
  // is the answer. The detour requests are extras and may fail quietly.
  const [direct, ...forced] = await Promise.all([
    walkRequest([from, to], true),
    ...sidePoints(from, to, WALK).map((v) => walkRequest([from, v, to], false).catch(() => null)),
  ]);
  return { routes: pick(direct.routes, forced.map((r) => r?.routes[0]), WALK), start: direct.start, end: direct.end };
}

// Drives from the first point to the last, through every point in between in
// order — the stops the driver asked for. Quickest first.
//
// With stops, the forced side points are left out: cutting "loops" out of a
// forced route would also cut the out-and-back to a stop the driver chose at
// the end of a side road. Mapbox's own alternatives still come back.
export async function findDriveRoutes(points: [number, number][]): Promise<RouteResult> {
  const from = points[0], to = points[points.length - 1];
  const sides = points.length === 2 ? sidePoints(from, to, DRIVE) : [];
  const [direct, ...forced] = await Promise.all([
    routeRequest('driving', points, true),
    ...sides.map((v) => routeRequest('driving', [from, v, to], false, [1]).catch(() => null)),
  ]);
  return { routes: pick(direct.routes, forced.map((r) => r?.routes[0]), DRIVE), start: direct.start, end: direct.end };
}
