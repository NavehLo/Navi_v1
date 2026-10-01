import { supabase } from './supabase';

// The signed-in user's token, for requests the server needs to attribute: the
// admin-only tools, and the AI calls logged per user (see lib/aiUsage). Empty
// when nobody is signed in — those requests still work, unattributed.
export async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
