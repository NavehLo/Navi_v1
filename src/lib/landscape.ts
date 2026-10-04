// "הרים, יער ונהרות": what a country, or an area inside it, looks like — how
// mountainous and how dramatic, how much forest and of what kind, and its
// rivers that flow all year or for a season.
//
// The numbers are built once by scripts/buildLandscape.mjs into
// src/data/landscape.json.gz (read on the server by landscapeData.ts).
// Everything a reader sees is derived from them here, and only here — the
// country list, the areas, the filters and the summary lines all call these,
// so they can never disagree. Pure functions: scripts/checkLandscape.mjs runs
// them against places anybody who walks knows.
//
// "Dramatic" is not height. A high plateau is flat; what makes mountains
// dramatic is how far the ground falls around you. Every ~1 km cell carries
// its relief: the highest point within about 2.5 km minus the lowest. The
// Netherlands come out at 25 m, the Tibetan plateau 500, the Black Forest
// 740, Glencoe 1,065, Zermatt 1,530, the Vikos gorge 1,950.
//
// Change a threshold → run checkLandscape.mjs. The thresholds are applied on
// read, so a change needs no rebuild — but each must be one of the stored
// relief bins (RELIEF_BINS in the build), which the check makes sure of.

export const LANDSCAPE_VERSION = 1;

// What is stored for a country or an area. Shares are in thousandths.
export interface LandscapeSummary {
  area: number;            // km² of land
  relief: number[];        // share of the land in each relief bin (reliefBins: lower edges, m)
  forest: number;          // share that is forest, closed or open
  closed: number;          // share that is closed forest (canopy over 70%)
  types: number[];         // share of the forest of each FOREST_TYPES
  perennial: number;       // share of the land in cells crossed by a river that flows all year
  seasonal: number;        // … by one that flows for a season (and no year-round one)
  ranges: number[];        // GMBA ids of its main mountain ranges, the largest first
}

export interface RangeName {
  en: string;
  he: string | null;
}

export interface LandscapeData {
  version: number;
  reliefBins: number[];
  ranges: Record<string, RangeName>;
}

// ── Mountains ───────────────────────────────────────────────────────────────

export type Relief = 'flat' | 'hills' | 'gentle' | 'mountains' | 'dramatic' | 'veryDramatic';
export const RELIEF_ORDER: Relief[] = ['flat', 'hills', 'gentle', 'mountains', 'dramatic', 'veryDramatic'];

// Where each level starts (m of relief within ~2.5 km). Calibrated on the
// places in checkLandscape.mjs: Jerusalem hills and Makhtesh Ramon are hills,
// the Galilee, the Lake District and the Black Forest gentle mountains, the
// Vosges mountains, Glencoe, the Tatras and Yosemite dramatic, Zermatt, the
// Dolomites' Tre Cime and Lauterbrunnen very dramatic.
export const RELIEF_FROM: Record<Relief, number> = {
  flat: 0,
  hills: 150,
  gentle: 400,
  mountains: 700,
  dramatic: 1000,
  veryDramatic: 1500,
};

export const RELIEF_LABELS: Record<Relief, string> = {
  flat: 'שטוח',
  hills: 'גבעות',
  gentle: 'הרים מתונים',
  mountains: 'הררי',
  dramatic: 'הרים דרמטיים',
  veryDramatic: 'הרים דרמטיים מאוד',
};

// A country or area "has" a kind of landscape when at least this share of
// its land is of it. A tenth is a lot of land — a tenth of Greece is the
// whole of Epirus' high country — and anything less is a corner of the place,
// which the areas inside it then show.
export const MIN_SHARE = 100; // thousandths

// Share (thousandths) of the land with at least `meters` of relief.
export function shareAtLeast(s: LandscapeSummary, bins: number[], meters: number): number {
  let sum = 0;
  bins.forEach((edge, i) => { if (edge >= meters) sum += s.relief[i] ?? 0; });
  return sum;
}

// The highest level that covers at least MIN_SHARE of the land.
export function reliefLevel(s: LandscapeSummary, bins: number[]): Relief {
  for (let i = RELIEF_ORDER.length - 1; i > 0; i--) {
    const level = RELIEF_ORDER[i];
    if (shareAtLeast(s, bins, RELIEF_FROM[level]) >= MIN_SHARE) return level;
  }
  return 'flat';
}

// ── Forest ──────────────────────────────────────────────────────────────────

// In the order the build stores them (Copernicus' forest types). Shown as
// information — "יער 45% מחטני" — not filtered by.
export const FOREST_TYPES = ['needleEvergreen', 'broadEvergreen', 'needleDeciduous', 'broadDeciduous', 'mixed', 'unknown'] as const;
export type ForestType = (typeof FOREST_TYPES)[number];

export const FOREST_LABELS: Record<ForestType, string> = {
  needleEvergreen: 'מחטני',
  broadDeciduous: 'נשיר',
  mixed: 'מעורב',
  broadEvergreen: 'רחב-עלים ירוק-עד',
  needleDeciduous: 'לגש',
  unknown: 'לא ידוע',
};

// What each one means, where the type is shown in full.
export const FOREST_EXPLAINED: Record<Exclude<ForestType, 'unknown'>, string> = {
  needleEvergreen: 'אורן, אשוח, אשוחית — ירוק כל השנה',
  broadDeciduous: 'אשור, אלון, ערמון, מייפל — שלכת בסתיו',
  mixed: 'מחטניים ונשירים יחד',
  broadEvergreen: 'אלון שעם, אלון ירוק-עד, יער גשם — ירוק כל השנה',
  needleDeciduous: 'מחטני שמשיר את מחטיו בסתיו (בעיקר בסיביר ובאלפים)',
};

// Forested: at least a quarter of the land (or of the ground around a
// trail) under trees, closed or open; very: at least half.
export const FORESTED = 250;
export const VERY_FORESTED = 500;
// A type is named when it is at least this share of the forest.
export const TYPE_SHARE = 250;
// Below this much forest, its types are not worth naming.
const MIN_FOREST_FOR_TYPES = 50;

export function mainForestTypes(s: LandscapeSummary): ForestType[] {
  if (s.forest < MIN_FOREST_FOR_TYPES) return [];
  return FOREST_TYPES
    .map((t, i) => [t, s.types[i] ?? 0] as const)
    .filter(([t, share]) => t !== 'unknown' && share >= TYPE_SHARE)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

// ── Rivers ──────────────────────────────────────────────────────────────────

export type Water = 'many' | 'some' | 'few';

// A summary is of a country or area ('area': shares of its land), or of a
// trail ('trail': shares of its length, `area` holding its km).
export type Kind = 'area' | 'trail';

// Of a country or area: the share of its land in ~1 km cells that a river
// crosses. Set against the world's countries (median 16%, top quarter above
// 25%): Switzerland, Slovenia, Montenegro and New Zealand are "many" all
// year; Greece and Spain "some" all year and more with the seasonal ones;
// Israel, Cyprus and Jordan "few" all year.
// Of a trail: the share of its length in a ~1 km cell that a river crosses —
// a tenth of the way beside one is a walk along a river, a thirtieth (a
// kilometre of a 30 km walk) a crossing or two.
const WATER_CUTS: Record<Kind, { many: number; some: number }> = {
  area: { many: 230, some: 70 },
  trail: { many: 100, some: 30 },
};

function waterTier(share: number, kind: Kind): Water {
  const c = WATER_CUTS[kind];
  return share >= c.many ? 'many' : share >= c.some ? 'some' : 'few';
}

export function perennialWater(s: LandscapeSummary, kind: Kind = 'area'): Water {
  return waterTier(s.perennial, kind);
}

// All year or for a season.
export function anyWater(s: LandscapeSummary, kind: Kind = 'area'): Water {
  return waterTier(s.perennial + s.seasonal, kind);
}

// ── Filtering ───────────────────────────────────────────────────────────────

export type ReliefChoice = 'any' | 'mountains' | 'dramatic' | 'veryDramatic';
export type ForestChoice = 'any' | 'forested' | 'veryForested';
export type WaterChoice = 'any' | 'perennial' | 'seasonal';

export interface LandscapeFilter {
  relief: ReliefChoice;
  forest: ForestChoice;
  water: WaterChoice;
}

export const NO_LANDSCAPE_FILTER: LandscapeFilter = { relief: 'any', forest: 'any', water: 'any' };

export function landscapeFilterCount(f: LandscapeFilter): number {
  return (f.relief !== 'any' ? 1 : 0) + (f.forest !== 'any' ? 1 : 0) + (f.water !== 'any' ? 1 : 0);
}

export function passesLandscape(s: LandscapeSummary | undefined, bins: number[], f: LandscapeFilter, kind: Kind = 'area'): boolean {
  if (landscapeFilterCount(f) === 0) return true;
  // Nothing known: filtered out, since the filter asks for something definite.
  if (!s) return false;
  if (f.relief !== 'any' && shareAtLeast(s, bins, RELIEF_FROM[f.relief]) < MIN_SHARE) return false;
  if (f.forest === 'forested' && s.forest < FORESTED) return false;
  if (f.forest === 'veryForested' && s.forest < VERY_FORESTED) return false;
  if (f.water === 'perennial' && perennialWater(s, kind) === 'few') return false;
  if (f.water === 'seasonal' && anyWater(s, kind) === 'few') return false;
  return true;
}

// ── Ordering ────────────────────────────────────────────────────────────────

export type LandscapeSort = 'default' | 'mountains' | 'dramatic' | 'veryDramatic' | 'forest' | 'water' | 'all';
export const LANDSCAPE_SORTS: LandscapeSort[] = ['default', 'mountains', 'dramatic', 'veryDramatic', 'forest', 'water', 'all'];

export const SORT_LABELS: Record<LandscapeSort, string> = {
  default: 'רגיל',
  mountains: 'הכי הררי',
  dramatic: 'הכי דרמטי',
  veryDramatic: 'דרמטי מאוד',
  forest: 'הכי מיוער',
  water: 'הכי הרבה נחלים זורמים',
  all: 'כל הנופים יחד',
};

// "All together", in the order the owner ranks them: mountains half, forest
// three tenths, rivers a fifth. Each part 0–1000: mountains the average of
// the shares at the three mountain levels (so drama counts more than mere
// height of ground), forest its share, rivers the year-round share — and half
// the seasonal — against what counts as "many".
const ALL_WEIGHTS = { mountains: 0.5, forest: 0.3, water: 0.2 };

function waterScore(s: LandscapeSummary, kind: Kind): number {
  return Math.min(1000, ((s.perennial + s.seasonal / 2) * 1000) / WATER_CUTS[kind].many);
}

// What the list is ordered by, 0–1000, the most first.
export function sortValue(s: LandscapeSummary | undefined, bins: number[], sort: LandscapeSort, kind: Kind = 'area'): number {
  if (!s || sort === 'default') return -1;
  switch (sort) {
    case 'mountains': return shareAtLeast(s, bins, RELIEF_FROM.mountains);
    case 'dramatic': return shareAtLeast(s, bins, RELIEF_FROM.dramatic);
    case 'veryDramatic': return shareAtLeast(s, bins, RELIEF_FROM.veryDramatic);
    case 'forest': return s.forest;
    case 'water': return s.perennial;
    case 'all': {
      const m = (shareAtLeast(s, bins, RELIEF_FROM.mountains) + shareAtLeast(s, bins, RELIEF_FROM.dramatic)
        + shareAtLeast(s, bins, RELIEF_FROM.veryDramatic)) / 3;
      return Math.round(ALL_WEIGHTS.mountains * m + ALL_WEIGHTS.forest * s.forest + ALL_WEIGHTS.water * waterScore(s, kind));
    }
  }
}

// The number beside each row while ordered by it: "דרמטי 56%", "ציון נוף 72".
export function sortBadge(s: LandscapeSummary | undefined, bins: number[], sort: LandscapeSort, kind: Kind = 'area'): string | null {
  if (!s || sort === 'default') return null;
  const v = sortValue(s, bins, sort, kind);
  if (sort === 'all') return `ציון נוף ${Math.round(v / 10)}`;
  const of = kind === 'trail' ? 'מהדרך' : 'מהשטח';
  const what: Record<Exclude<LandscapeSort, 'default' | 'all'>, string> = {
    mountains: 'הררי', dramatic: 'דרמטי', veryDramatic: 'דרמטי מאוד', forest: 'יער', water: 'נחלים זורמים',
  };
  return `${what[sort]} ${Math.round(v / 10)}% ${of}`;
}

// ── Words ───────────────────────────────────────────────────────────────────

const pct = (thousandths: number) => `${Math.max(1, Math.round(thousandths / 10))}%`;

// "הרים דרמטיים ב-15% מהשטח", or "שטוח ברובו" — the mountain line in full.
export function reliefLine(s: LandscapeSummary, bins: number[], kind: Kind = 'area'): string {
  const level = reliefLevel(s, bins);
  if (level === 'flat') return 'שטוח ברובו';
  return `${RELIEF_LABELS[level]} ב־${pct(shareAtLeast(s, bins, RELIEF_FROM[level]))} ${kind === 'trail' ? 'מהדרך' : 'מהשטח'}`;
}

// "יער ב-45% מהשטח: מחטני ונשיר", or "כמעט בלי יער".
export function forestLine(s: LandscapeSummary, kind: Kind = 'area'): string {
  if (s.forest < MIN_FOREST_FOR_TYPES) return 'כמעט בלי יער';
  const types = mainForestTypes(s).slice(0, 2).map((t) => FOREST_LABELS[t]);
  const where = kind === 'trail' ? 'מהשטח סביב הדרך' : 'מהשטח';
  return `יער ב־${pct(s.forest)} ${where}${types.length ? `: ${types.join(' ו')}` : ''}`;
}

// The same, short, for a row in a list.
export function reliefShort(s: LandscapeSummary, bins: number[]): string {
  return RELIEF_LABELS[reliefLevel(s, bins)];
}

export function forestShort(s: LandscapeSummary): string {
  if (s.forest < MIN_FOREST_FOR_TYPES) return 'מעט יער';
  const type = mainForestTypes(s)[0];
  return `יער ${pct(s.forest)}${type ? ` ${FOREST_LABELS[type]}` : ''}`;
}

export function waterShort(s: LandscapeSummary, kind: Kind = 'area'): string {
  const all = perennialWater(s, kind);
  const any = anyWater(s, kind);
  if (kind === 'trail') {
    if (all === 'many') return 'לאורך נחל זורם';
    if (all === 'some') return 'עובר ליד נחל זורם';
    if (any !== 'few') return 'ליד נחל עונתי';
    return 'בלי נחלים בדרך';
  }
  if (all === 'many') return 'הרבה נחלים זורמים';
  if (all === 'some') return 'נחלים זורמים';
  return any !== 'few' ? 'נחלים עונתיים' : 'מעט נחלים';
}

// GMBA marks a range with no name of its own "(nn)" ("Peloponnese (nn)": the
// mountains of the Peloponnese) — the place name alone says it.
export function rangeName(data: LandscapeData, id: number): string | null {
  const r = data.ranges[id];
  return r ? (r.he ?? r.en).replace(/\s*\(nn\)$/, '').replace(/ In The Wide Meaning$/i, '') : null;
}
