import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { collectSources } from '../../../lib/trailInfo/sources';
import { summarizeTrail } from '../../../lib/trailInfo/summarize';
import { readTrailInfo, writeTrailInfo } from '../../../lib/trailInfo/cache';
import { trailInfoKey, type TrailInfo, type TrailInfoRequest, type TrailInfoStatus } from '../../../lib/trailInfo/types';

// "על המסלול": a Hebrew description of a trail, written from its official
// site, Nakeb, Wikipedia and — when those say too little — a web search.
//
//   POST { kind: 'wmt', id }                      a world trail (OSM relation)
//   POST { kind: 'nakeb', id, name, lat?, lon? }  an Israeli trail
//
// The first request for a trail does the work (up to ~45 s); its answer is
// stored and every later request, from anyone, is answered from the store.

// Reading a site and asking a model takes far longer than Vercel's default.
export const maxDuration = 60;

type Body = { status: TrailInfoStatus; info?: TrailInfo; cached?: boolean };

// Two people opening the same new trail at once share one generation.
const inFlight = new Map<string, Promise<TrailInfo | 'no-sources' | null>>();

function parse(raw: unknown): TrailInfoRequest | null {
  const b = raw as Record<string, unknown> | null;
  const id = Number(b?.id);
  if (!b || !Number.isInteger(id) || id <= 0) return null;
  if (b.kind === 'wmt') return { kind: 'wmt', id };
  if (b.kind === 'nakeb' && typeof b.name === 'string' && b.name.trim()) {
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    return {
      kind: 'nakeb', id, name: b.name.trim().slice(0, 200),
      ...(Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {}),
    };
  }
  return null;
}

async function generate(req: TrailInfoRequest): Promise<TrailInfo | 'no-sources' | null> {
  const collected = await collectSources(req);
  if (!collected) return null;
  if (collected.sources.length === 0) return 'no-sources';
  return summarizeTrail(collected);
}

export async function POST(request: Request) {
  let req: TrailInfoRequest | null = null;
  let debug = false;
  let refresh = false;
  try {
    const raw = await request.json();
    req = parse(raw);
    // Local development only: `debug` returns what the model would be given,
    // `refresh` writes the description again although one is stored.
    const dev = process.env.NODE_ENV !== 'production';
    debug = dev && raw?.debug === true;
    refresh = dev && raw?.refresh === true;
  } catch { /* fall through */ }
  if (!req) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  if (debug) return NextResponse.json(await collectSources(req));

  const key = trailInfoKey(req);
  const cached = refresh ? null : await readTrailInfo(key);
  if (cached && !cached.stale) {
    return NextResponse.json({ status: 'ok', info: cached.info, cached: true } satisfies Body);
  }

  // Only a request that will do the work counts against the limit.
  if (!(await rateLimit(`trail-info:${clientIp(request)}`, 6, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' } satisfies Body, { status: 429 });
  }

  try {
    let work = inFlight.get(key);
    if (!work) {
      work = generate(req).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
    }
    const result = await work;
    if (result === 'no-sources') return NextResponse.json({ status: 'no-sources' } satisfies Body);
    if (!result) {
      // A stale description is better than none when the sources are down.
      return cached
        ? NextResponse.json({ status: 'ok', info: cached.info, cached: true } satisfies Body)
        : NextResponse.json({ status: 'unavailable' } satisfies Body);
    }
    await writeTrailInfo(key, result);
    return NextResponse.json({ status: 'ok', info: result } satisfies Body);
  } catch (error) {
    console.error('Trail info error:', error);
    return cached
      ? NextResponse.json({ status: 'ok', info: cached.info, cached: true } satisfies Body)
      : NextResponse.json({ status: 'unavailable' } satisfies Body);
  }
}
