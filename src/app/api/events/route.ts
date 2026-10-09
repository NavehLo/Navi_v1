import { serviceClient } from '../../../lib/supabaseService';
import { bearerToken, isAdminEmail, userFromToken } from '../../../lib/supabaseServer';
import { clientIp, rateLimit } from '../../../lib/rateLimit';
import { deviceOf, describeDevice, hashClient, isNativeRequest } from '../../../lib/clientHash';
import { isOwnerDevice, markOwnerDevice } from '../../../lib/ownerExclusion';
import { isAppEvent } from '../../../lib/appEvents';

// POST { events: [{ event, at, props? }] } from lib/track → app_events, for the
// admin's users report. Only names listed in lib/appEvents are kept, and only
// a few short values with each. The admin's use is not stored at all: signed
// in, the device joins the admin's devices (lib/ownerExclusion) and the
// events are dropped; from a device or IP already on that list, likewise.
// Always answers 204 — the page has nothing to do with the answer.

const MAX_EVENTS = 50;
const MAX_PROPS = 6;

const done = () => new Response(null, { status: 204 });

function cleanProps(raw: unknown): Record<string, string | number | boolean> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_PROPS)) {
    if (!/^[a-z_]{1,24}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 120);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!(await rateLimit(`events:${ip}`, 30, 60_000))) return done();
  const db = serviceClient();
  if (!db) return done();

  let body: { events?: unknown };
  try {
    body = await request.json();
  } catch {
    return done();
  }
  const raw = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];
  if (raw.length === 0) return done();

  const token = bearerToken(request);
  const user = token ? await userFromToken(token) : null;
  const device = deviceOf(request);
  const client = hashClient(ip);
  if (isAdminEmail(user?.email)) {
    await markOwnerDevice(device, describeDevice(request));
    return done();
  }
  if (await isOwnerDevice(device, client, !!user)) return done();

  const now = Date.now();
  const rows = raw.flatMap((e) => {
    const { event, at, props } = (e ?? {}) as { event?: unknown; at?: unknown; props?: unknown };
    if (!isAppEvent(event)) return [];
    // The page's own clock, within the last day; else the time it arrived.
    const t = typeof at === 'number' && at <= now + 60_000 && at > now - 86_400_000 ? at : now;
    return [{
      created_at: new Date(t).toISOString(),
      event,
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
      device_id: device,
      client_hash: user ? null : client,
      native: isNativeRequest(request),
      props: cleanProps(props),
    }];
  });
  if (rows.length === 0) return done();
  const { error } = await db.from('app_events').insert(rows);
  // A missing table (schema.sql not yet run) costs the report a few rows, nothing else.
  if (error && !/42P01|PGRST205|does not exist|Could not find/i.test(`${error.code} ${error.message}`)) {
    console.error('App events not recorded:', error.message);
  }
  return done();
}
