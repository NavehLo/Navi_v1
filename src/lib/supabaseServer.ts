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
  configured: boolean; // false when Supabase isn't set up — caller should not block
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
  if (!client) return { configured: false, allowed: true, count: 0 };

  const { data, error } = await client.rpc('increment_guide_usage', { p_daily_limit: dailyLimit });
  if (error || !data || !data[0]) {
    console.error('Guide quota RPC failed:', error);
    // Fail open — never block a legitimate user because of our own infra hiccup
    return { configured: false, allowed: true, count: 0 };
  }
  return { configured: true, allowed: data[0].allowed, count: data[0].current_count };
}
