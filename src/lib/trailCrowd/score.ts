// "מה אומרים מטיילים": how busy a world trail is compared with the other
// trails of its country, and how much the people who walked it liked it.
//
// The raw numbers are collected once per trail (collect.ts) and stored in
// public.trail_crowd. Everything a reader sees is derived from them here, and
// only here — the list, the filters and the trail card all call these, so
// they can never disagree. Pure functions: scripts/checkCrowd.mjs runs them.
//
// Change a rule or a threshold → bump CROWD_VERSION only if the *stored*
// numbers change (what is collected or how it is extracted). The tiers are
// computed on read, so a change to them takes effect without re-collecting.

export const CROWD_VERSION = 1;

// One site's numbers for the trail. So far only Komoot: its "best hikes in
// <area>" pages list the area's most walked routes, each with a rating, the
// number of ratings and the number of hikers (see komoot.ts).
export interface CrowdSource {
  site: string;            // "Komoot"
  url: string;             // the page the numbers were read from
  rating: number | null;   // on a 5-point scale; null when the site gives only a count
  count: number;           // ratings behind `rating`
  hikers?: number;         // people who walked it, where the site says
  route?: string;          // the site's name for the route that matched
}

// What is stored for one trail.
export interface CrowdData {
  id: number;
  pageviews: number;       // Wikipedia, every language, the last 24 months; 0 = no article
  sources: CrowdSource[];
  fetchedAt: string;
}

export type Traffic = 'very_high' | 'high' | 'medium' | 'low' | 'very_low';
export const TRAFFIC_ORDER: Traffic[] = ['very_high', 'high', 'medium', 'low', 'very_low'];

// What a list row carries.
export interface CrowdSummary {
  traffic: Traffic | 'unknown';
  // Its place among the country's trails with any signal, 0–1 (1 = the
  // busiest); null without one. Orders the trails within a tier.
  score: number | null;
  // Hikers by the sites' own count (Komoot); null when only Wikipedia knows it.
  hikers: number | null;
  rating: number | null;   // null: fewer than MIN_REVIEWS reviews with a score
  ratingCount: number;
}

// Below this many scored reviews an average says little.
export const MIN_REVIEWS = 5;
// Below this many trails with any signal, "compared with the others in the
// country" compares too few to mean anything. Ten still splits into the five
// tiers (one or two in each end); twenty left Malta, with 14 of its 37 trails
// on Komoot, without any.
export const MIN_SIGNALS = 10;

// Shares of the trails with a signal, busiest first: 10% / 20% / 40% / 20% / 10%.
const TIER_CUTS: Array<[number, Traffic]> = [
  [0.1, 'very_high'],
  [0.3, 'high'],
  [0.7, 'medium'],
  [0.9, 'low'],
  [1, 'very_low'],
];

// The average of the sites' scores, each weighted by its number of reviews.
export function ratingOf(sources: CrowdSource[]): { rating: number | null; count: number } {
  let sum = 0;
  let count = 0;
  for (const s of sources) {
    if (s.rating == null || !(s.count > 0)) continue;
    sum += s.rating * s.count;
    count += s.count;
  }
  if (count < MIN_REVIEWS) return { rating: null, count };
  return { rating: Math.round((sum / count) * 10) / 10, count };
}

export function reviewCount(sources: CrowdSource[]): number {
  return sources.reduce((n, s) => n + (s.count > 0 ? s.count : 0), 0);
}

// How many people walked it, as far as the sites say: their hikers where
// given, else their ratings (fewer, but in proportion).
export function trafficSignal(sources: CrowdSource[]): number {
  return sources.reduce((n, s) => n + Math.max(s.hikers ?? 0, s.count > 0 ? s.count : 0), 0);
}

// Each value's place among the others, 0 (least) to 1 (most); ties share the
// middle of their run. Zeros (no signal of this kind) get no place.
function percentiles(values: Map<number, number>): Map<number, number> {
  const entries = [...values].filter(([, v]) => v > 0).sort((a, b) => a[1] - b[1]);
  const out = new Map<number, number>();
  const n = entries.length;
  if (n === 0) return out;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && entries[j + 1][1] === entries[i][1]) j++;
    const p = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out.set(entries[k][0], p);
    i = j + 1;
  }
  return out;
}

// The tier of every trail in a country, from the stored rows of that
// country. Two signals, each placed among the country's trails that have it:
// how many people walked it by the sites' count, and how often its
// Wikipedia articles are read. A trail counts as busy as the stronger of the two says.
// A trail with neither is 'unknown' — never "few": no information is not
// evidence of few hikers.
export function trafficTiers(rows: CrowdData[]): Map<number, Traffic | 'unknown'> {
  return trafficTiersAndScores(rows).tiers;
}

function trafficTiersAndScores(rows: CrowdData[]): { tiers: Map<number, Traffic | 'unknown'>; scores: Map<number, number> } {
  const reviews = percentiles(new Map(rows.map((r) => [r.id, trafficSignal(r.sources)])));
  const views = percentiles(new Map(rows.map((r) => [r.id, r.pageviews])));

  const scored: Array<[number, number]> = [];
  for (const r of rows) {
    const a = reviews.get(r.id);
    const b = views.get(r.id);
    if (a == null && b == null) continue;
    scored.push([r.id, Math.max(a ?? 0, b ?? 0)]);
  }

  const out = new Map<number, Traffic | 'unknown'>(rows.map((r) => [r.id, 'unknown']));
  const scores = new Map(scored);
  if (scored.length < MIN_SIGNALS) return { tiers: out, scores };

  scored.sort((a, b) => b[1] - a[1]);
  const n = scored.length;
  for (let i = 0; i < n; ) {
    // Equal scores share a tier: the one at the middle of their run, so a
    // country where every trail scores the same is all "average".
    let j = i;
    while (j + 1 < n && scored[j + 1][1] === scored[i][1]) j++;
    const share = (i + j + 1) / 2 / n;
    const tier = TIER_CUTS.find(([cut]) => share < cut)![1];
    for (let k = i; k <= j; k++) out.set(scored[k][0], tier);
    i = j + 1;
  }
  return { tiers: out, scores };
}

export function crowdSummaries(rows: CrowdData[]): Map<number, CrowdSummary> {
  const { tiers, scores } = trafficTiersAndScores(rows);
  const out = new Map<number, CrowdSummary>();
  for (const r of rows) {
    const { rating, count } = ratingOf(r.sources);
    const traffic = tiers.get(r.id) ?? 'unknown';
    const hikers = trafficSignal(r.sources);
    out.set(r.id, {
      traffic, score: traffic === 'unknown' ? null : scores.get(r.id) ?? null,
      hikers: hikers > 0 ? hikers : null, rating, ratingCount: count,
    });
  }
  return out;
}

// ── The leading trails ───────────────────────────────────────────────────────
// "המסלולים המובילים": a country's (or an area's) busiest trails, the same
// everywhere they are shown — the country's list, the country picker and the
// stars on the map. Day walks and long-distance paths apart, and only trails
// hikers were counted on: a long path known only from Wikipedia may be famous
// for something else (Greece's "classic marathon" route is the race's).

export const LEADING_DAY = 10;
export const LEADING_LONG = 3;

// Busiest first; the rating breaks a tie.
export function byTraffic<T extends { crowd?: CrowdSummary }>(a: T, b: T): number {
  const d = (b.crowd?.score ?? -1) - (a.crowd?.score ?? -1);
  return d || (b.crowd?.rating ?? 0) - (a.crowd?.rating ?? 0);
}

export function leadersOf<T extends { crowd?: CrowdSummary; multiDay: boolean }>(trails: T[]): { day: T[]; long: T[] } {
  const ranked = trails.filter((t) => t.crowd && t.crowd.traffic !== 'unknown' && t.crowd.hikers).sort(byTraffic);
  return {
    day: ranked.filter((t) => !t.multiDay).slice(0, LEADING_DAY),
    long: ranked.filter((t) => t.multiDay).slice(0, LEADING_LONG),
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

export const TRAFFIC_LABELS: Record<Traffic, string> = {
  very_high: 'הרבה מאוד מטיילים',
  high: 'הרבה מטיילים',
  medium: 'כמות ממוצעת',
  low: 'מעט מטיילים',
  very_low: 'מעט מאוד מטיילים',
};

// The filter chips: shorter, as they sit under the heading "כמות מטיילים".
export const TRAFFIC_SHORT: Record<Traffic, string> = {
  very_high: 'הרבה מאוד',
  high: 'הרבה',
  medium: 'ממוצע',
  low: 'מעט',
  very_low: 'מעט מאוד',
};

export const NO_CROWD_INFO = 'אין מספיק מידע';
