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
  chars: number;
}

// The daily quota is a character budget, because characters are what the TTS
// provider actually bills. Only a cache miss spends any of it — replaying a
// narration that already exists costs nothing and so is never counted.
//
// Called twice per miss: once with chars = 0, which changes nothing and only
// reports whether the user is still under budget, and once afterwards with the
// characters actually synthesized. A user can therefore overshoot by at most
// one narration, and never by a narration that was free.
//
// See supabase/schema.sql → increment_guide_usage.
async function callGuideUsage(
  accessToken: string,
  dailyLimit: number,
  chars: number
): Promise<QuotaResult> {
  const client = userScopedClient(accessToken);
  if (!client) return { configured: false, unavailable: false, allowed: true, chars: 0 };

  try {
    const { data, error } = await client.rpc('increment_guide_usage', {
      p_daily_limit: dailyLimit,
      p_chars: chars,
    });
    if (error || !data || !data[0]) throw error ?? new Error('empty quota response');
    return { configured: true, unavailable: false, allowed: data[0].allowed, chars: data[0].current_chars };
  } catch (e) {
    // Don't hard-fail the user, but don't hand out unmetered TTS either: the
    // caller degrades to the per-IP daily cap while Supabase is down.
    console.error('Guide quota RPC failed:', e);
    return { configured: false, unavailable: true, allowed: true, chars: 0 };
  }
}

// Read-only: is this user still under today's character budget?
export function checkGuideQuota(accessToken: string, dailyCharLimit: number): Promise<QuotaResult> {
  return callGuideUsage(accessToken, dailyCharLimit, 0);
}

// Records characters that were actually synthesized (and therefore paid for).
export function recordGuideUsage(accessToken: string, dailyCharLimit: number, chars: number): Promise<QuotaResult> {
  return callGuideUsage(accessToken, dailyCharLimit, Math.max(1, Math.round(chars)));
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
