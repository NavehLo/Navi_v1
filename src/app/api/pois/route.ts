import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { hasOwnFacts, resolveArticles } from '../../../lib/grounding';
import { isDiscoveryCacheConfigured, readDiscovery, writeDiscovery } from '../../../lib/poiDiscoveryCache';

// Overpass answers in a second or fails eight seconds later, more or less at
// random, and the Wikipedia lookups that follow take a second or two more.
// Without this the platform default (ten to fifteen seconds) killed the
// function mid-retry, which the app could only report as "this trail has no
// points" — the bug this whole route was rewritten for.
export const maxDuration = 60;

export interface DiscoveredPOI {
  lat: number;
  lon: number;
  type: string;  // Hebrew type name, fed straight into the guide prompt
  name: string | null;
  osmType: string | null;  // node | way | relation — half of the cache key
  osmId: number | null;
  tags: Record<string, string>;  // the kept subset of KEPT_TAGS below
  // What the narration will be written from. Every point returned has one:
  // a Hebrew Wikipedia article about it, or a description in its own tags.
  grounding: 'wikipedia' | 'osm';
}

// An empty list is not one answer but three, and the caller has to tell them
// apart: Overpass said this stretch has nothing ('ok'), Overpass could not be
// reached ('unavailable'), or we did not ask ('rate-limited'). Returning a bare
// [] for all three is what let a trail silently lose its points — the app
// showed an outage as "no points on this trail", which is a different, and
// false, statement.
type DiscoveryStatus = 'ok' | 'unavailable' | 'rate-limited';

// Overpass already returns every tag on the element; these are the ones worth
// carrying to the guide. `wikipedia` and `wikidata` are what lets the narration
// be written from a real article rather than from the model's imagination, and
// the rest are facts in their own right (when it was built, how high it stands,
// what the inscription says). None of this costs an extra request.
const KEPT_TAGS = [
  'wikipedia',
  'wikidata',
  'description',
  'description:he',
  'start_date',
  'ele',
  'heritage',
  'inscription',
  'historic:civilization',
  'operator',
  'website',
] as const;

function keptTags(tags: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of KEPT_TAGS) {
    if (tags[key]) kept[key] = tags[key];
  }
  return kept;
}

const SEARCH_RADIUS_M = 250;   // how far off-trail a POI may be
const MAX_QUERY_POINTS = 120;  // polyline points sent to Overpass
const MAX_RESULTS = 40;

// OSM tag → Hebrew POI type. Order matters: first match wins. The specific
// historic values come before the catch-all, so the fortress at Yehiam is
// narrated as "מבצר" and not as "אתר היסטורי".
const TAG_TYPES: Array<{ key: string; value?: string; he: string }> = [
  { key: 'waterway', value: 'waterfall', he: 'מפל' },
  { key: 'natural', value: 'spring', he: 'מעיין' },
  { key: 'natural', value: 'peak', he: 'פסגה' },
  { key: 'natural', value: 'cave_entrance', he: 'מערה' },
  { key: 'natural', value: 'arch', he: 'קשת סלע' },
  { key: 'tourism', value: 'viewpoint', he: 'נקודת תצפית' },
  { key: 'historic', value: 'castle', he: 'מבצר' },
  { key: 'historic', value: 'fort', he: 'מצודה' },
  { key: 'historic', value: 'city_gate', he: 'שער עיר עתיק' },
  { key: 'historic', value: 'tower', he: 'מגדל היסטורי' },
  { key: 'historic', value: 'aqueduct', he: 'אמת מים' },
  { key: 'historic', value: 'archaeological_site', he: 'אתר ארכיאולוגי' },
  { key: 'historic', value: 'ruins', he: 'חורבה' },
  { key: 'historic', value: 'memorial', he: 'אנדרטה' },
  { key: 'historic', value: 'monument', he: 'אנדרטה' },
  { key: 'historic', value: 'monastery', he: 'מנזר עתיק' },
  { key: 'historic', value: 'church', he: 'כנסייה היסטורית' },
  { key: 'historic', value: 'tomb', he: 'קבר עתיק' },
  { key: 'historic', value: 'wayside_shrine', he: 'מקום קדוש' },
  { key: 'historic', he: 'אתר היסטורי' },
];

function classify(tags: Record<string, string>): string | null {
  for (const t of TAG_TYPES) {
    if (t.value ? tags[t.key] === t.value : !!tags[t.key]) return t.he;
  }
  return null;
}

// Overpass mirrors, fastest and most reliable first. All of them must serve
// the *whole planet*: a regional instance answers a query over Israel with a
// cheerful empty list, which is indistinguishable from "this stretch has
// nothing" and would be cached as such. overpass.osm.ch, which carries only a
// Swiss extract, was rejected for exactly that reason — it is not an outage
// that is dangerous here, it is a confident wrong answer.
//
// overpass-api.de returns 406 without a descriptive User-Agent (bot protection).
const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// How long to wait for the first mirror before also asking the second, and so
// on. The failure to design around is not "Overpass is down" but "this mirror
// fails this request and answers the next one": the main endpoint returns a
// gateway 504 for one query and serves the very same query a minute later,
// with its rate-limit slots free throughout. Trying the mirrors strictly one
// after another means waiting out each failure in turn — eight seconds for a
// 504, thirty for a mirror that hangs — and that is what turned a flaky
// service into trails with no points at all.
//
// So the requests are hedged instead: the next mirror is asked only if the
// previous one has not answered yet, and the first good answer wins. When the
// first mirror is healthy — the common case, about a second — no other mirror
// is contacted at all.
const HEDGE_DELAY_MS = 2_500;
// The whole of discovery, leaving room inside maxDuration for the Wikipedia
// lookups that follow and for the response itself.
const OVERPASS_BUDGET_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOverpass(query: string): Promise<unknown | null> {
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), OVERPASS_BUDGET_MS);

  const attempts = OVERPASS_ENDPOINTS.map(async (endpoint, i) => {
    if (i > 0) await sleep(i * HEDGE_DELAY_MS);
    // An earlier mirror already won, or the budget ran out.
    if (controller.signal.aborted) throw new Error('not needed');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${endpoint} → ${res.status}`);
    return await res.json();
  });

  try {
    // Promise.any: the first mirror that answers, not the first that replies.
    return await Promise.any(attempts);
  } catch (e) {
    const errors = e instanceof AggregateError ? e.errors : [e];
    console.error('Overpass unavailable:', errors.map((x) => String(x)).join(' | '));
    return null;
  } finally {
    clearTimeout(budget);
    controller.abort(); // stop the mirrors that lost the race
  }
}

// Per-instance cache, in front of the durable one — the same trail opened
// twice in a row does not even reach Supabase.
const cache = new Map<string, DiscoveredPOI[]>();

function buildQuery(coords: [number, number][]): string {
  const poly = coords.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  const around = `(around:${SEARCH_RADIUS_M},${poly})`;
  // `nwr` rather than node+way: a large site — a national park, a tell — is
  // often mapped as a relation, and those were being missed entirely.
  return `
[out:json][timeout:25];
(
  node${around}[waterway=waterfall];
  node${around}[natural~"^(spring|peak|cave_entrance|arch)$"];
  node${around}[tourism=viewpoint];
  nwr${around}[historic];
);
out center ${MAX_RESULTS * 2};
`.trim();
}

// Turns an Overpass answer into the points worth stopping at: classified,
// named or described, and backed by an article about the point itself.
async function selectPois(data: unknown): Promise<DiscoveredPOI[]> {
  const elements = (data as { elements?: Array<Record<string, any>> })?.elements ?? [];
  const candidates: Omit<DiscoveredPOI, 'grounding'>[] = [];

  for (const el of elements) {
    const tags = (el.tags ?? {}) as Record<string, string>;
    const type = classify(tags);
    if (!type) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const name = tags['name:he'] || tags.name || null;
    // An unnamed cave with no description is "a cave". There is nothing to
    // say about it that is not true of every cave, so it is not a stop.
    if (!name && !hasOwnFacts(tags)) continue;
    candidates.push({
      lat,
      lon,
      type,
      name,
      osmType: el.type ?? null,
      osmId: el.id ?? null,
      tags: keptTags(tags),
    });
    if (candidates.length >= MAX_RESULTS) break;
  }

  // Only points with something of their own to say survive: an article about
  // the point, or a description written on the element. The resolved article
  // title is stored in the tags so the narration reads that article and never
  // has to guess again.
  const articles = await resolveArticles(candidates);
  const pois: DiscoveredPOI[] = [];
  candidates.forEach((c, i) => {
    const article = articles[i];
    if (article) {
      pois.push({ ...c, tags: { ...c.tags, wikipedia: `he:${article.title}` }, grounding: 'wikipedia' });
    } else if (hasOwnFacts(c.tags)) {
      pois.push({ ...c, grounding: 'osm' });
    }
  });
  return pois;
}

function remember(key: string, pois: DiscoveredPOI[]) {
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  cache.set(key, pois);
}

export async function POST(request: Request) {
  try {
    // POI discovery is heavier (external Overpass) — 10/min per IP
    if (!(await rateLimit(`pois:${clientIp(request)}`, 10, 60_000))) {
      return NextResponse.json({ pois: [], status: 'rate-limited' satisfies DiscoveryStatus }, { status: 429 });
    }

    const { coords } = (await request.json()) as { coords: [number, number][] };
    if (!Array.isArray(coords) || coords.length < 2) {
      return NextResponse.json({ error: 'coords required' }, { status: 400 });
    }

    // Downsample to keep the Overpass query small
    const step = Math.max(1, Math.ceil(coords.length / MAX_QUERY_POINTS));
    const sampled = coords.filter((_, i) => i % step === 0).slice(0, MAX_QUERY_POINTS);

    const key = crypto.createHash('sha1').update(JSON.stringify(sampled)).digest('hex');
    const hit = cache.get(key);
    if (hit) return NextResponse.json({ pois: hit, cached: 'instance', status: 'ok' satisfies DiscoveryStatus });

    // The durable answer, written the first time anyone opened this trail.
    // This is what makes discovery reliable: after one success, Overpass is
    // not involved again.
    const stored = await readDiscovery<DiscoveredPOI>(key);
    if (stored && !stored.stale) {
      remember(key, stored.pois);
      return NextResponse.json({ pois: stored.pois, cached: 'durable', status: 'ok' satisfies DiscoveryStatus });
    }

    const data = await fetchOverpass(buildQuery(sampled as [number, number][]));
    if (!data) {
      // A stale list beats no list: it was a real answer about this trail once,
      // and the alternative is telling the walker the trail has nothing.
      if (stored) {
        remember(key, stored.pois);
        return NextResponse.json({ pois: stored.pois, cached: 'durable-stale', status: 'ok' satisfies DiscoveryStatus });
      }
      return NextResponse.json({
        pois: [],
        status: 'unavailable' satisfies DiscoveryStatus,
        durableCache: isDiscoveryCacheConfigured(),
      });
    }

    const pois = await selectPois(data);
    remember(key, pois);
    await writeDiscovery(key, pois);
    return NextResponse.json({ pois, status: 'ok' satisfies DiscoveryStatus });
  } catch (error: unknown) {
    console.error('POI discovery error:', error);
    // POIs are an enhancement — never fail the app over them. Saying the
    // discovery broke is not the same as failing the request.
    return NextResponse.json({ pois: [], status: 'unavailable' satisfies DiscoveryStatus });
  }
}
