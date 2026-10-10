import { NextResponse } from 'next/server';
import { landscapeOfCountries, landscapeOfCountry, trailLandscape } from '../../../lib/landscapeData';

// "הרים, יער ונהרות" — what each country and each of its areas looks like,
// from the summaries that ship with the server (see landscapeData.ts). No
// outside service, nothing paid.
//
//   GET            → every country's summary, for the country list
//   GET ?country=GR → the country's and each of its areas', for the area step
//   GET ?trail=123  → one world trail's, for its card ({status:'none'} when
//                     its country was not collected — collectLandscape.mjs)
//
// The same for everybody until the file is rebuilt, and the client asks with
// the version in the URL — a long CDN cache is safe.

type Status = 'ok' | 'unavailable';
const CACHE = { 'Cache-Control': 'public, s-maxage=2592000, stale-while-revalidate=86400' };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.has('trail')) {
    const id = Number(params.get('trail'));
    if (!Number.isInteger(id) || id === 0) return NextResponse.json({ error: 'trail: relation id' }, { status: 400 });
    const result = trailLandscape(id);
    return NextResponse.json(result ? { status: 'ok', ...result } : { status: 'none' }, { headers: CACHE });
  }
  const country = (params.get('country') ?? '').toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  }
  const result = country ? landscapeOfCountry(country) : landscapeOfCountries();
  if (!result) return NextResponse.json({ status: 'unavailable' satisfies Status });
  return NextResponse.json({ status: 'ok' satisfies Status, ...result }, { headers: CACHE });
}
