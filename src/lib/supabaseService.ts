import { createClient, SupabaseClient } from '@supabase/supabase-js';

// The one service-role Supabase client, server-side only.
//
// The rest of the project deliberately avoids the service-role key (see
// lib/supabaseServer, which acts as the signed-in user): it is held here, and
// used only by the two caches that are global rather than per-user — the
// narration for a spring is the same narration whoever is standing next to it,
// and so is the list of points along a trail.
//
// Everything built on it degrades to null when the key is missing. Without it
// the app still works; it just pays again, and asks OpenStreetMap again.

let cachedClient: SupabaseClient | null | undefined;

export function serviceClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  cachedClient = url && key
    ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  return cachedClient;
}
