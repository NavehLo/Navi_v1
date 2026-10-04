import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { countryTrails, storedCountryTrails, builtCountryCounts, type CountryTrailList } from '../../../../lib/countryTrails';
import { crowdForCountry } from '../../../../lib/trailCrowd/store';

// World trails by country, each with its twelve months rated (see
// countryTrails.ts). Two reads, both GET:
//   ?country=IT   the country's trails; built on the first ask (tens of
//                 seconds), then from the cache for everybody
//   ?counts=1     for every country built so far, how many trails are in
//                 season each month — the numbers beside the month-first list
//
// Where the admin has collected "מה אומרים מטיילים" for the country (see
// api/admin/trail-crowd), each trail also carries `crowd`: its traffic tier
// and rating. Joined here on every read, so the stored list stays as it is.
//
// Building a country costs a few dozen requests to Waymarked Trails and
// Open-Meteo, community services, so it has its own small allowance; a
// country already built costs nothing and has a generous one.

type Status = 'ok' | 'unavailable' | 'rate-limited';

async function withCrowd(list: CountryTrailList) {
  const crowd = await crowdForCountry(list.country);
  if (!crowd) return list;
  return { ...list, hasCrowd: true, trails: list.trails.map((t) => ({ ...t, crowd: crowd.get(t.id) })) };
}

export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ip = clientIp(request);

  if (url.searchParams.get('counts') === '1') {
    if (!(await rateLimit(`country-counts:${ip}`, 30, 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
    }
    return NextResponse.json({ status: 'ok' satisfies Status, counts: await builtCountryCounts() });
  }

  const country = (url.searchParams.get('country') ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  }
  if (!(await rateLimit(`country-trails:${ip}`, 30, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
  }

  try {
    const stored = await storedCountryTrails(country);
    if (stored) return NextResponse.json({ status: 'ok' satisfies Status, ...(await withCrowd(stored)) });
    if (!(await rateLimit(`country-build:${ip}`, 4, 10 * 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
    }
    const list = await countryTrails(country);
    if (!list) return NextResponse.json({ status: 'unavailable' satisfies Status });
    return NextResponse.json({ status: 'ok' satisfies Status, ...(await withCrowd(list)) });
  } catch (error) {
    console.error('Country trails error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
