import { forEachCell } from './climateGrid';
import { rateMonths, CLIMATE_VERSION } from './climate';

// "Where is it in season in May?" — every country, every month, from the
// climate grid alone. Server only.
//
// Each land cell is rated as if a four-hour day walk started on it, at the
// cell's own average height, by the same rateMonths the trail card uses. A
// country's share of good cells in a month says how much of it is walking
// weather then. It does not say how many marked trails lie in those parts:
// that is only known once the country's trail list has been built (see
// countryTrails.ts), and the panel says so.
//
// The pass rates a few hundred thousand cells, a second or two, once per
// server instance; the answer is small and also cached by the CDN.

const REFERENCE_HOURS = 4;
// A country is listed for a month when at least this share of it is good, or
// — for the small ones a few cells cover — at least MIN_CELLS cells.
const MIN_SHARE = 0.05;
const MIN_CELLS = 3;

export interface CountryMonth {
  country: string;                           // ISO 3166-1 alpha-2
  share: number;                             // 0..1 of the country's land that is good
  goodCells: number;
  bbox: [number, number, number, number];    // west, south, east, north of the good parts
}

export interface CountriesByMonth {
  version: number;
  months: CountryMonth[][];                  // 12 lists, the biggest share first
}

let cached: CountriesByMonth | null = null;

export function countriesByMonth(): CountriesByMonth {
  if (cached) return cached;
  const totals = new Map<string, number>();
  // Per month, per country: count and the box round the good cells.
  const good: Map<string, { n: number; bbox: [number, number, number, number] }>[] =
    Array.from({ length: 12 }, () => new Map());

  forEachCell((lat, lon, country, year) => {
    if (!country) return;
    totals.set(country, (totals.get(country) ?? 0) + 1);
    const months = year();
    const verdicts = rateMonths({ low: months, high: months, lat, hours: REFERENCE_HOURS });
    verdicts.forEach((v, m) => {
      if (v.rating !== 'good') return;
      const entry = good[m].get(country);
      if (!entry) {
        good[m].set(country, { n: 1, bbox: [lon, lat, lon, lat] });
      } else {
        entry.n++;
        const b = entry.bbox;
        if (lon < b[0]) b[0] = lon;
        if (lat < b[1]) b[1] = lat;
        if (lon > b[2]) b[2] = lon;
        if (lat > b[3]) b[3] = lat;
      }
    });
  });

  const months = good.map((byCountry) =>
    [...byCountry.entries()]
      .map(([country, { n, bbox }]) => ({ country, share: n / (totals.get(country) ?? n), goodCells: n, bbox }))
      .filter((c) => c.share >= MIN_SHARE || c.goodCells >= MIN_CELLS)
      .map((c) => ({
        ...c,
        share: Math.round(c.share * 100) / 100,
        // Half a cell out on each side: the box is round cell centres.
        bbox: [c.bbox[0] - 0.125, c.bbox[1] - 0.125, c.bbox[2] + 0.125, c.bbox[3] + 0.125] as CountryMonth['bbox'],
      }))
      .sort((a, b) => b.share - a.share || b.goodCells - a.goodCells)
  );

  cached = { version: CLIMATE_VERSION, months };
  return cached;
}
