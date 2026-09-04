import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { bearerToken, checkGuideQuota, recordGuideUsage } from '../../../../lib/supabaseServer';
import {
  type NarrationInput,
  type NarrationResult,
  pickTextProvider,
  lookupNarration,
  resultFromLookup,
  generateNarration,
} from '../../../../lib/narration';
import { isNarrationCacheConfigured } from '../../../../lib/narrationCache';

// Prepares a whole trail's narration in one go, so it can be downloaded to the
// device and played in the field with no reception. Points already in the
// cache come back immediately and cost nothing; only the gaps are generated.

export const maxDuration = 60;

const DAILY_CHARS_PER_USER = parseInt(process.env.GUIDE_DAILY_CHARS_PER_USER || '12000', 10);
const DAILY_MISSES_ANON = parseInt(process.env.GUIDE_DAILY_MISSES_ANON || '8', 10);

// Generating is slow — several seconds per point — and a serverless function
// has a deadline. Rather than risk a timeout that loses the whole batch, each
// request fills a few gaps and reports what is left; the client calls again
// until nothing is pending, showing progress as it goes.
const MAX_GENERATE_PER_REQUEST = 3;

const MAX_POIS = 40;

// Why a point is not in this response. The client used to be told only *that*
// some were missing and had to guess the reason from what else was in the
// payload — and guessed wrong, reporting "cannot be generated" for a point that
// was simply past the per-request batch limit.
type PendingReason =
  | 'batch-limit'   // fine: ask again and it will be generated
  | 'quota'         // out of budget for today
  | 'no-provider'   // no AI key configured on the server
  | 'error';        // generation threw — `detail` says what

interface Pending {
  poiKey: string;
  reason: PendingReason;
  detail?: string;
}

interface PrefetchPoi {
  lat: number;
  lon: number;
  type: string;
  name?: string | null;
  osmType?: string | null;
  osmId?: number | null;
  tags?: Record<string, string> | null;
}

export async function POST(request: Request) {
  try {
    if (!(await rateLimit(`prefetch:${clientIp(request)}`, 12, 60_000))) {
      return NextResponse.json({ error: 'יותר מדי בקשות. נסה שוב בעוד רגע.' }, { status: 429 });
    }

    const body = await request.json();
    const trailSlug: string = body.trailSlug ?? '';
    const pois: PrefetchPoi[] = Array.isArray(body.pois) ? body.pois.slice(0, MAX_POIS) : [];
    if (pois.length === 0) {
      return NextResponse.json({ error: 'pois required' }, { status: 400 });
    }

    const provider = pickTextProvider(body.provider);
    const token = bearerToken(request);

    // Points the device already holds. Without this the server re-does the
    // same points on every round: when the durable cache is unavailable the
    // in-memory fallback lives on one serverless instance, so a round answered
    // by a different instance sees nothing cached, regenerates the first few
    // points again, and the client — which already has them — stores nothing
    // and concludes the rest "cannot be generated". Telling the server what is
    // already downloaded makes each round move forward regardless.
    const have = new Set<string>(
      Array.isArray(body.have) ? (body.have as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, MAX_POIS * 4) : []
    );

    const results: NarrationResult[] = [];
    const pending: Pending[] = [];
    let skipped = 0;
    let generated = 0;
    let quotaReached = false;
    let charsThisRequest = 0;
    // Which limit stopped us, so the client can say something true instead of
    // guessing. 'user' means a real per-account character budget; 'anon' means
    // the per-IP cap, which also catches a signed-in caller whose Supabase
    // quota RPC is unreachable — worth telling apart when diagnosing.
    let quotaScope: 'user' | 'anon' | null = null;
    let failures = 0;

    for (const poi of pois) {
      const input: NarrationInput = {
        lat: poi.lat,
        lon: poi.lon,
        type: poi.type,
        name: poi.name ?? null,
        osmType: poi.osmType ?? null,
        osmId: poi.osmId ?? null,
        tags: poi.tags ?? null,
        trailSlug,
        voice: body.voice ?? null,
      };

      // The free half first, always: a downloaded trail re-downloaded, or a
      // point shared with another trail, never reaches an external API.
      const lookup = await lookupNarration(input);

      // Already on the device in the voice being downloaded: nothing to send,
      // nothing to generate, and — the part that matters — nothing to report
      // as pending.
      if (have.has(lookup.poiKey)) {
        skipped++;
        continue;
      }

      const hit = resultFromLookup(lookup);
      if (hit) {
        results.push(hit);
        continue;
      }

      if (!provider) {
        pending.push({ poiKey: lookup.poiKey, reason: 'no-provider' });
        continue;
      }
      if (quotaReached) {
        pending.push({ poiKey: lookup.poiKey, reason: 'quota' });
        continue;
      }
      if (generated >= MAX_GENERATE_PER_REQUEST) {
        pending.push({ poiKey: lookup.poiKey, reason: 'batch-limit' });
        continue;
      }

      // Each generation is charged, so each one is checked.
      let quotaEnforced = false;
      if (token) {
        const quota = await checkGuideQuota(token, DAILY_CHARS_PER_USER);
        if (quota.configured && !quota.allowed) {
          quotaReached = true;
          quotaScope = 'user';
          pending.push({ poiKey: lookup.poiKey, reason: 'quota' });
          continue;
        }
        quotaEnforced = quota.configured;
      }
      if (!quotaEnforced) {
        const allowed = await rateLimit(
          `guide:daily:${clientIp(request)}`,
          DAILY_MISSES_ANON,
          24 * 60 * 60 * 1000
        );
        if (!allowed) {
          quotaReached = true;
          quotaScope = 'anon';
          pending.push({ poiKey: lookup.poiKey, reason: 'quota' });
          continue;
        }
      }

      // One point failing must not lose the points that already succeeded:
      // the batch keeps going and reports the failure alongside the results.
      try {
        const result = await generateNarration(input, lookup, provider);
        generated++;
        charsThisRequest += result.charsSynthesized;
        if (token && quotaEnforced && result.charsSynthesized > 0) {
          await recordGuideUsage(token, DAILY_CHARS_PER_USER, result.charsSynthesized);
        }
        results.push(result);
      } catch (e) {
        console.error('Narration generation failed for', lookup.poiKey, e);
        failures++;
        pending.push({
          poiKey: lookup.poiKey,
          reason: 'error',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return NextResponse.json({
      results,
      pending,          // call again to fill these
      generated,
      skipped,
      charsThisRequest,
      failures,
      // Whether narrations survive between requests at all. Without the durable
      // cache the fallback is per-instance memory, which on a serverless host
      // means a point can be generated more than once and paid for more than
      // once — worth saying out loud rather than leaving as a mystery stall.
      durableCache: isNarrationCacheConfigured(),
      // Distinguishes "come back for the rest" from "you have hit your limit":
      // the client stops asking in the second case.
      quotaReached,
      quotaScope,
      hasProvider: !!provider,
      // The per-request generation cap, so the client can tell a batch that is
      // simply not finished yet from one that cannot finish at all.
      batchLimit: MAX_GENERATE_PER_REQUEST,
    });
  } catch (error: any) {
    console.error('Prefetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
