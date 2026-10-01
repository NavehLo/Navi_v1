// English names for world trails — the pure half, shared by the server and the
// browser. A route in Greece is mapped as "2A - Αγία Μαρίνα – Δανακός" and one
// in Japan in kanji; the original stays the trail's name, and an English one is
// shown beside it so the reader can tell what and where it is.
//
// Only names in a script other than Latin get one. "Tour du Mont Lion" or
// "Rundweg am See" can already be read, and a machine-made English version of
// them would add little but awkwardness.

// A letter that is not Latin. Digits, dashes and the ref in front ("2A - ")
// belong to no script and say nothing either way.
const NON_LATIN_LETTER = /(?![\p{Script=Latin}])\p{L}/u;

export function needsEnglish(name: string | null | undefined): boolean {
  return !!name && NON_LATIN_LETTER.test(name);
}

// What OpenStreetMap itself says, before anyone translates anything: the
// English name when a mapper wrote one, otherwise the international name —
// usually the local name in Latin letters ("2A - Agia Marina – Danakos").
export function englishFromTags(tags: Record<string, string> | null | undefined): string | null {
  if (!tags) return null;
  const en = tags['name:en']?.trim();
  if (en && !needsEnglish(en)) return en;
  const intl = tags.int_name?.trim();
  if (intl && !needsEnglish(intl)) return intl;
  return null;
}

// An English name is only worth showing if it says something the original did
// not — never the same string again.
export function usefulEnglish(name: string | null | undefined, english: string | null | undefined): string | null {
  const en = english?.trim();
  if (!en || needsEnglish(en)) return null;
  if (name && en.toLowerCase() === name.trim().toLowerCase()) return null;
  return en;
}

// The model is asked for a JSON object of id → English name. Models wrap it in
// a code fence, add a sentence before it, or answer with an array; take the
// first object in the text and keep only ids that were asked about, with a
// Latin string for a value.
export function parseTranslations(text: string, ids: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const wanted = new Set(ids);
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = Number(key);
    if (!wanted.has(id) || typeof value !== 'string') continue;
    const en = value.trim().replace(/\s+/g, ' ');
    if (en && en.length <= 200 && !needsEnglish(en)) out[id] = en;
  }
  return out;
}
