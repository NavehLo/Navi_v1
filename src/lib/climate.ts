// Which months suit a walk, from the climate where it is — "מתי כדאי ללכת".
//
// Seasons do not travel: spring in the Arava is summer on the Hermon and
// winter in the Alps. So each of the twelve months is judged on its own, from
// the long-term averages at the trail's own place and height (TerraClimate
// 1991–2020, read by climateGrid.ts on the server), and on how long the walk
// keeps somebody out there. Pure functions, used on the server for the trail
// card, the world-trail lists and the month-first country list, so all three
// say the same thing. scripts/checkClimate.mjs pins them against known places.
//
// A month gets the worst of four verdicts: heat at the lowest point, cold and
// snow at the highest, rain, and daylight. Changing any rule or threshold here
// means bumping CLIMATE_VERSION — it is part of every cache key, on the device
// and in public.country_trails.

import { heatLoad } from './hikeAdvice';

export const CLIMATE_VERSION = 1;

export type MonthRating = 'good' | 'fair' | 'bad';

export const RATING_LABELS: Record<MonthRating, string> = {
  good: 'עונה מומלצת',
  fair: 'אפשרי בהיערכות',
  bad: 'לא מומלץ',
};

const ORDER: Record<MonthRating, number> = { good: 0, fair: 1, bad: 2 };
export const worse = (a: MonthRating, b: MonthRating): MonthRating => (ORDER[a] >= ORDER[b] ? a : b);

// One month's averages at one point, already moved to that point's height.
export interface MonthClimate {
  tmax: number;   // °C, average daily high
  tmin: number;   // °C, average daily low
  ppt: number;    // mm in the month
  vap: number;    // kPa, average vapour pressure
  swe: number;    // mm of snow water on the ground, month average
}

export interface ClimateInput {
  low: MonthClimate[];    // the trail's lowest (warmest) point, 12 months
  high: MonthClimate[];   // its highest (coldest) point; the same as low on a flat walk
  lat: number;            // for the length of the day
  hours: number;          // time out there, breaks included
}

export interface MonthReason {
  rating: MonthRating;
  text: string;
}

export interface MonthVerdict {
  rating: MonthRating;
  reasons: MonthReason[];   // worst first; a good month has one line saying why
  tmax: number;             // the day's high at the low point, rounded
  tmin: number;             // the night's low at the high point, rounded
  ppt: number;              // mm, rounded
  daylight: number;         // hours, to the half hour
}

// ── Heat ─────────────────────────────────────────────────────────────────────
// The same heat-load index the forecast uses (IMS / IDF: dry and wet-bulb
// averaged), on the month's average high and the humidity that goes with it.
// The month's vapour pressure against the saturation pressure at the high
// gives the afternoon's relative humidity.
function saturation(t: number): number {
  return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
}

function heatLevel(m: MonthClimate): number {
  const rh = Math.max(5, Math.min(100, (m.vap / saturation(m.tmax)) * 100));
  return heatLoad(m.tmax, rh).level;
}

// A long day in the heat is a different thing from an hour's stroll in it:
// past five hours the bar comes down one level, under two it goes up one.
function heatShift(hours: number): number {
  return hours > 5 ? 1 : hours < 2 ? -1 : 0;
}

function judgeHeat(m: MonthClimate, hours: number): MonthReason | null {
  const level = heatLevel(m) + heatShift(hours);
  const t = Math.round(m.tmax);
  if (level >= 4) return { rating: 'bad', text: `חם מאוד: כ-${t}° בצהריים` };
  if (level >= 2) return { rating: 'fair', text: `חם: כ-${t}° בצהריים — לצאת מוקדם` };
  return null;
}

// ── Cold and snow ────────────────────────────────────────────────────────────
// Snow is judged at the top: lying on the ground, it closes a mountain path
// long after the air has warmed (June in the high Alps), so it counts on its
// own; and a wet month whose average is below freezing falls as snow (the
// Hermon in January) whatever is on the ground already. A month-average of a
// few millimetres of snow water is patches in gullies, not a closed path.
// The day's cold is judged halfway up — the top alone would make every
// mountain walk sound colder than the walking is.
const SNOW_BAD_MM = 100;
const SNOW_FAIR_MM = 20;

function judgeCold(top: MonthClimate, dayHigh: number): MonthReason | null {
  const hi = Math.round(dayHigh);
  const lo = Math.round(top.tmin);
  const mean = (top.tmax + top.tmin) / 2;
  if (top.swe >= SNOW_BAD_MM) return { rating: 'bad', text: `שלג על השביל בחלק הגבוה` };
  if (mean <= 0 && top.ppt >= 50) return { rating: 'bad', text: `שלג וקרה בחלק הגבוה (כ-${lo}° בלילה)` };
  if (dayHigh <= 3) return { rating: 'bad', text: `קר מאוד: כ-${hi}° ביום, ${lo}° בלילה` };
  if (top.swe >= SNOW_FAIR_MM || (mean <= 2 && top.ppt >= 30)) return { rating: 'fair', text: `ייתכן שלג בחלק הגבוה` };
  if (dayHigh <= 10) return { rating: 'fair', text: `קר: כ-${hi}° ביום — ביגוד חם` };
  if (top.tmin <= -3) return { rating: 'fair', text: `קרה בלילות: כ-${lo}°` };
  return null;
}

// ── Rain ─────────────────────────────────────────────────────────────────────
// Cold rain soaks and chills and turns paths to mud; a warm month's rain is
// mostly afternoon showers that pass. So the bar is higher when it is warmer —
// otherwise the Alps' and Iceland's wet, perfectly walkable summers would read
// as a warning.
function judgeRain(m: MonthClimate, low: MonthClimate): MonthReason | null {
  const fairAt = low.tmax >= 15 ? 200 : low.tmax >= 10 ? 150 : 100;
  const badAt = low.tmax >= 15 ? 350 : 250;
  const mm = Math.round(m.ppt);
  if (m.ppt >= badAt) return { rating: 'bad', text: `גשום מאוד: כ-${mm} מ״מ בחודש` };
  if (m.ppt >= fairAt) return { rating: 'fair', text: `גשום: כ-${mm} מ״מ בחודש` };
  return null;
}

// ── Daylight ─────────────────────────────────────────────────────────────────
// Length of the day in the middle of the month, from the sun's declination.
export function daylightHours(lat: number, month: number): number {
  const day = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][month];
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (day - 81));
  const x = -Math.tan((lat * Math.PI) / 180) * Math.tan((decl * Math.PI) / 180);
  if (x <= -1) return 24;
  if (x >= 1) return 0;
  return (2 * Math.acos(x) * 180) / Math.PI / 15;
}

function judgeDaylight(daylight: number, hours: number): MonthReason | null {
  // An hour's margin: nobody starts at first light on the dot.
  if (hours + 1 <= daylight) return null;
  const h = Math.round(daylight * 2) / 2;
  return { rating: daylight < hours ? 'bad' : 'fair', text: `ימים קצרים: כ-${h} שעות אור — לצאת עם שחר` };
}

// ── The year ─────────────────────────────────────────────────────────────────

// A walk counted in days is judged as a full day of walking, not as one
// endless one — no one walks a 300 km trail before dark.
const MAX_DAY_HOURS = 8;

export function rateMonths({ low, high, lat, hours }: ClimateInput): MonthVerdict[] {
  const day = Math.min(hours, MAX_DAY_HOURS);
  const annualRain = low.reduce((s, m) => s + m.ppt, 0);
  return low.map((lo, i) => {
    const hi = high[i] ?? lo;
    // The rain of whichever point gets more: a ridge catches more than its valley.
    const wet = hi.ppt > lo.ppt ? hi : lo;
    const daylight = daylightHours(lat, i);
    const reasons = [judgeHeat(lo, day), judgeCold(hi, (lo.tmax + hi.tmax) / 2), judgeRain(wet, lo), judgeDaylight(daylight, day)]
      .filter((r): r is MonthReason => r != null)
      .sort((a, b) => ORDER[b.rating] - ORDER[a.rating]);
    const rating = reasons.reduce<MonthRating>((acc, r) => worse(acc, r.rating), 'good');
    if (reasons.length === 0) {
      reasons.push({ rating: 'good', text: `נעים: כ-${Math.round(lo.tmax)}° ביום` });
    }
    // In a dry land the little rain there is comes all at once, down the wadis.
    // Not a reason to stay home — the desert's best months are its rainy ones —
    // but worth a line.
    if (annualRain < 250 && wet.ppt >= 10) {
      reasons.push({ rating: 'fair', text: 'בימי גשם יש סכנת שיטפונות' });
    }
    return {
      rating,
      reasons,
      tmax: Math.round(lo.tmax),
      tmin: Math.round(hi.tmin),
      ppt: Math.round(wet.ppt),
      daylight: Math.round(daylight * 2) / 2,
    };
  });
}

// ── Words ────────────────────────────────────────────────────────────────────

export const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const MONTH_SHORT = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

// "מרץ–מאי, אוק׳–נוב׳": the months with this rating, in runs, wrapping round
// the new year so a desert winter reads "נוב׳–מרץ" and not two pieces.
export function monthRuns(ratings: MonthRating[], want: MonthRating = 'good'): string {
  const on = ratings.map((r) => r === want);
  if (on.every(Boolean)) return 'כל השנה';
  if (!on.some(Boolean)) return '';
  // Start just after a month that is off, so no run is cut by December.
  const start = (on.findIndex((v) => !v) + 1) % 12;
  const runs: [number, number][] = [];
  for (let k = 0; k < 12; k++) {
    const m = (start + k) % 12;
    if (!on[m]) continue;
    const last = runs[runs.length - 1];
    if (last && (last[1] + 1) % 12 === m) last[1] = m;
    else runs.push([m, m]);
  }
  return runs.map(([a, b]) => (a === b ? MONTH_SHORT[a] : `${MONTH_SHORT[a]}–${MONTH_SHORT[b]}`)).join(', ');
}
