import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { resolveTtsVoice, audioKey, synthesize } from '../../../../lib/tts';

// Speaks one fixed sentence so a voice can be judged in the app, in Hebrew,
// without editing an environment variable and redeploying.
//
// The sample text is deliberately fixed and never changes: the audio cache
// keys on (text + voice signature), so hearing the *same* voice again is free,
// and only a genuinely new voice or setting costs credits. It is also short —
// about 90 characters, roughly a cent at v3 pricing.
//
// It carries place names on purpose: Hebrew without niqqud is ambiguous about
// vowels, and proper nouns are where a voice's pronunciation actually breaks.

const SAMPLE_TEXT =
  'שלום, אני המדריכה של נָבִי. לפנינו מעיין עין חמד, ומעליו מתנשאת חורבת סעדים מהתקופה הביזנטית.';

export async function POST(request: Request) {
  try {
    // Each miss is a paid synthesis, so this is capped tighter than narration.
    if (!(await rateLimit(`voicetest:${clientIp(request)}`, 12, 60_000))) {
      return NextResponse.json({ error: 'יותר מדי בדיקות קול. נסה שוב בעוד רגע.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const voice = resolveTtsVoice('openai', body.voice ?? null);
    if (!voice) {
      return NextResponse.json(
        { error: 'לא הוגדר ספק קול בשרת. בדוק את ELEVENLABS_API_KEY ו-ELEVENLABS_VOICE_ID.' },
        { status: 400 }
      );
    }

    const key = audioKey(SAMPLE_TEXT, voice);
    const cached = sampleCache.get(key);
    if (cached) {
      return NextResponse.json({
        text: SAMPLE_TEXT,
        audio: cached.buffer.toString('base64'),
        audioFormat: cached.format,
        provider: voice.provider,
        voiceId: voice.voice,
        niqqud: !!voice.niqqud,
        cached: true,
      });
    }

    const { speech, error } = await synthesize(SAMPLE_TEXT, voice, body.voice ?? null);
    if (!speech) {
      // The provider's own words, not a guess. A rejected setting, a bad voice
      // id, an expired key and an empty balance all used to read the same.
      return NextResponse.json(
        { error: 'ייצור הקול נכשל.', detail: error, voiceId: voice.voice, provider: voice.provider },
        { status: 502 }
      );
    }

    if (sampleCache.size > 30) sampleCache.delete(sampleCache.keys().next().value!);
    sampleCache.set(key, { buffer: speech.buffer, format: speech.format });

    return NextResponse.json({
      text: SAMPLE_TEXT,
      audio: speech.buffer.toString('base64'),
      audioFormat: speech.format,
      provider: voice.provider,
      voiceId: voice.voice,
      niqqud: !!voice.niqqud,
      degraded: speech.degraded ?? null,
      cached: false,
    });
  } catch (error: any) {
    console.error('Voice test error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Samples are small and few; keeping them in process memory means re-hearing a
// voice you already tried on this instance costs nothing at all.
const sampleCache = new Map<string, { buffer: Buffer; format: string }>();
