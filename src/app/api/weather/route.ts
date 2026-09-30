import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import {
  parsePointForecast, parseRingRain, parseDust, PAST_DAYS, PICKABLE_DAYS,
  type WeatherPoint, type WeatherBundle, type PointForecast, type RingRain, type DustForecast, type OpenMeteoRaw,
} from '../../../lib/weather';

// The forecast for a trail's few weather points, from Open-Meteo.
//
// Asked from here rather than from the browser for two reasons: an hour of
// server-side cache for everybody looking at the same trail, and one place to
// add a key or change the source without shipping a new app. Open-Meteo's free
// tier is for non-commercial use; with OPEN_METEO_API_KEY set, the requests go
// to the paid customer- hosts instead.
//
// Same three-way answer as the water and POI routes: 'ok', 'unavailable' and
// 'rate-limited' — a failure has to look different from "no rain", or the
// panel ends up promising a dry day it knows nothing about.

type Status = 'ok' | 'unavailable' | 'rate-limited';

const KEY = process.env.OPEN_METEO_API_KEY;
const FORECAST_URL = KEY ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = KEY ? 'https://customer-air-quality-api.open-meteo.com/v1/air-quality' : 'https://air-quality-api.open-meteo.com/v1/air-quality';

const HOURLY = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation_probability',
  'precipitation', 'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index',
  'visibility', 'cape',
].join(',');
const DAILY = 'sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code';

const MAX_POINTS = 8;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; bundle: WeatherBundle }>();

function withKey(params: URLSearchParams): URLSearchParams {
  if (KEY) params.set('apikey', KEY);
  return params;
}

async function getJson(url: string): Promise<OpenMeteoRaw | OpenMeteoRaw[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error('Open-Meteo error:', res.status, url.split('?')[0]);
      return null;
    }
    return res.json();
  } catch (e) {
    console.error('Open-Meteo request failed:', e);
    return null;
  }
}

const coord = (n: number) => n.toFixed(4);
const eleParam = (e: number | null) => (e == null || !Number.isFinite(e) ? 'nan' : String(Math.round(e)));

export async function POST(request: Request) {
  try {
    if (!(await rateLimit(`weather:${clientIp(request)}`, 20, 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
    }

    const { points } = (await request.json()) as { points: WeatherPoint[] };
    if (!Array.isArray(points) || points.length === 0) {
      return NextResponse.json({ error: 'points required' }, { status: 400 });
    }
    const valid = points
      .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && ['start', 'high', 'ring'].includes(p.role))
      .slice(0, MAX_POINTS);
    const main = valid.filter((p) => p.role !== 'ring');
    const ring = valid.filter((p) => p.role === 'ring');
    if (main.length === 0) return NextResponse.json({ error: 'a start point is required' }, { status: 400 });

    const cacheKey = valid.map((p) => `${p.role}:${coord(p.lat)},${coord(p.lon)},${eleParam(p.ele)}`).join('|');
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json({ status: 'ok' satisfies Status, bundle: hit.bundle });
    }

    const days = { past_days: String(PAST_DAYS), forecast_days: String(PICKABLE_DAYS + 1) };

    // Several locations go in one request as comma-separated lists; the answer
    // is then an array in the same order.
    const mainParams = withKey(new URLSearchParams({
      latitude: main.map((p) => coord(p.lat)).join(','),
      longitude: main.map((p) => coord(p.lon)).join(','),
      elevation: main.map((p) => eleParam(p.ele)).join(','),
      hourly: HOURLY,
      daily: DAILY,
      timezone: 'auto',
      ...days,
    }));

    // Rain upstream only needs a daily total — asking the ring for its hours
    // would triple the payload for nothing the panel reads.
    const ringParams = ring.length > 0 ? withKey(new URLSearchParams({
      latitude: ring.map((p) => coord(p.lat)).join(','),
      longitude: ring.map((p) => coord(p.lon)).join(','),
      daily: 'precipitation_sum',
      timezone: 'auto',
      ...days,
    })) : null;

    // Dust and haze: the air-quality model only runs 5 days by default and 7 at
    // most, and on a 45 km global grid over Israel — a regional signal, which
    // is what a dust storm is.
    const dustParams = withKey(new URLSearchParams({
      latitude: coord(main[0].lat),
      longitude: coord(main[0].lon),
      hourly: 'pm10,dust',
      timezone: 'auto',
      forecast_days: String(PICKABLE_DAYS),
    }));

    const [mainRaw, ringRaw, dustRaw] = await Promise.all([
      getJson(`${FORECAST_URL}?${mainParams}`),
      ringParams ? getJson(`${FORECAST_URL}?${ringParams}`) : Promise.resolve(null),
      getJson(`${AIR_URL}?${dustParams}`),
    ]);

    if (!mainRaw) return NextResponse.json({ status: 'unavailable' satisfies Status });

    const mainList = Array.isArray(mainRaw) ? mainRaw : [mainRaw];
    const forecasts: PointForecast[] = mainList.map((raw, i) => parsePointForecast(raw, main[i].role as 'start' | 'high'));
    const ringList = ringRaw ? (Array.isArray(ringRaw) ? ringRaw : [ringRaw]) : [];
    const ringRain: RingRain[] = ringList.map(parseRingRain);
    const dust: DustForecast | null = dustRaw && !Array.isArray(dustRaw) ? parseDust(dustRaw) : null;

    const bundle: WeatherBundle = {
      fetchedAt: Date.now(),
      points: forecasts,
      ring: ringRain,
      dust,
      todayIndex: PAST_DAYS,
    };

    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { at: Date.now(), bundle });
    return NextResponse.json({ status: 'ok' satisfies Status, bundle });
  } catch (error) {
    console.error('Weather route error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
