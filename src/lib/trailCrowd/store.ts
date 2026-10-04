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
export async function crowdForCountry(country: string): Promise<Map<number, CrowdSummary> | null> {
  const rows = await crowdRows(country);
  return rows.length ? crowdSummaries(rows) : null;
}

export async function writeCrowd(country: string, row: CrowdData): Promise<boolean> {
  const db = serviceClient();
  if (!db || tableMissing) return false;
  try {
    const { rating, count } = ratingOf(row.sources);
    const { error } = await db.from('trail_crowd').upsert({
      trail_id: row.id,
      country,
      crowd_version: CROWD_VERSION,
      fetched_at: row.fetchedAt,
      pageviews: row.pageviews,
      sources: row.sources,
      rating,
      rating_count: count,
    }, { onConflict: 'trail_id,country' });
    if (error) throw error;
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
