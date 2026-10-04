import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { withAiUsage } from '../../../../lib/aiUsage';
import { countryTrails } from '../../../../lib/countryTrails';
import { collectCrowd } from '../../../../lib/trailCrowd/collect';
import { crowdRows, isCrowdTableMissing, writeCrowd } from '../../../../lib/trailCrowd/store';
import { crowdSummaries, reviewCount } from '../../../../lib/trailCrowd/score';

// The admin's run that fills "מה אומרים מטיילים" for one country's trails
// (settings → מתקדם). Every trail costs a web search and a short model call,
// so it is run by hand, one country at a time, never by a visitor.
//
//   GET  ?country=GR   how far the country is: trails, collected, with a
//                      rating, with any signal, and what the runs cost so far
//   POST ?country=GR   collects the next trails not yet collected, for as
//                      long as one request may run, and says how many remain.
//                      The screen calls it again until none do; stopping
//                      half way loses nothing.

export const maxDuration = 60;

// Stop starting new trails after this, so the last ones finish in time.
const START_BUDGET_MS = 32_000;
const PARALLEL = 4;

function badCountry(country: string) {
  return !/^[A-Z]{2}$/.test(country);
}

async function progress(country: string) {
  const list = await countryTrails(country);
  const rows = await crowdRows(country, { fresh: true });
  const ids = new Set((list?.trails ?? []).map((t) => t.id));
  const mine = rows.filter((r) => ids.has(r.id));
  const summaries = crowdSummaries(mine);
  let cost = 0;
  const db = serviceClient();
  if (db) {
    const { data } = await db.from('ai_usage').select('cost_usd').eq('area', 'trail_crowd');
    cost = (data ?? []).reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
  }
  return {
    total: ids.size,
    done: mine.length,
    remaining: ids.size - mine.length,
    withRating: [...summaries.values()].filter((s) => s.rating != null).length,
    withReviews: mine.filter((r) => reviewCount(r.sources) > 0).length,
    withWikipedia: mine.filter((r) => r.pageviews > 0).length,
    withTraffic: [...summaries.values()].filter((s) => s.traffic !== 'unknown').length,
    // Every country's runs together: the log does not say which country.
    costUsd: Math.round(cost * 100) / 100,
  };
}

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const country = (new URL(request.url).searchParams.get('country') ?? '').toUpperCase();
  if (badCountry(country)) return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  const p = await progress(country);
  return NextResponse.json({ status: isCrowdTableMissing() ? 'no-table' : 'ok', ...p }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const country = (new URL(request.url).searchParams.get('country') ?? '').toUpperCase();
  if (badCountry(country)) return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  if (!process.env.TAVILY_API_KEY) return NextResponse.json({ status: 'no-search-key' });

  return withAiUsage(request, 'trail_crowd', async () => {
    const list = await countryTrails(country);
    if (!list) return NextResponse.json({ status: 'unavailable' });
    const have = new Set((await crowdRows(country, { fresh: true })).map((r) => r.id));
    if (isCrowdTableMissing()) return NextResponse.json({ status: 'no-table' });
    const pending = list.trails.filter((t) => !have.has(t.id));
    const regions = new Map(list.regions.map((r) => [r.id, r]));

    const started = Date.now();
    let next = 0;
    let processed = 0;
    let failed = 0;
    const worker = async () => {
      while (next < pending.length && Date.now() - started < START_BUDGET_MS) {
        const trail = pending[next++];
        const row = await collectCrowd(country, trail, regions).catch((e) => {
          console.error('Trail crowd collect failed:', trail.id, e);
          return null;
        });
        if (row && (await writeCrowd(country, row))) processed++;
        else failed++;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    // Every trail of this request failed: something is wrong (quota, keys),
    // and calling again would only fail again.
    const status = processed === 0 && failed > 0 ? 'failing' : 'ok';
    return NextResponse.json(
      { status, processed, failed, ...(await progress(country)) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  });
}
