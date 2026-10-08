import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Null when Supabase isn't configured — the app runs fine without it,
// login and the personal area are simply hidden.
//
// PKCE, not the implicit default: a sign-in completes only with the secret
// this device made when it started that sign-in. Under implicit flow any link
// carrying `#access_token=…&refresh_token=…` signed the reader into whatever
// account the link's author chose — and their recordings would then sync
// into it.
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey, { auth: { flowType: 'pkce' } }) : null;

export const isSupabaseConfigured = !!supabase;
