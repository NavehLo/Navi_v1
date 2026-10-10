import { iso1A2Code } from '@rapideditor/country-coder';
import { serviceClient } from './supabaseService';
import { fetchWmt } from './wmtServer';
import { lonLatToMercator, mercatorToLonLat, type WmtRouteSummary } from './waymarked';
import { countryCells, climateAt } from './climateGrid';
import { rateMonths, rateLongWalk, crossesClimates, isGorgeName, CLIMATE_VERSION, MULTI_DAY_KM, type MonthRating } from './climate';
import { estimateHike } from './hikeEffort';
import { lookupEnglish } from './trailNameCache';
import { needsEnglish } from './trailNames';
import { regionsAlong, regionInfo, type RegionInfo } from './regions';
import { CROWD_VERSION } from './trailCrowd/score';
import { isSectionId, sectionsOfCountry, type TrailSection } from './trailCrowd/sections';

// A country's marked trails with the twelve months rated for each — the list
// behind "מסלולים בעולם". Server only.
//
// Waymarked Trails cannot list a country: an area query answers 100 routes at
// most, the most important first (international, national, regional, local).
// A whole-country query would be all long-distance paths. So the country is
// cut into up to MAX_TILES squares where its land is, sized to the country,
// and each square is asked for its 100: in a small country that reaches the
// local walks, in a large one the regional and national trails, which is what
// somebody choosing a country for a trip looks at first.
//
// For each route, Waymarked's outline clipped to the square gives its length
// in this country and a few points along it; Open-Meteo gives those points'
// heights (free, 100 to a request); the climate grid and the same rateMonths
// as the trail card do the rest.
//
// Building a country takes tens of seconds and a few dozen requests to two
// community services, so it is done once: kept in memory and in
// public.country_trails (when the table exists) for 30 days, or until the
// rating rules change (CLIMATE_VERSION). Two people asking for the same new
// country share one build.

export interface CountryTrail {
  id: number;
  name: string;
  name_en: string | null;
  group: string;
  linear: WmtRouteSummary['linear'];
  km: number;               // length inside this country, as far as the squares saw it
  crossesBorder: boolean;   // it goes on into a neighbour, so km is only this country's part
  multiDay: boolean;
  lat: number;              // a point on it, for the map
  lon: number;
  regions: string[];        // ids of the areas it passes through (see regions.ts)
  months: MonthRating[];    // 12
  // A popular part of a long trail (trailCrowd/sections.ts), not a route of
  // its own: its id is negative, its group 'SEC'.
  section?: { parent: number; parentName: string | null; parentGroup: string };
}

export interface CountryTrailList {
  country: string;
  version: number;
  builtAt: number;
  partial: boolean;         // the build ran out of time; rebuilt sooner
  regions: RegionInfo[];    // the areas that have trails, for the step before the list
  trails: CountryTrail[];
}

// What a stored list is checked against: the rating rules, and the shape of
// the list itself (LIST_FORMAT — 2 added the areas, 4 left out the
// international paths). Both live in the table's climate_version column, so a
// change to either rebuilds every country. The popular parts of long trails
// (`section`, 2026-10) did not bump it: an optional field, which a list
// without it is still right without — they are added to it as they are found.
const LIST_FORMAT = 4;
const STORED_VERSION = CLIMATE_VERSION * 100 + LIST_FORMAT;

const MAX_TILES = 12;
const TILE_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24];
const MAX_TRAILS = 600;
const SAMPLES = 5;
const BUILD_BUDGET_MS = 40_000;
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const PARTIAL_FRESH_MS = 24 * 60 * 60 * 1000;

const KEY = process.env.OPEN_METEO_API_KEY;
const ELEVATION_URL = KEY ? 'https://customer-api.open-meteo.com/v1/elevation' : 'https://api.open-meteo.com/v1/elevation';

const GROUP_ORDER: Record<string, number> = { INT: 0, NAT: 1, REG: 2, LOC: 3 };

// ── Geometry ─────────────────────────────────────────────────────────────────

type Line = Array<[number, number]>; // [lon, lat]

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}

function lineKm(line: Line): number {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += haversineKm(line[i - 1], line[i]);
  return km;
}

function evenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1 || 1))]);
}

// ── Squares ──────────────────────────────────────────────────────────────────

interface Tile {
  west: number; south: number; east: number; north: number;
  cells: number;
}

// The country's land without its overseas territories: in the grid Britain
// holds the Falklands and Norway Svalbard and Bouvet, and squares wide enough
// to reach them all were 24° across — Britain's list came out with 2 trails.
// Islands that are part of the country itself (the Canaries, the Azores,
// Hawaii, Corsica) stay.
const homeCells = new Map<string, Array<[number, number]>>();
function homeLand(country: string): Array<[number, number]> {
  let cells = homeCells.get(country);
  if (!cells) {
    const all = countryCells(country);
    const home = all.filter(([lat, lon]) => iso1A2Code([lon, lat], { level: 'territory' }) === country);
    cells = home.length ? home : all;
    homeCells.set(country, cells);
  }
  return cells;
}

function tilesFor(country: string): Tile[] {
  const cells = homeLand(country);
  if (cells.length === 0) return [];
  for (const size of TILE_SIZES) {
    const counts = new Map<string, number>();
    for (const [lat, lon] of cells) {
      const k = `${Math.floor(lat / size)},${Math.floor(lon / size)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (counts.size > MAX_TILES && size !== TILE_SIZES[TILE_SIZES.length - 1]) continue;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TILES)
      .map(([k, n]) => {
        const [r, c] = k.split(',').map(Number);
        return { south: r * size, north: (r + 1) * size, west: c * size, east: (c + 1) * size, cells: n };
      });
  }
  return [];
}

function mercatorBox(t: Tile): string {
  const [minx, miny] = lonLatToMercator(t.west, Math.max(-85, t.south));
  const [maxx, maxy] = lonLatToMercator(t.east, Math.min(85, t.north));
  return [minx, miny, maxx, maxy].map((n) => n.toFixed(0)).join(',');
}

export interface Found {
  summary: WmtRouteSummary;
  lines: Line[];
}

type Feature = { id?: number; properties?: { id?: number }; geometry?: { type: string; coordinates: unknown } };

async function readTile(tile: Tile, found: Map<number, Found>): Promise<boolean> {
  const bbox = mercatorBox(tile);
  const list = (await fetchWmt(`/list/by_area?bbox=${bbox}&limit=100`, 12_000, false)) as
    | { results?: WmtRouteSummary[] }
    | null;
  if (!list) return false;
  const routes = (list.results ?? []).filter((r) => r?.id);
  if (routes.length === 0) return true;
  const outlines = (await fetchWmt(
    `/list/segments?bbox=${bbox}&relations=${routes.map((r) => r.id).join(',')}`,
    25_000,
    false,
  )) as { features?: Feature[] } | null;
  if (!outlines) return false;
  const byId = new Map(routes.map((r) => [r.id, r]));
  for (const f of outlines.features ?? []) {
    const id = Number(f.id ?? f.properties?.id);
    const summary = byId.get(id);
    if (!summary || !f.geometry) continue;
    const raw = f.geometry.type === 'LineString'
      ? [f.geometry.coordinates as number[][]]
      : f.geometry.type === 'MultiLineString' ? (f.geometry.coordinates as number[][][]) : [];
    const lines: Line[] = raw
      .map((l) => l.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])).map((p) => mercatorToLonLat(p[0], p[1])))
      .filter((l) => l.length > 1);
    const entry = found.get(id) ?? { summary, lines: [] };
    entry.lines.push(...lines);
    found.set(id, entry);
  }
  return true;
}

// ── Heights ──────────────────────────────────────────────────────────────────

async function elevations(points: Array<[number, number]>): Promise<Array<number | null>> {
  const out: Array<number | null> = points.map(() => null);
  const batches: number[][] = [];
  for (let i = 0; i < points.length; i += 100) batches.push(Array.from({ length: Math.min(100, points.length - i) }, (_, j) => i + j));
  await pool(batches, 3, async (idx) => {
    const params = new URLSearchParams({
      latitude: idx.map((i) => points[i][1].toFixed(4)).join(','),
      longitude: idx.map((i) => points[i][0].toFixed(4)).join(','),
    });
    if (KEY) params.set('apikey', KEY);
    try {
      const res = await fetch(`${ELEVATION_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { elevation?: number[] };
      body.elevation?.forEach((e, j) => { if (Number.isFinite(e)) out[idx[j]] = e; });
    } catch {
      // No heights: the grid's own is used, which only blurs mountain trails.
    }
  });
  return out;
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

// ── Rating ───────────────────────────────────────────────────────────────────

interface Sample { lon: number; lat: number; ele: number | null }

function rateTrail(samples: Sample[], km: number, multiDay: boolean, gorge: boolean): MonthRating[] | null {
  if (!multiDay || !crossesClimates(samples)) {
    // A day walk, or a long one that stays in one place: like the trail card,
    // heat at its lowest point and cold at its highest, for the time it takes.
    const known = samples.filter((s) => s.ele != null);
    const low = known.length ? known.reduce((a, b) => (b.ele! < a.ele! ? b : a)) : samples[0];
    const high = known.length ? known.reduce((a, b) => (b.ele! > a.ele! ? b : a)) : samples[0];
    const lowC = climateAt(low.lat, low.lon, low.ele);
    const highC = climateAt(high.lat, high.lon, high.ele);
    if (!lowC || !highC) return null;
    const relief = known.length ? Math.max(0, high.ele! - low.ele!) : 0;
    const hours = estimateHike(km, relief, relief).totalHours;
    return rateMonths({ low: lowC.months, high: highC.months, lat: (low.lat + high.lat) / 2, hours, gorge }).map((m) => m.rating);
  }
  // A walk of days: point by point, as rateLongWalk explains.
  const points = samples
    .map((s) => ({ c: climateAt(s.lat, s.lon, s.ele), lat: s.lat }))
    .filter((p): p is { c: NonNullable<typeof p.c>; lat: number } => p.c != null)
    .map((p) => ({ months: p.c.months, lat: p.lat }));
  return points.length ? rateLongWalk(points, gorge).map((m) => m.rating) : null;
}

// ── Building ─────────────────────────────────────────────────────────────────

type Candidate = {
  summary: WmtRouteSummary; km: number; crossesBorder: boolean; samples: Sample[]; regions: string[]; byId?: boolean;
  section?: CountryTrail['section'];
};

// Each route: its length here, and a few points on it that are in this
// country (a square at a border holds the neighbour's trails too).
// `byId`: the trails added by id (see "Trails added by id"). Among them a
// stage of an international path — a day's walk of the Peaks of the Balkans
// or the E4, a route of its own in OSM — is kept: its card and "טען" are that
// stage, not the whole path. A longer one is the path itself, and is not.
const INT_STAGE_KM = 50;

function candidatesFrom(country: string, found: Map<number, Found>, byId = false): Candidate[] {
  const candidates: Candidate[] = [];
  for (const { summary, lines } of found.values()) {
    const sampled = evenly(lines.flat(), 30);
    const inside = sampled.filter(([lon, lat]) => iso1A2Code([lon, lat]) === country);
    if (inside.length === 0) continue;
    // An international path (the E4, ten thousand kilometres from Gibraltar
    // to Cyprus) is not this country's trail: the squares see only its part
    // here — often all of it inside, so it does not even seem to cross the
    // border — but its card and "טען" are the whole of it, and load its
    // longest piece, in Spain. Its parts in this country are mapped as routes
    // of their own ("E4 – part Greece, Central"), and those are kept.
    if (summary.group === 'INT' && !(byId && lines.reduce((s, l) => s + lineKm(l), 0) <= INT_STAGE_KM)) continue;
    // The squares reach over the border; only the share inside counts.
    const km = lines.reduce((s, l) => s + lineKm(l), 0) * (inside.length / sampled.length);
    if (km < 0.5) continue;
    candidates.push({ summary, km, crossesBorder: inside.length < sampled.length, regions: regionsAlong(country, inside), samples: evenly(inside, SAMPLES).map(([lon, lat]) => ({ lon, lat, ele: null })), byId });
  }
  return candidates;
}

// Heights, English names and the twelve months: candidates become trails.
async function trailsFrom(chosen: Candidate[], fallbackNames: Record<number, string | null> = {}): Promise<CountryTrail[]> {
  const allSamples = chosen.flatMap((c) => c.samples);
  const heights = await elevations(allSamples.map((s) => [s.lon, s.lat]));
  allSamples.forEach((s, i) => { s.ele = heights[i]; });

  const english = await lookupEnglish(chosen.filter((c) => needsEnglish(c.summary.name)).map((c) => c.summary.id));

  const trails: CountryTrail[] = [];
  for (const c of chosen) {
    // A trail found under a day walk — a stage of a national or international
    // path among them — is judged by its length alone, as its card is.
    const multiDay = c.km > MULTI_DAY_KM || (!c.byId && (c.summary.group === 'INT' || c.summary.group === 'NAT'));
    const gorge = isGorgeName(c.summary.name) || isGorgeName(english.get(c.summary.id));
    const months = rateTrail(c.samples, c.km, multiDay, gorge);
    if (!months) continue;
    const mid = c.samples[Math.floor(c.samples.length / 2)];
    trails.push({
      id: c.summary.id,
      name: c.summary.name || c.summary.ref || fallbackNames[c.summary.id] || `מסלול ${c.summary.id}`,
      name_en: english.get(c.summary.id) ?? null,
      group: c.summary.group,
      linear: c.summary.linear,
      km: Math.round(c.km * 10) / 10,
      crossesBorder: c.crossesBorder,
      multiDay,
      lat: Math.round(mid.lat * 1e4) / 1e4,
      lon: Math.round(mid.lon * 1e4) / 1e4,
      regions: c.regions,
      months,
      ...(c.section ? { section: c.section } : {}),
    });
  }
  return trails;
}

// ── Trails added by id ───────────────────────────────────────────────────────
// The squares reach a large country's local paths only where its land is small
// (the Canaries, not mainland Spain): asked for a 50 km square, Waymarked
// answers its 100 national and regional routes and no local one. The local
// paths that matter most — the ones Komoot lists among an area's most walked —
// are found by the hiker metrics' collection, under those very routes
// (trailCrowd/discover.ts), and added here by id. They are remembered in
// public.trail_crowd, so a rebuilt list (every 30 days, or a new format) gets
// them back without collecting again.

// Also used by scripts/collectLandscape.mjs, for the outlines it samples.
export async function readByIds(country: string, ids: number[]): Promise<Map<number, Found>> {
  const found = new Map<number, Found>();
  if (!ids.length) return found;
  const summaries = new Map<number, WmtRouteSummary>();
  for (let i = 0; i < ids.length; i += 50) {
    const r = (await fetchWmt(`/list/by_ids?relations=${ids.slice(i, i + 50).join(',')}`, 20_000, false)) as { results?: WmtRouteSummary[] } | null;
    for (const s of r?.results ?? []) summaries.set(s.id, s);
  }
  const tiles = tilesFor(country);
  if (!tiles.length || !summaries.size) return found;
  // The whole country as one box; the outlines come back whole (checked 2026-10).
  const box = mercatorBox({
    west: Math.min(...tiles.map((t) => t.west)), south: Math.min(...tiles.map((t) => t.south)),
    east: Math.max(...tiles.map((t) => t.east)), north: Math.max(...tiles.map((t) => t.north)), cells: 0,
  });
  const wanted = [...summaries.keys()];
  for (let i = 0; i < wanted.length; i += 40) {
    const outlines = (await fetchWmt(`/list/segments?bbox=${box}&relations=${wanted.slice(i, i + 40).join(',')}`, 30_000, false)) as { features?: Feature[] } | null;
    for (const f of outlines?.features ?? []) {
      const id = Number(f.id ?? f.properties?.id);
      const summary = summaries.get(id);
      if (!summary || !f.geometry) continue;
      const raw = f.geometry.type === 'LineString'
        ? [f.geometry.coordinates as number[][]]
        : f.geometry.type === 'MultiLineString' ? (f.geometry.coordinates as number[][][]) : [];
      const lines: Line[] = raw
        .map((l) => l.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])).map((p) => mercatorToLonLat(p[0], p[1])))
        .filter((l) => l.length > 1);
      const entry = found.get(id) ?? { summary, lines: [] };
      entry.lines.push(...lines);
      found.set(id, entry);
    }
  }
  return found;
}

// The trails the hiker metrics found for this country (rows with numbers),
// each with the name of the route that found it — for a path mapped without
// a name of its own.
async function crowdTrails(country: string): Promise<Map<number, string | null>> {
  const client = serviceClient();
  if (!client) return new Map();
  try {
    const { data, error } = await client
      .from('trail_crowd')
      .select('trail_id, sources')
      .eq('country', country)
      .eq('crowd_version', CROWD_VERSION)
      .gt('rating_count', 0);
    if (error) throw error;
    return new Map((data ?? []).map((r) => [Number(r.trail_id), (r.sources as Array<{ route?: string }>)?.[0]?.route ?? null]));
  } catch {
    return new Map();
  }
}

// `budgetMs`: how long the squares may take — a request's worth on the
// server; longer from a script on the Mac, so a large country is read whole.
async function build(country: string, budgetMs = BUILD_BUDGET_MS): Promise<CountryTrailList | null> {
  const started = Date.now();
  const tiles = tilesFor(country);
  if (tiles.length === 0) return null;

  const found = new Map<number, Found>();
  let answered = 0, partial = false;
  await pool(tiles, 4, async (tile) => {
    if (Date.now() - started > budgetMs / 2) { partial = true; return; }
    if (await readTile(tile, found)) answered++;
    else partial = true;
  });
  if (answered === 0) return null;

  const candidates = candidatesFrom(country, found);
  candidates.sort((a, b) => (GROUP_ORDER[a.summary.group] ?? 4) - (GROUP_ORDER[b.summary.group] ?? 4) || b.km - a.km);
  const chosen = candidates.slice(0, MAX_TRAILS);
  // The trails added by id earlier, which the squares do not reach.
  const have = new Set(chosen.map((c) => c.summary.id));
  const crowd = await crowdTrails(country);
  const extra = [...crowd.keys()].filter((id) => !have.has(id) && !isSectionId(id));
  if (extra.length) chosen.push(...candidatesFrom(country, await readByIds(country, extra), true));
  // And the popular parts of long trails, from their own table.
  if ([...crowd.keys()].some(isSectionId)) {
    chosen.push(...sectionCandidates(country, (await sectionsOfCountry(country)).filter((s) => crowd.has(s.id))));
  }

  const trails = await trailsFrom(chosen, Object.fromEntries(crowd));
  const regions = regionInfo(country, new Set(trails.flatMap((t) => t.regions)));
  return { country, version: STORED_VERSION, builtAt: Date.now(), partial, regions, trails };
}

// ── Remembering ──────────────────────────────────────────────────────────────

const memory = new Map<string, CountryTrailList>();
const inFlight = new Map<string, Promise<CountryTrailList | null>>();
let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `Country trails cache disabled: table public.country_trails is missing. ` +
          `Run the country_trails section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`Country trails cache ${where} failed:`, e);
}

function isFresh(list: CountryTrailList | null | undefined): list is CountryTrailList {
  if (!list || list.version !== STORED_VERSION) return false;
  return Date.now() - list.builtAt < (list.partial ? PARTIAL_FRESH_MS : FRESH_MS);
}

async function readTable(country: string): Promise<CountryTrailList | null> {
  const client = serviceClient();
  if (!client || tableMissing) return null;
  try {
    const { data, error } = await client
      .from('country_trails')
      .select('country, climate_version, built_at, partial, trails')
      .eq('country', country)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      country: data.country,
      version: data.climate_version,
      builtAt: new Date(data.built_at).getTime(),
      partial: !!data.partial,
      // `trails` holds the list and its areas together, so the table needs no
      // new column for them.
      regions: data.trails?.regions ?? [],
      trails: data.trails?.trails ?? [],
    };
  } catch (e) {
    noteError('read', e);
    return null;
  }
}

async function writeTable(list: CountryTrailList): Promise<void> {
  const client = serviceClient();
  if (!client || tableMissing) return;
  try {
    const { error } = await client.from('country_trails').upsert({
      country: list.country,
      climate_version: list.version,
      built_at: new Date(list.builtAt).toISOString(),
      partial: list.partial,
      good_by_month: goodByMonth(list),
      trails: { regions: list.regions, trails: list.trails },
    });
    if (error) throw error;
  } catch (e) {
    noteError('write', e);
  }
}

export function goodByMonth(list: CountryTrailList): number[] {
  return Array.from({ length: 12 }, (_, m) => list.trails.filter((t) => t.months[m] === 'good').length);
}

// The country's list from memory or the table, or null when it has not been
// built (or is out of date). Cheap; never builds.
export async function storedCountryTrails(country: string): Promise<CountryTrailList | null> {
  const mem = memory.get(country);
  if (isFresh(mem)) return mem;
  const stored = await readTable(country);
  if (isFresh(stored)) {
    memory.set(country, stored);
    return stored;
  }
  return null;
}

// The list, building it if need be. Null when it could not be built.
export async function countryTrails(country: string): Promise<CountryTrailList | null> {
  const stored = await storedCountryTrails(country);
  if (stored) return stored;
  const running = inFlight.get(country);
  if (running) return running;
  const work = (async () => {
    try {
      const list = await build(country);
      if (list) {
        memory.set(country, list);
        await writeTable(list);
      }
      return list;
    } finally {
      inFlight.delete(country);
    }
  })();
  inFlight.set(country, work);
  return work;
}

// How many trails are good in each month, for every country already built —
// so the month-first list can say "23 מסלולים" beside a country it knows.
export async function builtCountryCounts(): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  for (const [c, list] of memory) if (isFresh(list)) out[c] = goodByMonth(list);
  const client = serviceClient();
  if (!client || tableMissing) return out;
  try {
    const { data, error } = await client
      .from('country_trails')
      .select('country, climate_version, good_by_month')
      .eq('climate_version', STORED_VERSION);
    if (error) throw error;
    for (const row of data ?? []) if (!out[row.country] && Array.isArray(row.good_by_month)) out[row.country] = row.good_by_month;
  } catch (e) {
    noteError('counts', e);
  }
  return out;
}

// Adds trails to a country's stored list by id (see "Trails added by id"),
// and returns the list. Trails it has already, or that are not in the
// country, are skipped.
// `names`: for a path mapped without a name, what to call it instead.
export async function addTrails(country: string, ids: number[], names: Record<number, string | null> = {}): Promise<CountryTrailList | null> {
  const list = await countryTrails(country);
  if (!list) return null;
  const have = new Set(list.trails.map((t) => t.id));
  const missing = [...new Set(ids)].filter((id) => !have.has(id));
  if (!missing.length) return list;
  const added = await trailsFrom(candidatesFrom(country, await readByIds(country, missing), true), names);
  if (!added.length) return list;
  const trails = [...list.trails, ...added];
  const updated: CountryTrailList = {
    ...list,
    trails,
    regions: regionInfo(country, new Set(trails.flatMap((t) => t.regions))),
  };
  memory.set(country, updated);
  await writeTable(updated);
  return updated;
}

// The popular parts of long trails (trailCrowd/sections.ts) as candidates:
// from the points kept along each, like a route's outline.
function sectionCandidates(country: string, sections: TrailSection[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of sections) {
    const inside = s.samples.filter(([lon, lat]) => iso1A2Code([lon, lat]) === country);
    if (!inside.length) continue;
    out.push({
      summary: { type: 'relation', id: s.id, name: s.name, group: 'SEC', linear: 'yes' },
      km: s.km,
      crossesBorder: inside.length < s.samples.length,
      regions: regionsAlong(country, inside),
      samples: evenly(inside, SAMPLES).map(([lon, lat]) => ({ lon, lat, ele: null })),
      byId: true,
      section: { parent: s.parentId, parentName: s.parentName, parentGroup: s.parentGroup },
    });
  }
  return out;
}

// Adds popular parts of long trails to a country's stored list (or puts back
// the ones it has, renamed or moved), and returns the list.
export async function addSections(country: string, sections: TrailSection[]): Promise<CountryTrailList | null> {
  const list = await countryTrails(country);
  if (!list || !sections.length) return list;
  const ids = new Set(sections.map((s) => s.id));
  const added = await trailsFrom(sectionCandidates(country, sections));
  const trails = [...list.trails.filter((t) => !ids.has(t.id)), ...added];
  const updated: CountryTrailList = { ...list, trails, regions: regionInfo(country, new Set(trails.flatMap((t) => t.regions))) };
  memory.set(country, updated);
  await writeTable(updated);
  return updated;
}

// Builds a country's list again now, whatever its age — after the hiker
// metrics found trails for it (scripts/collectCrowd.mjs CROWD_REBUILD=1), or
// with a longer budget when a partial list is collected for its landscape
// (scripts/collectLandscape.mjs --build).
export async function rebuildCountryTrails(country: string, budgetMs?: number): Promise<CountryTrailList | null> {
  const list = await build(country, budgetMs);
  if (list) {
    memory.set(country, list);
    await writeTable(list);
  }
  return list;
}
