// "קטע פופולרי": the part of a long marked trail that a famous day walk is.
//
// Many of the walks people actually do are a few kilometres of a trail that
// runs for hundreds: the Valbona Pass on the Peaks of the Balkans, Conic Hill
// on the West Highland Way, Beachy Head on the South Downs Way. The long trail
// is never credited with a day walk's numbers (match.ts), and an international
// one is not in a country's list at all; where OSM maps it stage by stage the
// stage is found (discover.ts), but most are mapped whole. On Komoot's routes
// (2026-10) 7% of the hikers walked such a part with no stage to give it to.
//
// So the part is cut out of the long trail itself: the ways of its OSM
// relation, from the first to the last that the route runs along. What is
// kept is only where it starts and ends on the trail, a few points along it
// for the lists, and a name from the places at its two ends (Nominatim, OSM's
// own place search) — all OpenStreetMap's, never Komoot's line. Komoot gives
// only the numbers, as for every trail, and the fact that this part is the
// one people walk.
//
// A section goes by a negative id — -(trail id × 100 + n) — in the lists,
// trail_crowd and the card, so that nothing can take it for an OSM relation.
// Its card is the long trail's ways between the two ends, cut on the server
// (/api/world-trails?id=<negative>), with the long trail as its parent.
//
// Made only from the Mac (scripts/collectCrowd.mjs): naming a section waits a
// second for each of its two places.

import { iso1A2Code } from '@rapideditor/country-coder';
import { serviceClient } from '../supabaseService';
import { fetchWmt } from '../wmtServer';
import { mercatorToLonLat, wmtWalkedWays, type WmtRouteDetails, type WmtWay, type WmtElevation } from '../waymarked';
import type { KomootRoute } from './komoot';
import { gradeCovers, routeKm, type TrailLines } from './match';
import type { CrowdSource } from './score';

export interface TrailSection {
  id: number;                       // negative
  country: string;
  parentId: number;                 // the long trail's OSM relation
  parentName: string | null;
  parentGroup: string;
  name: string;
  start: [number, number];          // [lat, lon], on the trail
  end: [number, number];
  km: number;
  samples: Array<[number, number]>; // [lon, lat], along it, for the lists
}

// A route point this close to the long trail is on it (as in match.ts).
const NEAR_M = 150;
// The part must be a walk, and the route's: for a loop that goes out along
// the trail and back another way it is about half the route, never much more.
const MIN_KM = 2;
const KM_OF_ROUTE: [number, number] = [0.4, 1.3];
// Two parts of the same trail sharing this much of the shorter are one.
const SAME_PART = 0.5;
const SAMPLES = 30;

export function isSectionId(id: number): boolean {
  return id < 0;
}

function sectionId(parentId: number, n: number): number {
  return -(parentId * 100 + n);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

interface Walked {
  ways: WmtWay[];
  // Every vertex: [lon, lat] and the index of its way.
  pts: Array<[number, number, number]>;
}

function walkedOf(details: WmtRouteDetails): Walked {
  const ways = wmtWalkedWays(details);
  const pts: Walked['pts'] = [];
  ways.forEach((w, i) => {
    for (const [x, y] of w.geometry.coordinates) {
      const [lon, lat] = mercatorToLonLat(x, y);
      pts.push([lon, lat, i]);
    }
  });
  return { ways, pts };
}

// How far (metres) a point is from each way of the trail.
function wayDistances(lat: number, lon: number, w: Walked): number[] {
  const ky = 111_320, kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const out = w.ways.map(() => Infinity);
  for (let i = 1; i < w.pts.length; i++) {
    const a = w.pts[i - 1], b = w.pts[i];
    if (a[2] !== b[2]) continue; // not across two ways
    const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky;
    const bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < out[b[2]]) out[b[2]] = d;
  }
  return out;
}

// The way the nearest point of the trail is on, and how far it is (metres).
function nearestWay(lat: number, lon: number, w: Walked): { way: number; d: number } {
  const ds = wayDistances(lat, lon, w);
  let way = -1;
  ds.forEach((d, i) => { if (way < 0 || d < ds[way]) way = i; });
  return { way, d: way < 0 ? Infinity : ds[way] };
}

function waysKm(ways: WmtWay[]): number {
  return ways.reduce((s, w) => s + (w.length ?? 0), 0) / 1000;
}

function evenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

// The ways from the one at `start` to the one at `end`. A trail can pass the
// same spot twice (up a valley and back down it): of the ways at each end,
// the pair whose stretch is nearest the section's length.
function rangeOf(w: Walked, start: [number, number], end: [number, number], km?: number): [number, number] {
  const near = (ds: number[]) => {
    const best = Math.min(...ds);
    return ds.flatMap((d, i) => (d <= Math.max(30, best + 10) ? [i] : []));
  };
  const as = near(wayDistances(start[0], start[1], w));
  const bs = near(wayDistances(end[0], end[1], w));
  let pick: [number, number] = [-1, -1];
  let off = Infinity;
  for (const a of as) {
    for (const b of bs) {
      const r: [number, number] = a <= b ? [a, b] : [b, a];
      const o = km == null ? 0 : Math.abs(waysKm(w.ways.slice(r[0], r[1] + 1)) - km);
      if (o < off) { off = o; pick = r; }
    }
  }
  return pick;
}

// The section's part of the long trail's details: its ways alone, as one
// stretch, with the long trail as its parent — the card, "טען" and the
// stages' "back to the main trail" then work as for any route.
export function cutSection(parent: WmtRouteDetails, s: TrailSection): WmtRouteDetails | null {
  const w = walkedOf(parent);
  if (!w.ways.length) return null;
  const [a, b] = rangeOf(w, s.start, s.end, s.km);
  if (a < 0 || b < 0) return null;
  const ways = w.ways.slice(a, b + 1);
  const xs = ways.flatMap((x) => x.geometry.coordinates.map((c) => c[0]));
  const ys = ways.flatMap((x) => x.geometry.coordinates.map((c) => c[1]));
  const length = ways.reduce((n, x) => n + (x.length ?? 0), 0);
  return {
    type: 'relation',
    id: s.id,
    name: s.name,
    group: 'SEC',
    linear: 'yes',
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    tags: {},
    subroutes: {},
    superroutes: { [String(parent.id)]: { type: 'relation', id: parent.id, name: parent.name ?? parent.ref, group: parent.group, linear: parent.linear } },
    route: {
      route_type: 'route',
      length,
      linear: 'yes',
      start: 0,
      main: [{ route_type: 'linear', start: 0, length, ways }],
      appendices: [],
    },
  };
}

// The long trail's elevation, narrowed to the section's ways.
export function cutElevation(elevation: WmtElevation, details: WmtRouteDetails): WmtElevation {
  const ids = new Set((details.route.main[0]?.ways ?? []).map((w) => String(w.id)));
  const segments = Object.fromEntries(Object.entries(elevation.segments ?? {}).filter(([id]) => ids.has(id)));
  const eles = Object.values(segments).flatMap((s) => s.elevation.map((e) => e.ele));
  return {
    segments,
    min_elevation: eles.length ? Math.min(...eles) : elevation.min_elevation,
    max_elevation: eles.length ? Math.max(...eles) : elevation.max_elevation,
  };
}

// ── Places ───────────────────────────────────────────────────────────────────

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
let lastAsk = 0;
const places = new Map<string, string | null>();

// The village or town at a point, from OSM (Nominatim asks for one request a
// second at most).
async function placeAt(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (places.has(key)) return places.get(key)!;
  const wait = lastAsk + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAsk = Date.now();
  let name: string | null = null;
  try {
    // Zoom 13: the village ("Valbonë"), not the hamlet at its edge ("Rragam").
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon), zoom: '13', format: 'jsonv2', 'accept-language': 'en' });
    const res = await fetch(`${NOMINATIM}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const d = (await res.json()) as { name?: string; address?: Record<string, string> };
      const a = d.address ?? {};
      name = (d.name || a.village || a.town || a.city || a.hamlet || a.suburb || a.locality || '').trim() || null;
    }
  } catch {
    // No name: the section is named by its length instead.
  }
  places.set(key, name);
  return name;
}

async function nameOf(parentName: string | null, start: [number, number], end: [number, number], km: number): Promise<string> {
  const head = parentName ?? 'שביל מסומן';
  const [a, b] = [await placeAt(start[0], start[1]), await placeAt(end[0], end[1])];
  if (a && b && a !== b) return `${head}: ${a} – ${b}`;
  if (a || b) return `${head}: ${a ?? b}`;
  return `${head}: קטע של ${Math.round(km)} ק״מ`;
}

// ── Finding ──────────────────────────────────────────────────────────────────

export interface FoundSection {
  section: TrailSection;
  source: CrowdSource;   // the most walked route along it
  isNew: boolean;
}

// For each route that ran along nothing but a far longer trail (`onLong`, from
// matchAllDetailed), the part of that trail it walks — merged with a part of
// the same trail that `existing` (or a busier route) already has.
export async function findSections(
  country: string,
  onLong: Map<KomootRoute, TrailLines[]>,
  existing: TrailSection[],
  { log = () => {} }: { log?: (s: string) => void } = {},
): Promise<FoundSection[]> {
  const details = new Map<number, WmtRouteDetails | null>();
  const walked = new Map<number, Walked>();
  const parts: Array<FoundSection & { range: [number, number] }> = [];
  const used = new Set(existing.map((s) => s.id));
  const parentsRead = new Set<number>();

  const walkedFor = async (id: number): Promise<Walked | null> => {
    if (!details.has(id)) details.set(id, (await fetchWmt(`/details/relation/${id}`, 60_000, false)) as WmtRouteDetails | null);
    const d = details.get(id);
    if (!d) return null;
    if (!walked.has(id)) walked.set(id, walkedOf(d));
    return walked.get(id)!;
  };

  // The ones already made, placed on their trails.
  for (const s of existing) {
    const w = await walkedFor(s.parentId);
    if (!w) continue;
    parts.push({ section: s, source: null as unknown as CrowdSource, isNew: false, range: rangeOf(w, s.start, s.end, s.km) });
  }
  const credited = new Set<number>();

  // The most walked first: it sets the part, and its numbers are the part's.
  // The same route listed on two pages is one.
  const seen = new Set<string>();
  const routes = [...onLong.keys()].sort((a, b) => b.hikers - a.hikers).filter((r) => {
    const key = r.points.map((p) => p.join(',')).join(';');
    return !seen.has(key) && !!seen.add(key);
  });
  for (const route of routes) {
    const length = routeKm(route);
    for (const t of [...onLong.get(route)!].sort((a, b) => a.km - b.km)) {
      const w = await walkedFor(t.id);
      if (!w || !w.ways.length) continue;
      const hits = route.points.map(([lat, lon]) => nearestWay(lat, lon, w)).filter((h) => h.d <= NEAR_M);
      if (!hits.length) { if (process.env.SECTIONS_DEBUG) log(`  - ${route.name}: not on ${t.id}'s walked piece`); continue; }
      const range: [number, number] = [Math.min(...hits.map((h) => h.way)), Math.max(...hits.map((h) => h.way))];
      const ways = w.ways.slice(range[0], range[1] + 1);
      const km = waysKm(ways);
      if (km < MIN_KM || km < length * KM_OF_ROUTE[0] || km > length * KM_OF_ROUTE[1]) {
        if (process.env.SECTIONS_DEBUG) log(`  - ${route.name} (${route.hikers}): part ${km.toFixed(1)} km of ${t.id} vs route ${length.toFixed(1)} km`);
        continue;
      }
      const pts = w.pts.filter((p) => p[2] >= range[0] && p[2] <= range[1]);
      // Most of it in this country (a border ridge counts where it mostly is).
      const sample = evenly(pts, SAMPLES);
      if (sample.filter(([lon, lat]) => iso1A2Code([lon, lat]) === country).length < sample.length / 2) continue;

      const grade = route.grade && gradeCovers(length, km) ? route.grade : undefined;
      const source: CrowdSource = {
        site: 'Komoot', url: route.guide, rating: route.rating, count: route.ratings, hikers: route.hikers, route: route.name,
        ...(grade ? { grade } : {}),
      };
      const same = parts.find((p) => p.section.parentId === t.id && overlap(p.range, range, w) >= SAME_PART);
      if (same) {
        if (process.env.SECTIONS_DEBUG) log(`  = ${route.name} (${route.hikers}) → ${same.section.name}`);
        if (!credited.has(same.section.id)) { same.source = source; credited.add(same.section.id); }
        break;
      }
      const d = details.get(t.id)!;
      const parentName = d.name ?? d.ref ?? null;
      const first = pts[0], last = pts[pts.length - 1];
      const start: [number, number] = [round(first[1]), round(first[0])];
      const end: [number, number] = [round(last[1]), round(last[0])];
      // A trail across a border has sections in each country: the number is
      // free on the whole trail, or one country's would overwrite another's.
      if (!parentsRead.has(t.id)) {
        parentsRead.add(t.id);
        for (const other of await sectionsOfParent(t.id)) used.add(other.id);
      }
      let n = 1;
      while (used.has(sectionId(t.id, n))) n++;
      const id = sectionId(t.id, n);
      used.add(id);
      const section: TrailSection = {
        id, country, parentId: t.id, parentName, parentGroup: d.group ?? '',
        name: await nameOf(parentName, start, end, km),
        start, end, km: Math.round(km * 10) / 10,
        samples: sample.map(([lon, lat]) => [round(lon), round(lat)]),
      };
      log(`  section ${section.name} (${section.km} km) ⇐ ${route.name} (${route.hikers})`);
      parts.push({ section, source, isNew: true, range });
      credited.add(id);
      break;
    }
  }
  return parts.filter((p) => credited.has(p.section.id));
}

function round(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

// Shared length of two ranges of ways, over the shorter one's.
function overlap(a: [number, number], b: [number, number], w: Walked): number {
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  if (lo > hi) return 0;
  const shared = waysKm(w.ways.slice(lo, hi + 1));
  const shorter = Math.min(waysKm(w.ways.slice(a[0], a[1] + 1)), waysKm(w.ways.slice(b[0], b[1] + 1)));
  return shorter ? shared / shorter : 0;
}

// ── Stored ───────────────────────────────────────────────────────────────────
// public.trail_sections: one row per section. Server only, service_role.

type Row = {
  id: number; country: string; parent_id: number; parent_name: string | null; parent_group: string | null; name: string;
  start_lat: number; start_lon: number; end_lat: number; end_lon: number; km: number; samples: unknown;
};

function fromRow(r: Row): TrailSection {
  return {
    id: Number(r.id), country: r.country, parentId: Number(r.parent_id), parentName: r.parent_name, parentGroup: r.parent_group ?? '',
    name: r.name, start: [r.start_lat, r.start_lon], end: [r.end_lat, r.end_lon], km: Number(r.km),
    samples: Array.isArray(r.samples) ? (r.samples as Array<[number, number]>) : [],
  };
}

const COLUMNS = 'id, country, parent_id, parent_name, parent_group, name, start_lat, start_lon, end_lat, end_lon, km, samples';
let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) console.error(`Trail sections disabled: table public.trail_sections is missing. Run supabase/schema.sql. (${message})`);
    tableMissing = true;
    return;
  }
  console.error(`Trail sections ${where} failed:`, e);
}

export function isSectionsTableMissing(): boolean {
  return tableMissing;
}

async function readWhere(column: 'country' | 'id' | 'parent_id', value: string | number): Promise<TrailSection[]> {
  const db = serviceClient();
  if (!db || tableMissing) return [];
  try {
    const { data, error } = await db.from('trail_sections').select(COLUMNS).eq(column, value);
    if (error) throw error;
    return ((data ?? []) as Row[]).map(fromRow);
  } catch (e) {
    noteError('read', e);
    return [];
  }
}

export function sectionsOfCountry(country: string): Promise<TrailSection[]> {
  return readWhere('country', country);
}

export async function sectionById(id: number): Promise<TrailSection | null> {
  return (await readWhere('id', id))[0] ?? null;
}

export function sectionsOfParent(parentId: number): Promise<TrailSection[]> {
  return readWhere('parent_id', parentId);
}

export async function writeSections(sections: TrailSection[]): Promise<boolean> {
  const db = serviceClient();
  if (!db || tableMissing) return false;
  if (!sections.length) return true;
  try {
    // Never over another country's section (see sectionId).
    const { data: taken, error: readError } = await db.from('trail_sections').select('id, country').in('id', sections.map((s) => s.id));
    if (readError) throw readError;
    const owner = new Map((taken ?? []).map((r) => [Number(r.id), r.country as string]));
    const clash = sections.filter((s) => owner.has(s.id) && owner.get(s.id) !== s.country);
    if (clash.length) throw new Error(`section ids held by another country: ${clash.map((s) => s.id).join(', ')}`);
    const { error } = await db.from('trail_sections').upsert(sections.map((s) => ({
      id: s.id, country: s.country, parent_id: s.parentId, parent_name: s.parentName, parent_group: s.parentGroup, name: s.name,
      start_lat: s.start[0], start_lon: s.start[1], end_lat: s.end[0], end_lon: s.end[1], km: s.km, samples: s.samples,
      updated_at: new Date().toISOString(),
    })), { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (e) {
    noteError('write', e);
    return false;
  }
}
