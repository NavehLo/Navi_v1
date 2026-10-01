import { serviceClient } from './supabaseService';

// Durable store of world trails' English names, keyed by OSM relation id.
//
// It does two jobs. A name translated once is never paid for again, by anyone.
// And it is the index that makes those names searchable: Waymarked Trails
// searches a route's own name and its name:xx tags, but not int_name and of
// course not a translation we made — "Danakos" finds nothing there. Every
// English name we learn, from OSM or from a model, lands here, and the search
// asks this table alongside Waymarked Trails.
//
// It grows with use: a trail is in it once someone has seen it in the app.
// Without the service-role key or the table, everything here is a no-op —
// names are translated every time and only OSM's own names can be searched.

export interface TrailNameRow {
  relation_id: number;
  name: string;
  name_en: string;
  source: 'osm' | 'ai';
}

let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `Trail name cache disabled: table public.trail_name_en is missing. ` +
          `Run the trail_name_en section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`Trail name cache ${where} failed:`, e);
}

export async function lookupEnglish(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const client = serviceClient();
  if (!client || tableMissing || ids.length === 0) return out;
  try {
    const { data, error } = await client
      .from('trail_name_en')
      .select('relation_id, name_en')
      .in('relation_id', ids);
    if (error) throw error;
    for (const row of data ?? []) out.set(Number(row.relation_id), row.name_en);
  } catch (e) {
    noteError('read', e);
  }
  return out;
}

// OSM's own English name beats a model's guess, so a translation never
// overwrites one; an OSM name overwrites anything (a mapper may have added it
// since we translated).
export async function saveEnglish(rows: TrailNameRow[]): Promise<void> {
  const client = serviceClient();
  if (!client || tableMissing || rows.length === 0) return;
  try {
    const osm = rows.filter((r) => r.source === 'osm');
    const ai = rows.filter((r) => r.source === 'ai');
    if (osm.length) {
      const { error } = await client.from('trail_name_en').upsert(osm);
      if (error) throw error;
    }
    if (ai.length) {
      const { error } = await client
        .from('trail_name_en')
        .upsert(ai, { onConflict: 'relation_id', ignoreDuplicates: true });
      if (error) throw error;
    }
  } catch (e) {
    noteError('write', e);
  }
}

// Every word typed has to appear in the English name, in any order and as any
// part of a word — "danak" finds "Agia Marina – Danakos", as does "marina 2a".
export async function searchEnglish(query: string, limit: number): Promise<TrailNameRow[]> {
  const client = serviceClient();
  if (!client || tableMissing) return [];
  const words = query
    .toLowerCase()
    .replace(/[%_,()\\]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 5);
  if (words.length === 0) return [];
  try {
    let q = client.from('trail_name_en').select('relation_id, name, name_en, source');
    for (const w of words) q = q.ilike('name_en', `%${w}%`);
    const { data, error } = await q.limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => ({ ...r, relation_id: Number(r.relation_id) })) as TrailNameRow[];
  } catch (e) {
    noteError('search', e);
    return [];
  }
}
