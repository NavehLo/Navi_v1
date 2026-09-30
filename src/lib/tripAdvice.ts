// The words around the numbers: what the chosen day will feel like out there.
//
// The model is handed the conclusions hikeAdvice.ts already reached — never
// the raw forecast — and asked only to say them well. That keeps the litres,
// layers and warnings the same whether the text came from the model, from the
// device cache, or from the plain sentences below that stand in with no signal.

import type { DayAdvice } from './hikeAdvice';
import { formatHour, windMeaning, uvMeaning } from './hikeAdvice';
import type { HikeEffort } from './hikeEffort';
import { formatHours } from './hikeEffort';
import { weatherCodeInfo } from './weather';

export interface AdviceInput {
  trailName: string;
  kind: 'hike' | 'drive';
  km: number;
  hours: string;
  effort: string | null;
  day: string;              // "שבת 4/10", "היום", "מחר"
  daysAhead: number;
  start: string;
  end: string;
  sunset: string;
  sky: string;
  temp: string;             // "17–22°"
  feels: string;
  heat: string;
  rainChance: number;
  rainMm: number;
  gusts: number;
  windNote: string;         // the gusts in plain words
  uv: number;
  uvNote: string;           // the UV index in plain words
  high: string | null;      // "בנקודה הגבוהה (1150 מ׳): 12–15°, מרגיש כמו 9°"
  water: string | null;     // "3–4 ליטר לאדם (…)" — a range, the top including a reserve
  clothing: string[];
  warnings: string[];       // "סכנה: …", "זהירות: …"
  betterStart: string | null;
}

const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function dayName(d: DayAdvice): string {
  if (d.daysAhead === 0) return 'היום';
  if (d.daysAhead === 1) return 'מחר';
  const wd = WEEKDAYS[new Date(`${d.date}T12:00`).getDay()];
  return `יום ${wd} ${Number(d.date.slice(8, 10))}/${Number(d.date.slice(5, 7))}`;
}

const range = (a: number, b: number) => (Math.round(a) === Math.round(b) ? `${Math.round(a)}°` : `${Math.round(a)}–${Math.round(b)}°`);

export function adviceInput(
  trail: { name: string; kind: 'hike' | 'drive'; totalDistance: number },
  day: DayAdvice,
  effort: HikeEffort | null,
  hours: number,
): AdviceInput {
  const s = day.summary;
  const w = day.water;
  return {
    trailName: trail.name,
    kind: trail.kind,
    km: Math.round(trail.totalDistance * 10) / 10,
    hours: formatHours(hours),
    effort: effort?.levelLabel ?? null,
    day: dayName(day),
    daysAhead: day.daysAhead,
    start: formatHour(day.startHour),
    end: formatHour(Math.min(23.99, day.endHour)),
    sunset: day.sunset,
    sky: weatherCodeInfo(s.code).label,
    temp: range(s.tMin, s.tMax),
    feels: range(s.feelsMin, s.feelsMax),
    heat: s.heat.label,
    rainChance: Math.round(s.popMax),
    rainMm: s.precipSum,
    gusts: s.gustMax,
    windNote: windMeaning(s.gustMax),
    uv: Math.round(s.uvMax),
    uvNote: uvMeaning(s.uvMax),
    high: s.high ? `בנקודה הגבוהה (${s.high.ele} מ׳): ${range(s.high.tMin, s.high.tMax)}, מרגיש כמו ${Math.round(s.high.feelsMin)}°` : null,
    water: w ? `${w.min}–${w.max} ליטר מים לאדם (הקצה העליון כולל ${w.reserve === 1 ? 'ליטר' : 'חצי ליטר'} רזרבה)${w.electrolytes ? ', וכדאי גם חטיפים מלוחים או אבקת מלחים' : ''}` : null,
    clothing: day.clothing.map((c) => c.label),
    warnings: day.warnings.map((x) => `${x.level === 'danger' ? 'סכנה' : x.level === 'warn' ? 'זהירות' : 'לידיעה'}: ${x.text}`),
    betterStart: day.suggestedStart != null ? formatHour(day.suggestedStart) : null,
  };
}

// A short, stable key for the device cache: the same inputs always give the
// same text, and a forecast that moves changes the key.
export function adviceKey(input: AdviceInput): string {
  const str = JSON.stringify(input);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The same facts in plain sentences — what the panel shows by default, and
// whenever the model is off or cannot be reached. Recommending, not ordering:
// "ההמלצה היא לקחת 3–4 ליטר…" rather than "קחו…".
export function fallbackAdvice(a: AdviceInput): string {
  const parts: string[] = [];
  parts.push(`${a.day} צפוי ${a.sky}, ${a.temp} בשעות ${a.kind === 'drive' ? 'הנסיעה' : 'ההליכה'} (מרגיש כמו ${a.feels}).`);
  if (a.high) parts.push(`${a.high}.`);
  if (a.rainChance >= 30) parts.push(`סיכוי לגשם של עד ${a.rainChance}%.`);
  if (a.gusts >= 35) parts.push(a.windNote);
  if (a.kind === 'hike' && a.uv >= 6) parts.push(a.uvNote);
  if (a.kind === 'hike') {
    if (a.heat !== 'ללא עומס חום') parts.push(`${a.heat} — כדאי לנוח בצל ולשתות לאורך כל הדרך.`);
    if (a.betterStart) parts.push(`כדי להימנע מהחום, כדאי לשקול לצאת כבר ב־${a.betterStart}.`);
    if (a.water) parts.push(`ההמלצה היא לקחת ${a.water}.`);
    if (a.clothing.length) parts.push(`כדאי לשקול לקחת: ${a.clothing.join(', ')}.`);
  }
  return parts.join(' ');
}
