import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { applyLexicon, resolveNiqqudProvider } from '../../../../lib/niqqud';
import { dictaEndpoint, vocalizeWithDicta } from '../../../../lib/dictaNakdan';

// Shows what the vowel-point pass does to a piece of text, without synthesizing
// anything.
//
// Niqqud is invisible from the app: it happens between the stored narration and
// the voice, and if the diacritizer is unreachable the fallback is silent — the
// audio still plays, just read the old way. This endpoint puts both readings on
// screen side by side, costs nothing, and is the fastest way to answer "is
// Nakdan actually running in production?" from the deployed app rather than
// from a machine that may not be able to reach it at all.

const MAX_CHARS = 600;

export async function POST(request: Request) {
  try {
    // DICTA is somebody else's free service; this must not become a way to
    // hammer it.
    if (!(await rateLimit(`niqqud:${clientIp(request)}`, 10, 60_000))) {
      return NextResponse.json({ error: 'יותר מדי בדיקות ניקוד. נסה שוב בעוד רגע.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_CHARS) : '';
    if (!text) return NextResponse.json({ error: 'לא נשלח טקסט לבדיקה.' }, { status: 400 });

    const active = resolveNiqqudProvider();
    const lexicon = applyLexicon(text);
    const dicta = await vocalizeWithDicta(text);

    return NextResponse.json({
      text,
      // The provider a real narration would use right now.
      active,
      lexicon: { text: lexicon, changed: lexicon !== text },
      dicta:
        'text' in dicta
          ? { ok: true, text: dicta.text, changed: dicta.text !== text, error: null }
          : { ok: false, text: null, changed: false, error: dicta.error },
      // Named so a wrong or retired endpoint is visible rather than guessed at.
      endpoint: dictaEndpoint(),
    });
  } catch (error: any) {
    console.error('Niqqud test error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
