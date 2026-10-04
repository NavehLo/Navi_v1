import { NextResponse } from 'next/server';
import { serviceClient } from '../../../lib/supabaseService';

// A recorded walk that its owner shared by link (/?walk=<id>).
//
// Recordings are private: RLS lets only the owner read a row, and anon has no
// grant on the table at all — so nobody can list them. This route reads one,
// by its id, with the service role, and only while its owner has `shared`
// on. Turning sharing off makes the link answer 404 at once.
//
//   GET ?id=<uuid> → { name, gpx, stats, startedAt }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!UUID.test(id)) return NextResponse.json({ error: 'id: a recording id' }, { status: 400 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  const { data, error } = await db
    .from('recordings')
    .select('name, gpx, stats, started_at')
    .eq('id', id)
    .eq('shared', true)
    .maybeSingle();
  if (error) {
    console.error('walk: read failed', error.code, error.message);
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(
    { name: data.name, gpx: data.gpx, stats: data.stats, startedAt: data.started_at },
    // Short: a link turned off should stop working soon.
    { headers: { 'Cache-Control': 'public, s-maxage=60' } },
  );
}
