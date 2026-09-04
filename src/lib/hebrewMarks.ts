// The Hebrew combining marks, in one place because both the vowel-point table
// and the Nakdan client need them, and importing one from the other would make
// the two modules circular.
//
// Written as explicit escapes rather than a literal class: the marks are
// invisible in source, and a plain U+0591–U+05C7 range silently swallows the
// four characters in that block that are punctuation rather than marks —
// U+05BE maqaf, U+05C0 paseq, U+05C3 sof pasuq and U+05C6 nun hafukha.
// Removing those would change the text rather than un-vocalize it, which
// matters here: Nakdan's output is accepted only if stripping the marks gives
// back exactly what was sent, and a swallowed maqaf made that check reject
// perfectly good output.
const NIQQUD_MARKS = /[֑-ׇֽֿׁׂׅׄ]/g;

export function stripNiqqud(text: string): string {
  return text.replace(NIQQUD_MARKS, '');
}

export function hasNiqqud(text: string): boolean {
  NIQQUD_MARKS.lastIndex = 0;
  return NIQQUD_MARKS.test(text);
}
