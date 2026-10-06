// The leading trails of every country collected so far, for the country
// picker (the names under a country) and the stars on the map. A country's
// own list picks its leaders itself, from the same function (leadersOf).

import { serviceClient } from '../supabaseService';
import { countryTrails, type CountryTrail } from '../countryTrails';
import { CROWD_VERSION, crowdSummaries, leadersOf, type CrowdData, type CrowdSummary } from './score';
import { crowdRows } from './store';

export type LeaderTrail = Pick<CountryTrail, 'id' | 'name' | 'name_en' | 'group' | 'linear' | 'multiDay' | 'km' | 'lat' | 'lon'> & {
  crowd: CrowdSummary;
};

export interface CountryLeaders {
  day: LeaderTrail[];
  long: LeaderTrail[];
}

const MEMORY_MS = 10 * 60_000;
let memo: { at: number; leaders: Record<string, CountryLeaders> } | null = null;

// The countries with at least one trail that has numbers. Read a page at a
// time: the API answers at most 1,000 rows, and with more rows than that the
// later countries went missing (Switzerland, Britain, Ireland, Iceland).
async function collectedCountries(): Promise<string[]> {
  const db = serviceClient();
  if (!db) return [];
  try {
    const out = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from('trail_crowd')
        .select('country')
        .eq('crowd_version', CROWD_VERSION)
        .or('rating_count.gt.0,pageviews.gt.0')
        .order('country')
        .order('trail_id')
        .range(from, from + 999);
      if (error) throw error;
      for (const r of data ?? []) out.add(r.country as string);
      if ((data?.length ?? 0) < 1000) break;
    }
    return [...out];
  } catch (e) {
    console.error('Leading trails: countries could not be read:', e);
    return [];
  }
}

// Every collected country's list, each trail with its summary and its stored
// row — for the leaders here and the world ranking (ranking.ts).
export interface CollectedCountry {
  country: string;
  trails: Array<CountryTrail & { crowd?: CrowdSummary; row?: CrowdData }>;
}

export async function collectedCountryLists(): Promise<CollectedCountry[]> {
  const out: CollectedCountry[] = [];
  for (const country of await collectedCountries()) {
    // Built if need be (a new list format rebuilds every country): a country
    // skipped here would be missing from the cache for its whole lifetime.
    const list = await countryTrails(country);
    if (!list) continue;
    // Only the trails of the current list: one that has left it since (a
    // rebuilt list) must not count in the comparison.
    const ids = new Set(list.trails.map((t) => t.id));
    const rows = (await crowdRows(country)).filter((r) => ids.has(r.id));
    if (!rows.length) continue;
    const crowd = crowdSummaries(rows);
    const byId = new Map(rows.map((r) => [r.id, r]));
    out.push({ country, trails: list.trails.map((t) => ({ ...t, crowd: crowd.get(t.id), row: byId.get(t.id) })) });
  }
  return out;
}

export async function allLeaders(): Promise<Record<string, CountryLeaders>> {
  if (memo && Date.now() - memo.at < MEMORY_MS) return memo.leaders;
  const out: Record<string, CountryLeaders> = {};
  for (const { country, trails } of await collectedCountryLists()) {
    const { day, long } = leadersOf(trails);
    const slim = (t: (typeof trails)[number]): LeaderTrail => ({
      id: t.id, name: t.name, name_en: t.name_en, group: t.group, linear: t.linear,
      multiDay: t.multiDay, km: t.km, lat: t.lat, lon: t.lon, crowd: t.crowd!,
    });
    if (day.length || long.length) out[country] = { day: day.map(slim), long: long.map(slim) };
  }
  memo = { at: Date.now(), leaders: out };
  return out;
}
