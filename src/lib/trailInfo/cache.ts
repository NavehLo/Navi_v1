import { serviceClient } from '../supabaseService';
import type { TrailInfo } from './types';

// Durable cache of trail descriptions, one row per trail for everyone.
//
// Writing a description reads a website, a few encyclopedia articles and asks
// a language model — tens of seconds and the free tier's quota. The first
// visitor to a trail pays that; everyone after gets the row. Same shape and
// same "works without the table" rule as poiDiscoveryCache.ts.

// Raise to retire every stored description — when the prompt or the sources
// change in a way that should reach trails that were already described.
export const INFO_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
// Trail sites change: a new hut, a closed section, a new bus line.
const MAX_AGE_MS = 90 * DAY_MS;

let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `Trail info cache disabled: table public.trail_info is missing. ` +
          `Run the trail_info section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`Trail info cache ${where} failed:`, e);
}

const memory = new Map<string, { at: number; info: TrailInfo }>();
const MEMORY_MAX = 100;

function remember(key: string, info: TrailInfo, at = Date.now()): void {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value!);
  memory.set(key, { at, info });
}

export async function readTrailInfo(key: string): Promise<{ info: TrailInfo; stale: boolean } | null> {
  const hit = memory.get(key);
  if (hit) return { info: hit.info, stale: Date.now() - hit.at > MAX_AGE_MS };

  const client = serviceClient();
  if (!client || tableMissing) return null;
  try {
    const { data, error } = await client
      .from('trail_info')
      .select('info, created_at')
      .eq('trail_key', key)
      .eq('info_version', INFO_VERSION)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const at = new Date(data.created_at).getTime();
    const info = data.info as TrailInfo;
    remember(key, info, at);
    return { info, stale: Date.now() - at > MAX_AGE_MS };
  } catch (e) {
    noteError('read', e);
    return null;
  }
}

export async function writeTrailInfo(key: string, info: TrailInfo): Promise<void> {
  remember(key, info);
  const client = serviceClient();
  if (!client || tableMissing) return;
  try {
    const { error } = await client.from('trail_info').upsert({
      trail_key: key,
      info_version: INFO_VERSION,
      info,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    noteError('write', e);
  }
}
