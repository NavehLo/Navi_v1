import { NextResponse } from 'next/server';
import crypto from 'crypto';

export interface DiscoveredPOI {
  lat: number;
  lon: number;
  type: string;  // Hebrew type name, fed straight into the guide prompt
  name: string | null;
}

const SEARCH_RADIUS_M = 250;   // how far off-trail a POI may be
const MAX_QUERY_POINTS = 120;  // polyline points sent to Overpass
const MAX_RESULTS = 40;

// OSM tag → Hebrew POI type. Order matters: first match wins.
const TAG_TYPES: Array<{ key: string; value?: string; he: string }> = [
  { key: 'waterway', value: 'waterfall', he: 'מפל' },
  { key: 'natural', value: 'spring', he: 'מעיין' },
  { key: 'natural', value: 'peak', he: 'פסגה' },
  { key: 'natural', value: 'cave_entrance', he: 'מערה' },
  { key: 'tourism', value: 'viewpoint', he: 'נקודת תצפית' },
  { key: 'historic', value: 'archaeological_site', he: 'אתר ארכיאולוגי' },
  { key: 'historic', value: 'ruins', he: 'חורבה' },
  { key: 'historic', value: 'memorial', he: 'אנדרטה' },
  { key: 'historic', value: 'monastery', he: 'מנזר עתיק' },
  { key: 'historic', he: 'אתר היסטורי' },
];

function classify(tags: Record<string, string>): string | null {
  for (const t of TAG_TYPES) {
    if (t.value ? tags[t.key] === t.value : !!tags[t.key]) return t.he;
  }
  return null;
}

// overpass-api.de returns 406 without a descriptive User-Agent (bot protection).
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

// Per-instance cache — same trail asked twice hits Overpass once
const cache = new Map<string, DiscoveredPOI[]>();

function buildQuery(coords: [number, number][]): string {
  const poly = coords.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  const around = `(around:${SEARCH_RADIUS_M},${poly})`;
  return `
[out:json][timeout:25];
(
  node${around}[waterway=waterfall];
  node${around}[natural~"^(spring|peak|cave_entrance)$"];
  node${around}[tourism=viewpoint];
  node${around}[historic];
  way${around}[historic];
);
out center ${MAX_RESULTS * 2};
`.trim();
}

export async function POST(request: Request) {
  try {
    const { coords } = (await request.json()) as { coords: [number, number][] };
    if (!Array.isArray(coords) || coords.length < 2) {
      return NextResponse.json({ error: 'coords required' }, { status: 400 });
    }

    // Downsample to keep the Overpass query small
    const step = Math.max(1, Math.ceil(coords.length / MAX_QUERY_POINTS));
    const sampled = coords.filter((_, i) => i % step === 0).slice(0, MAX_QUERY_POINTS);

    const key = crypto.createHash('sha1').update(JSON.stringify(sampled)).digest('hex');
    const hit = cache.get(key);
    if (hit) return NextResponse.json({ pois: hit, cached: true });

    const data = await fetchOverpass(buildQuery(sampled as [number, number][]));
    if (!data) return NextResponse.json({ pois: [] });
    const pois: DiscoveredPOI[] = [];
    for (const el of data.elements ?? []) {
      const tags = el.tags ?? {};
      const type = classify(tags);
      if (!type) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      pois.push({
        lat,
        lon,
        type,
        name: tags['name:he'] || tags.name || null,
      });
      if (pois.length >= MAX_RESULTS) break;
    }

    if (cache.size > 50) cache.delete(cache.keys().next().value!);
    cache.set(key, pois);
    return NextResponse.json({ pois });
  } catch (error: any) {
    console.error('POI discovery error:', error);
    // POIs are an enhancement — never fail the app over them
    return NextResponse.json({ pois: [] });
  }
}
