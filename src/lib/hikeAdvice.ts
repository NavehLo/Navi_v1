// What a forecast means for one particular walk on one particular day.
//
// Everything that ends up as a number or a warning on the panel is decided
// here, by fixed rules, and not by the language model: how much water, which
// layers, whether it is safe to go. The model only puts these into sentences
// (api/trip-advice), so a bad day for the model can never turn into "one litre
// is plenty" in August. These are pure functions — scripts/checkHikeAdvice.mjs
// runs them against made-up forecasts.

import {
  weatherCodeInfo, isSnowCode, isStormCode,
  type WeatherBundle, type PointForecast,
} from './weather';

// ── Heat load ─────────────────────────────────────────────────────────────────
// The index the Israel Meteorological Service and the IDF use: the average of
// the dry and the wet-bulb temperature, in the six IDF categories. It is a
// shade figure; walking in the sun feels a category worse, which the water
// rates below already allow for.
export const HEAT_LABELS = [
  'ללא עומס חום',
  'עומס חום קל',
  'עומס חום מתון',
  'עומס חום בינוני',
  'עומס חום כבד',
  'עומס חום כבד מאוד',
];

export interface HeatLoad {
  index: number;
  level: number;          // 0..5, index into HEAT_LABELS
  label: string;
}

// Stull (2011): wet-bulb temperature from temperature and humidity, good to
// about a degree across the range that matters here.
export function wetBulb(t: number, rh: number): number {
  return (
    t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(t + rh) - Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

export function heatLoad(t: number, rh: number): HeatLoad {
  const index = (t + wetBulb(t, rh)) / 2;
  const level = index < 22 ? 0 : index < 24 ? 1 : index < 26 ? 2 : index < 28 ? 3 : index < 30 ? 4 : 5;
  return { index: Math.round(index * 10) / 10, level, label: HEAT_LABELS[level] };
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TripInfo {
  kind: 'hike' | 'drive';
  hours: number;          // how long it is out there, breaks included
  isDesert: boolean;
}

export interface HourRow {
  hour: number;
  temp: number;
  feels: number;
  pop: number;
  precip: number;
  wind: number;
  gust: number;
  code: number;
  uv: number;
  heatLevel: number;
}

export type WarningLevel = 'danger' | 'warn' | 'info';

export interface Warning {
  id: string;
  level: WarningLevel;
  text: string;
}

export interface ClothingItem {
  id: string;
  label: string;
}

export interface DaySummary {
  tMin: number;
  tMax: number;
  feelsMin: number;
  feelsMax: number;
  popMax: number;
  precipSum: number;
  windMax: number;
  gustMax: number;
  cloudMean: number;
  uvMax: number;
  code: number;           // the worst sky of the walking hours
  heat: HeatLoad;         // the worst hour
  pm10Max: number | null;
  // The top of the trail, when it was asked about separately.
  high: { ele: number; tMin: number; tMax: number; feelsMin: number; gustMax: number } | null;
}

export interface WaterAdvice {
  liters: number;
  perHour: number;
  electrolytes: boolean;
}

export type DayRating = 'good' | 'fair' | 'bad';
export type Reliability = 'high' | 'medium' | 'low';

export interface DayAdvice {
  date: string;
  daysAhead: number;
  startHour: number;
  endHour: number;
  sunrise: string;        // 'HH:MM'
  sunset: string;
  // A start that would be meaningfully cooler than the default, when there is one.
  suggestedStart: number | null;
  hours: HourRow[];
  summary: DaySummary;
  water: WaterAdvice | null;      // null on drives
  clothing: ClothingItem[];       // empty on drives
  warnings: Warning[];
  rating: DayRating;
  reliability: Reliability;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const hhmm = (iso: string) => iso.slice(11, 16);
const hourOf = (iso: string) => {
  const [h, m] = hhmm(iso).split(':').map(Number);
  return (h || 0) + (m || 0) / 60;
};
const pad = (n: number) => String(n).padStart(2, '0');

export function formatHour(h: number): string {
  const whole = Math.floor(h);
  return `${pad(whole)}:${pad(Math.round((h - whole) * 60))}`;
}

// Starts at seven from May to October, when the heat is the thing to beat, and
// at eight otherwise; never before first light.
export function defaultStartHour(date: string, sunrise: string): number {
  const month = Number(date.slice(5, 7));
  const base = month >= 5 && month <= 10 ? 7 : 8;
  return Math.max(base, Math.ceil(hourOf(sunrise) * 4) / 4);
}

// The indices of the hourly rows a walk from startHour to endHour touches.
function windowIndices(time: string[], date: string, startHour: number, endHour: number): number[] {
  const out: number[] = [];
  const first = Math.floor(startHour);
  const last = Math.min(23, Math.max(first, Math.ceil(endHour) - 1));
  for (let h = first; h <= last; h++) {
    const i = time.indexOf(`${date}T${pad(h)}:00`);
    if (i >= 0) out.push(i);
  }
  return out;
}

const max = (a: number[]) => (a.length ? Math.max(...a) : 0);
const min = (a: number[]) => (a.length ? Math.min(...a) : 0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

function worstHeatOver(p: PointForecast, idx: number[]): HeatLoad {
  let worst = heatLoad(-50, 0);
  for (const i of idx) {
    const h = heatLoad(p.hourly.temp[i], p.hourly.rh[i]);
    if (h.index > worst.index) worst = h;
  }
  return worst;
}

// ── Water ─────────────────────────────────────────────────────────────────────
// Litres an hour by heat load: from half a litre on a cool day up to one and a
// quarter in heavy heat, in line with the common Israeli guidance of "a litre
// an hour in the heat". Half a litre on top in reserve, rounded up to the half
// litre, never under a litre and a half — and never under three for a walk of
// three hours or more in real heat, which is the figure every hiking body here
// repeats for a summer day out.
const LITERS_PER_HOUR = [0.4, 0.5, 0.6, 0.75, 1.0, 1.25];

export function waterFor(hours: number, heatLevel: number): WaterAdvice {
  const perHour = LITERS_PER_HOUR[Math.max(0, Math.min(5, heatLevel))];
  let liters = Math.ceil((hours * perHour + 0.5) * 2) / 2;
  liters = Math.max(1.5, liters);
  if (heatLevel >= 2 && hours >= 3) liters = Math.max(3, liters);
  return {
    liters,
    perHour,
    electrolytes: (heatLevel >= 2 && hours >= 3) || hours >= 6,
  };
}

// ── The day ───────────────────────────────────────────────────────────────────
export function adviseDay(bundle: WeatherBundle, dayIndex: number, todayIndex: number, trip: TripInfo): DayAdvice | null {
  const start = bundle.points.find((p) => p.role === 'start') ?? bundle.points[0];
  if (!start) return null;
  const high = bundle.points.find((p) => p.role === 'high') ?? null;
  const date = start.daily.date[dayIndex];
  if (!date) return null;

  const sunrise = start.daily.sunrise[dayIndex] || `${date}T06:00`;
  const sunset = start.daily.sunset[dayIndex] || `${date}T18:00`;
  const startHour = defaultStartHour(date, sunrise);
  const endHour = startHour + trip.hours;

  const idx = windowIndices(start.hourly.time, date, startHour, endHour);
  if (idx.length === 0) return null;
  const hIdx = high ? windowIndices(high.hourly.time, date, startHour, endHour) : [];

  const H = start.hourly;
  const pick = (arr: number[], ii: number[]) => ii.map((i) => arr[i]);

  const hours: HourRow[] = idx.map((i) => ({
    hour: Number(H.time[i].slice(11, 13)),
    temp: H.temp[i],
    feels: H.feels[i],
    pop: H.pop[i],
    precip: H.precip[i],
    wind: H.wind[i],
    gust: H.gust[i],
    code: H.code[i],
    uv: H.uv[i],
    heatLevel: heatLoad(H.temp[i], H.rh[i]).level,
  }));

  // Heat is read at whichever point is hotter, cold at whichever is colder —
  // the walk passes through both.
  const heatStart = worstHeatOver(start, idx);
  const heatHigh = high ? worstHeatOver(high, hIdx) : null;
  const heat = heatHigh && heatHigh.index > heatStart.index ? heatHigh : heatStart;

  const codes = pick(H.code, idx).concat(high ? pick(high.hourly.code, hIdx) : []);
  const code = codes.reduce((w, c) => (weatherCodeInfo(c).severity > weatherCodeInfo(w).severity ? c : w), codes[0] ?? 0);

  let pm10Max: number | null = null;
  if (bundle.dust) {
    const di = windowIndices(bundle.dust.time, date, startHour, endHour);
    // The air-quality model reaches fewer days than the weather one; past its
    // end the hours come back empty, which is "no answer", not "clean air".
    const vals = di.map((i) => bundle.dust!.pm10[i]).filter((v) => Number.isFinite(v));
    if (vals.length) pm10Max = max(vals);
  }

  const summary: DaySummary = {
    tMin: round1(min(pick(H.temp, idx))),
    tMax: round1(max(pick(H.temp, idx))),
    feelsMin: round1(Math.min(min(pick(H.feels, idx)), high && hIdx.length ? min(pick(high.hourly.feels, hIdx)) : Infinity)),
    feelsMax: round1(max(pick(H.feels, idx))),
    popMax: max(pick(H.pop, idx).concat(high ? pick(high.hourly.pop, hIdx) : [])),
    precipSum: round1(sum(pick(H.precip, idx))),
    windMax: Math.round(max(pick(H.wind, idx).concat(high ? pick(high.hourly.wind, hIdx) : []))),
    gustMax: Math.round(max(pick(H.gust, idx).concat(high ? pick(high.hourly.gust, hIdx) : []))),
    cloudMean: Math.round(sum(pick(H.cloud, idx)) / idx.length),
    uvMax: round1(max(pick(H.uv, idx))),
    code,
    heat,
    pm10Max: pm10Max == null ? null : Math.round(pm10Max),
    high: high && hIdx.length ? {
      ele: Math.round(high.ele),
      tMin: round1(min(pick(high.hourly.temp, hIdx))),
      tMax: round1(max(pick(high.hourly.temp, hIdx))),
      feelsMin: round1(min(pick(high.hourly.feels, hIdx))),
      gustMax: Math.round(max(pick(high.hourly.gust, hIdx))),
    } : null,
  };

  const sunsetH = hourOf(sunset);
  const capeMax = max(pick(H.cape, idx));
  const visMin = H.vis.length ? min(pick(H.vis, idx)) : Infinity;

  // Rain before the day. For mud, the last three days at the trail; for a
  // flood, yesterday and today anywhere around a desert trail — water that
  // fell overnight upstream is still coming down the wadi in the morning.
  const rainOn = (p: { precipSum: number[] }, i: number) => (i >= 0 ? p.precipSum[i] ?? 0 : 0);
  const pastRain = rainOn(start.daily, dayIndex - 1) + rainOn(start.daily, dayIndex - 2) + rainOn(start.daily, dayIndex - 3);
  const floodRain = Math.max(
    rainOn(start.daily, dayIndex), rainOn(start.daily, dayIndex - 1),
    ...(high ? [rainOn(high.daily, dayIndex), rainOn(high.daily, dayIndex - 1)] : []),
    ...bundle.ring.flatMap((r) => {
      const i = r.date.indexOf(date);
      return i >= 0 ? [rainOn(r, i), rainOn(r, i - 1)] : [];
    }),
  );

  // ── Warnings ──
  const warnings: Warning[] = [];
  const isHike = trip.kind === 'hike';

  if (isHike && heat.level >= 5) {
    warnings.push({ id: 'heat', level: 'danger', text: `${heat.label} — לא מומלץ לצאת למסלול ביום הזה.` });
  } else if (isHike && heat.level === 4) {
    warnings.push({ id: 'heat', level: 'danger', text: `${heat.label} — לצאת רק עם שחר, לקצר את המסלול, או לדחות.` });
  } else if (isHike && heat.level === 3) {
    warnings.push({ id: 'heat', level: 'warn', text: `${heat.label} — להתחיל מוקדם, לנוח בצל ולשתות הרבה.` });
  }

  if (codes.some(isStormCode) || (capeMax >= 800 && summary.popMax >= 40)) {
    warnings.push({ id: 'storm', level: 'danger', text: 'חשש לסופת רעמים — להימנע מפסגות, רכסים חשופים ואפיקי נחלים.' });
  }

  if (trip.isDesert && floodRain >= 5) {
    warnings.push({ id: 'flood', level: 'danger', text: 'צפוי גשם באזור — סכנת שיטפונות. שיטפון יכול להגיע מגשם במעלה הנחל גם כשמעליכם שמש. לא להיכנס לאפיקי נחלים.' });
  } else if (trip.isDesert && floodRain >= 1) {
    warnings.push({ id: 'flood', level: 'warn', text: 'קצת גשם באזור — לבדוק התראות שיטפונות ערב הטיול ולא להיכנס לאפיקים אם יורד גשם במעלה.' });
  }

  if (codes.some(isSnowCode)) {
    warnings.push({ id: 'snow', level: 'danger', text: 'צפוי שלג — הדרכים והשבילים עלולים להיסגר. לבדוק לפני היציאה.' });
  } else if (summary.feelsMin <= 0) {
    warnings.push({ id: 'frost', level: 'warn', text: 'קור של מתחת לאפס — חשש לקרה ולקרח על השביל.' });
  }

  if (summary.gustMax >= 60) {
    warnings.push({ id: 'wind', level: 'danger', text: `משבי רוח חזקים מאוד (עד ${summary.gustMax} קמ״ש) — מסוכן ליד מצוקים ובקטעים חשופים.` });
  } else if (summary.gustMax >= 45) {
    warnings.push({ id: 'wind', level: 'warn', text: `משבי רוח חזקים (עד ${summary.gustMax} קמ״ש) — להיזהר בקטעים חשופים.` });
  }

  if (summary.popMax >= 60 || summary.precipSum >= 2) {
    warnings.push({ id: 'rain', level: 'warn', text: `צפוי גשם בשעות ההליכה (סיכוי עד ${summary.popMax}%).` });
  }

  if (isHike && !trip.isDesert && (pastRain >= 10 || summary.precipSum >= 5)) {
    warnings.push({ id: 'mud', level: 'warn', text: 'ירד גשם בימים האחרונים — צפוי בוץ ושביל חלק.' });
  }

  if (summary.pm10Max != null && summary.pm10Max >= 300) {
    warnings.push({ id: 'dust', level: 'danger', text: 'אובך כבד (אבק באוויר) — לא מומלץ למאמץ בחוץ, במיוחד לבעלי רגישות נשימתית.' });
  } else if (summary.pm10Max != null && summary.pm10Max >= 150) {
    warnings.push({ id: 'dust', level: 'warn', text: 'צפוי אובך — הראות תהיה מוגבלת, ומאמץ עלול להקשות על הנשימה.' });
  }

  if (isHike && endHour > sunsetH) {
    warnings.push({ id: 'dark', level: 'danger', text: `לפי הקצב המשוער תסיימו אחרי השקיעה (${hhmm(sunset)}) — לצאת מוקדם יותר או לקצר.` });
  } else if (isHike && endHour > sunsetH - 0.5) {
    warnings.push({ id: 'dark', level: 'warn', text: `תסיימו קרוב לשקיעה (${hhmm(sunset)}) — לקחת פנס ולא להתעכב.` });
  }

  if (visMin < 1000) {
    warnings.push({ id: 'fog', level: 'info', text: 'צפוי ערפל — הנוף עלול להיות מוסתר, ולהקפיד על הסימון.' });
  }

  // ── A cooler start ──
  // When the default start walks into real heat, try every quarter hour from
  // first light and offer the start that keeps the worst hour coolest.
  let suggestedStart: number | null = null;
  if (isHike && heat.level >= 3) {
    const first = Math.ceil(hourOf(sunrise) * 4) / 4;
    let best = { start: startHour, index: heat.index };
    for (let s = first; s < startHour; s += 0.25) {
      const w = windowIndices(H.time, date, s, s + trip.hours);
      if (w.length === 0) continue;
      const h = worstHeatOver(start, w);
      if (h.index < best.index - 0.5) best = { start: s, index: h.index };
    }
    if (best.start < startHour) suggestedStart = best.start;
  }

  // ── What to take ──
  const water = isHike ? waterFor(trip.hours, heat.level) : null;
  const clothing = isHike ? clothingFor(summary, {
    rainy: summary.popMax >= 40 || summary.precipSum >= 1,
    muddy: warnings.some((w) => w.id === 'mud'),
    dark: warnings.some((w) => w.id === 'dark'),
  }) : [];

  const rating: DayRating = warnings.some((w) => w.level === 'danger') ? 'bad'
    : warnings.some((w) => w.level === 'warn') ? 'fair' : 'good';

  const daysAhead = dayIndex - todayIndex;
  const reliability: Reliability = daysAhead <= 2 ? 'high' : daysAhead <= 4 ? 'medium' : 'low';

  return {
    date, daysAhead, startHour, endHour,
    sunrise: hhmm(sunrise), sunset: hhmm(sunset),
    suggestedStart, hours, summary, water, clothing, warnings, rating, reliability,
  };
}

// ── Clothing ──────────────────────────────────────────────────────────────────
// By the "feels like" temperature — wind and humidity included — at the
// coldest and the warmest the walk will be, not by the day's headline number.
export function clothingFor(s: DaySummary, f: { rainy: boolean; muddy: boolean; dark: boolean }): ClothingItem[] {
  const items: ClothingItem[] = [];
  // A hat for the sun, and for the heat even when the morning sun is still low
  // — in Ein Gedi at eight it is already 28°.
  const sunny = s.uvMax >= 3 || s.feelsMax >= 25;

  if (sunny) items.push({ id: 'hat', label: 'כובע רחב שוליים' });
  if (s.uvMax >= 5) items.push({ id: 'sunscreen', label: 'קרם הגנה' });
  if (s.uvMax >= 6 && s.feelsMax >= 22) items.push({ id: 'sleeves', label: 'חולצה ארוכה ודקה נגד שמש' });
  if (s.feelsMax >= 22) items.push({ id: 'light', label: 'בגדים קלים ונושמים' });

  if (s.feelsMin < 5) {
    items.push({ id: 'warm', label: 'מעיל חם, כובע צמר וכפפות' });
  } else if (s.feelsMin < 12) {
    items.push({ id: 'fleece', label: 'פליז או סוודר' });
  } else if (s.feelsMin < 18) {
    items.push({ id: 'layer', label: 'שכבה ארוכה קלה לבוקר' });
  }

  if (s.gustMax >= 35 && s.feelsMin < 20) items.push({ id: 'windbreaker', label: 'מעיל רוח' });
  if (f.rainy) items.push({ id: 'rain', label: 'מעיל גשם' });
  if (f.rainy && s.feelsMin < 12) items.push({ id: 'socks', label: 'גרביים להחלפה' });
  if (f.muddy || f.rainy) items.push({ id: 'boots', label: 'נעליים גבוהות עם אחיזה טובה' });
  if (f.dark) items.push({ id: 'headlamp', label: 'פנס ראש' });
  return items;
}

// ── The week ──────────────────────────────────────────────────────────────────
// The days somebody can choose between: today and the six after it. Days the
// forecast does not reach are simply not in the list.
export function adviseWeek(bundle: WeatherBundle, todayIndex: number, trip: TripInfo, days = 7): DayAdvice[] {
  const out: DayAdvice[] = [];
  for (let i = todayIndex; i < todayIndex + days; i++) {
    const d = adviseDay(bundle, i, todayIndex, trip);
    if (d) out.push(d);
  }
  return out;
}

// Today at the trail, found by date rather than trusted from the bundle: a
// forecast read from the device cache may be a day or two old, and its
// "today" has moved on.
export function findTodayIndex(bundle: WeatherBundle, now = new Date()): number {
  const start = bundle.points[0];
  if (!start) return bundle.todayIndex;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const i = start.daily.date.indexOf(today);
  return i >= 0 ? i : bundle.todayIndex;
}
