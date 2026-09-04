import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { classifyElevenLabsError } from '../../../../lib/elevenlabsErrors';

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
}

// The list changes rarely and the panel refetches on every open, so a short
// process-memory cache keeps repeated opens off the API entirely.
let cache: { at: number; voices: VoiceChoice[] } | null = null;
const CACHE_MS = 5 * 60_000;

export async function GET(request: Request) {
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
    return NextResponse.json({ voices: cache.voices, cached: true });
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
    return NextResponse.json({ voices, cached: false });
  } catch (error: any) {
    console.error('ElevenLabs voices failed:', error);
    return NextResponse.json({ error: error.message, voices: [] }, { status: 502 });
  }
}
