import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { bearerToken, checkGuideQuota, recordGuideUsage } from '../../../lib/supabaseServer';
import {
  type NarrationInput,
  availableProviders,
  pickTextProvider,
  lookupNarration,
  resultFromLookup,
  generateNarration,
} from '../../../lib/narration';

// The daily quota is a character budget: characters are what TTS bills for, so
// counting them is the only way the limit reflects real spend. Cache hits cost
// nothing and are never counted, which is why replaying a trail you have
// already walked is free no matter how many times you do it.
const DAILY_CHARS_PER_USER = parseInt(process.env.GUIDE_DAILY_CHARS_PER_USER || '12000', 10);
// Anonymous callers are capped by IP instead, and by *new* narrations rather
// than characters — the sliding-window limiter counts events, not weights.
const DAILY_MISSES_ANON = parseInt(process.env.GUIDE_DAILY_MISSES_ANON || '8', 10);

// Lets the settings UI show only providers that actually have a key configured.
// Booleans only — no secrets leave the server.
export async function GET() {
  return NextResponse.json({ providers: availableProviders() });
}

export async function POST(request: Request) {
  try {
    // Burst protection for everyone: 20 requests/min per IP, regardless of login
    if (!(await rateLimit(`guide:${clientIp(request)}`, 20, 60_000))) {
      return NextResponse.json({ error: 'יותר מדי בקשות. נסה שוב בעוד רגע.' }, { status: 429 });
    }

    const body = await request.json();
    const { lat, lon, type, name, provider: requestedProvider } = body;
    const input: NarrationInput = {
      lat,
      lon,
      type,
      name: name ?? null,
      osmType: body.osmType ?? null,
      osmId: body.osmId ?? null,
      trailSlug: body.trailSlug ?? null,
      tags: body.tags ?? null,
      covered: Array.isArray(body.covered) ? body.covered.slice(0, 10) : null,
      voice: body.voice ?? null,

    };

    // Free first: an already-narrated point never reaches an external API, and
    // so never touches the quota either.
    const lookup = await lookupNarration(input);
    const hit = resultFromLookup(lookup);
    if (hit) return NextResponse.json(hit);

    const provider = pickTextProvider(requestedProvider);

    // No provider key configured -> mocked text, no audio (dev/demo mode)
    if (!provider) {
      console.warn('No AI provider key found. Returning mocked response.');
      return NextResponse.json({
        poiKey: lookup.poiKey,
        text: `ברוכים הבאים לנקודה בנ"צ ${lat.toFixed(3)}, ${lon.toFixed(3)}. תהנו מהסיור!`,
        audioUrl: null,
        audio: null,
        audioFormat: 'mp3',
        cached: false,
      });
    }

    // From here on the request costs money, so it has to pass a quota.
    const token = bearerToken(request);
    let quotaEnforced = false;
    if (token) {
      const quota = await checkGuideQuota(token, DAILY_CHARS_PER_USER);
      if (quota.configured && !quota.allowed) {
        return NextResponse.json(
          { error: 'הגעת למכסה היומית של קריינויות חדשות. נקודות ששמעת כבר ימשיכו לעבוד — נסה שוב מחר.' },
          { status: 429 }
        );
      }
      quotaEnforced = quota.configured;
    }

    // No per-account quota was applied — either the caller isn't signed in, or
    // Supabase is unreachable (e.g. a paused free-tier project). Either way the
    // per-IP daily cap has to hold the line, otherwise an outage on their side
    // turns into unmetered TTS spend on ours.
    if (!quotaEnforced) {
      const allowed = await rateLimit(`guide:daily:${clientIp(request)}`, DAILY_MISSES_ANON, 24 * 60 * 60 * 1000);
      if (!allowed) {
        return NextResponse.json(
          {
            error: token
              ? 'שירות המכסה אינו זמין כרגע, ולכן חלה מכסה יומית מצומצמת. נסה שוב מאוחר יותר.'
              : 'הגעת למכסה היומית להתנסות ללא התחברות. התחבר עם Google לקבלת מכסה גדולה יותר.',
          },
          { status: 429 }
        );
      }
    }

    const result = await generateNarration(input, lookup, provider);

    // Charge for what was actually synthesized, now that it is known.
    if (token && quotaEnforced && result.charsSynthesized > 0) {
      await recordGuideUsage(token, DAILY_CHARS_PER_USER, result.charsSynthesized);
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('AI Guide Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
