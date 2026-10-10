import { NextResponse, after } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { fetchWmt } from '../../../lib/wmtServer';
import { lookupEnglish, saveEnglish, searchEnglish } from '../../../lib/trailNameCache';
import { englishFromTags, needsEnglish } from '../../../lib/trailNames';
import { wmtParents, wmtStages, type WmtElevation, type WmtRouteDetails, type WmtRouteSummary } from '../../../lib/waymarked';
import { countriesFor } from '../../../lib/trailCountry';
import { cutElevation, cutSection, sectionById } from '../../../lib/trailCrowd/sections';

// Proxy for the Waymarked Trails API (marked hiking routes from OSM, worldwide).
// Four reads, all GET:
//   ?bbox=minx,miny,maxx,maxy   routes crossing a Web Mercator box (metres)
//   ?q=<text>                   routes by name, for the search box
//   ?id=<relation id>           one route: name, length, geometry
//   ?id=<relation id>&elevation=1   DEM elevation samples along its ways
//   ?id=<negative id>           a popular part of a long trail
//                               (lib/trailCrowd/sections.ts): the long trail's
//                               ways between its two ends, in the same shape,
//                               with the long trail as its parent — and so
//                               with &elevation=1 and &stages=1 likewise
//   ?id=<relation id>&stages=1      a long trail's stages, and the long
//                                   trails it is itself a stage of — a few
//                                   hundred bytes where the details are
//                                   megabytes, for the open trail's card
//     &climb=0                      without climb and descent: only the order,
//                                   for stepping from a stage to the next
//
// It goes through the server rather than straight from the browser for the
// same reasons the Overpass calls do: a User-Agent that says who is asking, a
// per-IP limit so one enthusiastic clicker cannot hammer a community service,
// and a cache — the details of a national trail are several megabytes.
//
// Same tri-state contract as /api/pois: 'ok' with nothing in it is an answer
// about this spot; 'unavailable' and 'rate-limited' mean we could not ask.
type Status = 'ok' | 'unavailable' | 'rate-limited';

const MAX_LIST = 12;
const MAX_SEARCH = 8;

function parseBbox(raw: string | null): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minx, miny, maxx, maxy] = parts;
  // A click box is a few hundred metres; anything approaching a country is
  // not a click and would return the whole region's trail list.
  if (maxx <= minx || maxy <= miny || maxx - minx > 50_000 || maxy - miny > 50_000) return null;
  return [minx, miny, maxx, maxy];
}

// A search result, with the English name attached when one is already known.
// `needs_en` says the name is in a script the reader may not read and an
// English one is worth asking /api/world-trails/translate for. `countries`
// are ISO codes, the one holding most of the route first; empty when it could
// not be placed in time.
type SearchResult = WmtRouteSummary & { name_en: string | null; needs_en: boolean; countries: string[] };

// The country is a help in telling results apart, not a reason to keep them
// waiting: past this, the list goes without it.
const COUNTRY_WAIT_MS = 2500;

function withinTime<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// By name: Waymarked Trails' own search (the route's name and its name:xx
// tags, forgiving of half-typed words) and, beside it, the English names this
// app has learned — int_name and translations, which that search cannot see.
async function search(query: string): Promise<{ status: Status; results: SearchResult[] }> {
  const [wmt, ours] = await Promise.all([
    fetchWmt(`/list/search?query=${encodeURIComponent(query)}&limit=${MAX_SEARCH}&locale=he`, 8000) as Promise<
      { results?: WmtRouteSummary[] } | null
    >,
    searchEnglish(query, MAX_SEARCH),
  ]);

  const results: WmtRouteSummary[] = [...(wmt?.results ?? [])];
  const seen = new Set(results.map((r) => r.id));
  const onlyOurs = ours.filter((r) => !seen.has(r.relation_id)).map((r) => r.relation_id);
  if (onlyOurs.length) {
    const extra = (await fetchWmt(`/list/by_ids?relations=${onlyOurs.join(',')}`, 8000)) as
      | { results?: WmtRouteSummary[] }
      | null;
    // A match on the English name is a match on what was typed; it goes ahead
    // of Waymarked Trails' looser ones.
    results.unshift(...(extra?.results ?? []));
  }
  if (!wmt && results.length === 0) return { status: 'unavailable', results: [] };

  const shown = results.slice(0, MAX_SEARCH);
  const english = new Map(ours.map((r) => [r.relation_id, r.name_en]));
  const unknown = shown.filter((r) => needsEnglish(r.name) && !english.has(r.id)).map((r) => r.id);
  const [known, countries] = await Promise.all([
    lookupEnglish(unknown),
    withinTime(countriesFor(shown.map((r) => r.id)), COUNTRY_WAIT_MS, new Map<number, string[]>()),
  ]);
  for (const [id, en] of known) english.set(id, en);

  return {
    status: 'ok',
    results: shown.map((r) => ({
      ...r,
      name_en: english.get(r.id) ?? null,
      needs_en: needsEnglish(r.name),
      countries: countries.get(r.id) ?? [],
    })),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (query) {
    if (query.length < 2 || query.length > 80) {
      return NextResponse.json({ error: 'q: 2–80 characters' }, { status: 400 });
    }
    // Its own allowance: typing a name asks once a word or so, and must not
    // use up the taps on the map.
    if (!(await rateLimit(`wmt-search:${clientIp(request)}`, 40, 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status, results: [] }, { status: 429 });
    }
    try {
      return NextResponse.json(await search(query));
    } catch (error) {
      console.error('World trails search error:', error);
      return NextResponse.json({ status: 'unavailable' satisfies Status, results: [] });
    }
  }

  const bbox = parseBbox(url.searchParams.get('bbox'));
  const id = Number(url.searchParams.get('id'));
  const wantElevation = url.searchParams.get('elevation') === '1';
  const wantStages = url.searchParams.get('stages') === '1';

  if (!bbox && !(Number.isInteger(id) && id !== 0)) {
    return NextResponse.json({ error: 'bbox or id required' }, { status: 400 });
  }

  if (!(await rateLimit(`wmt:${clientIp(request)}`, 20, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
  }

  try {
    if (!bbox && id < 0) return NextResponse.json(await sectionOf(id, wantElevation, wantStages));
    if (!bbox && wantStages) return NextResponse.json(await stagesOf(id, url.searchParams.get('climb') !== '0'));
    if (bbox) {
      const data = (await fetchWmt(
        `/list/by_area?bbox=${bbox.map((n) => n.toFixed(1)).join(',')}&limit=${MAX_LIST}&locale=he`
      )) as { results?: unknown[] } | null;
      if (!data) return NextResponse.json({ status: 'unavailable' satisfies Status, results: [] });
      return NextResponse.json({ status: 'ok' satisfies Status, results: data.results ?? [] });
    }

    const path = wantElevation
      ? `/details/relation/${id}/way-elevation?simplify=50`
      : `/details/relation/${id}?locale=he`;
    const data = await fetchWmt(path);
    if (!data) return NextResponse.json({ status: 'unavailable' satisfies Status });
    if (!wantElevation) after(() => rememberEnglish(data as WmtRouteDetails));
    return NextResponse.json({ status: 'ok' satisfies Status, data });
  } catch (error) {
    console.error('World trails error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}

// A popular part of a long trail, cut out of the long trail's details (and
// elevation), which fetchWmt keeps — opening the long trail after it is free.
async function sectionOf(id: number, wantElevation: boolean, wantStages: boolean) {
  const section = await sectionById(id);
  if (!section) return { status: 'unavailable' satisfies Status };
  if (wantStages) {
    return { status: 'ok' satisfies Status, stages: [], parents: [{ id: section.parentId, name: section.parentName }], climb: true };
  }
  const parent = (await fetchWmt(`/details/relation/${section.parentId}?locale=he`)) as WmtRouteDetails | null;
  const data = parent && cutSection(parent, section);
  if (!data) return { status: 'unavailable' satisfies Status };
  if (!wantElevation) return { status: 'ok' satisfies Status, data };
  const elevation = (await fetchWmt(`/details/relation/${section.parentId}/way-elevation?simplify=50`)) as WmtElevation | null;
  if (!elevation) return { status: 'unavailable' satisfies Status };
  return { status: 'ok' satisfies Status, data: cutElevation(elevation, data) };
}

// The details and the elevation are both cached in fetchWmt, and the card
// that asks has usually just had them fetched for the trail itself.
// `climb`: whether climb and descent were asked for — said back, so a list
// asked for without them is not taken for one whose elevation was missing.
async function stagesOf(id: number, climb: boolean) {
  const details = (await fetchWmt(`/details/relation/${id}?locale=he`)) as WmtRouteDetails | null;
  if (!details) return { status: 'unavailable' satisfies Status };
  const parents = wmtParents(details);
  let stages = wmtStages(details);
  if (stages.length && climb) {
    // Without elevation the list still stands, only without climb and descent.
    const elevation = (await fetchWmt(`/details/relation/${id}/way-elevation?simplify=50`)) as WmtElevation | null;
    if (elevation) {
      try { stages = wmtStages(details, elevation); } catch (e) { console.error('Stage elevation failed:', id, e); }
    }
  }
  return { status: 'ok' satisfies Status, stages, parents, climb };
}

// A route opened here whose English name OSM already holds goes into the
// table, so that from now on it can be found by that name too — int_name
// especially, which Waymarked Trails' own search does not look at.
async function rememberEnglish(details: WmtRouteDetails): Promise<void> {
  if (!needsEnglish(details?.name)) return;
  const en = englishFromTags(details.tags);
  if (!en) return;
  await saveEnglish([{ relation_id: details.id, name: details.name!, name_en: en, source: 'osm' }]);
}
