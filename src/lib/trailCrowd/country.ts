// Collecting "מה אומרים מטיילים" for a whole country, in steps that each fit
// in one request (the admin's screen calls them in turn, and
// scripts/collectCrowd.mjs runs them straight through):
//
//   1. find    Komoot's "best hikes" pages for the country and its areas
//              (a few dozen Tavily searches)
//   2. read    those pages: each area's most walked routes, with their lines
//              (one Tavily credit per five pages), tied to our trails by
//              where they go — free
//   3. finish  Wikipedia reads for the trails worth asking about, and a row
//              for every trail of the country: one that no page listed is
//              stored empty, and shows "אין מספיק מידע"
//
// No search is made for a single trail. Popularity is lopsided: the pages
// list the few trails most people walk, and a search for each of the
// hundreds of others would mostly find nothing (see README).

import type { CountryTrail, CountryTrailList } from '../countryTrails';
import { countryEnglish } from '../trailInfo/sources';
import { findGuides, readGuides, type KomootRoute } from './komoot';
import { matchRoutes, trailLines } from './match';
import { pageviewsFor } from './collect';
import { writeCrowdRows } from './store';
import type { CrowdData, CrowdSource } from './score';

// The country's areas by the names Komoot would use.
function areaNames(list: CountryTrailList): string[] {
  return [...new Set(list.regions.map((r) => r.latin ?? r.name).filter((n) => /[a-z]/i.test(n)))];
}

export async function findCountryGuides(list: CountryTrailList): Promise<string[] | null> {
  return findGuides(countryEnglish(list.country), areaNames(list));
}

// The trails' lines are kept between calls: a run reads its pages over
// several requests, and the lines are the same for all of them.
let linesMemo: { country: string; at: number; lines: Awaited<ReturnType<typeof trailLines>> } | null = null;

async function linesFor(list: CountryTrailList) {
  if (linesMemo?.country === list.country && Date.now() - linesMemo.at < 30 * 60_000) return linesMemo.lines;
  const lines = await trailLines(list.trails);
  linesMemo = { country: list.country, at: Date.now(), lines };
  return lines;
}

// Reads some pages and returns, for each of our trails found on them, the
// numbers of its most walked route. Plain JSON, to be merged by the caller.
export async function readAndMatch(
  list: CountryTrailList,
  urls: string[]
): Promise<{ routes: number; matches: Record<number, CrowdSource> }> {
  const routes: KomootRoute[] = await readGuides(urls);
  const lines = await linesFor(list);
  return { routes: routes.length, matches: Object.fromEntries(matchRoutes(routes, lines)) };
}

export function mergeMatches(into: Record<number, CrowdSource>, more: Record<number, CrowdSource>): void {
  for (const [id, s] of Object.entries(more)) {
    const prev = into[Number(id)];
    if (!prev || (prev.hikers ?? 0) < (s.hikers ?? 0)) into[Number(id)] = s;
  }
}

// Wikipedia is asked only about the trails that could have an article: the
// long-distance and regional paths, and the trails a page listed. A local
// path no site lists has none (in Greece, 14 of 600 names appear anywhere on
// Wikipedia at all).
export function wikiCandidates(list: CountryTrailList, matches: Record<number, CrowdSource>): CountryTrail[] {
  return list.trails.filter((t) => t.group !== 'LOC' || matches[t.id]);
}

export async function pageviewsOf(trails: CountryTrail[]): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  for (let i = 0; i < trails.length; i += 4) {
    const views = await Promise.all(trails.slice(i, i + 4).map((t) => pageviewsFor(t).catch(() => 0)));
    trails.slice(i, i + 4).forEach((t, k) => { out[t.id] = views[k]; });
  }
  return out;
}

export async function saveCountry(
  list: CountryTrailList,
  matches: Record<number, CrowdSource>,
  views: Record<number, number>
): Promise<boolean> {
  const at = new Date().toISOString();
  const rows: CrowdData[] = list.trails.map((t) => ({
    id: t.id,
    pageviews: views[t.id] ?? 0,
    sources: matches[t.id] ? [matches[t.id]] : [],
    fetchedAt: at,
  }));
  return writeCrowdRows(list.country, rows);
}
