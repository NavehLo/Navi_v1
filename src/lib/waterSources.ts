// Deciding whether a piece of water on the map is somewhere you can cool off.
//
// This is the safety-critical part of the summer feature, and it is kept apart
// from the Overpass route so it is a pure function of a tag bag and can be
// checked directly — see scripts/checkWaterFilter.mjs.
//
// The thing that makes it safety-critical: 41% of `natural=water` in Israel is
// water you must not go into. Counted over the country, 1,413 reservoir, 235
// wastewater, 205 basin and 114 fishpond. Rendering `natural=water` naively as
// "a place to cool off" would put 235 sewage-treatment ponds on the map as a
// recommendation. The block list below is not a tidy-up, it is the feature.
//
// The second trap is the opposite one: a further 2,115 `natural=water`
// polygons (44%) carry no `water=` subtype at all. They are not safe by
// default — they are unclassified. An unnamed one is dropped outright, and a
// named one is carried through as explicitly unverified rather than as a pool.

import { isPerennialStream } from './perennialStreams';

export type WaterCategory =
  | 'pool'              // a pool you can get into
  | 'pool_unverified'   // natural=water, named, but no water= subtype
  | 'spring'            // a spring — may well be dry in August
  | 'perennial_stream'  // a named stream from the hand-checked list
  | 'sea';

export interface WaterSourceProps {
  category: WaterCategory;
  label: string;        // Hebrew, shown on the map and in the panel
  // False for anything we cannot stand behind: springs, unverified polygons.
  // These still show — they are the best information there is — but they do not
  // count towards "you will find water here".
  confident: boolean;
}

export const WATER_CATEGORIES: Record<WaterCategory, Omit<WaterSourceProps, 'category'>> = {
  pool:             { label: 'בריכה',                 confident: true },
  pool_unverified:  { label: 'בריכה — לא מאומת',      confident: false },
  spring:           { label: 'מעיין',                 confident: false },
  perennial_stream: { label: 'נחל איתן',              confident: true },
  sea:              { label: 'ים',                    confident: true },
};

// `water=` values that mean "you can swim in this".
const SWIMMABLE_WATER = new Set(['pond', 'lake', 'stream_pool', 'lagoon', 'shallow', 'oxbow']);

// `water=` values that mean "do not go in". wastewater is sewage treatment;
// reservoir, basin and fishpond are infrastructure, usually fenced, often
// treated, and never a hiking destination.
const BLOCKED_WATER = new Set([
  'wastewater',
  'reservoir',
  'basin',
  'fishpond',
  'drain',
  'canal',
  'ditch',
  'moat',
  'harbour',
  'wastewater_basin',
  'sewage',
]);

// Names that disqualify whatever carries them.
//
// This exists because of what the whole-country audit turned up: the tags alone
// let through מאגר בזלת, מאגר יקוצה, מאגרי פדיה and מאגר מצר — reservoirs that
// say so in their own name and carry nothing but `natural=water` — along with
// the Arab Potash evaporation pans on the Dead Sea, מעגן מיכאל's fish farm,
// two Yarkon dams, three ornamental fountains and a reverse-osmosis plant.
// A name is weak evidence in general and strong evidence here, because in
// Hebrew these things are named for what they are.
//
// Blocking on a name can only remove sources, never add one, so the cost of a
// false positive is a missing pool and the cost of a miss is someone swimming
// in a potash pan. Run scripts/checkWaterFilter.mjs --audit after editing.
const NAME_BLOCKED = [
  /מאגר/,                    // reservoir — said outright in the name
  /בריכ(ת|ות) דגים|בריכת הדגים/,
  /מזרק/,                    // fountain
  /סכר/,                     // dam
  /טיוב|טיהור|שפכים|קולחין|ביוב/,
  /בריכ(ת|ות) (ה)?חורף/,     // a winter pool is a dry hollow in August
  /בריכת נוי/,               // ornamental
  /\breservoir\b|\bfish\b|\bfountain\b|\bdam\b|\bsewage\b|\bevaporation\b|\bpotash\b/i,
  /البوتاس|تبخر/,
];

function nameBlocked(tags: Record<string, string>): boolean {
  const names = [tags.name, tags['name:he'], tags['name:en'], tags['name:ar']].filter(Boolean).join(' | ');
  return names.length > 0 && NAME_BLOCKED.some((re) => re.test(names));
}

// Tags that disqualify anything at all, whatever else it says about itself.
function isHardBlocked(tags: Record<string, string>): boolean {
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return true;
  if (tags.landuse === 'aquaculture' || tags.aquaculture) return true;
  if (tags.landuse === 'salt_pond' || tags.landuse === 'salt') return true;
  if (tags.salt === 'yes') return true;                  // מלחת סדום is not a swim
  if (tags.man_made && MAN_MADE_BLOCKED.has(tags.man_made)) return true;
  if (tags.basin) return true;                           // basin=detention/infiltration/...
  if (tags.reservoir_type) return true;                  // reservoir_type=sewage/water_storage
  if (tags.amenity === 'fountain' || tags.fountain) return true;
  if (tags.leisure === 'swimming_pool' || tags.leisure === 'water_park') return true;
  if (tags.tourism === 'zoo' || tags.zoo || tags.animal) return true;  // an aquarium enclosure
  if (tags.golf) return true;                            // a water hazard is not a swimming hole
  if (tags.building) return true;
  if (tags.access === 'private' || tags.access === 'no') return true;
  if (tags.swimming === 'no') return true;
  if (nameBlocked(tags)) return true;
  return false;
}

const MAN_MADE_BLOCKED = new Set([
  'wastewater_plant',
  'storage_tank',
  'water_works',
  'reservoir_covered',
  'basin',
  'pumping_station',
  'water_tower',
]);

// Returns what this element is, or null to drop it.
//
// Order matters. The hard blocks run first so that no later branch can talk its
// way past them, and the stream branch runs last because it is the only one
// that is allowed to overrule `intermittent`.
export function classifyWater(tags: Record<string, string>): WaterSourceProps | null {
  if (isHardBlocked(tags)) return null;

  if (tags.natural === 'water') {
    // A seasonal pool is a dry hollow in August, and unlike a named stream
    // there is no hand-checked list saying otherwise, so the tag is believed.
    if (tags.intermittent === 'yes' || tags.seasonal === 'yes') return null;
    const subtype = tags.water;
    if (subtype && BLOCKED_WATER.has(subtype)) return null;
    if (subtype && SWIMMABLE_WATER.has(subtype)) return category('pool');
    if (subtype) return null;  // some other subtype we have not vetted
    // No subtype at all: unclassified, not safe-by-default. Only worth showing
    // if somebody cared enough to name it, and then only as unverified.
    const named = tags['name:he'] || tags.name;
    return named ? category('pool_unverified') : null;
  }

  if (tags.natural === 'spring') {
    // Springs are shown with their own label saying we do not know whether
    // they hold water in summer — only 25 of 982 springs in the country carry
    // any seasonal tag at all, so the tag's absence says nothing.
    if (tags.intermittent === 'yes' || tags.seasonal === 'yes') return null;
    return category('spring');
  }

  if (tags.natural === 'coastline' || tags.natural === 'beach') return category('sea');

  if (tags.waterway === 'stream' || tags.waterway === 'river') {
    // The hand-checked list is the only thing that admits a stream, and it
    // deliberately outranks `intermittent` — OSM marks most ways of כזיב,
    // ערוגות, פרת and דוד as seasonal, which they are not. See
    // perennialStreams.ts for the counts behind that decision.
    return isPerennialStream(tags['name:he'] || tags.name) ? category('perennial_stream') : null;
  }

  return null;
}

function category(c: WaterCategory): WaterSourceProps {
  return { category: c, ...WATER_CATEGORIES[c] };
}
