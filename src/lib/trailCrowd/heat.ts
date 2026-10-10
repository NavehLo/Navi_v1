// "מפת חום של מטיילים": one point per trail that Komoot counts hikers on, in
// every collected country, weighted by heatWeight (lib/trailHeat.ts). The
// point is the one the country's list keeps for the map (a point on the
// trail); the hikers are Komoot's, from the trail's stored row.

import { heatWeight } from '../trailHeat';
import { collectedCountryLists } from './leaders';

export interface HeatData {
  // [lon, lat, weight 0–1]
  points: Array<[number, number, number]>;
  // The countries that have at least one point.
  countries: string[];
}

const MEMORY_MS = 10 * 60_000;
let memo: { at: number; data: HeatData } | null = null;

export async function heatPoints(): Promise<HeatData> {
  if (memo && Date.now() - memo.at < MEMORY_MS) return memo.data;
  const points: HeatData['points'] = [];
  const countries: string[] = [];
  for (const { country, trails } of await collectedCountryLists()) {
    let any = false;
    for (const t of trails) {
      const w = heatWeight(t.crowd?.hikers ?? 0);
      if (!w || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
      points.push([t.lon, t.lat, w]);
      any = true;
    }
    if (any) countries.push(country);
  }
  const data = { points, countries: countries.sort() };
  memo = { at: Date.now(), data };
  return data;
}
