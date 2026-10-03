// Waymarked Trails (hiking.waymarkedtrails.org): every marked hiking route in
// OpenStreetMap, worldwide, behind a small public API. This file is the pure
// half — types for what the API returns and the maths that turns a route into
// the app's own trail coordinates. Nothing here touches the network; the
// server proxy is src/app/api/world-trails/route.ts.
//
// Everything below was checked against the live API (September 2026). Two
// things it does not say anywhere and that cost an afternoon to find out:
//   - bounding boxes and every coordinate are EPSG:3857 (Web Mercator metres),
//     not lon/lat. A lon/lat bbox is accepted and quietly returns nothing.
//   - the ways inside `route.main` are already oriented along the route, so
//     concatenating them in order gives a continuous line. `direction` is the
//     OSM oneway flag, not an instruction to reverse anything.
//   - a long trail mapped as a relation of its stages (a "super-route", e.g.
//     the Menalon Trail) nests: each entry in `route.main` is then a whole
//     stage with its own `main`, and has no `ways` at all. Such a stage
//     carries its own relation `id`, and the details list each one's name
//     under `subroutes`; a stage's own details name the long trail it belongs
//     to under `superroutes`.

import type { Coordinate3D } from '../utils/trailUtils';
import { computeElevationGain } from '../utils/trailUtils';

export type WmtGroup = 'NAT' | 'REG' | 'LOC' | string;

export interface WmtRouteSummary {
  type: 'relation';
  id: number;
  name?: string;
  ref?: string;
  group: WmtGroup;
  linear: 'yes' | 'no' | 'sorted';
  symbol_id?: string;
  symbol_description?: string;
}

// How a route refers to another: its stages (`subroutes`) and the long trails
// it is a stage of (`superroutes`).
export interface WmtRouteRef extends WmtRouteSummary {
  itinerary?: string[];
}

export interface WmtWay {
  id: number;
  direction: number;
  length: number;
  role: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

export interface WmtSegment {
  route_type: string;
  start: number;
  length: number;
  // A plain segment has `ways`; a stage of a super-route has `main` instead,
  // and the stage's own relation id.
  id?: number;
  ways?: WmtWay[];
  main?: WmtSegment[];
}

export interface WmtRouteDetails extends WmtRouteSummary {
  operator?: string;
  description?: string;
  url?: string;
  wikipedia?: string | Record<string, string>;
  bbox: [number, number, number, number];
  tags: Record<string, string>;
  subroutes?: Record<string, WmtRouteRef>;
  superroutes?: Record<string, WmtRouteRef>;
  route: {
    route_type: string;
    length: number; // metres, mapped length of the whole relation
    linear: string;
    start: number;
    main: WmtSegment[];
    appendices: WmtSegment[];
  };
}

export interface WmtElevation {
  min_elevation: number;
  max_elevation: number;
  segments: Record<string, { elevation: Array<{ x: number; y: number; ele: number; pos: number }> }>;
}

// ── Projection ───────────────────────────────────────────────────────────────

const R = 6378137;
const HALF_WORLD = 20037508.342789244;

export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * HALF_WORLD) / 180;
  const clamped = Math.max(-89.9, Math.min(89.9, lat));
  const y = (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) * HALF_WORLD) / Math.PI;
  return [x, y];
}

export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / R) * (180 / Math.PI);
  const lat = (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90;
  return [lon, lat];
}

// ── Labels ───────────────────────────────────────────────────────────────────

export function groupLabel(group: WmtGroup): string {
  switch (group) {
    case 'NAT': return 'שביל לאומי';
    case 'REG': return 'שביל אזורי';
    case 'LOC': return 'שביל מקומי';
    default: return 'שביל מסומן';
  }
}

// Wikipedia comes back either as "he:שביל ישראל" or as {he: '…', en: '…'}.
// Prefer Hebrew, then English, then whatever is there.
export function wikipediaUrl(wikipedia: WmtRouteDetails['wikipedia']): string | null {
  if (!wikipedia) return null;
  let lang: string | undefined;
  let title: string | undefined;
  if (typeof wikipedia === 'string') {
    const idx = wikipedia.indexOf(':');
    if (idx > 0) { lang = wikipedia.slice(0, idx); title = wikipedia.slice(idx + 1); }
  } else {
    lang = ['he', 'en'].find((l) => wikipedia[l]) ?? Object.keys(wikipedia)[0];
    if (lang) title = wikipedia[lang];
  }
  if (!lang || !title) return null;
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

// ── Route → coordinates ──────────────────────────────────────────────────────

export interface WmtCoordsResult {
  coords: Coordinate3D[]; // [lat, lon, ele]
  // A route that OSM holds as several disconnected pieces (linear: 'no')
  // cannot be walked end to end; we hand back its longest piece and say so.
  partial: boolean;
  segmentCount: number;
  hasElevation: boolean;
}

function segmentDistance(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Elevation samples for one way, mapped onto that way's geometry by fraction
// of length. The samples run in the way's own OSM direction while the
// geometry has been turned to follow the route, so the two may disagree —
// whichever end of the geometry the first sample sits nearer decides.
function elevationsForWay(
  way: WmtWay,
  samples: WmtElevation['segments'][string] | undefined
): number[] | null {
  const pts = way.geometry.coordinates;
  const ele = samples?.elevation;
  if (!ele || ele.length === 0 || pts.length === 0) return null;
  if (ele.length === 1 || pts.length === 1) return pts.map(() => ele[0].ele);

  const first = ele[0];
  const reversed =
    segmentDistance([first.x, first.y], pts[0]) > segmentDistance([first.x, first.y], pts[pts.length - 1]);
  const ordered = reversed ? [...ele].reverse() : ele;
  const posEnd = Math.max(ordered[0].pos, ordered[ordered.length - 1].pos) || 1;
  // After reversing, `pos` counts backwards; turn it into a forward fraction.
  const frac = ordered.map((s) => (reversed ? (posEnd - s.pos) / posEnd : s.pos / posEnd));

  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + segmentDistance(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 1;

  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    const f = cum[i] / total;
    while (j < frac.length - 2 && frac[j + 1] < f) j++;
    const f0 = frac[j], f1 = frac[j + 1];
    const t = f1 > f0 ? Math.max(0, Math.min(1, (f - f0) / (f1 - f0))) : 0;
    out.push(ordered[j].ele + (ordered[j + 1].ele - ordered[j].ele) * t);
  }
  return out;
}

// Super-routes nest stages inside `main`; flatten down to the segments that
// actually hold ways, in route order.
function leafSegments(segments: WmtSegment[]): WmtSegment[] {
  return segments.flatMap((s) => (s.ways ? [s] : leafSegments(s.main ?? [])));
}

function wayEnds(segment: WmtSegment): [[number, number], [number, number]] | null {
  const ways = (segment.ways ?? []).filter((w) => w.geometry?.coordinates?.length);
  if (ways.length === 0) return null;
  const first = ways[0].geometry.coordinates;
  const last = ways[ways.length - 1].geometry.coordinates;
  return [first[0], last[last.length - 1]];
}

// Consecutive stages that meet end to start are one walk. Web Mercator metres,
// so this is a few tens of real metres at hiking latitudes.
const JOIN_GAP = 50;

// Group leaf segments into runs that join up, each run a walkable piece.
function chainSegments(leaves: WmtSegment[]): WmtSegment[][] {
  const chains: WmtSegment[][] = [];
  let prevEnd: [number, number] | null = null;
  for (const leaf of leaves) {
    const ends = wayEnds(leaf);
    if (!ends) continue;
    const joins = prevEnd && segmentDistance(prevEnd, ends[0]) <= JOIN_GAP;
    if (joins) chains[chains.length - 1].push(leaf);
    else chains.push([leaf]);
    prevEnd = ends[1];
  }
  return chains;
}

function chainLength(chain: WmtSegment[]): number {
  return chain.reduce((sum, s) => sum + (s.length ?? 0), 0);
}

function chainToCoords(chain: WmtSegment[], elevation?: WmtElevation | null): { coords: Coordinate3D[]; withEle: boolean } {
  const coords: Coordinate3D[] = [];
  let withEle = false;
  for (const way of chain.flatMap((s) => s.ways ?? [])) {
    const pts = way.geometry?.coordinates ?? [];
    const eles = elevation ? elevationsForWay(way, elevation.segments[String(way.id)]) : null;
    if (eles) withEle = true;
    for (let i = 0; i < pts.length; i++) {
      const [lon, lat] = mercatorToLonLat(pts[i][0], pts[i][1]);
      const last = coords[coords.length - 1];
      // Consecutive ways share their joining node — keep it once.
      if (last && Math.abs(last[0] - lat) < 1e-7 && Math.abs(last[1] - lon) < 1e-7) continue;
      coords.push([lat, lon, eles ? eles[i] : 0]);
    }
  }
  return { coords, withEle };
}

export function wmtRouteToCoords(details: WmtRouteDetails, elevation?: WmtElevation | null): WmtCoordsResult {
  const chains = chainSegments(leafSegments(details.route?.main ?? []));
  if (chains.length === 0) return { coords: [], partial: false, segmentCount: 0, hasElevation: false };

  // Disconnected pieces: the longest one is the walk worth offering.
  const longest = chains.reduce((a, b) => (chainLength(b) > chainLength(a) ? b : a), chains[0]);
  const { coords, withEle } = chainToCoords(longest, elevation);
  return { coords, partial: chains.length > 1, segmentCount: chains.length, hasElevation: withEle };
}

// ── Stages ───────────────────────────────────────────────────────────────────

// One stage of a long trail, in the order the trail walks them.
export interface WmtStage {
  id: number;
  name: string | null;
  // Where it starts and ends, when the mappers said so — often in Latin
  // letters where the name is not.
  itinerary: string[];
  startKm: number;
  lengthKm: number;
  gain: number | null;
  loss: number | null;
}

// The long trail's stages, from its own details. Fewer than two is not a trail
// made of stages, and gets no list. Climb and descent come from the long
// trail's elevation samples, which cover every stage's ways.
export function wmtStages(details: WmtRouteDetails, elevation?: WmtElevation | null): WmtStage[] {
  const parts = (details.route?.main ?? []).filter((s) => s.id != null && s.main);
  if (parts.length < 2) return [];
  return parts.map((part) => {
    const ref = details.subroutes?.[String(part.id)];
    let gain: number | null = null;
    let loss: number | null = null;
    if (elevation) {
      // A stage in pieces is summed piece by piece — never across a gap.
      for (const chain of chainSegments(leafSegments(part.main ?? []))) {
        const { coords, withEle } = chainToCoords(chain, elevation);
        if (!withEle) continue;
        const c = computeElevationGain(coords.map((p) => p[2]));
        gain = (gain ?? 0) + c.gain;
        loss = (loss ?? 0) + c.loss;
      }
    }
    return {
      id: part.id!,
      name: ref?.name ?? null,
      itinerary: ref?.itinerary ?? [],
      startKm: (part.start ?? 0) / 1000,
      lengthKm: (part.length ?? 0) / 1000,
      gain,
      loss,
    };
  });
}

// The long trails this route is a stage of. Usually one.
export function wmtParents(details: WmtRouteDetails): Array<{ id: number; name: string | null }> {
  return Object.values(details.superroutes ?? {}).map((r) => ({ id: r.id, name: r.name ?? null }));
}
