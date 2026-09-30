// The forecast for a trail, as the app carries it around.
//
// Open-Meteo is the source (free, no key, 16 days, and it corrects the
// temperature for the height it is asked about — the top of the Hermon gets a
// colder answer than the car park). The server route asks it and hands back
// this shape; everything that reads a forecast reads it from here, so swapping
// the source later means changing parseForecast and nothing else.
//
// Free use of Open-Meteo is non-commercial. If the app is ever sold, the
// server needs an API key (customer- prefix) — see api/weather/route.ts.

import type { Coordinate3D } from '../utils/trailUtils';

// Where on the trail a forecast was asked for. 'start' is where people park
// and set off; 'high' is the top, asked separately only when it is high enough
// above the start to be a different day up there; 'ring' points sit around a
// desert trail and are asked about rain alone — a flash flood comes from rain
// that fell upstream, often somewhere perfectly dry-looking from the path.
export type PointRole = 'start' | 'high' | 'ring';

export interface WeatherPoint {
  role: PointRole;
  lat: number;
  lon: number;
  // The trail's own height here, when the file has one. Passed to Open-Meteo so
  // it downscales to the path rather than to its 9 km grid cell's average.
  ele: number | null;
}

export interface HourlyForecast {
  time: string[];          // local time at the trail, 'YYYY-MM-DDTHH:00'
  temp: number[];          // °C
  feels: number[];         // apparent temperature, °C
  rh: number[];            // relative humidity, %
  pop: number[];           // chance of rain, %
  precip: number[];        // mm in the hour
  code: number[];          // WMO weather code
  cloud: number[];         // %
  wind: number[];          // km/h
  gust: number[];          // km/h
  uv: number[];
  vis: number[];           // m
  cape: number[];          // J/kg — how much energy there is for a thunderstorm
}

export interface DailyForecast {
  date: string[];          // 'YYYY-MM-DD', local
  sunrise: string[];       // 'YYYY-MM-DDTHH:MM'
  sunset: string[];
  tmax: number[];
  tmin: number[];
  precipSum: number[];
  code: number[];
}

export interface PointForecast {
  role: 'start' | 'high';
  lat: number;
  lon: number;
  ele: number;             // the height the forecast is for
  hourly: HourlyForecast;
  daily: DailyForecast;
}

export interface RingRain {
  lat: number;
  lon: number;
  date: string[];
  precipSum: number[];
}

export interface DustForecast {
  time: string[];
  pm10: number[];          // μg/m³
  dust: number[];          // μg/m³
}

export interface WeatherBundle {
  fetchedAt: number;
  points: PointForecast[];
  ring: RingRain[];
  dust: DustForecast | null;
  // Index into daily.date of today at the trail. The forecast starts a few days
  // back (to see whether it has been raining — mud, and flood water still
  // running), so "today" is not the first day.
  todayIndex: number;
}

export type WeatherStatus = 'loading' | 'ok' | 'cached' | 'unavailable' | 'rate-limited';

// How many days back and forward to ask for. Back: long enough to see a wet
// spell. Forward: a week of choosable days, plus today.
export const PAST_DAYS = 3;
export const PICKABLE_DAYS = 7;

// The top is asked about separately only when it is this much above the start
// — at ~0.65 °C per 100 m, 400 m is two and a half degrees and a different
// wind, which is the difference between a jacket and no jacket.
const HIGH_POINT_MIN_RISE_M = 400;

// Rain this far out can still arrive down the wadi.
const RING_RADIUS_KM = 20;
const RING_POINTS = 6;

// Deserts in the flash-flood sense: the Negev, the Arava and Eilat mountains,
// the Judean Desert and the Dead Sea, and the dry Jordan Valley. A box, not a
// map — it only decides whether to spend six more forecast points on asking
// about rain upstream, and a false "yes" costs nothing but those.
export function isDesertArea(lat: number, lon: number): boolean {
  if (lat < 31.35) return true;                    // Negev, Arava, Eilat
  if (lon > 35.25 && lat < 31.95) return true;     // Judean Desert, Dead Sea
  if (lon > 35.45 && lat < 32.45) return true;     // Jordan Valley
  return false;
}

function destination(lat: number, lon: number, km: number, bearingDeg: number): [number, number] {
  const R = 6371;
  const d = km / R;
  const b = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
}

// The points worth asking about for a trail. coords are [lat, lon, ele].
export function weatherPointsFor(coords: Coordinate3D[], hasElevation: boolean): WeatherPoint[] {
  if (coords.length === 0) return [];
  const [slat, slon, sele] = coords[0];
  const points: WeatherPoint[] = [
    { role: 'start', lat: slat, lon: slon, ele: hasElevation ? sele : null },
  ];

  if (hasElevation) {
    let hi = 0;
    for (let i = 1; i < coords.length; i++) if (coords[i][2] > coords[hi][2]) hi = i;
    if (coords[hi][2] - sele >= HIGH_POINT_MIN_RISE_M) {
      points.push({ role: 'high', lat: coords[hi][0], lon: coords[hi][1], ele: coords[hi][2] });
    }
  }

  // The middle of the trail, as the centre of the ring: for a long linear walk
  // the start is at one edge of the catchment that matters.
  const mid = coords[Math.floor(coords.length / 2)];
  if (isDesertArea(mid[0], mid[1])) {
    for (let k = 0; k < RING_POINTS; k++) {
      const [lat, lon] = destination(mid[0], mid[1], RING_RADIUS_KM, (360 / RING_POINTS) * k);
      points.push({ role: 'ring', lat, lon, ele: null });
    }
  }
  return points;
}

// ── Weather codes ─────────────────────────────────────────────────────────────
// WMO codes, the ones Open-Meteo uses. `icon` names a lucide icon the panel
// maps to a component; `severity` orders them so a day's "worst sky" can be
// picked out of its hours.
export interface CodeInfo {
  label: string;
  icon: 'sun' | 'cloud-sun' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
  severity: number;
}

export function weatherCodeInfo(code: number): CodeInfo {
  if (code === 0) return { label: 'שמשי', icon: 'sun', severity: 0 };
  if (code === 1) return { label: 'בהיר ברובו', icon: 'sun', severity: 1 };
  if (code === 2) return { label: 'מעונן חלקית', icon: 'cloud-sun', severity: 2 };
  if (code === 3) return { label: 'מעונן', icon: 'cloud', severity: 3 };
  if (code === 45 || code === 48) return { label: 'ערפל', icon: 'fog', severity: 4 };
  if (code >= 51 && code <= 57) return { label: 'טפטוף', icon: 'drizzle', severity: 5 };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) {
    const heavy = code === 65 || code === 67 || code === 82;
    return { label: heavy ? 'גשם חזק' : 'גשם', icon: 'rain', severity: heavy ? 7 : 6 };
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: 'שלג', icon: 'snow', severity: 8 };
  if (code >= 95) return { label: 'סופת רעמים', icon: 'storm', severity: 9 };
  return { label: 'לא ידוע', icon: 'cloud', severity: 0 };
}

export function isSnowCode(code: number): boolean {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

export function isStormCode(code: number): boolean {
  return code >= 95;
}

// ── Parsing Open-Meteo ────────────────────────────────────────────────────────
// Missing numbers come back as null; they are read as 0 here, which for every
// field above is the harmless reading (no rain, no wind, no dust).
// What Open-Meteo sends for one location, as far as this file reads it.
export interface OpenMeteoRaw {
  latitude?: number;
  longitude?: number;
  elevation?: number;
  hourly?: Record<string, unknown>;
  daily?: Record<string, unknown>;
}

const nums = (a: unknown): number[] => (Array.isArray(a) ? a.map((v) => (typeof v === 'number' ? v : 0)) : []);
const strs = (a: unknown): string[] => (Array.isArray(a) ? a.map((v) => String(v ?? '')) : []);

export function parsePointForecast(raw: OpenMeteoRaw | null, role: 'start' | 'high'): PointForecast {
  const h = raw?.hourly ?? {};
  const d = raw?.daily ?? {};
  return {
    role,
    lat: raw?.latitude ?? 0,
    lon: raw?.longitude ?? 0,
    ele: raw?.elevation ?? 0,
    hourly: {
      time: strs(h.time),
      temp: nums(h.temperature_2m),
      feels: nums(h.apparent_temperature),
      rh: nums(h.relative_humidity_2m),
      pop: nums(h.precipitation_probability),
      precip: nums(h.precipitation),
      code: nums(h.weather_code),
      cloud: nums(h.cloud_cover),
      wind: nums(h.wind_speed_10m),
      gust: nums(h.wind_gusts_10m),
      uv: nums(h.uv_index),
      vis: h.visibility ? nums(h.visibility) : [],
      cape: nums(h.cape),
    },
    daily: {
      date: strs(d.time),
      sunrise: strs(d.sunrise),
      sunset: strs(d.sunset),
      tmax: nums(d.temperature_2m_max),
      tmin: nums(d.temperature_2m_min),
      precipSum: nums(d.precipitation_sum),
      code: nums(d.weather_code),
    },
  };
}

export function parseRingRain(raw: OpenMeteoRaw | null): RingRain {
  return {
    lat: raw?.latitude ?? 0,
    lon: raw?.longitude ?? 0,
    date: strs(raw?.daily?.time),
    precipSum: nums(raw?.daily?.precipitation_sum),
  };
}

export function parseDust(raw: OpenMeteoRaw | null): DustForecast | null {
  const h = raw?.hourly;
  if (!h?.time) return null;
  // Kept as NaN rather than 0 where the model has no value: past its last
  // day, 0 would read as perfectly clean air.
  const orNaN = (a: unknown): number[] => (Array.isArray(a) ? a.map((v) => (typeof v === 'number' ? v : NaN)) : []);
  return { time: strs(h.time), pm10: orNaN(h.pm10), dust: orNaN(h.dust) };
}
