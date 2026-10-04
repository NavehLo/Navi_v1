import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { crowdCountryOf, crowdRows } from '../../../../lib/trailCrowd/store';
import { crowdSummaries } from '../../../../lib/trailCrowd/score';
import { storedCountryTrails } from '../../../../lib/countryTrails';

// GET ?id=<relation> → "מה אומרים מטיילים" for the trail card: the traffic
// tier and rating (as in the country list) and each review site's numbers
// with a link. {status:'none'} when nothing was collected for the trail —
// so far only for the countries the admin has run (api/admin/trail-crowd).

export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'id' }, { status: 400 });
  if (!(await rateLimit(`trail-crowd:${clientIp(request)}`, 60, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' }, { status: 429 });
  }
  const country = await crowdCountryOf(id);
  if (!country) return NextResponse.json({ status: 'none' });
  // Compared with the trails of the country's current list, as in the list.
  const list = await storedCountryTrails(country);
  const all = await crowdRows(country);
  const rows = list ? all.filter((r) => list.trails.some((t) => t.id === r.id) || r.id === id) : all;
  const row = rows.find((r) => r.id === id);
  if (!row) return NextResponse.json({ status: 'none' });
  const summary = crowdSummaries(rows).get(id)!;
  return NextResponse.json({
    status: 'ok',
    country,
    ...summary,
    pageviews: row.pageviews,
    sources: row.sources,
    fetchedAt: row.fetchedAt,
  });
}
