import { serviceClient } from './supabaseService';
import { hashClient } from './clientHash';

// The admin's own use, left out of the users report ("משתמשים ושימוש") and
// exempt from the AI limits even when the admin is not signed in:
//   - the admin's address (ADMIN_EMAILS), as everywhere;
//   - the admin's devices (owner_devices) — a device joins the list by itself
//     the first time the admin is signed in on it, or by "המכשיר הזה שלי";
//   - the admin's IP addresses (owner_ips), compared as the same salted hash
//     the usage tables keep. An IP counts only for a guest: someone else
//     signed in on the admin's network is still someone else.
// Decided only on the server; the page cannot claim to be the admin's.

export interface OwnerLists {
  devices: Set<string>;
  ipHashes: Set<string>;
}

const TTL_MS = 60_000;
let cached: { at: number; lists: Promise<OwnerLists> } | null = null;

export function forgetOwnerLists() {
  cached = null;
}

export function ownerLists(): Promise<OwnerLists> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.lists;
  const lists = (async (): Promise<OwnerLists> => {
    const db = serviceClient();
    const empty = { devices: new Set<string>(), ipHashes: new Set<string>() };
    if (!db) return empty;
    const [devices, ips] = await Promise.all([
      db.from('owner_devices').select('device_id'),
      db.from('owner_ips').select('ip'),
    ]);
    // Before schema.sql adds the tables, nobody is the admin's but the address.
    return {
      devices: new Set((devices.data ?? []).map((r) => r.device_id as string)),
      ipHashes: new Set((ips.data ?? []).map((r) => hashClient(r.ip as string))),
    };
  })().catch(() => ({ devices: new Set<string>(), ipHashes: new Set<string>() }));
  cached = { at: Date.now(), lists };
  return lists;
}

// Whether a request with no admin signed in still comes from the admin.
// `signedIn` is true when someone else is signed in: then only the device counts.
export async function isOwnerDevice(device: string | null, clientHash: string | null, signedIn: boolean): Promise<boolean> {
  if (!device && !clientHash) return false;
  const { devices, ipHashes } = await ownerLists();
  if (device && devices.has(device)) return true;
  return !signedIn && !!clientHash && ipHashes.has(clientHash);
}

// The admin is signed in on this device: from now on it is the admin's.
export async function markOwnerDevice(device: string | null, label?: string): Promise<void> {
  if (!device) return;
  const { devices } = await ownerLists();
  if (devices.has(device)) return;
  const db = serviceClient();
  if (!db) return;
  const { error } = await db.from('owner_devices').upsert({ device_id: device, label: label ?? null }, { onConflict: 'device_id', ignoreDuplicates: true });
  if (!error) forgetOwnerLists();
}
