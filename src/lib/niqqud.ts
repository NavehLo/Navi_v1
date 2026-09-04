// Vowel points before the text reaches the voice.
//
// Hebrew is normally written without niqqud, which leaves the vowels for the
// reader to infer from context. A TTS model has to guess, and it guesses wrong
// in ways that change the word outright: מהר מירון (מ + הר מירון, "from Mount
// Meron") comes out as *maher*, "quickly".
//
// Two providers, in order of how much they can actually fix:
//
//   'dicta'   — DICTA's Nakdan, a Hebrew diacritization model. Vocalizes the
//               whole sentence, proper nouns and ordinary vocabulary alike,
//               and is the only one of the two that can reach a word like
//               חקלאות or שלווה. Needs a network call; falls back to the
//               lexicon on any failure.
//   'lexicon' — the table below. No network, no cost, and no coverage beyond
//               the geographic vocabulary it lists.
//
// Applied at synthesis time rather than when the narration is written, so the
// stored text stays plain readable Hebrew and this can improve without
// regenerating a single narration.

import { hasNiqqud } from './hebrewMarks';
import { vocalizeWithDicta } from './dictaNakdan';

export { hasNiqqud, stripNiqqud } from './hebrewMarks';

// Bumping this re-renders audio, because it is part of the voice signature.
// Raise it whenever anything below changes the reading.
//
// 2: single-letter prefixes (מהר, הנחל, ומעלה) are vocalized too, and a
//    provider can be chosen — the provider is part of the signature as well.
export const NIQQUD_VERSION = 2;

export type NiqqudProvider = 'lexicon' | 'dicta';

// Only the words whose mispronunciation is audible and common. Each is the form
// as it appears in a name — construct forms (עֵין, חֻרְבַּת, מְעָרַת) included,
// since that is how they actually occur.
const LEXICON: Record<string, string> = {
  // water
  'נחל': 'נַחַל',
  'עין': 'עֵין',
  'מעיין': 'מַעְיָן',
  // Also spelled without the second yud. Listed so the whole-word reading
  // ("a spring") wins over the prefix reading ("from the spring of"), which
  // the rules below would otherwise produce.
  'מעין': 'מַעְיָן',
  'מפל': 'מַפַּל',
  'מפלי': 'מַפְּלֵי',
  'גב': 'גֶּב',
  'גבי': 'גְּבֵי',
  'באר': 'בְּאֵר',
  'בורות': 'בּוֹרוֹת',
  'בריכת': 'בְּרֵכַת',
  'בריכות': 'בְּרֵכוֹת',
  // relief
  'הר': 'הַר',
  'הרי': 'הָרֵי',
  'מעלה': 'מַעֲלֵה',
  'מצפה': 'מִצְפֶּה',
  'מצפור': 'מִצְפּוֹר',
  'גיא': 'גֵּיא',
  'עמק': 'עֵמֶק',
  'בקעת': 'בִּקְעַת',
  'מכתש': 'מַכְתֵּשׁ',
  'נקיק': 'נָקִיק',
  'קניון': 'קַנְיוֹן',
  'סדק': 'סֶדֶק',
  'סדקי': 'סִדְקֵי',
  'מדבר': 'מִדְבָּר',
  'רמת': 'רָמַת',
  'צוק': 'צוּק',
  'צוקי': 'צוּקֵי',
  // built and historic
  'חורבת': 'חֻרְבַּת',
  'חורבה': 'חֻרְבָּה',
  'תל': 'תֵּל',
  'מבצר': 'מִבְצָר',
  'מערת': 'מְעָרַת',
  'מערה': 'מְעָרָה',
  'מנזר': 'מִנְזָר',
  'אנדרטה': 'אַנְדַּרְטָה',
  'אנדרטת': 'אַנְדַּרְטַת',
  'קבר': 'קֶבֶר',
  'טחנת': 'טַחֲנַת',
  'טחנות': 'טַחֲנוֹת',
  'שריד': 'שָׂרִיד',
  'שרידי': 'שְׂרִידֵי',
  // vegetation and land
  'יער': 'יַעַר',
  'חורש': 'חֹרֶשׁ',
  'שמורת': 'שְׁמוּרַת',
  'בוסתן': 'בֻּסְתָּן',
  // route words
  'שביל': 'שְׁבִיל',
  'דרך': 'דֶּרֶךְ',
  'מסלול': 'מַסְלוּל',
  'צומת': 'צֹמֶת',
};

// Matches a run of Hebrew letters, so the lookup happens on whole words only
// and never inside one.
const HEBREW_WORD = /[א-ת]+/g;

// Letters that cannot carry a dagesh. Which branch of a prefix rule applies
// turns on this, and on nothing else — which is what makes these two prefixes
// safe to attach without knowing the sentence.
const GUTTURAL = /[אהחער]/;

const DAGESH = 'ּ';

// A dagesh goes on the letter, before its vowel: נ + ּ + ַ renders as נַּ.
function withDagesh(vocalized: string): string {
  return vocalized[0] + DAGESH + vocalized.slice(1);
}

// ב, כ and ל are deliberately absent: "בנחל" is either בְּנַחַל or בַּנַּחַל
// depending on whether the definite article is folded into the prefix, and the
// unvocalized text does not say which. Guessing there would trade one wrong
// reading for another. מ and ה (before a non-guttural) are determined by the
// stem alone.
function attachPrefix(letter: string, stem: string): string | null {
  const vocalized = LEXICON[stem];
  if (!vocalized) return null;
  const guttural = GUTTURAL.test(stem[0]);
  if (letter === 'מ') return guttural ? 'מֵ' + vocalized : 'מִ' + withDagesh(vocalized);
  if (letter === 'ה' && !guttural) return 'הַ' + withDagesh(vocalized);
  return null;
}

// ו is שורוק before ב, ו, מ and פ, and שווא everywhere else.
function attachVav(rest: string): string {
  return /^[בומפ]/.test(rest) ? 'וּ' : 'וְ';
}

// The word as it should be read, or null if this table has nothing to say
// about it. A whole-word entry always wins over a prefix reading.
function vocalizeWord(word: string, allowVav = true): string | null {
  const whole = LEXICON[word];
  if (whole) return whole;

  if (word.length >= 3) {
    const prefixed = attachPrefix(word[0], word.slice(1));
    if (prefixed) return prefixed;
  }

  if (allowVav && word.length >= 3 && word[0] === 'ו') {
    const rest = vocalizeWord(word.slice(1), false);
    if (rest) return attachVav(word.slice(1)) + rest;
  }

  return null;
}

export function applyLexicon(text: string): string {
  return text.replace(HEBREW_WORD, (word, offset: number, whole: string) => {
    // Cheap guard: a word already followed by a mark is already vocalized, and
    // whoever put the marks there — a source, or Nakdan — knew more than this
    // table does.
    if (hasNiqqud(whole.slice(offset, offset + word.length + 1))) return word;
    return vocalizeWord(word) ?? word;
  });
}

// Kept for callers that only want to know whether the table would do anything.
export function niqqudWouldApply(text: string): boolean {
  return applyLexicon(text) !== text;
}

// Which provider a synthesis will use. DICTA by default: it fails soft, and a
// failure lands on exactly the lexicon result we would otherwise have had.
export function resolveNiqqudProvider(): NiqqudProvider {
  return process.env.NIQQUD_PROVIDER?.toLowerCase() === 'lexicon' ? 'lexicon' : 'dicta';
}

export interface NiqqudOutcome {
  text: string;
  // What actually produced the text — 'lexicon' when DICTA was asked and could
  // not answer, so the app never claims a diacritizer ran when it did not.
  provider: NiqqudProvider;
  requested: NiqqudProvider;
  changed: boolean;
  error: string | null;
}

export async function vocalize(text: string, requested: NiqqudProvider): Promise<NiqqudOutcome> {
  if (requested === 'dicta') {
    const result = await vocalizeWithDicta(text);
    if ('text' in result) {
      return { text: result.text, provider: 'dicta', requested, changed: result.text !== text, error: null };
    }
    const fallback = applyLexicon(text);
    return { text: fallback, provider: 'lexicon', requested, changed: fallback !== text, error: result.error };
  }
  const out = applyLexicon(text);
  return { text: out, provider: 'lexicon', requested, changed: out !== text, error: null };
}
