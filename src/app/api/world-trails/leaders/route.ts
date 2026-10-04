import { NextResponse } from 'next/server';
import { allLeaders } from '../../../../lib/trailCrowd/leaders';

// A country's list may have to be built first (tens of seconds, rarely).
export const maxDuration = 60;

// GET → {status, countries: {GR: {day, long}}}: the leading trails of every
// country whose "מה אומרים מטיילים" has been collected — the names under a
// country in the picker, and the stars on the map. The same for everybody,
// and changed only by an admin's run, so the CDN may keep it a while.

export async function GET() {
  try {
    return NextResponse.json(
      { status: 'ok', countries: await allLeaders() },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600' } }
    );
  } catch (e) {
    console.error('Leading trails failed:', e);
    return NextResponse.json({ status: 'unavailable' });
  }
}
