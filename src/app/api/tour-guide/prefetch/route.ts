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

    const results: NarrationResult[] = [];
    const pending: string[] = [];
    let generated = 0;
    let quotaReached = false;
    let charsThisRequest = 0;

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
      };

      // The free half first, always: a downloaded trail re-downloaded, or a
      // point shared with another trail, never reaches an external API.
      const lookup = await lookupNarration(input);
      const hit = resultFromLookup(lookup);
      if (hit) {
        results.push(hit);
        continue;
      }

      if (!provider || quotaReached || generated >= MAX_GENERATE_PER_REQUEST) {
        pending.push(lookup.poiKey);
        continue;
      }

      // Each generation is charged, so each one is checked.
      let quotaEnforced = false;
      if (token) {
        const quota = await checkGuideQuota(token, DAILY_CHARS_PER_USER);
        if (quota.configured && !quota.allowed) {
          quotaReached = true;
          pending.push(lookup.poiKey);
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
          pending.push(lookup.poiKey);
          continue;
        }
      }

      const result = await generateNarration(input, lookup, provider);
      generated++;
      charsThisRequest += result.charsSynthesized;
      if (token && quotaEnforced && result.charsSynthesized > 0) {
        await recordGuideUsage(token, DAILY_CHARS_PER_USER, result.charsSynthesized);
      }
      results.push(result);
    }

    return NextResponse.json({
      results,
      pending,          // call again to fill these
      generated,
      charsThisRequest,
      // Distinguishes "come back for the rest" from "you have hit your limit":
      // the client stops asking in the second case.
      quotaReached,
    });
  } catch (error: any) {
    console.error('Prefetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
