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

import { hasNiqqud, stripNiqqud } from './hebrewMarks';

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
// being its reading in context. Field names have moved between versions, and
// the shape could not be verified from the machine this was written on, so the
// reader is deliberately permissive: it takes the best string it can find and
// leaves the judging to the round-trip check below, which is the real guard.
// Returning an empty string for a token it cannot read is safe — the check
// then rejects the whole response rather than speaking a mangled sentence.
function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const key of ['w', 'word', 'vocalized', 'nakdan', 'text', 'val', 'value']) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === 'string' && inner.length > 0) return inner;
    }
  }
  return null;
}

function readToken(token: unknown, depth = 0): string {
  if (typeof token === 'string') return token;
  if (!token || typeof token !== 'object') return '';
  const t = token as Record<string, unknown>;

  const original =
    typeof t.word === 'string' ? t.word
    : typeof t.orig === 'string' ? t.orig
    : typeof t.text === 'string' ? t.text
    : '';

  if (t.sep === true || t.isSep === true) return original;

  for (const field of ['options', 'nakdanOptions', 'opts']) {
    const list = t[field];
    if (!Array.isArray(list) || list.length === 0) continue;
    const picked = firstString(list[0]);
    // Some versions mark a morphological split inside the option with a pipe.
    if (picked) return picked.replace(/\|/g, '');
  }

  // No option list at all: take a string the token carries that is actually
  // vocalized. Testing for marks rather than just for Hebrew matters — a token
  // usually carries the original spelling too, and it comes first.
  for (const value of Object.values(t)) {
    if (typeof value === 'string' && hasNiqqud(value)) return value.replace(/\|/g, '');
  }

  // The live service wraps each entry one level deeper than the shape this was
  // first written against: `{"data":[{"nakdan":{"word":…,"options":[…]}}]}`.
  // Rather than special-case the key, step into a nested object and read that.
  if (depth < 2) {
    for (const value of Object.values(t)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const inner = readToken(value, depth + 1);
        if (inner) return inner;
      }
    }
  }

  return original;
}

// The tokens live under a different key in each version, and at least one
// version double-encodes the body as a JSON string. Rather than enumerate,
// take the first array of objects found near the top.
function tokensOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const field of ['tokens', 'data', 'result', 'results', 'output']) {
      const value = d[field];
      if (Array.isArray(value)) return value;
    }
    for (const value of Object.values(d)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') return value;
    }
  }
  return null;
}

// `raw` carries a truncated sample of whatever Nakdan actually returned. It is
// the whole point of the settings check: the response shape could not be
// verified from a machine that cannot reach DICTA at all, so when the reader
// above does not recognise it, the app has to be able to show what it got.
export type DictaResult = { text: string } | { error: string; raw?: string };

function sample(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 900 ? text.slice(0, 900) + '…' : text;
  } catch {
    return String(value).slice(0, 900);
  }
}

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

  const body = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(body);
    // At least one version returns the payload as a JSON-encoded string.
    if (typeof data === 'string') data = JSON.parse(data);
  } catch {
    return { error: 'Nakdan החזיר תשובה שאינה JSON', raw: sample(body) };
  }

  const tokens = tokensOf(data);
  if (!tokens || tokens.length === 0) {
    return { error: 'תשובת Nakdan לא הכילה טוקנים', raw: sample(data) };
  }

  // Not `tokens.map(readToken)`: map passes the index as the second argument,
  // which lands in `depth` and switches the unwrapping off from the third
  // token onward.
  const vocalized = tokens.map((token) => readToken(token)).join('');
  if (!vocalized.trim()) {
    return { error: 'מבנה תשובה לא מוכר מ-Nakdan', raw: sample(data) };
  }

  if (letters(vocalized) !== letters(text)) {
    // Never worth risking: the guide would read words nobody wrote.
    return {
      error: 'Nakdan החזיר טקסט שאינו זהה למקור מלבד הניקוד — התוצאה נפסלה',
      raw: sample(data),
    };
  }

  return { text: vocalized };
}
