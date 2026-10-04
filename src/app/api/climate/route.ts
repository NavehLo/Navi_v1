import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { climateAt } from '../../../lib/climateGrid';
import { rateMonths, rateLongWalk, isGorgeName, CLIMATE_VERSION, MULTI_DAY_KM, type MonthVerdict } from '../../../lib/climate';
import { countriesByMonth } from '../../../lib/climateCountries';

// "מתי כדאי ללכת": the twelve months for one trail, from the climate grid that
// ships with the server (see climateGrid.ts) — no outside service, nothing paid.
//
//   POST { low: {lat, lon, ele}, high: {lat, lon, ele}, hours, km?, samples?, name? }
//        → { status, version, months: MonthVerdict[12] }
//        A walk longer than a day (km over MULTI_DAY_KM, with points along
//        it in `samples`) is rated section by section — see rateLongWalk.
//        `name` tells a gorge or canyon (isGorgeName), where rain counts more.
//   GET  ?countries=1
//        → { status, version, months: CountryMonth[][12] } — where it is in
//          season, month by month, for the month-first world list
//
// Same three-way answer as the weather route: 'unavailable' is "could not
// tell", never twelve green months.

type Status = 'ok' | 'unavailable' | 'rate-limited';

interface Point {
  lat: number;
  lon: number;
  ele: number | null;
}

function point(p: unknown): Point | null {
  const q = p as Partial<Point> | null;
  if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) return null;
  if (Math.abs(q.lat!) > 90 || Math.abs(q.lon!) > 180) return null;
  const ele = Number.isFinite(q.ele) ? Math.max(-500, Math.min(9000, q.ele!)) : null;
  return { lat: q.lat!, lon: q.lon!, ele };
}

export async function POST(request: Request) {
  if (!(await rateLimit(`climate:${clientIp(request)}`, 30, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
  }
  try {
    const body = (await request.json()) as { low?: unknown; high?: unknown; hours?: unknown; km?: unknown; samples?: unknown; name?: unknown };
    const gorge = isGorgeName(typeof body.name === 'string' ? body.name.slice(0, 200) : null);
    const low = point(body.low);
    const high = point(body.high) ?? low;
    const hours = Number(body.hours);
    if (!low || !high || !Number.isFinite(hours) || hours <= 0) {
      return NextResponse.json({ error: 'low, high and hours required' }, { status: 400 });
    }
    const samples = Array.isArray(body.samples) ? body.samples.slice(0, 12).map(point).filter((p): p is Point => p != null) : [];
    if (Number(body.km) > MULTI_DAY_KM && samples.length >= 2) {
      const points = samples
        .map((p) => ({ c: climateAt(p.lat, p.lon, p.ele), lat: p.lat }))
        .filter((p) => p.c != null)
        .map((p) => ({ months: p.c!.months, lat: p.lat }));
      if (points.length === 0) return NextResponse.json({ status: 'unavailable' satisfies Status });
      return NextResponse.json({ status: 'ok' satisfies Status, version: CLIMATE_VERSION, months: rateLongWalk(points, gorge) });
    }

    const lowClimate = climateAt(low.lat, low.lon, low.ele);
    const highClimate = climateAt(high.lat, high.lon, high.ele);
    if (!lowClimate || !highClimate) return NextResponse.json({ status: 'unavailable' satisfies Status });

    const months: MonthVerdict[] = rateMonths({
      low: lowClimate.months,
      high: highClimate.months,
      lat: (low.lat + high.lat) / 2,
      hours,
      gorge,
    });
    return NextResponse.json({ status: 'ok' satisfies Status, version: CLIMATE_VERSION, months });
  } catch (error) {
    console.error('Climate route error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('countries') !== '1') {
    return NextResponse.json({ error: 'countries=1 required' }, { status: 400 });
  }
  try {
    const result = countriesByMonth();
    if (result.months.every((m) => m.length === 0)) {
      return NextResponse.json({ status: 'unavailable' satisfies Status });
    }
    // The same for everybody until the rules change, and the client asks
    // with the version in the URL — a long CDN cache is safe.
    return NextResponse.json(
      { status: 'ok' satisfies Status, ...result },
      { headers: { 'Cache-Control': 'public, s-maxage=2592000, stale-while-revalidate=86400' } }
    );
  } catch (error) {
    console.error('Climate countries error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
