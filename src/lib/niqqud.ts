// Vowel points for the geographic vocabulary of Israeli trails.
//
// Hebrew is normally written without niqqud, which leaves the vowels for the
// reader to infer from context. A TTS model has to guess, and on trail names it
// guesses wrong in the same few places every time: עין is read as "ayin" (an
// eye) instead of "ein" (a spring of), נחל as "nechel" instead of "nachal".
//
// What this fixes is the *generic* half of a name — the נחל, the עין, the
// חורבת — which is the half that repeats on every trail and so is worth getting
// right once. It deliberately does not touch the proper noun that follows
// (כזיב, צאלים, עתרי): vowelizing arbitrary Hebrew names correctly needs a
// dedicated model, not a lookup table, and a wrong guess there would be worse
// than no guess at all.
//
// Applied at synthesis time rather than when the narration is written, so the
// stored text stays plain readable Hebrew and this table can improve without
// regenerating a single narration.

// Bumping this re-renders audio, because it is part of the voice signature.
// Raise it whenever the table below changes.
export const NIQQUD_VERSION = 1;

// Only the words whose mispronunciation is audible and common. Each is the form
// as it appears in a name — construct forms (עֵין, חֻרְבַּת, מְעָרַת) included,
// since that is how they actually occur.
const LEXICON: Record<string, string> = {
  // water
  'נחל': 'נַחַל',
  'עין': 'עֵין',
  'מעיין': 'מַעְיָן',
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

// A Hebrew word already carrying vowel points is left alone: whoever put them
// there — a source, or a future model — knew more than this table does.
const NIQQUD_MARK = /[֑-ׇ]/;

// Matches a run of Hebrew letters, so the lookup happens on whole words only
// and never inside one.
const HEBREW_WORD = /[א-ת]+/g;

export function applyNiqqud(text: string): string {
  return text.replace(HEBREW_WORD, (word, offset: number, whole: string) => {
    // Cheap guard: if this word is followed immediately by a mark, it is
    // already vowelized.
    if (NIQQUD_MARK.test(whole.slice(offset, offset + word.length + 1))) return word;
    return LEXICON[word] ?? word;
  });
}

// True when the text contains at least one word this table would change —
// used to report whether it did anything, rather than claiming it did.
export function niqqudWouldApply(text: string): boolean {
  return applyNiqqud(text) !== text;
}
