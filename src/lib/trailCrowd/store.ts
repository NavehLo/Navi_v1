// public.trail_crowd: the raw numbers collected per world trail (collect.ts),
// read back a country at a time. Server only, service_role.

import { serviceClient } from '../supabaseService';
import { CROWD_VERSION, crowdSummaries, ratingOf, type CrowdData, type CrowdSummary } from './score';

// A country's rows change only during an admin run, and then the run itself
// clears this; a few minutes spare the table one read per list opened.
const MEMORY_MS = 5 * 60_000;
const memory = new Map<string, { at: number; rows: CrowdData[] }>();
let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) console.error(`Trail crowd disabled: table public.trail_crowd is missing. Run supabase/schema.sql. (${message})`);
    tableMissing = true;
    return;
  }
  console.error(`Trail crowd ${where} failed:`, e);
}

export function isCrowdTableMissing(): boolean {
  return tableMissing;
}

export async function crowdRows(country: string, { fresh = false } = {}): Promise<CrowdData[]> {
  const hit = memory.get(country);
  if (!fresh && hit && Date.now() - hit.at < MEMORY_MS) return hit.rows;
  const db = serviceClient();
  if (!db || tableMissing) return [];
  try {
    const { data, error } = await db
      .from('trail_crowd')
      .select('trail_id, pageviews, sources, fetched_at')
      .eq('country', country)
      .eq('crowd_version', CROWD_VERSION);
    if (error) throw error;
    const rows: CrowdData[] = (data ?? []).map((r) => ({
      id: Number(r.trail_id),
      pageviews: Number(r.pageviews) || 0,
      sources: Array.isArray(r.sources) ? r.sources : [],
      fetchedAt: r.fetched_at,
    }));
    memory.set(country, { at: Date.now(), rows });
    return rows;
  } catch (e) {
    noteError('read', e);
    return [];
  }
}

// The summaries for a country's list, or null when the country has no data
// (the list then shows nothing about hikers at all).
// `ids`: the trails of the country's current list. A trail that has left it
// since (a rebuilt list) must not count in the comparison.
export async function crowdForCountry(country: string, ids?: Set<number>): Promise<Map<number, CrowdSummary> | null> {
  const all = await crowdRows(country);
  const rows = ids ? all.filter((r) => ids.has(r.id)) : all;
  return rows.length ? crowdSummaries(rows) : null;
}

// A country's rows, all at once — a trail no page listed gets an empty row,
// so the country counts as collected and the trail shows "אין מספיק מידע".
export async function writeCrowdRows(country: string, rows: CrowdData[]): Promise<boolean> {
  const db = serviceClient();
  if (!db || tableMissing) return false;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await db.from('trail_crowd').upsert(
        rows.slice(i, i + 200).map((row) => {
          const { rating, count } = ratingOf(row.sources);
          return {
            trail_id: row.id,
            country,
            crowd_version: CROWD_VERSION,
            fetched_at: row.fetchedAt,
            pageviews: row.pageviews,
            sources: row.sources,
            rating,
            rating_count: count,
          };
        }),
        { onConflict: 'trail_id,country' }
      );
      if (error) throw error;
    }
    memory.delete(country);
    return true;
  } catch (e) {
    noteError('write', e);
    return false;
  }
}

// A country a trail's row was collected under, for the trail card, which
// knows only the trail. A trail across a border may have two; either will do.
export async function crowdCountryOf(id: number): Promise<string | null> {
  const db = serviceClient();
  if (!db || tableMissing) return null;
  try {
    const { data, error } = await db
      .from('trail_crowd')
      .select('country')
      .eq('trail_id', id)
      .eq('crowd_version', CROWD_VERSION)
      .limit(1);
    if (error) throw error;
    return data?.[0]?.country ?? null;
  } catch (e) {
    noteError('read', e);
    return null;
  }
}
