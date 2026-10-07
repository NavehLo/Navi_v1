import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { collectTrailPhotos, type CollectDebug } from '../../../lib/trailPhotos/collect';
import { readTrailPhotos, writeTrailPhotos } from '../../../lib/trailPhotos/cache';
import { MAX_SENT_POINTS, type TrailPhotos, type TrailPhotosStatus } from '../../../lib/trailPhotos/types';
import { withAiUsage } from '../../../lib/aiUsage';

// "תמונות מהמסלול": photos along a trail, from free sources, chosen so they
// spread along it (lib/trailPhotos/select.ts).
//
//   POST { coords: [lat, lon][], wmtId? }
//
// The points are the trail's own, thinned on the device the same way every
// time (thinForPhotos), so a trail always lands on the same stored answer.
// The answer is keyed by those points — not by a name or id the device
// could send with someone else's line — and a world trail's id only adds its
// own photo. The first request for a trail does the work (up to ~45 s);
// every later one, from anyone, is answered from the store.

export const maxDuration = 60;

type Body = { status: TrailPhotosStatus; photos?: TrailPhotos; cached?: boolean };

const inFlight = new Map<string, Promise<TrailPhotos | null>>();

interface Req { coords: [number, number][]; wmtId: number | null }

function parse(raw: unknown): Req | null {
  const b = raw as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.coords)) return null;
  if (b.coords.length < 2 || b.coords.length > MAX_SENT_POINTS + 1) return null;
  const coords: [number, number][] = [];
  for (const c of b.coords) {
    const lat = Number((c as unknown[])?.[0]);
    const lon = Number((c as unknown[])?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    coords.push([lat, lon]);
  }
  const id = Number(b.wmtId);
  return { coords, wmtId: Number.isInteger(id) && id > 0 ? id : null };
}

async function handlePost(request: Request) {
  let req: Req | null = null;
  let debug = false;
  let refresh = false;
  try {
    const raw = await request.json();
    req = parse(raw);
    // Local development only: `debug` adds how many candidates each step
    // kept, `refresh` chooses again although a choice is stored.
    const dev = process.env.NODE_ENV !== 'production';
    debug = dev && raw?.debug === true;
    refresh = dev && raw?.refresh === true;
  } catch { /* fall through */ }
  if (!req) return NextResponse.json({ error: 'bad request' }, { status: 400 });

  if (debug) {
    const info = {} as CollectDebug;
    const photos = await collectTrailPhotos(req.coords, req.wmtId, info);
    return NextResponse.json({ photos, debug: info });
  }

  const key = 'pts:' + crypto.createHash('sha1').update(JSON.stringify([req.coords, req.wmtId])).digest('hex');
  const cached = refresh ? null : await readTrailPhotos(key);
  if (cached && !cached.stale) {
    return NextResponse.json({ status: 'ok', photos: cached.photos, cached: true } satisfies Body);
  }

  // Only a request that will do the work counts against the limit.
  if (!(await rateLimit(`trail-photos:${clientIp(request)}`, 6, 60_000))) {
    return cached
      ? NextResponse.json({ status: 'ok', photos: cached.photos, cached: true } satisfies Body)
      : NextResponse.json({ status: 'rate-limited' } satisfies Body, { status: 429 });
  }

  try {
    let work = inFlight.get(key);
    if (!work) {
      work = collectTrailPhotos(req.coords, req.wmtId).finally(() => inFlight.delete(key));
      inFlight.set(key, work);
    }
    const result = await work;
    // A failed search is not "no photos": keep the old choice, store nothing.
    if (!result) {
      return cached
        ? NextResponse.json({ status: 'ok', photos: cached.photos, cached: true } satisfies Body)
        : NextResponse.json({ status: 'unavailable' } satisfies Body);
    }
    await writeTrailPhotos(key, result);
    return NextResponse.json({ status: 'ok', photos: result } satisfies Body);
  } catch (error) {
    console.error('Trail photos error:', error);
    return cached
      ? NextResponse.json({ status: 'ok', photos: cached.photos, cached: true } satisfies Body)
      : NextResponse.json({ status: 'unavailable' } satisfies Body);
  }
}

// The model's look at the pictures is logged under this area and the caller
// (see lib/aiUsage).
export function POST(request: Request) {
  return withAiUsage(request, 'trail_photos', () => handlePost(request));
}
