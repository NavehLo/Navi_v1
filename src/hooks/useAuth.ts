import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { isNativeApp, NATIVE_AUTH_REDIRECT, openInSystemBrowser, onNativeAuthRedirect } from '../lib/native';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

// Who is signed in — and, just as important in the field, who *was*.
//
// A Supabase sign-in is an access token that lasts an hour and a refresh
// token that renews it. With no reception the renewal cannot happen, and
// `getSession()` then answers "no session" even though the session is still
// on the device and will renew itself the moment the network is back. The app
// used to take that answer at its word: an hour into a walk, or on coming
// back to the app after it had been in the background, the account looked
// signed out, the personal area disappeared, and the trails saved in it could
// not be opened — exactly where they were needed.
//
// So the account is remembered on the device, and only forgotten when the
// user signs out themselves. `user` is that account whenever there is one;
// `sessionLive` says whether the server will actually accept it right now
// (it will not while offline, nor after the server really ended the session —
// then signing in again is needed before anything can be saved).

const REMEMBERED_KEY = 'navi:lastUser.v1';

// Read through an external store, so the server render (nobody) and the
// first client render agree, and the remembered account shows at once —
// without waiting on a session check that, on a weak signal, can hang.
const listeners = new Set<() => void>();
function subscribeRemembered(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function readRememberedRaw(): string | null {
  try { return localStorage.getItem(REMEMBERED_KEY); } catch { return null; }
}
function writeRemembered(user: User | null) {
  try {
    if (user) localStorage.setItem(REMEMBERED_KEY, JSON.stringify(user));
    else localStorage.removeItem(REMEMBERED_KEY);
  } catch {}
  listeners.forEach((l) => l());
}

export function useAuth() {
  const [liveUser, setLiveUser] = useState<User | null>(null);
  const rememberedRaw = useSyncExternalStore(subscribeRemembered, readRememberedRaw, () => null);
  const remembered = useMemo<User | null>(() => {
    try { return rememberedRaw ? (JSON.parse(rememberedRaw) as User) : null; } catch { return null; }
  }, [rememberedRaw]);
  const [authLoading, setAuthLoading] = useState(!!supabase);
  const signingOutRef = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;

    const take = (user: User | null) => {
      setLiveUser(user);
      if (user) writeRemembered(user);
    };

    client.auth.getSession().then(({ data }) => {
      take(data.session?.user ?? null);
      setAuthLoading(false);
    });

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' && signingOutRef.current) {
        signingOutRef.current = false;
        writeRemembered(null);
      }
      take(session?.user ?? null);
    });

    // Back in reception: ask again. If the refresh token is still good this
    // renews the session, and the TOKEN_REFRESHED above brings `liveUser` back.
    const retry = () => {
      client.auth.getSession().then(({ data }) => { if (data.session) take(data.session.user); });
    };
    window.addEventListener('online', retry);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('online', retry);
    };
  }, []);

  // The app's sign-in comes back as a link into the app (see lib/native.ts):
  // a code to exchange, or the tokens themselves after the "#".
  useEffect(() => onNativeAuthRedirect(async (url) => {
    const client = supabase;
    if (!client) return;
    const code = url.searchParams.get('code');
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    const access_token = hash.get('access_token'), refresh_token = hash.get('refresh_token');
    if (code) await client.auth.exchangeCodeForSession(code);
    else if (access_token && refresh_token) await client.auth.setSession({ access_token, refresh_token });
  }), []);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    if (isNativeApp()) {
      const { data } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: NATIVE_AUTH_REDIRECT, skipBrowserRedirect: true },
      });
      if (data?.url) await openInSystemBrowser(data.url);
      return;
    }
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    signingOutRef.current = true;
    writeRemembered(null);
    // `local`: this device only, not every device the account is signed in on.
    await supabase.auth.signOut({ scope: 'local' });
  }, []);

  return {
    user: supabase ? liveUser ?? remembered : null,
    sessionLive: !!liveUser,
    authLoading,
    signInWithGoogle,
    signOut,
    isAuthAvailable: !!supabase,
  };
}
