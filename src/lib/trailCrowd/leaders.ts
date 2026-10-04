// The leading trails of every country collected so far, for the country
// picker (the names under a country) and the stars on the map. A country's
// own list picks its leaders itself, from the same function (leadersOf).

import { serviceClient } from '../supabaseService';
import { storedCountryTrails, type CountryTrail } from '../countryTrails';
import { CROWD_VERSION, leadersOf, type CrowdSummary } from './score';
import { crowdForCountry } from './store';

export type LeaderTrail = Pick<CountryTrail, 'id' | 'name' | 'name_en' | 'group' | 'linear' | 'multiDay' | 'km' | 'lat' | 'lon'> & {
  crowd: CrowdSummary;
};

export interface CountryLeaders {
  day: LeaderTrail[];
  long: LeaderTrail[];
}

const MEMORY_MS = 10 * 60_000;
let memo: { at: number; leaders: Record<string, CountryLeaders> } | null = null;

// The countries with at least one trail that has numbers.
async function collectedCountries(): Promise<string[]> {
  const db = serviceClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('trail_crowd')
      .select('country')
      .eq('crowd_version', CROWD_VERSION)
      .or('rating_count.gt.0,pageviews.gt.0');
    if (error) throw error;
    return [...new Set((data ?? []).map((r) => r.country as string))];
  } catch (e) {
    console.error('Leading trails: countries could not be read:', e);
    return [];
  }
}

export async function allLeaders(): Promise<Record<string, CountryLeaders>> {
  if (memo && Date.now() - memo.at < MEMORY_MS) return memo.leaders;
  const out: Record<string, CountryLeaders> = {};
  for (const country of await collectedCountries()) {
    const [list, crowd] = await Promise.all([storedCountryTrails(country), crowdForCountry(country)]);
    if (!list || !crowd) continue;
    const trails = list.trails.map((t) => ({ ...t, crowd: crowd.get(t.id) }));
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
