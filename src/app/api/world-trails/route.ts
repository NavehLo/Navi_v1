import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';

// Proxy for the Waymarked Trails API (marked hiking routes from OSM, worldwide).
// Three reads, all GET:
//   ?bbox=minx,miny,maxx,maxy   routes crossing a Web Mercator box (metres)
//   ?id=<relation id>           one route: name, length, geometry
//   ?id=<relation id>&elevation=1   DEM elevation samples along its ways
//
// It goes through the server rather than straight from the browser for the
// same reasons the Overpass calls do: a User-Agent that says who is asking, a
// per-IP limit so one enthusiastic clicker cannot hammer a community service,
// and a cache — the details of a national trail are several megabytes.
//
// Same tri-state contract as /api/pois: 'ok' with nothing in it is an answer
// about this spot; 'unavailable' and 'rate-limited' mean we could not ask.
type Status = 'ok' | 'unavailable' | 'rate-limited';

const BASE = 'https://hiking.waymarkedtrails.org/api/v1';
const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
const MAX_LIST = 12;

const cache = new Map<string, { at: number; body: unknown }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 40;

async function fetchWmt(path: string): Promise<unknown | null> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error('Waymarked Trails error:', path, res.status);
      return null;
    }
    const body = await res.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(path, { at: Date.now(), body });
    return body;
  } catch (e) {
    console.error('Waymarked Trails request failed:', path, e);
    return null;
  }
}

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const bbox = parseBbox(url.searchParams.get('bbox'));
  const id = Number(url.searchParams.get('id'));
  const wantElevation = url.searchParams.get('elevation') === '1';

  if (!bbox && !(Number.isInteger(id) && id > 0)) {
    return NextResponse.json({ error: 'bbox or id required' }, { status: 400 });
  }

  if (!(await rateLimit(`wmt:${clientIp(request)}`, 20, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
  }

  try {
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
    return NextResponse.json({ status: 'ok' satisfies Status, data });
  } catch (error) {
    console.error('World trails error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
