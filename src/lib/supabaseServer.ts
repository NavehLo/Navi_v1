import { createClient } from '@supabase/supabase-js';

// Builds a Supabase client scoped to one request, carrying the signed-in
// user's own access token. RPC calls made with this client run as that user
// (auth.uid() resolves correctly), so RLS and per-user quotas work without
// needing a service-role key.
function userScopedClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') || request.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export interface QuotaResult {
  // false when the quota could not be enforced — either Supabase isn't set up
  // at all, or it's unreachable (see `unavailable`). Either way the caller must
  // fall back to another limit rather than letting the request through unmetered.
  configured: boolean;
  unavailable: boolean; // Supabase is configured but the RPC failed (paused project, outage)
  allowed: boolean;
  count: number;
}

// Atomically increments today's usage counter for the signed-in user and
// reports whether they're still under dailyLimit. See
// supabase/schema.sql → increment_guide_usage for the server-side function.
export async function checkAndIncrementGuideQuota(
  accessToken: string,
  dailyLimit: number
): Promise<QuotaResult> {
  const client = userScopedClient(accessToken);
  if (!client) return { configured: false, unavailable: false, allowed: true, count: 0 };

  try {
    const { data, error } = await client.rpc('increment_guide_usage', { p_daily_limit: dailyLimit });
    if (error || !data || !data[0]) throw error ?? new Error('empty quota response');
    return { configured: true, unavailable: false, allowed: data[0].allowed, count: data[0].current_count };
  } catch (e) {
    // Don't hard-fail the user, but don't hand out unmetered TTS either: the
    // caller degrades to the per-IP daily cap while Supabase is down.
    console.error('Guide quota RPC failed:', e);
    return { configured: false, unavailable: true, allowed: true, count: 0 };
  }
}

// Cheap read used by /api/keepalive to keep a free-tier project from being
// auto-paused after 7 idle days. Raw fetch rather than supabase-js, because
// here the HTTP status *is* the signal: RLS returns zero rows for the anon role
// and even a "table missing" 404 proves Postgres answered. A paused project
// replies 540/503 from the gateway, and a dead one fails to connect at all.
export async function pingSupabase(): Promise<{ ok: boolean; configured: boolean; detail: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return { ok: false, configured: false, detail: 'Supabase env vars are not set' };

  try {
    const res = await fetch(`${url}/rest/v1/guide_usage?select=user_id&limit=1`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    // 401/403 means the gateway rejected us at the edge — the request never
    // reached Postgres, so it neither proves the project is up nor counts as
    // activity. Treat a bad/rotated anon key as a failed ping, not a pass.
    const ok = res.status < 500 && res.status !== 401 && res.status !== 403;
    return { ok, configured: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, configured: true, detail: e instanceof Error ? e.message : String(e) };
  }
}
