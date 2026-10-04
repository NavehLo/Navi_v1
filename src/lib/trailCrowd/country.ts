// Collecting "מה אומרים מטיילים" for a whole country, in steps that each fit
// in one request (the admin's screen calls them in turn, and
// scripts/collectCrowd.mjs runs them straight through):
//
//   1. find    Komoot's "best hikes" pages for the country and its areas
//              (a few dozen Tavily searches)
//   2. read    those pages: each area's most walked routes, with their lines
//              (read straight from Komoot — free), tied to our trails by
//              where they go; a route on none of them leads to the trail
//              under it, which is added to the list (discover.ts) — free
//   3. finish  Wikipedia reads for the trails worth asking about, and a row
//              for every trail of the country: one that no page listed is
//              stored empty, and shows "אין מספיק מידע"
//
// No search is made for a single trail. Popularity is lopsided: the pages
// list the few trails most people walk, and a search for each of the
// hundreds of others would mostly find nothing (see README).

import { iso1A2Code } from '@rapideditor/country-coder';
import { addTrails, type CountryTrail, type CountryTrailList } from '../countryTrails';
import { discoverTrails } from './discover';
import { countryEnglish } from '../trailInfo/sources';
import { findGuides, readGuides, type KomootRoute } from './komoot';
import { matchRoutes, routeKm, trailLines, trailsOf } from './match';
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

// Reads some pages and returns, for each trail found on them, the numbers of
// its most walked route — our list's trails, and the trails under routes on
// none of them, which are not in the list yet (withAddedTrails adds them).
// Plain JSON, to be merged by the caller. `deadline`: see discoverTrails.
export async function readAndMatch(
  list: CountryTrailList,
  urls: string[],
  opts: { deadline?: number } = {},
): Promise<{ routes: number; matches: Record<number, CrowdSource> }> {
  const routes: KomootRoute[] = await readGuides(urls);
  return { routes: routes.length, matches: await matchAll(list, routes, opts) };
}

export async function matchAll(
  list: CountryTrailList,
  all: KomootRoute[],
  opts: { deadline?: number } = {},
): Promise<Record<number, CrowdSource>> {
  // A search for a country's areas also finds pages about places of the same
  // name elsewhere (Malta's searches: Ireland, Bohemia, Australia). Only the
  // routes that pass through the country count.
  const routes = all.filter((r) => r.points.some(([lat, lon], i) => i % 10 === 0 && iso1A2Code([lon, lat]) === list.country));
  const lines = await linesFor(list);
  const km = new Map(lines.map((l) => [l.id, l.km]));
  // A route that runs along none of the list's trails, or only along one far
  // longer than itself (the Cares gorge walk, on the multi-day "Anillo de
  // Picos"), is looked under: the trail it actually is may be a local path
  // the list does not have.
  const settled: KomootRoute[] = [];
  const unsettled: KomootRoute[] = [];
  for (const r of routes) {
    const on = trailsOf(r, lines);
    if (on.length && Math.min(...on.map((id) => km.get(id) ?? Infinity)) <= routeKm(r) * 2) settled.push(r);
    else unsettled.push(r);
  }
  const matches = matchRoutes(settled, lines);
  const found = await discoverTrails(unsettled, new Set(list.trails.map((t) => t.id)), opts);
  // The list's trails and the ones found compete: the shortest wins.
  for (const [id, s] of matchRoutes(unsettled, [...lines, ...found])) {
    const prev = matches.get(id);
    if (!prev || (prev.hikers ?? 0) < (s.hikers ?? 0)) matches.set(id, s);
  }
  return Object.fromEntries(matches);
}

// The list with the trails found under the routes added to it.
export async function withAddedTrails(list: CountryTrailList, matches: Record<number, CrowdSource>): Promise<CountryTrailList> {
  const have = new Set(list.trails.map((t) => t.id));
  const missing = Object.keys(matches).map(Number).filter((id) => !have.has(id));
  if (!missing.length) return list;
  // A path mapped without a name takes the name of the route that found it.
  const names = Object.fromEntries(missing.map((id) => [id, matches[id].route ?? null]));
  const updated = (await addTrails(list.country, missing, names)) ?? list;
  linesMemo = null;
  return updated;
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
