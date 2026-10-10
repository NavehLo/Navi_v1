// "מפת חום של מטיילים": every trail Komoot counts hikers on, in every
// collected country, weighted by heatWeight (lib/trailHeat.ts). The point is
// the one the country's list keeps for the map (a point on the trail); the
// hikers are Komoot's, from the trail's stored row. Close up the same trails
// are drawn one by one, and a tap opens the trail — hence the name and kind.

import { heatWeight } from '../trailHeat';
import type { CountryTrail } from '../countryTrails';
import { collectedCountryLists } from './leaders';

export type HeatTrail = Pick<CountryTrail, 'id' | 'name' | 'name_en' | 'group' | 'linear' | 'lat' | 'lon'> & {
  country: string;
  hikers: number;
  // 0–1, what the trail adds to the heat.
  w: number;
};

export interface HeatData {
  trails: HeatTrail[];
  // The countries that have at least one trail with hikers.
  countries: string[];
}

const MEMORY_MS = 10 * 60_000;
let memo: { at: number; data: HeatData } | null = null;

export async function heatPoints(): Promise<HeatData> {
  if (memo && Date.now() - memo.at < MEMORY_MS) return memo.data;
  const out: HeatTrail[] = [];
  const countries: string[] = [];
  for (const { country, trails } of await collectedCountryLists()) {
    let any = false;
    for (const t of trails) {
      const hikers = t.crowd?.hikers ?? 0;
      const w = heatWeight(hikers);
      if (!w || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
      out.push({ id: t.id, name: t.name, name_en: t.name_en, group: t.group, linear: t.linear, lat: t.lat, lon: t.lon, country, hikers, w });
      any = true;
    }
    if (any) countries.push(country);
  }
  const data = { trails: out, countries: countries.sort() };
  memo = { at: Date.now(), data };
  return data;
}
