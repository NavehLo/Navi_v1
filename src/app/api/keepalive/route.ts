import { NextResponse } from 'next/server';
import { pingSupabase } from '../../../lib/supabaseServer';

// Supabase pauses free-tier projects after 7 days without activity, which
// silently kills login, the personal area and the per-user quota. A single
// daily request is enough to keep the project counted as active — see
// vercel.json for the cron entry that calls this route.
//
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` whenever that env var
// exists. When it's set we require it, so the route can't be used as a free
// outbound-request endpoint; without it the route stays open (harmless — it
// only performs one anonymous read).
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await pingSupabase();
  if (!result.ok) {
    console.error('Supabase keepalive failed:', result.detail);
  }

  // 503 on failure so a cron-monitoring service (or Vercel's log alerts) can
  // actually notice that the project went down instead of silently 200-ing.
  return NextResponse.json(
    { supabase: result.ok ? 'alive' : 'unreachable', ...result },
    { status: result.ok ? 200 : 503 }
  );
}
