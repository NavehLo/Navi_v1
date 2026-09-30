import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { classifyElevenLabsError } from '../../../../lib/elevenlabsErrors';
import { areLibraryVoicesBlocked, isVoiceUnusable } from '../../../../lib/elevenlabs';

// Lists the voices this ElevenLabs account can actually use.
//
// Picking a voice from the Voice Library on the website and pasting its id
// here fails on the free plan with a 402: library voices are usable in their
// web player but not through the API. Which voices *are* usable depends on the
// plan, and hardcoding a guessed list of "safe" ids would just move the
// guessing into the code. Asking the account is accurate by construction.
//
// The key stays server-side; only names and public voice ids come back.

const VOICES_URL = 'https://api.elevenlabs.io/v1/voices';

export interface VoiceChoice {
  id: string;
  name: string;
  category: string | null; // premade | cloned | professional | generated
  labels: Record<string, string>;
  previewUrl: string | null;
  // This account was actually refused this voice — not a guess from its
  // category, but a 402 the server has already received for it. The picker
  // can then say so instead of offering a voice that will be silently
  // replaced by the fallback.
  refused?: boolean;
}

// The list changes rarely and the panel refetches on every open, so a short
// process-memory cache keeps repeated opens off the API entirely.
let cache: { at: number; voices: VoiceChoice[] } | null = null;
const CACHE_MS = 5 * 60_000;

// Refusals are read at response time rather than stored in the cache: the
// list of voices changes rarely, but a voice becomes known-refused the moment
// someone tries it.
//
// Once any voice has come back 402, the plan is known not to allow library
// voices at all, and every non-premade voice in the list is marked — waiting
// for each one to be tried in turn would mean a silent narration per voice.
// 'premade' is the only category every plan may drive over the API.
function withRefusals(voices: VoiceChoice[]): VoiceChoice[] {
  const blocked = areLibraryVoicesBlocked();
  return voices.map((v) =>
    isVoiceUnusable(v.id) || (blocked && v.category !== 'premade')
      ? { ...v, refused: true }
      : v
  );
}

export async function GET(request: Request) {
  // One of the admin's tuning tools (settings → מתקדם); see isAdminRequest.
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  if (!(await rateLimit(`voices:${clientIp(request)}`, 20, 60_000))) {
    return NextResponse.json({ error: 'יותר מדי בקשות. נסה שוב בעוד רגע.' }, { status: 429 });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: 'לא הוגדר ELEVENLABS_API_KEY בשרת.', voices: [] },
      { status: 400 }
    );
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json({ voices: withRefusals(cache.voices), cached: true });
  }

  try {
    const res = await fetch(VOICES_URL, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 400);
      console.error('ElevenLabs voices error:', res.status, detail);
      // A scoped key is the common case here: one allowed to synthesize speech
      // but not to list voices, which empties the picker while narration works.
      const { reason, hint } = classifyElevenLabsError(res.status, detail);
      return NextResponse.json(
        { error: `ElevenLabs ${res.status}`, detail, reason, hint, voices: [] },
        { status: 502 }
      );
    }

    const data = await res.json();
    const voices: VoiceChoice[] = (data.voices ?? [])
      .filter((v: any) => v?.voice_id)
      .map((v: any) => ({
        id: v.voice_id,
        name: v.name ?? v.voice_id,
        category: v.category ?? null,
        labels: v.labels ?? {},
        previewUrl: v.preview_url ?? null,
      }));

    cache = { at: Date.now(), voices };
    return NextResponse.json({ voices: withRefusals(voices), cached: false });
  } catch (error: any) {
    console.error('ElevenLabs voices failed:', error);
    return NextResponse.json({ error: error.message, voices: [] }, { status: 502 });
  }
}
