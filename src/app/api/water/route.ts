import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { classifyWater, type WaterCategory } from '../../../lib/waterSources';

// Places along a trail where you can get into water and cool off.
//
// Structurally a twin of api/pois/route.ts — same two Overpass endpoints, same
// User-Agent, same rate limit, same DiscoveryStatus — because the failure modes
// are the same and the app already knows how to handle them. What is different
// is that everything Overpass returns goes through classifyWater() before it is
// allowed out; see src/lib/waterSources.ts for why that filter is the feature.
//
// NOT drinking water. Nothing here is checked for whether it is safe to drink,
// and the UI says so wherever these appear.

export interface WaterSource {
  lat: number;
  lon: number;
  category: WaterCategory;
  label: string;       // Hebrew
  confident: boolean;  // false for springs and unverified polygons
  name: string | null;
  osmType: string | null;
  osmId: number | null;
  // Present for streams and rivers only. A stream is not a place, it is a line
  // that runs alongside the trail — collapsing it to one point (which is what
  // `out center` gives) reported נחל כזיב as 3% near water, when in truth you
  // walk in its bed for most of the route. Carrying the line lets the distance
  // maths ask "how far is the water from here" at every step of the walk.
  geometry?: Array<[number, number]>;
}

// Same three-way answer as POI discovery. An empty list has to say which of
// "this trail has no water", "Overpass is down" and "we did not ask" it means —
// rendering an outage as "no water on this trail" in August is the kind of
// wrong answer this app has already had to fix once.
type DiscoveryStatus = 'ok' | 'unavailable' | 'rate-limited';

// Tighter than the 250 m used for POI discovery, on purpose: a viewpoint is
// worth knowing about from a distance, but water is only worth knowing about if
// you can actually walk to it and back. 150 m is a two-to-three minute detour.
const SEARCH_RADIUS_M = 150;
const MAX_QUERY_POINTS = 120;
const MAX_RESULTS = 60;

// A stream way can carry hundreds of vertices, and the client compares every
// one of them against every trail point. Thinning to roughly one vertex per
// 50 m keeps that comparison cheap while staying far finer than the 150 m
// buffer it feeds, so the answer does not change.
const GEOMETRY_SPACING_KM = 0.05;

function thin(geometry: Array<{ lat: number; lon: number }>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let last: { lat: number; lon: number } | null = null;
  for (const g of geometry) {
    if (last && haversineKm(last.lat, last.lon, g.lat, g.lon) < GEOMETRY_SPACING_KM) continue;
    out.push([g.lat, g.lon]);
    last = g;
  }
  // Always keep the far end, so a long straight run is not clipped short.
  const tail = geometry[geometry.length - 1];
  if (tail && (out.length === 0 || out[out.length - 1][0] !== tail.lat || out[out.length - 1][1] !== tail.lon)) {
    out.push([tail.lat, tail.lon]);
  }
  return out;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchOverpass(query: string): Promise<any | null> {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(28000),
      });
      if (res.ok) return res.json();
      console.error('Overpass error:', endpoint, res.status);
    } catch (e) {
      console.error('Overpass request failed:', endpoint, e);
    }
  }
  return null;
}

const cache = new Map<string, WaterSource[]>();

function buildQuery(coords: [number, number][]): string {
  const poly = coords.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  const around = `(around:${SEARCH_RADIUS_M},${poly})`;
  // Asked broadly and filtered here rather than narrowed in the query: the
  // block list is the part that has to be reviewable, and it can only be
  // reviewed if it sees everything.
  //
  // Two output modes, because the two kinds of source are different shapes. A
  // pool or a spring is a place, and `out center` gives it the single point the
  // maths wants. A stream is a line, and its centre is meaningless — so
  // waterways come back with `out geom` and keep their shape.
  return `
[out:json][timeout:25];
(
  way${around}[natural=water];
  node${around}[natural=spring];
  way${around}[natural=coastline];
)->.places;
way${around}[waterway~"^(stream|river)$"][name]->.lines;
.places out center ${MAX_RESULTS * 3};
.lines out geom ${MAX_RESULTS};
`.trim();
}

export async function POST(request: Request) {
  try {
    if (!(await rateLimit(`water:${clientIp(request)}`, 10, 60_000))) {
      return NextResponse.json({ sources: [], status: 'rate-limited' satisfies DiscoveryStatus }, { status: 429 });
    }

    const { coords } = (await request.json()) as { coords: [number, number][] };
    if (!Array.isArray(coords) || coords.length < 2) {
      return NextResponse.json({ error: 'coords required' }, { status: 400 });
    }

    const step = Math.max(1, Math.ceil(coords.length / MAX_QUERY_POINTS));
    const sampled = coords.filter((_, i) => i % step === 0).slice(0, MAX_QUERY_POINTS);

    const key = crypto.createHash('sha1').update(JSON.stringify(sampled)).digest('hex');
    const hit = cache.get(key);
    if (hit) return NextResponse.json({ sources: hit, cached: true, status: 'ok' satisfies DiscoveryStatus });

    const data = await fetchOverpass(buildQuery(sampled as [number, number][]));
    if (!data) {
      return NextResponse.json({ sources: [], status: 'unavailable' satisfies DiscoveryStatus });
    }

    const sources: WaterSource[] = [];
    for (const el of data.elements ?? []) {
      const tags = el.tags ?? {};
      const props = classifyWater(tags);
      if (!props) continue;
      const geometry = Array.isArray(el.geometry) && el.geometry.length > 1 ? thin(el.geometry) : undefined;
      // A way returned with `out geom` has no centre of its own, so its first
      // vertex stands in as the anchor; the geometry is what actually gets
      // measured against the trail.
      const lat = el.lat ?? el.center?.lat ?? geometry?.[0]?.[0];
      const lon = el.lon ?? el.center?.lon ?? geometry?.[0]?.[1];
      if (lat == null || lon == null) continue;
      sources.push({
        lat,
        lon,
        category: props.category,
        label: props.label,
        confident: props.confident,
        name: tags['name:he'] || tags.name || null,
        osmType: el.type ?? null,
        osmId: el.id ?? null,
        ...(geometry ? { geometry } : {}),
      });
      if (sources.length >= MAX_RESULTS) break;
    }

    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    cache.set(key, sources);
    return NextResponse.json({ sources, status: 'ok' satisfies DiscoveryStatus });
  } catch (error: any) {
    console.error('Water discovery error:', error);
    return NextResponse.json({ sources: [], status: 'unavailable' satisfies DiscoveryStatus });
  }
}
