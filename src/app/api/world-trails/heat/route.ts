import { NextResponse } from 'next/server';
import { heatPoints } from '../../../../lib/trailCrowd/heat';

// A country's list may have to be built first (tens of seconds, rarely).
export const maxDuration = 60;

// GET → {status, points: [[lon, lat, weight]], countries: ['GR', …]}: the
// "מפת חום של מטיילים" layer — one point per trail Komoot counts hikers on.
// The same for everybody, and changed only by an admin's run, so the CDN may
// keep it a while.

export async function GET() {
  try {
    return NextResponse.json(
      { status: 'ok', ...(await heatPoints()) },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=3600' } }
    );
  } catch (e) {
    console.error('Hiker heat failed:', e);
    return NextResponse.json({ status: 'unavailable' });
  }
}
