import { iso1A2Code } from '@rapideditor/country-coder';
import { serviceClient } from './supabaseService';
import { mercatorToLonLat } from './waymarked';
import { fetchWmt } from './wmtServer';

// Which country a world trail is in, for the search results: "Menalon Trail"
// alone does not say Greece, and two routes called "Tour du Mont" are told
// apart by where they are. Server only.
//
// Waymarked Trails' search returns names without a location. Its /segments
// listing gives a simplified outline of any set of routes in one request;
// points sampled along it are placed in countries offline, from the borders
// that ship with country-coder (the iD editor's dataset). A trail is located
// once and remembered — in memory, and in public.trail_country when the
// table exists.

// ── Geometry → countries ─────────────────────────────────────────────────────

const SAMPLES = 24;
// A country has to hold at least this share of the sampled points to be
// named, so a trail that runs along a border is not credited with the
// neighbour it brushes once.
const MIN_SHARE = 0.15;
const MAX_COUNTRIES = 3;

type Line = [number, number][];
type Geometry = { type: 'LineString'; coordinates: Line } | { type: 'MultiLineString'; coordinates: Line[] };

// ISO 3166-1 alpha-2 codes, the country holding most of the route first.
export function countriesOfGeometry(geometry: Geometry | null | undefined): string[] {
  if (!geometry) return [];
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates ?? [];
  const points = lines.flat().filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
  if (points.length === 0) return [];

  const step = Math.max(1, (points.length - 1) / (SAMPLES - 1));
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < points.length; i += step) {
    const [x, y] = points[Math.round(i)];
    const code = iso1A2Code(mercatorToLonLat(x, y));
    total++;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n], i) => i === 0 || n / total >= MIN_SHARE)
    .slice(0, MAX_COUNTRIES)
    .map(([code]) => code);
}

// ── Remembering ──────────────────────────────────────────────────────────────

const memory = new Map<number, string[]>();
const MEMORY_MAX = 5000;
let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `Trail country cache disabled: table public.trail_country is missing. ` +
          `Run the trail_country section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`Trail country cache ${where} failed:`, e);
}

function remember(id: number, countries: string[]) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(id, countries);
}

async function readTable(ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const client = serviceClient();
  if (!client || tableMissing || ids.length === 0) return out;
  try {
    const { data, error } = await client.from('trail_country').select('relation_id, countries').in('relation_id', ids);
    if (error) throw error;
    for (const row of data ?? []) out.set(Number(row.relation_id), row.countries ?? []);
  } catch (e) {
    noteError('read', e);
  }
  return out;
}

async function writeTable(rows: Array<{ relation_id: number; countries: string[] }>): Promise<void> {
  const client = serviceClient();
  if (!client || tableMissing || rows.length === 0) return;
  try {
    const { error } = await client.from('trail_country').upsert(rows);
    if (error) throw error;
  } catch (e) {
    noteError('write', e);
  }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

const WORLD = '-20037508,-20037508,20037508,20037508';

// Countries for each id that could be placed. One that could not — the
// outline service did not answer in time — is simply absent, and is tried
// again on the next search that finds it.
export async function countriesFor(ids: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const unknown: number[] = [];
  for (const id of ids) {
    const known = memory.get(id);
    if (known) out.set(id, known);
    else unknown.push(id);
  }
  if (unknown.length === 0) return out;

  const stored = await readTable(unknown);
  for (const [id, countries] of stored) { out.set(id, countries); remember(id, countries); }
  const missing = unknown.filter((id) => !stored.has(id));
  if (missing.length === 0) return out;

  const outlines = (await fetchWmt(`/list/segments?bbox=${WORLD}&relations=${missing.join(',')}`, 4000, false)) as
    | { features?: Array<{ id?: number; properties?: { id?: number }; geometry?: Geometry }> }
    | null;
  const found: Array<{ relation_id: number; countries: string[] }> = [];
  for (const f of outlines?.features ?? []) {
    const id = Number(f.id ?? f.properties?.id);
    if (!missing.includes(id)) continue;
    const countries = countriesOfGeometry(f.geometry);
    if (countries.length === 0) continue;
    out.set(id, countries);
    remember(id, countries);
    found.push({ relation_id: id, countries });
  }
  await writeTable(found);
  return out;
}
