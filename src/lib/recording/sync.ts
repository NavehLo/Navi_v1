import { supabase } from '../supabase';
import { withElevation } from '../demElevation';
import { PersonalAreaError, run } from '../personalArea';
import { gpxToSegments, recordingToGpx } from './gpx';
import { computeRecStats } from './stats';
import {
  deleteLocal, getLocal, listLocal, pendingDeletes, putLocal, setPendingDeletes,
} from './store';
import type { RecPoint, RecStats, Recording } from './types';

// Recordings in the account (table `recordings`, supabase/schema.sql).
//
// The device is where a recording is made and kept first; the account holds
// a copy so it is there on another phone and can be shared by link. A
// recording's id is made on the device, so sending it again is harmless
// (upsert), and "not yet in the account" is simply syncedAt = null — set
// again by a rename, so the next sync carries the new name.
//
// Only the owner reads a row (RLS "own rows"). A shared one is read by others
// through /api/walk, on the server, and only while `shared` is true.

interface Row {
  id: string;
  name: string;
  started_at: string;
  ended_at: string;
  stats: RecStats;
  gpx?: string;
  shared: boolean;
}

function client() {
  if (!supabase) throw new PersonalAreaError('unavailable', 'Supabase is not configured');
  return supabase;
}

function toRow(rec: Recording): Row {
  return {
    id: rec.id,
    name: rec.name,
    started_at: new Date(rec.startedAt).toISOString(),
    ended_at: new Date(rec.endedAt).toISOString(),
    stats: rec.stats,
    gpx: recordingToGpx(rec),
    shared: rec.shared,
  };
}

// The heights from the elevation model (the one the 3D map is drawn from),
// in place of the phone's own: a GPS height is good to ±10–20 m, which adds
// up to climbs nobody walked. Needs reception; without it the recording
// keeps the GPS heights and gets these on a later sync.
export async function withModelHeights(segments: RecPoint[][]): Promise<RecPoint[][] | null> {
  const flat = segments.flat();
  if (flat.length < 2) return null;
  const coords = flat.map((p) => [p.lat, p.lon, p.ele ?? 0] as [number, number, number]);
  const out = await withElevation(coords);
  if (out === coords) return null; // no tiles to be had
  let i = 0;
  return segments.map((seg) => seg.map((p) => ({ ...p, ele: out[i++][2] })));
}

async function improveHeights(rec: Recording): Promise<Recording> {
  if (rec.stats.eleSource === 'dem') return rec;
  const segments = await withModelHeights(rec.segments).catch(() => null);
  if (!segments) return rec;
  const stats = computeRecStats(segments, {
    activeMs: rec.stats.totalSec * 1000, pausedMs: rec.stats.pausedSec * 1000, eleSource: 'dem',
  });
  return { ...rec, segments, stats };
}

// The recordings this device shows for the account (or for nobody signed in).
export async function listForUser(userId: string | null): Promise<Recording[]> {
  const all = await listLocal();
  return all.filter((r) => r.ownerId === null || r.ownerId === userId);
}

export async function upsertRecording(rec: Recording, userId: string): Promise<Recording> {
  const better = await improveHeights(rec);
  await run(client().from('recordings').upsert(toRow(better), { onConflict: 'id' }));
  const synced = { ...better, ownerId: userId, syncedAt: new Date().toISOString() };
  await putLocal(synced);
  return synced;
}

// Brings the device and the account into step, and returns the list to show.
// Throws (a PersonalAreaError) when the account cannot be reached; the device's
// own list is still good then.
export async function syncRecordings(userId: string): Promise<Recording[]> {
  // Deleted here while out of reception.
  const deletes = pendingDeletes();
  if (deletes.length) {
    await run(client().from('recordings').delete().in('id', deletes));
    setPendingDeletes([]);
  }

  // Up: new, renamed, or recorded before signing in.
  for (const rec of await listForUser(userId)) {
    if (!rec.syncedAt) await upsertRecording(rec, userId);
  }

  // Down: made on another device, and gone from the account elsewhere.
  const rows = (await run<Row[]>(
    client().from('recordings').select('id, name, started_at, ended_at, stats, shared').order('started_at', { ascending: false })
  )) ?? [];
  const onServer = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const local = await getLocal(row.id);
    if (local) {
      if (local.shared !== row.shared || local.name !== row.name) await putLocal({ ...local, shared: row.shared, name: row.name });
      continue;
    }
    const full = await run<{ gpx: string }>(client().from('recordings').select('gpx').eq('id', row.id).maybeSingle());
    const segments = full?.gpx ? gpxToSegments(full.gpx) : null;
    if (!segments) continue;
    await putLocal({
      id: row.id,
      name: row.name,
      startedAt: Date.parse(row.started_at),
      endedAt: Date.parse(row.ended_at),
      segments,
      stats: row.stats,
      ownerId: userId,
      syncedAt: new Date().toISOString(),
      shared: row.shared,
    });
  }
  for (const rec of await listLocal()) {
    if (rec.ownerId === userId && rec.syncedAt && !onServer.has(rec.id)) await deleteLocal(rec.id);
  }
  return listForUser(userId);
}

export async function renameRecording(rec: Recording, name: string): Promise<Recording> {
  const next = { ...rec, name, syncedAt: null };
  await putLocal(next);
  return next;
}

// Deleted from the device at once; from the account now if it can be
// reached, otherwise on the next sync.
export async function deleteRecording(rec: Recording, canReachAccount: boolean): Promise<void> {
  await deleteLocal(rec.id);
  if (!rec.ownerId) return;
  if (canReachAccount) {
    try {
      await run(client().from('recordings').delete().eq('id', rec.id));
      return;
    } catch {
      // falls through to "later"
    }
  }
  setPendingDeletes([...new Set([...pendingDeletes(), rec.id])]);
}

// Turns the link on (or off). The recording goes up to the account with it.
export async function setShared(rec: Recording, shared: boolean, userId: string): Promise<Recording> {
  return upsertRecording({ ...rec, shared }, userId);
}
