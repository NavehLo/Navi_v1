import { serviceClient } from '../supabaseService';
import type { TrailPhotos } from './types';

// Durable store of each trail's chosen photos, one row per trail for everyone.
// Only the choice is kept — links, authors, licences — never the pictures.
//
// Choosing searches Commons part by part (slowly, to stay under its limit)
// and asks the free model about the pictures; the first visitor to a trail
// waits for that, everyone after gets the row. Same shape and same "works
// without the table" rule as trailInfo/cache.ts.

// Raise to choose every trail's photos again — when a rule in select.ts, a
// source or the model's question changes.
export const PHOTOS_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
// New photos are uploaded all the time; a trail's choice is renewed after this.
const MAX_AGE_MS = 90 * DAY_MS;
// Chosen without the model's look (no key, or its allowance used up): soon
// chosen again, so the model gets to look.
const UNCHECKED_MAX_AGE_MS = 7 * DAY_MS;

let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `Trail photos cache disabled: table public.trail_photos is missing. ` +
          `Run the trail_photos section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`Trail photos cache ${where} failed:`, e);
}

const memory = new Map<string, { at: number; photos: TrailPhotos }>();
const MEMORY_MAX = 200;

function remember(key: string, photos: TrailPhotos, at = Date.now()): void {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(key, { at, photos });
}

function isStale(photos: TrailPhotos, at: number): boolean {
  return Date.now() - at > (photos.checked ? MAX_AGE_MS : UNCHECKED_MAX_AGE_MS);
}

export async function readTrailPhotos(key: string): Promise<{ photos: TrailPhotos; stale: boolean } | null> {
  const hit = memory.get(key);
  if (hit) return { photos: hit.photos, stale: isStale(hit.photos, hit.at) };

  const client = serviceClient();
  if (!client || tableMissing) return null;
  try {
    const { data, error } = await client
      .from('trail_photos')
      .select('photos, created_at')
      .eq('trail_key', key)
      .eq('photos_version', PHOTOS_VERSION)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const at = new Date(data.created_at).getTime();
    const photos = data.photos as TrailPhotos;
    remember(key, photos, at);
    return { photos, stale: isStale(photos, at) };
  } catch (e) {
    noteError('read', e);
    return null;
  }
}

export async function writeTrailPhotos(key: string, photos: TrailPhotos): Promise<void> {
  remember(key, photos);
  const client = serviceClient();
  if (!client || tableMissing) return;
  try {
    const { error } = await client.from('trail_photos').upsert({
      trail_key: key,
      photos_version: PHOTOS_VERSION,
      photos,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    noteError('write', e);
  }
}
