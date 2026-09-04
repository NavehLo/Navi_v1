// DICTA's Nakdan — Hebrew diacritization.
//
// The lexicon in lib/niqqud can only fix the words it lists, and it lists the
// generic half of trail names. It cannot reach a proper noun, and it cannot
// reach ordinary vocabulary: חקלאות and שלווה were read wrong and there is no
// table size that changes that. Nakdan is a model trained on manually
// vocalized modern Hebrew, and vocalizes the whole sentence.
//
// Free, keyless and public, which is what makes it usable here. It is also
// somebody else's service, so every call is treated as optional: short
// timeout, one attempt, and a hard fall back to the lexicon on any failure.
//
// The endpoint is an env var because DICTA versions it in the hostname
// (nakdan-5-1, nakdan-u1-0, …) and rolls it forward; pointing at a new one
// must not need a code change.
//
// SAFETY: the response is verified before it is used. Strip the vowel points
// back off, and it has to equal what we sent. Nakdan may only add marks — if
// the letters came back different, for any reason, the result is discarded
// and the lexicon answers instead. That is what keeps a service we do not
// control from putting words in the guide's mouth.

import { stripNiqqud } from './hebrewMarks';

const DEFAULT_ENDPOINT = 'https://nakdan-5-1.loadbalancer.dicta.org.il/api';
const TIMEOUT_MS = 6000;
const MAX_CHARS = 4000;

export function dictaEndpoint(): string {
  return process.env.DICTA_NAKDAN_URL || DEFAULT_ENDPOINT;
}

// Only the letters matter for the comparison. A maqaf may legitimately replace
// a space when Nakdan joins two words, and whitespace runs are not meaningful.
function letters(text: string): string {
  return stripNiqqud(text).replace(/[־\s]+/g, ' ').trim();
}

// Nakdan returns one entry per token. A token is either a separator (spaces
// and punctuation, passed through) or a word with ranked options, the first
// being its reading in context. The exact field names have moved between
// versions, so each shape it has used is accepted and anything unrecognised
// falls back to the original token.
function readToken(token: unknown): string | null {
  if (typeof token === 'string') return token;
  if (!token || typeof token !== 'object') return null;
  const t = token as Record<string, unknown>;
  const original = typeof t.word === 'string' ? t.word : typeof t.orig === 'string' ? t.orig : typeof t.text === 'string' ? t.text : '';
  if (t.sep === true || t.isSep === true) return original;

  const options = Array.isArray(t.options) ? t.options : Array.isArray(t.nakdanOptions) ? t.nakdanOptions : [];
  const first: unknown = options[0];
  const option = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  const vocalized =
    typeof first === 'string' ? first : option ? (option.w ?? option.word ?? option.vocalized) : null;

  // Some versions mark a morphological split inside the option with a pipe.
  return typeof vocalized === 'string' && vocalized.length > 0 ? vocalized.replace(/\|/g, '') : original || null;
}

function tokensOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const field of ['tokens', 'data', 'result', 'results']) {
      const value = d[field];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

export type DictaResult = { text: string } | { error: string };

export async function vocalizeWithDicta(text: string): Promise<DictaResult> {
  if (!text.trim()) return { text };
  if (text.length > MAX_CHARS) return { error: `הטקסט ארוך מ-${MAX_CHARS} תווים` };

  let res: Response;
  try {
    res = await fetch(dictaEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        task: 'nakdan',
        data: text,
        genre: 'modern',
        addmorph: false,
        keepqq: false,
        keepmetagim: false,
        nodageshvowel: false,
        patachma: false,
        useTokenization: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Timeout, DNS, a blocked egress — all the same to the caller.
    const err = e as { name?: string; message?: string };
    return { error: `הבקשה ל-Nakdan נכשלה: ${err?.name === 'TimeoutError' ? 'פסק זמן' : err?.message || String(e)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { error: `Nakdan ${res.status}: ${body.slice(0, 200) || res.statusText}` };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { error: 'Nakdan החזיר תשובה שאינה JSON' };
  }

  const tokens = tokensOf(data);
  if (!tokens || tokens.length === 0) return { error: 'תשובת Nakdan לא הכילה טוקנים' };

  const parts: string[] = [];
  for (const token of tokens) {
    const part = readToken(token);
    if (part === null) return { error: 'מבנה תשובה לא מוכר מ-Nakdan' };
    parts.push(part);
  }
  const vocalized = parts.join('');

  if (letters(vocalized) !== letters(text)) {
    // Never worth risking: the guide would read words nobody wrote.
    return { error: 'Nakdan החזיר טקסט שאינו זהה למקור מלבד הניקוד — התוצאה נפסלה' };
  }

  return { text: vocalized };
}
