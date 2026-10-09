import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { bearerToken } from '../../../lib/supabaseServer';
import { isAiLimitError } from '../../../lib/aiLimits';
import {
  type NarrationInput,
  availableProviders,
  pickTextProvider,
  textProviderChain,
  ttsPreferenceFor,
  lookupNarration,
  resultFromLookup,
  groundingFor,
  generateNarration,
} from '../../../lib/narration';
import { resolveTtsVoice, voiceStamp } from '../../../lib/tts';
import { withAiUsage } from '../../../lib/aiUsage';

// Lets the settings UI show only providers that actually have a key
// configured, and — the part that is easy to get wrong from the outside —
// which voice is *actually* speaking.
//
// The voice provider is independent of the text provider: ElevenLabs handles
// speech whenever it is configured, whichever model wrote the words. When it
// is not configured the code falls back to OpenAI or Gemini silently, which
// looks identical from the app: the voice settings simply stop having any
// effect, with nothing on screen to say why. This endpoint is what makes that
// visible. Booleans and public identifiers only — no secrets leave the server.
export async function GET(request: Request) {
  // The caller's own voice preferences, if it has any: without them this would
  // report the server's default while the app was actually using something
  // else, which is exactly the confusion the endpoint exists to remove.
  let override = null;
  try {
    const raw = new URL(request.url).searchParams.get('voice');
    if (raw) override = JSON.parse(raw);
  } catch {
    // A malformed preference is the same as none.
  }

  const voice = resolveTtsVoice(ttsPreferenceFor(pickTextProvider()), override);
  const stamp = voiceStamp(voice);
  return NextResponse.json({
    providers: availableProviders(),
    // The order narration will actually try, for the environment as deployed.
    // `providers` above only covers the three paid keys, so without this there
    // was no way to tell from outside whether GEMINI_FREE_API_KEY had reached
    // the server at all — and a free key that is simply absent looks exactly
    // like one that is configured and never chosen. Engine names only; the
    // keys themselves never leave the server.
    textChain: textProviderChain(),
    tts: stamp
      ? {
          provider: stamp.provider,
          model: stamp.model,
          // A voice id is a public Voice Library identifier, not a secret.
          voiceId: stamp.provider === 'elevenlabs' ? stamp.voiceId : null,
          tunable: stamp.provider === 'elevenlabs',
          // The exact rendering identity. The app stores it next to every clip
          // it keeps on the device, and refuses to replay one whose signature
          // no longer matches — otherwise a trail downloaded under the old
          // voice keeps playing that voice forever.
          signature: stamp.signature,
          niqqud: stamp.niqqud,
          niqqudProvider: stamp.niqqudProvider,
        }
      : null, // nothing server-side — the browser's own speechSynthesis reads it
  });
}

async function handlePost(request: Request) {
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
        voice: null,
      });
    }

    // Nothing specific is known about this point, so nothing will be written
    // and nothing charged — checked before the quota so it costs no daily slot
    // either. The app skips it in silence: a stop with nothing to say is not a
    // stop.
    const grounding = await groundingFor(input, lookup);
    if (!grounding) {
      return NextResponse.json({ poiKey: lookup.poiKey, text: null, reason: 'no-sources' });
    }

    // From here on each call to a model or a voice passes the limits in
    // lib/aiLimits, set by the admin. A person over their share of the voice
    // still gets the text, read by the phone; over every text engine's share,
    // the answer below.
    let result;
    try {
      result = await generateNarration(input, lookup, provider, grounding);
    } catch (e) {
      if (!isAiLimitError(e)) throw e;
      return NextResponse.json(
        {
          error: bearerToken(request)
            ? 'הגעת למגבלה היומית של קריינויות חדשות. נקודות ששמעת כבר ימשיכו לעבוד — נסה שוב מחר.'
            : 'הגעת למגבלה היומית להתנסות ללא התחברות. התחבר עם Google לקבלת מגבלה גדולה יותר.',
        },
        { status: 429 }
      );
    }
    if (!result) {
      return NextResponse.json({ poiKey: lookup.poiKey, text: null, reason: 'no-sources' });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('AI Guide Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Every AI call made while answering is logged under this area and the caller
// (see lib/aiUsage).
export function POST(request: Request) {
  return withAiUsage(request, 'guide', () => handlePost(request));
}
