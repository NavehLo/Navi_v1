import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../../lib/rateLimit';
import { sectionsOfParent } from '../../../../lib/trailCrowd/sections';
import { crowdOfIds } from '../../../../lib/trailCrowd/store';
import { komootOf } from '../../../../lib/trailCrowd/score';

// GET ?parent=<relation> → the popular parts of a long trail
// (lib/trailCrowd/sections.ts), the most walked first, for its card:
// {status, sections: [{id, name, km, country, hikers, rating, count}]}.
// Changed only by an admin's run, so the CDN may keep it a while.

export async function GET(request: Request) {
  const parent = Number(new URL(request.url).searchParams.get('parent'));
  if (!Number.isInteger(parent) || parent <= 0) return NextResponse.json({ error: 'parent' }, { status: 400 });
  if (!(await rateLimit(`trail-sections:${clientIp(request)}`, 60, 60_000))) {
    return NextResponse.json({ status: 'rate-limited' }, { status: 429 });
  }
  const sections = await sectionsOfParent(parent);
  const crowd = await crowdOfIds(sections.map((s) => s.id));
  const out = sections
    .map((s) => {
      const k = komootOf(crowd.get(s.id)?.sources ?? []);
      return { id: s.id, name: s.name, km: s.km, country: s.country, hikers: k?.hikers ?? 0, rating: k?.rating ?? null, count: k?.ratings ?? 0 };
    })
    // A part with no numbers left (a later run found it no longer walked) is not shown.
    .filter((s) => s.hikers > 0)
    .sort((a, b) => b.hikers - a.hikers);
  return NextResponse.json(
    { status: 'ok', sections: out },
    { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600' } },
  );
}
