// "לפי דירוג" (in "מסלולים בעולם"): every world trail Komoot has numbers for, from every
// country collected so far, with its popularity score (popularityScore in
// score.ts — the only place it is computed). Highest first; the reader's
// filters and other orders are applied on the device.

import type { CountryTrail } from '../countryTrails';
import type { LandscapeSummary } from '../landscape';
import { trailLandscapeOfCountry } from '../landscapeData';
import { byRank, komootOf, popularityScore, type KomootNumbers } from './score';
import { collectedCountryLists } from './leaders';

export type RankedTrail = Pick<CountryTrail, 'id' | 'name' | 'name_en' | 'group' | 'linear' | 'multiDay' | 'km' | 'months'> & {
  country: string;
  komoot: KomootNumbers;
  score: number;
  landscape?: LandscapeSummary;
};

export interface Ranking {
  trails: RankedTrail[];
  // The relief bins the trails' landscape lines need; null when none has one.
  reliefBins: number[] | null;
}

const MEMORY_MS = 10 * 60_000;
let memo: { at: number; ranking: Ranking } | null = null;

export async function allRanked(): Promise<Ranking> {
  if (memo && Date.now() - memo.at < MEMORY_MS) return memo.ranking;
  const byId = new Map<number, RankedTrail & { routes: string }>();
  let reliefBins: number[] | null = null;

  for (const { country, trails } of await collectedCountryLists()) {
    const land = trailLandscapeOfCountry(country);
    if (land) reliefBins ??= land.reliefBins;
    for (const t of trails) {
      const komoot = t.row ? komootOf(t.row.sources) : null;
      if (!komoot) continue;
      const ranked = {
        id: t.id, name: t.name, name_en: t.name_en, group: t.group, linear: t.linear,
        multiDay: t.multiDay, km: t.km, months: t.months, country,
        komoot, score: popularityScore(komoot),
        ...(land?.trails[t.id] ? { landscape: land.trails[t.id] } : {}),
        routes: t.row!.sources.filter((s) => s.site === 'Komoot').map((s) => `${s.route ?? s.url}|${s.hikers ?? 0}|${s.count}`).sort().join('#'),
      };
      // A trail across a border is listed by both countries: once, where it
      // scores higher (the longer part where equal).
      const known = byId.get(t.id);
      if (!known || ranked.score > known.score || (ranked.score === known.score && ranked.km > known.km)) byId.set(t.id, ranked);
    }
  }

  // One Komoot route matched to two of our trails (a path and a stretch of
  // a longer one) would show the same numbers twice: kept once, on the
  // shorter trail — the one the route fits, as in the matching (match.ts).
  const byRoute = new Map<string, RankedTrail & { routes: string }>();
  for (const t of byId.values()) {
    const known = byRoute.get(t.routes);
    if (!known || t.km < known.km) byRoute.set(t.routes, t);
  }

  const trails = [...byRoute.values()]
    .map(({ routes: _routes, ...t }) => t) // eslint-disable-line @typescript-eslint/no-unused-vars
    .sort(byRank('score'));
  memo = { at: Date.now(), ranking: { trails, reliefBins } };
  return memo.ranking;
}
