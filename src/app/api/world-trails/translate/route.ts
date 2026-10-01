import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { englishNamesFor, MAX_TRANSLATE } from '../../../../lib/trailTranslate';
import { withAiUsage } from '../../../../lib/aiUsage';

// POST {ids: number[]} → {status, names: {[id]: English name}}
//
// English names for world trails whose own name is in a non-Latin script —
// from the shared table when someone has seen the trail before, otherwise
// translated now and filed there. Only ids are accepted; the names are looked
// up on the server (see lib/trailTranslate).
async function handlePost(request: Request) {
  let ids: unknown;
  try {
    ids = (await request.json())?.ids;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TRANSLATE) {
    return NextResponse.json({ error: `ids: 1–${MAX_TRANSLATE} relation ids` }, { status: 400 });
  }

  if (!(await rateLimit(`wmt-en:${clientIp(request)}`, 30, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' }, { status: 429 });
  }

  const names = await englishNamesFor(ids.map(Number));
  return NextResponse.json({ status: 'ok', names });
}

// Every AI call made while answering is logged under this area and the caller
// (see lib/aiUsage).
export function POST(request: Request) {
  return withAiUsage(request, 'trail_translate', () => handlePost(request));
}
