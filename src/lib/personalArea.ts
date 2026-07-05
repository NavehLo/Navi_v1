import { supabase } from './supabase';

export interface SavedTrail {
  id: string;
  name: string;
  source_url: string | null;
  source_content: string | null;
  total_distance: number | null;
  created_at: string;
}

export interface TourHistoryEntry {
  id: string;
  trail_name: string;
  distance_km: number | null;
  completed_pct: number | null;
  mode: string;
  created_at: string;
}

export interface TrailNote {
  trail_name: string;
  rating: number | null;
  note: string | null;
}

function client() {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase;
}

// ── מסלולים שמורים ────────────────────────────────────────────────────────────
export async function saveTrail(input: {
  name: string;
  sourceUrl?: string | null;
  sourceContent?: string | null;
  totalDistance?: number | null;
}): Promise<void> {
  const { error } = await client().from('saved_trails').insert({
    name: input.name,
    source_url: input.sourceUrl ?? null,
    source_content: input.sourceContent ?? null,
    total_distance: input.totalDistance ?? null,
  });
  if (error) throw error;
}

export async function listSavedTrails(): Promise<SavedTrail[]> {
  const { data, error } = await client()
    .from('saved_trails')
    .select('id, name, source_url, source_content, total_distance, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function deleteSavedTrail(id: string): Promise<void> {
  const { error } = await client().from('saved_trails').delete().eq('id', id);
  if (error) throw error;
}

// ── היסטוריית סיורים ──────────────────────────────────────────────────────────
export async function recordTour(input: {
  trailName: string;
  distanceKm: number;
  completedPct: number;
  mode?: 'virtual' | 'field';
}): Promise<void> {
  const { error } = await client().from('tour_history').insert({
    trail_name: input.trailName,
    distance_km: input.distanceKm,
    completed_pct: Math.round(input.completedPct),
    mode: input.mode ?? 'virtual',
  });
  if (error) throw error;
}

export async function listTourHistory(): Promise<TourHistoryEntry[]> {
  const { data, error } = await client()
    .from('tour_history')
    .select('id, trail_name, distance_km, completed_pct, mode, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

// ── הערות ודירוג ─────────────────────────────────────────────────────────────
export async function getTrailNote(trailName: string): Promise<TrailNote | null> {
  const { data, error } = await client()
    .from('trail_notes')
    .select('trail_name, rating, note')
    .eq('trail_name', trailName)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listTrailNotes(): Promise<TrailNote[]> {
  const { data, error } = await client()
    .from('trail_notes')
    .select('trail_name, rating, note');
  if (error) throw error;
  return data ?? [];
}

export async function upsertTrailNote(input: {
  trailName: string;
  rating: number | null;
  note: string | null;
}): Promise<void> {
  const { data: userData } = await client().auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await client().from('trail_notes').upsert(
    {
      user_id: userId,
      trail_name: input.trailName,
      rating: input.rating,
      note: input.note,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,trail_name' }
  );
  if (error) throw error;
}
