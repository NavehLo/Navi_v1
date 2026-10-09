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

// The site's own admin: whoever signs in with an address listed in
// ADMIN_EMAILS (comma-separated, set in Vercel). Only they see — and may call —
// the tuning tools behind "מתקדם" in the settings: the voice, the AI provider,
// the niqqud check. Server-side on purpose: the repository is public, so the
// address stays out of the code and out of the page, and the tools that spend
// TTS credits are closed to everyone else, not merely hidden from them.
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && adminEmails().includes(email.toLowerCase());
}

export async function isAdminRequest(request: Request): Promise<boolean> {
  const admins = adminEmails();
  if (admins.length === 0) return false;
  const token = bearerToken(request);
  if (!token) return false;
  const email = (await userFromToken(token))?.email?.toLowerCase();
  return !!email && admins.includes(email);
}

// Who a token belongs to. Asks Supabase rather than reading the token, so a
// forged or expired one gets no answer and an address cannot simply be claimed.
export async function userFromToken(token: string): Promise<{ id: string; email: string | null } | null> {
  const client = userScopedClient(token);
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  } catch {
    return null;
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
