import { supabase } from './supabase';
import { deviceId } from './deviceId';
import { isNativeApp } from './native';

// The signed-in user's token, for requests the server needs to attribute: the
// admin-only tools, and the AI calls logged per user (see lib/aiUsage). Empty
// when nobody is signed in — those requests still work, unattributed.
//
// With it, always, the device's own random id and whether this is the Android
// app: the users report tells guests apart by the device, and leaves out the
// admin's devices (lib/ownerExclusion).
export async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const device = deviceId();
  if (device) headers['X-Navi-Device'] = device;
  if (isNativeApp()) headers['X-Navi-Native'] = '1';
  if (!supabase) return headers;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {}
  return headers;
}
