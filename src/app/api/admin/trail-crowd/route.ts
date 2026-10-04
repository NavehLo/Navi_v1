import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { withAiUsage } from '../../../../lib/aiUsage';
import { countryTrails } from '../../../../lib/countryTrails';
import {
  findCountryGuides, pageviewsOf, readAndMatch, saveCountry, wikiCandidates, withAddedTrails,
} from '../../../../lib/trailCrowd/country';
import { crowdRows, isCrowdTableMissing } from '../../../../lib/trailCrowd/store';
import { crowdSummaries, trafficSignal, type CrowdSource } from '../../../../lib/trailCrowd/score';

// The admin's run of "מה אומרים מטיילים" for one country (settings → מתקדם),
// in the steps of lib/trailCrowd/country.ts. Each step fits in one request;
// the screen keeps what they return and passes it on — the server keeps
// nothing between them, so a run stopped half way simply starts again.
//
//   GET  ?country=GR                     how the country stands: trails,
//                                        with Komoot numbers, with a rating…
//   POST ?country=GR {step:'find'}       → {guides}
//   POST ?country=GR {step:'read', urls} (≤4 pages) → {routes, matches}
//   POST ?country=GR {step:'finish', matches, from?}
//        Wikipedia for the next trails worth asking about, ≤12 a call:
//        → {views, next} until next is null, then saves (with all `views`
//        sent back) → the GET's answer

export const maxDuration = 60;

const READ_MAX = 4;
const WIKI_BATCH = 12;

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
    withRating: [...summaries.values()].filter((s) => s.rating != null).length,
    withKomoot: mine.filter((r) => trafficSignal(r.sources) > 0).length,
    withWikipedia: mine.filter((r) => r.pageviews > 0).length,
    withTraffic: [...summaries.values()].filter((s) => s.traffic !== 'unknown').length,
    fetchedAt: mine[0]?.fetchedAt ?? null,
    // Every country's runs together: the log does not say which country.
    costUsd: Math.round(cost * 100) / 100,
  };
}

const noStore = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const country = (new URL(request.url).searchParams.get('country') ?? '').toUpperCase();
  if (badCountry(country)) return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  const p = await progress(country);
  return NextResponse.json({ status: isCrowdTableMissing() ? 'no-table' : 'ok', ...p }, noStore);
}

function cleanMatches(raw: unknown): Record<number, CrowdSource> {
  const out: Record<number, CrowdSource> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, s] of Object.entries(raw as Record<string, Partial<CrowdSource>>)) {
    if (!/^\d+$/.test(id) || !s || typeof s.url !== 'string' || !/^https:\/\/www\.komoot\.com\//.test(s.url)) continue;
    out[Number(id)] = {
      site: 'Komoot',
      url: s.url,
      rating: typeof s.rating === 'number' && s.rating > 0 && s.rating <= 5 ? s.rating : null,
      count: Math.max(0, Math.round(Number(s.count) || 0)),
      hikers: Math.max(0, Math.round(Number(s.hikers) || 0)),
      route: typeof s.route === 'string' ? s.route.slice(0, 200) : undefined,
    };
  }
  return out;
}

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const country = (new URL(request.url).searchParams.get('country') ?? '').toUpperCase();
  if (badCountry(country)) return NextResponse.json({ error: 'country: two-letter ISO code' }, { status: 400 });
  if (!process.env.TAVILY_API_KEY) return NextResponse.json({ status: 'no-search-key' });
  const body = await request.json().catch(() => ({}));

  return withAiUsage(request, 'trail_crowd', async () => {
    let list = await countryTrails(country);
    if (!list) return NextResponse.json({ status: 'unavailable' });

    if (body.step === 'find') {
      const guides = await findCountryGuides(list);
      if (!guides) return NextResponse.json({ status: 'failing' });
      return NextResponse.json({ status: 'ok', guides }, noStore);
    }

    if (body.step === 'read') {
      const urls = (Array.isArray(body.urls) ? body.urls : [])
        .filter((u: unknown): u is string => typeof u === 'string' && /^https:\/\/www\.komoot\.com\/guide\//.test(u))
        .slice(0, READ_MAX);
      // Finding the trails under unmatched routes stops in time for the answer.
      const { routes, matches } = await readAndMatch(list, urls, { deadline: Date.now() + 35_000 });
      return NextResponse.json({ status: 'ok', routes, matches }, noStore);
    }

    if (body.step === 'finish') {
      const matches = cleanMatches(body.matches);
      // The trails found under Komoot's routes join the list (once; later
      // calls find them there already).
      list = await withAddedTrails(list, matches);
      const ask = wikiCandidates(list, matches);
      const from = Math.max(0, Number(body.from) || 0);
      if (from < ask.length) {
        const views = await pageviewsOf(ask.slice(from, from + WIKI_BATCH));
        const next = from + WIKI_BATCH < ask.length ? from + WIKI_BATCH : null;
        return NextResponse.json({ status: 'ok', views, next, of: ask.length }, noStore);
      }
      const views: Record<number, number> = {};
      for (const [id, v] of Object.entries(body.views ?? {})) if (/^\d+$/.test(id)) views[Number(id)] = Math.max(0, Number(v) || 0);
      if (!(await saveCountry(list, matches, views))) {
        return NextResponse.json({ status: isCrowdTableMissing() ? 'no-table' : 'failing' });
      }
      return NextResponse.json({ status: 'ok', saved: true, ...(await progress(country)) }, noStore);
    }

    return NextResponse.json({ error: 'step: find | read | finish' }, { status: 400 });
  });
}
