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
import { alongTrails, LONGER_FACTOR, routeKm, trailLinesOf, trailsOf, type TrailLines } from './match';

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
// An international path is never a country's trail itself (countryTrails),
// so it comes back apart, in `int`: only its stages can be.
async function under(route: KomootRoute, known: Set<number>, probes: Map<string, WmtRouteSummary[]>): Promise<{ local: TrailLines[]; int: TrailLines[] }> {
  const pts = route.points;
  const ids = new Set<number>();
  const intIds = new Set<number>();
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
    for (const s of found) if (!known.has(s.id)) (s.group === 'INT' ? intIds : ids).add(s.id);
  }
  if (!ids.size && !intIds.size) return { local: [], int: [] };
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const outlines = (await fetchWmt(
    `/list/segments?bbox=${box(Math.min(...lons) - OUTLINE_PAD, Math.min(...lats) - OUTLINE_PAD, Math.max(...lons) + OUTLINE_PAD, Math.max(...lats) + OUTLINE_PAD)}&relations=${[...ids, ...intIds].join(',')}`,
    20_000,
    false,
  )) as { features?: Feature[] } | null;
  const local: TrailLines[] = [];
  const int: TrailLines[] = [];
  for (const f of outlines?.features ?? []) {
    const id = Number(f.id);
    if (!f.geometry || !(ids.has(id) || intIds.has(id))) continue;
    const t = trailLinesOf(id, f.geometry, null);
    if (t) (ids.has(id) ? local : int).push(t);
  }
  return { local, int };
}

// A stage of a long trail the route runs along — the trail far longer than
// the route, so it is not credited itself (match.ts). On Komoot's routes
// (2026-10) 3% of the hikers walk such a stage: the Swiss, Slovenian and
// British long paths are mapped stage by stage.
async function stageUnder(route: KomootRoute, long: TrailLines[], subroutes: Map<number, number[]>): Promise<TrailLines[]> {
  const pts = route.points;
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  const bbox = box(Math.min(...lons) - OUTLINE_PAD, Math.min(...lats) - OUTLINE_PAD, Math.max(...lons) + OUTLINE_PAD, Math.max(...lats) + OUTLINE_PAD);
  // The shortest first: the stage of a regional path before that of the E4.
  for (const t of [...long].sort((a, b) => a.km - b.km).slice(0, 3)) {
    let ids = subroutes.get(t.id);
    if (!ids) {
      const d = (await fetchWmt(`/details/relation/${t.id}`, 30_000, false)) as { subroutes?: Record<string, unknown> } | null;
      ids = Object.keys(d?.subroutes ?? {}).map(Number).filter(Number.isFinite);
      subroutes.set(t.id, ids);
    }
    if (!ids.length) continue;
    const out = (await fetchWmt(`/list/segments?bbox=${bbox}&relations=${ids.join(',')}`, 30_000, false)) as { features?: Feature[] } | null;
    const stages = (out?.features ?? []).flatMap((f) => (f.geometry ? [trailLinesOf(Number(f.id), f.geometry, null)] : [])).filter((x): x is TrailLines => !!x);
    const fit = trailsOf(route, stages);
    if (fit.length) return stages.filter((s) => fit.includes(s.id));
  }
  return [];
}

// The trails, not in the list, that the given routes run along: their ids
// and outlines, for match.ts to credit with the routes' numbers.
// `deadline`: a time (ms) after which no new route is started — a request has
// a minute; what is left is found on the next run.
// `listLines`: the list's own trails, for the long ones among them whose
// stages a route may walk. `longOut`: filled, for a route that found nothing,
// with the trails far longer than itself that it runs along — where a popular
// part of a long trail can be cut out instead (sections.ts).
export async function discoverTrails(
  routes: KomootRoute[],
  known: Set<number>,
  { deadline = Infinity, listLines = [], longOut }: { deadline?: number; listLines?: TrailLines[]; longOut?: Map<KomootRoute, TrailLines[]> } = {},
): Promise<TrailLines[]> {
  const probes = new Map<string, WmtRouteSummary[]>();
  const subroutes = new Map<number, number[]>();
  const found = new Map<number, TrailLines>();
  let next = 0;
  const worker = async () => {
    while (next < routes.length && Date.now() < deadline) {
      const route = routes[next++];
      try {
        const { local, int } = await under(route, known, probes);
        // Only the trails this route actually runs along.
        let fit = trailsOf(route, local).map((id) => local.find((c) => c.id === id)!);
        if (!fit.length) {
          // Else a stage of a trail too long to take its numbers.
          const length = routeKm(route);
          const long = alongTrails(route, [...listLines, ...local, ...int]).filter((t) => t.km > length * LONGER_FACTOR);
          if (long.length) fit = (await stageUnder(route, long, subroutes)).filter((t) => !known.has(t.id));
          if (!fit.length && long.length) longOut?.set(route, long);
        }
        for (const t of fit) if (!found.has(t.id)) found.set(t.id, t);
      } catch (e) {
        console.error('Trails under a Komoot route could not be read:', route.name, e);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return [...found.values()];
}
