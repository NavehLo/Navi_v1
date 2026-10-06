import { NextResponse } from 'next/server';
import { allRanked } from '../../../../lib/trailCrowd/ranking';

// A country's list may have to be built first (tens of seconds, rarely).
export const maxDuration = 60;

// GET → {status, trails, reliefBins}: "לפי דירוג" — every world trail
// with Komoot's numbers, from every collected country, by its popularity
// score. The same for everybody, and changed only by an admin's run, so the
// CDN may keep it a while.

export async function GET() {
  try {
    return NextResponse.json(
      { status: 'ok', ...(await allRanked()) },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600' } }
    );
  } catch (e) {
    console.error('World ranking failed:', e);
    return NextResponse.json({ status: 'unavailable' });
  }
}
