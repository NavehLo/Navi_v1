import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Durable narration cache.
//
// Narration text and its audio are cached separately and permanently, so a
// point of interest costs one LLM call and one TTS call for its entire life:
// the virtual tour used to preview a trail and the walk through it in the
// field play the very same file. Splitting text from audio means changing the
// voice re-renders audio without paying for the text again.
//
// The cache is global rather than per-user — the narration for a spring is the
// same narration whoever is standing next to it — so it needs write access
// that isn't tied to a signed-in user. The rest of the project deliberately
// avoids a service-role key (see lib/supabaseServer), so this module holds the
// only use of it, server-side, and everything here degrades to null when the
// key is missing. Without it the app still works; it just pays again.

export const NARRATION_BUCKET = 'narrations';

// Bumping this invalidates every cached narration on purpose: it is the
// mechanism for rolling out a better prompt without deleting rows by hand.
// Audio keyed to superseded text simply stops being referenced.
export const PROMPT_VERSION = 2;

export interface PoiIdentity {
  lat: number;
  lon: number;
  type: string;
  osmType?: string | null; // 'node' | 'way' | 'relation'
  osmId?: number | string | null;
  trailSlug?: string | null; // only for the synthetic start/midway/end points
}

const SYNTHETIC_TYPES = new Set(['start', 'midway', 'end']);

// Identifies the *point*, not the trail it was found on, so a spring that
// appears in two different trails is paid for once. Four decimal places is
// about 11 m — close enough that two readings of the same node collapse onto
// one key, far enough apart that neighbouring points don't collide.
export function poiKeyFor(p: PoiIdentity): string {
  const v = `v${PROMPT_VERSION}`;
  if (p.osmType && p.osmId != null && p.osmId !== '') {
    return `osm:${p.osmType}/${p.osmId}:${v}`;
  }
  if (p.trailSlug && SYNTHETIC_TYPES.has(p.type)) {
    return `trail:${p.trailSlug}:${p.type}:${v}`;
  }
  return `geo:${p.lat.toFixed(4)}:${p.lon.toFixed(4)}:${p.type}:${v}`;
}

let cachedClient: SupabaseClient | null | undefined;

function serviceClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cachedClient = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return cachedClient;
}

export function isNarrationCacheConfigured(): boolean {
  return serviceClient() !== null;
}

export interface CachedNarration {
  text: string;
  sources: unknown;
}

export async function readNarration(poiKey: string): Promise<CachedNarration | null> {
  const client = serviceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('poi_narration')
      .select('text, sources')
      .eq('poi_key', poiKey)
      .maybeSingle();
    if (error) throw error;
    return data ? { text: data.text, sources: data.sources } : null;
  } catch (e) {
    console.error('Narration cache read failed:', e);
    return null;
  }
}

export async function writeNarration(poiKey: string, text: string, sources: unknown): Promise<void> {
  const client = serviceClient();
  if (!client) return;
  try {
    const { error } = await client
      .from('poi_narration')
      .upsert({ poi_key: poiKey, text, prompt_version: PROMPT_VERSION, sources: sources ?? null });
    if (error) throw error;
  } catch (e) {
    // A cache that can't be written is a cost problem, never a user-facing one.
    console.error('Narration cache write failed:', e);
  }
}

export interface CachedAudio {
  url: string;
  format: string;
}

function publicUrl(client: SupabaseClient, storagePath: string): string {
  return client.storage.from(NARRATION_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

export async function readAudio(audioKey: string): Promise<CachedAudio | null> {
  const client = serviceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('narration_audio')
      .select('storage_path, format')
      .eq('audio_key', audioKey)
      .maybeSingle();
    if (error) throw error;
    return data ? { url: publicUrl(client, data.storage_path), format: data.format } : null;
  } catch (e) {
    console.error('Audio cache read failed:', e);
    return null;
  }
}

export interface AudioToStore {
  audioKey: string;
  poiKey: string;
  buffer: Buffer;
  format: string; // mp3 | wav
  chars: number;
}

// Uploads the clip and records it. Returns the public URL, or null when the
// cache isn't configured or the upload failed — the caller then falls back to
// sending the audio inline as base64.
export async function writeAudio(a: AudioToStore): Promise<CachedAudio | null> {
  const client = serviceClient();
  if (!client) return null;

  const storagePath = `${a.audioKey}.${a.format}`;
  try {
    const { error: uploadError } = await client.storage
      .from(NARRATION_BUCKET)
      .upload(storagePath, a.buffer, {
        contentType: a.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { error } = await client.from('narration_audio').upsert({
      audio_key: a.audioKey,
      poi_key: a.poiKey,
      storage_path: storagePath,
      format: a.format,
      chars: a.chars,
    });
    if (error) throw error;

    return { url: publicUrl(client, storagePath), format: a.format };
  } catch (e) {
    console.error('Audio cache write failed:', e);
    return null;
  }
}
