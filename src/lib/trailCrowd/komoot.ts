// Komoot's "best hikes in <area>" pages.
//
// Each page lists the area's ten most walked routes, already ranked, each
// with its rating, the number of ratings and the number of hikers — and its
// line, encoded in the URL of the route's map picture. That line is what ties
// a Komoot route to one of our trails (match.ts): by where it goes, not by a
// name in another language.
//
// The pages are found with Tavily (a search is one credit) and read straight
// from Komoot, like any visitor's browser: one page at a time, the numbers
// taken from the data the page carries for its own list. Reading them through
// Tavily was tried first — it returned the list in one of two layouts at
// random, one of them without the lines (2026-10).
//
// Why Komoot alone: AllTrails and Wikiloc refuse to serve their pages to a
// program, and a search returns only a fragment of their lists, mostly
// without numbers. Why by area and not by trail: a few dozen pages cover a
// country's popular trails, against a search for each of its hundreds of
// trails, most of which no site has heard of.

import { tavilySearch } from '../trailInfo/sources';

export interface KomootRoute {
  guide: string;            // the page it was listed on
  rank: number;             // its place on that page, 1 = most popular
  name: string;
  rating: number | null;    // out of 5
  ratings: number;
  hikers: number;
  km: number | null;
  points: Array<[number, number]>; // [lat, lon]
}

// "/guide/18691/hiking-in-the-crete", in any of its languages, as one URL.
const GUIDE = /komoot\.com\/(?:[a-z]{2}-[a-z]{2}\/)?guide\/(\d+)\/([a-z0-9-]+)/i;
// Walking pages only: not cycling, castles, waterfalls, "attractions".
const WALKING = /hik|walk/i;

export function guideUrl(url: string): string | null {
  const m = GUIDE.exec(url);
  return m && WALKING.test(m[2]) ? `https://www.komoot.com/guide/${m[1]}/${m[2].toLowerCase()}` : null;
}

// The pages for a country: two searches for each of its areas and two for
// the whole. Null when no search could be made at all (no key, no credit).
export async function findGuides(country: string, areas: string[]): Promise<string[] | null> {
  const queries = [
    `best hikes in ${country}`,
    `hiking trails ${country}`,
    ...areas.flatMap((a) => [`best hikes in ${a}, ${country}`, `hiking around ${a} ${country}`]),
  ];
  const found = new Set<string>();
  let answered = 0;
  for (let i = 0; i < queries.length; i += 4) {
    const batch = await Promise.all(
      queries.slice(i, i + 4).map((q) => tavilySearch(q, { domains: ['komoot.com'], max: 10 }))
    );
    for (const results of batch) {
      if (!results) continue;
      answered++;
      for (const r of results) {
        const u = guideUrl(r.url);
        if (u) found.add(u);
      }
    }
  }
  return answered ? [...found] : null;
}

// Google's encoded polyline, at Komoot's precision of 1e-4 degrees.
export function decodeLine(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    const v: number[] = [];
    for (let k = 0; k < 2; k++) {
      let shift = 0, r = 0, b: number;
      do {
        if (i >= s.length) return out;
        b = s.charCodeAt(i++) - 63;
        r |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32);
      v.push(r & 1 ? ~(r >> 1) : r >> 1);
    }
    lat += v[0];
    lon += v[1];
    out.push([lat / 1e4, lon / 1e4]);
  }
  return out;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; Navi-Trail-App/1.0; naveh@hamarag.com)';

// The routes of one page, from the data it carries for its list
// ("discoverTours": id, name, distance, map picture, visitors, ratings).
export function parseGuide(url: string, html: string): KomootRoute[] {
  const text = html.replace(/\\"/g, '"');
  const start = text.indexOf('"discoverTours":{"items":[');
  if (start < 0) return [];
  const body = text.slice(start);
  // A route's id is a number for Komoot's own suggestions and a code
  // ("e945461356") for a hiker's published one; Spain's pages are mostly the
  // second. What follows the name tells a route from anything else so shaped.
  const heads = [...body.matchAll(/\{"id":"([0-9a-z]+)","status":"public","name":"((?:[^"\\]|\\.)*)"(?=,"(?:source|nameTranslationMetadata)")/g)];
  const routes: KomootRoute[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < heads.length && routes.length < 10; k++) {
    const id = heads[k][1];
    if (seen.has(id)) continue;
    const item = body.slice(heads[k].index, heads[k + 1]?.index ?? heads[k].index + 20_000);
    const line = /"vectorMapImage":\{"src":"https:\/\/tourpic-vector\.maps\.komoot\.net\/r\/big\/([^/"]+)\//.exec(item)?.[1];
    const visitors = /"visitors":(\d+)/.exec(item)?.[1];
    if (!line || !visitors) continue;
    let points: Array<[number, number]>;
    try { points = decodeLine(decodeURIComponent(line)); } catch { continue; }
    if (points.length < 2) continue;
    seen.add(id);
    const count = Number(/"ratingCount":(\d+)/.exec(item)?.[1] ?? 0);
    const score = Number(/"ratingScore":([\d.]+)/.exec(item)?.[1] ?? NaN);
    const distance = Number(/"distance":([\d.]+)/.exec(item)?.[1] ?? NaN);
    routes.push({
      guide: url,
      rank: routes.length + 1,
      name: heads[k][2].replace(/\\(.)/g, '$1'),
      rating: count > 0 && score > 0 ? Math.round(score * 10) / 10 : null,
      ratings: count,
      hikers: Number(visitors),
      km: Number.isFinite(distance) ? Math.round(distance / 100) / 10 : null,
      points,
    });
  }
  return routes;
}

// Reads the pages, two at a time, gently. A page that does not answer is
// skipped.
export async function readGuides(urls: string[]): Promise<KomootRoute[]> {
  const out: KomootRoute[] = [];
  for (let i = 0; i < urls.length; i += 2) {
    const done = await Promise.all(urls.slice(i, i + 2).map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return [];
        return parseGuide(url, await res.text());
      } catch (e) {
        console.error('Komoot page could not be read:', url, e);
        return [];
      }
    }));
    out.push(...done.flat());
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}
