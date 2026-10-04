// Finding the trails under Komoot's most walked routes that a country's list
// does not have.
//
// A large country's list is built from big squares, and asked for a 50 km
// square Waymarked Trails answers its 100 national and regional routes and
// no local path — while the day walks people actually do run on local paths
// (Spain's PR trails; Montserrat's "Del Monestir a Sant Jeroni"). So for each
// Komoot route that matched none of the list's trails, the trails right
// under it are asked for — two tiny squares, a third and two thirds along
// it, where only a handful of routes cross — and those it runs along (by the
// same rules as match.ts) are added to the list (countryTrails.addTrails).
//
// On Spain's routes (2026-10): one in six led to such a trail, among them the
// Caminito del Rey (13,587 hikers on Komoot), Cala Bóquer and Caldera Blanca.
// Free: Waymarked Trails only, about three requests a route.

import { fetchWmt } from '../wmtServer';
import { lonLatToMercator, type WmtRouteSummary } from '../waymarked';
import type { KomootRoute } from './komoot';
import { trailLinesOf, trailsOf, type TrailLines } from './match';

// Half the side of the squares asked about, in degrees (about a kilometre).
const PROBE = 0.01;
// The outline asked for reaches this far around the route, so a local path's
// length is measured whole (the rule against crediting a far longer trail
// needs it).
const OUTLINE_PAD = 0.3;
const PARALLEL = 4;

function box(w: number, s: number, e: number, n: number): string {
  const [x0, y0] = lonLatToMercator(w, Math.max(-85, s));
  const [x1, y1] = lonLatToMercator(e, Math.min(85, n));
  return [x0, y0, x1, y1].map((v) => v.toFixed(0)).join(',');
}

type Feature = { id?: number; geometry?: { type: string; coordinates: unknown } };

// The trails under one route that are not in `known`, with their outlines.
async function under(route: KomootRoute, known: Set<number>, probes: Map<string, WmtRouteSummary[]>): Promise<TrailLines[]> {
  const pts = route.points;
  const ids = new Set<number>();
  for (const [lat, lon] of [pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]]) {
    // Neighbouring routes share their squares.
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    let found = probes.get(key);
    if (!found) {
      const r = (await fetchWmt(`/list/by_area?bbox=${box(lon - PROBE, lat - PROBE, lon + PROBE, lat + PROBE)}&limit=100`, 15_000, false)) as
        | { results?: WmtRouteSummary[] }
        | null;
      found = r?.results ?? [];
      probes.set(key, found);
    }
    // An international path never belongs to a country's list (countryTrails).
    for (const s of found) if (s.group !== 'INT' && !known.has(s.id)) ids.add(s.id);
  }
  if (!ids.size) return [];
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const outlines = (await fetchWmt(
    `/list/segments?bbox=${box(Math.min(...lons) - OUTLINE_PAD, Math.min(...lats) - OUTLINE_PAD, Math.max(...lons) + OUTLINE_PAD, Math.max(...lats) + OUTLINE_PAD)}&relations=${[...ids].join(',')}`,
    20_000,
    false,
  )) as { features?: Feature[] } | null;
  const out: TrailLines[] = [];
  for (const f of outlines?.features ?? []) {
    const id = Number(f.id);
    if (!ids.has(id) || !f.geometry) continue;
    const t = trailLinesOf(id, f.geometry, null);
    if (t) out.push(t);
  }
  return out;
}

// The trails, not in the list, that the given routes run along: their ids
// and outlines, for match.ts to credit with the routes' numbers.
// `deadline`: a time (ms) after which no new route is started — a request has
// a minute; what is left is found on the next run.
export async function discoverTrails(
  routes: KomootRoute[],
  known: Set<number>,
  { deadline = Infinity }: { deadline?: number } = {},
): Promise<TrailLines[]> {
  const probes = new Map<string, WmtRouteSummary[]>();
  const found = new Map<number, TrailLines>();
  let next = 0;
  const worker = async () => {
    while (next < routes.length && Date.now() < deadline) {
      const route = routes[next++];
      try {
        const candidates = await under(route, known, probes);
        // Only the trails this route actually runs along.
        for (const id of trailsOf(route, candidates)) {
          const t = candidates.find((c) => c.id === id)!;
          if (!found.has(id)) found.set(id, t);
        }
      } catch (e) {
        console.error('Trails under a Komoot route could not be read:', route.name, e);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return [...found.values()];
}
