// The streams worth walking into in an Israeli summer, by name.
//
// This is a hand-written list, and it is hand-written on purpose. The obvious
// automatic answer is to read OSM's `intermittent` tag and keep whatever is not
// marked seasonal. Counted over the whole country that leaves 1,536 named
// stream ways, and the list is worthless: not one of them carries a positive
// `intermittent=no`, 64% carry no name at all, and what is named includes נחל
// קדרון and נחל חברון — both of which run year round because they carry
// sewage. Absence of a tag is absence of information, never permission.
//
// The tag is unreliable in the other direction too, which is the part that
// decides how this file is used. Measured against Overpass, OSM marks
// `intermittent=yes` on 26 of 34 ways of נחל כזיב, 24 of 28 of נחל ערוגות,
// 22 of 25 of נחל פרת and all 6 of נחל דוד — four of the best-known perennial
// water hikes in the country. So for a named stream this list *overrides*
// `intermittent`; see waterSources.ts, where the tag stays an absolute block
// for everything else.
//
// Same reasoning as niqqud.ts: where the automatic data is not good enough, a
// short table a person can read and check beats a clever guess.
//
// Criterion for inclusion: it flows in summer AND you can get into it. Flowing
// is not enough on its own.
//
// LIMITATION, stated because it will bite someone: the list is by stream name,
// not by segment. A stream that only holds water along its lower reach is
// marked along its dry upper reach too. Every entry here was checked to match
// a real OSM name string (Overpass, whole-country query) — an entry that
// matches nothing is not a safe entry, it is a silent no-op.

import { stripNiqqud } from './hebrewMarks';

// Names as OSM actually spells them, verified against Overpass. Grouped the way
// a walker thinks about the country rather than alphabetically.
//
// Deliberately NOT here, though they were in the first draft: מיצר, צלמון,
// חרוד, תבור, ציפורי, תנינים, נעמן, אורן, בוקק. Borderline entries make the
// whole list less trustworthy, and a shorter list that is right is worth more
// than a long one that has to be argued about.
const PERENNIAL: Record<string, string[]> = {
  // Golan and Hermon — the headwaters of the Jordan, and the Golan canyons.
  'חרמון/גולן': [
    'נחל דן',
    'נחל חרמון',      // OSM's name for the Banias; "בניאס" appears only in name:ar
    'נחל שניר',       // tagged 'נחל שניר (חצבני)' on most ways
    'נחל עיון',
    'נחל יהודיה',
    'נחל זויתן',      // OSM spells it with one ו
    'נחל משושים',
    'נחל דליות',
    'נחל אל על',
    'נחל גילבון',
    'נחל גמלא',
  ],
  // Galilee.
  'גליל': [
    'נחל כזיב',
    'נחל עמוד',
  ],
  // Beit She'an valley.
  'עמקים': [
    'נחל עמל',        // the Asi, at Gan HaShlosha; OSM: 'נחל עמל (האסי)'
  ],
  // Judean desert — the canyons that hold water all year.
  'מדבר יהודה': [
    'נחל דוד',
    'נחל ערוגות',
    'נחל פרת',        // Wadi Qelt; OSM carries 'קלט' only as an alternate name
  ],
};

// Spellings that are not OSM's but that a person — or another data source —
// might reasonably write. Kept apart from the list above so that list stays a
// clean statement of which streams are included.
const ALIASES: Record<string, string> = {
  'נחל בניאס': 'נחל חרמון',
  'הבניאס': 'נחל חרמון',
  'בניאס': 'נחל חרמון',
  'נחל חצבני': 'נחל שניר',
  'נחל זוויתן': 'נחל זויתן',
  'נחל האסי': 'נחל עמל',
  'האסי': 'נחל עמל',
  'ואדי קלט': 'נחל פרת',
  'נחל קלט': 'נחל פרת',
};

// OSM names arrive with vowel points, with either kind of parenthetical suffix
// ('נחל שניר (חצבני)', 'נחל דן (מחולק)'), with a maqaf where a space would do,
// and with stray double spaces. All of those are the same stream, so they are
// flattened before comparison rather than being listed as separate entries.
//
// Stripping the parenthesis is what makes 'נחל עמל (האסי)' match 'נחל עמל'. It
// can only ever widen a match to a name already on the list, so it cannot let
// an unlisted stream through.
function normalize(name: string): string {
  return stripNiqqud(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[־–—-]/g, ' ')
    .replace(/["'׳״’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CANONICAL = new Map<string, string>();
for (const [region, names] of Object.entries(PERENNIAL)) {
  for (const name of names) CANONICAL.set(normalize(name), region);
}
const ALIAS_LOOKUP = new Map(
  Object.entries(ALIASES).map(([from, to]) => [normalize(from), normalize(to)])
);

// True when a waterway with this name is one we are prepared to point someone
// at in August. Everything not on the list is false, including streams that
// flow all year — נחל קדרון and נחל חברון flow because of what is in them.
export function isPerennialStream(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = normalize(name);
  return CANONICAL.has(n) || CANONICAL.has(ALIAS_LOOKUP.get(n) ?? '');
}

// Every accepted name, for the build-time review pass that reads the filter
// output by eye.
export function perennialStreamNames(): string[] {
  return Object.values(PERENNIAL).flat();
}
