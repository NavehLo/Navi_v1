import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAdminEmail, isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { clientIp } from '../../../../lib/rateLimit';
import { deviceOf, describeDevice, hashClient } from '../../../../lib/clientHash';
import { forgetOwnerLists, markOwnerDevice } from '../../../../lib/ownerExclusion';
import { PAID_PROVIDERS } from '../../../../lib/aiLimits';
import type { AiProvider } from '../../../../lib/aiPricing';
import type {
  EventUsage, OwnerExclusion, PersonUsage, ProviderUsage, UsersReport,
} from '../../../../lib/usersReport';

// GET ?days=7|30|90|0 → the admin's "משתמשים ושימוש": every registered user
// (from Supabase Auth, used the app or not) and every guest (by device, else
// by hashed IP), with what each did in the app (app_events, lib/track) and
// which API services they used (ai_usage). The admin's own use is left out:
// the admin's address, devices and IPs (lib/ownerExclusion), and the rows
// already marked exempt (the admin's scripts).

interface EventRow {
  user_id: string | null; user_email: string | null; device_id: string | null; client_hash: string | null;
  native: boolean; event: string; day: string; events: number; first_at: string; last_at: string;
}
interface ApiRow {
  user_id: string | null; user_email: string | null; device_id: string | null; client_hash: string | null;
  exempt: boolean; provider: string; day: string; calls: number; chars: number; searches: number;
  cost_usd: number; first_at: string; last_at: string;
}
interface AuthUser { id: string; email?: string; created_at: string; last_sign_in_at?: string | null }

const MISSING = /42883|42P01|PGRST202|PGRST205|does not exist|Could not find/i;

async function allUsers(db: SupabaseClient): Promise<AuthUser[]> {
  const users: AuthUser[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    users.push(...(data.users as AuthUser[]));
    if (data.users.length < 1000) break;
  }
  return users;
}

async function ownerExclusion(db: SupabaseClient, request: Request): Promise<OwnerExclusion> {
  const current = deviceOf(request);
  const [devices, ips] = await Promise.all([
    db.from('owner_devices').select('device_id, label, created_at').order('created_at'),
    db.from('owner_ips').select('ip, label, created_at').order('created_at'),
  ]);
  return {
    devices: (devices.data ?? []).map((d) => ({ id: d.device_id, label: d.label, createdAt: d.created_at, current: d.device_id === current })),
    ips: (ips.data ?? []).map((r) => ({ ip: r.ip, label: r.label, createdAt: r.created_at })),
    currentIp: clientIp(request) === 'unknown' ? null : clientIp(request),
  };
}

const isPaid = (provider: string) => PAID_PROVIDERS.has(provider as AiProvider);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
const earlier = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ status: 'not-configured' } satisfies UsersReport);

  // The admin is looking from this device: it is the admin's.
  await markOwnerDevice(deviceOf(request), describeDevice(request));
  forgetOwnerLists();

  const days = Math.max(0, Math.min(3650, parseInt(new URL(request.url).searchParams.get('days') ?? '30', 10) || 0));
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

  const [events, api, users, owner, firstEvent, firstApi] = await Promise.all([
    db.rpc('app_events_summary', { p_since: since }),
    db.rpc('ai_usage_by_person', { p_since: since }),
    allUsers(db),
    ownerExclusion(db, request),
    db.from('app_events').select('created_at').order('created_at', { ascending: true }).limit(1),
    db.from('ai_usage').select('created_at').order('created_at', { ascending: true }).limit(1),
  ]);
  const failed = events.error ?? api.error;
  if (failed) {
    const detail = [failed.code, failed.message].filter(Boolean).join(': ');
    console.error('Users report failed:', failed);
    return NextResponse.json({ status: MISSING.test(detail) ? 'no-table' : 'error', detail, owner } satisfies UsersReport);
  }

  const ownerDevices = new Set(owner.devices.map((d) => d.id));
  const ownerHashes = new Set(owner.ips.map((r) => hashClient(r.ip)));
  const isOwner = (r: { user_email: string | null; user_id: string | null; device_id: string | null; client_hash: string | null }) =>
    isAdminEmail(r.user_email)
    || (!!r.device_id && ownerDevices.has(r.device_id))
    || (!r.user_id && !!r.client_hash && ownerHashes.has(r.client_hash));

  const eventRows = (events.data ?? []) as EventRow[];
  const apiRows = (api.data ?? []) as ApiRow[];

  // One person per signed-in user; a guest is a device, else an IP hash. A
  // device once used signed in belongs to that user, and an IP hash seen with
  // only one device is that device (the AI log before devices were sent).
  const deviceUser = new Map<string, string>();
  const hashDevices = new Map<string, Set<string>>();
  for (const r of eventRows) {
    if (r.user_id && r.device_id) deviceUser.set(r.device_id, r.user_id);
    if (!r.user_id && r.device_id && r.client_hash) {
      const set = hashDevices.get(r.client_hash) ?? new Set();
      set.add(r.device_id);
      hashDevices.set(r.client_hash, set);
    }
  }
  const personKey = (r: { user_id: string | null; device_id: string | null; client_hash: string | null }) => {
    if (r.user_id) return `u:${r.user_id}`;
    if (r.device_id) return deviceUser.has(r.device_id) ? `u:${deviceUser.get(r.device_id)}` : `d:${r.device_id}`;
    if (r.client_hash) {
      const devices = hashDevices.get(r.client_hash);
      if (devices?.size === 1) {
        const [d] = devices;
        return deviceUser.has(d) ? `u:${deviceUser.get(d)}` : `d:${d}`;
      }
      return `h:${r.client_hash}`;
    }
    return 'h:unknown';
  };

  const people = new Map<string, PersonUsage & { daySet: Set<string> }>();
  const person = (key: string, email: string | null) => {
    let p = people.get(key);
    if (!p) {
      p = {
        key, kind: key.startsWith('u:') ? 'user' : 'guest', email, signedUpAt: null, lastSignInAt: null,
        firstAt: null, lastAt: null, activeDays: 0, native: false, web: false,
        events: {}, eventsTotal: 0, api: [], apiCalls: 0, costUsd: 0, daySet: new Set(),
      };
      people.set(key, p);
    }
    if (email && !p.email) p.email = email;
    return p;
  };

  const excluded = { events: 0, apiCalls: 0 };
  const eventPeople = new Map<string, Set<string>>();
  for (const r of eventRows) {
    if (isOwner(r)) { excluded.events += Number(r.events); continue; }
    const p = person(personKey(r), r.user_email);
    p.events[r.event] = (p.events[r.event] ?? 0) + Number(r.events);
    p.eventsTotal += Number(r.events);
    p.daySet.add(r.day);
    if (r.native) p.native = true; else p.web = true;
    p.firstAt = earlier(p.firstAt, r.first_at);
    p.lastAt = later(p.lastAt, r.last_at);
    const set = eventPeople.get(r.event) ?? new Set();
    set.add(p.key);
    eventPeople.set(r.event, set);
  }

  const providerPeople = new Map<string, Set<string>>();
  const providers = new Map<string, ProviderUsage>();
  for (const r of apiRows) {
    if (r.exempt || isOwner(r)) { excluded.apiCalls += Number(r.calls); continue; }
    const p = person(personKey(r), r.user_email);
    const cost = isPaid(r.provider) ? Number(r.cost_usd) : 0;
    let use = p.api.find((a) => a.provider === r.provider);
    if (!use) { use = { provider: r.provider, calls: 0, chars: 0, searches: 0, costUsd: 0 }; p.api.push(use); }
    use.calls += Number(r.calls);
    use.chars += Number(r.chars);
    use.searches += Number(r.searches);
    use.costUsd += cost;
    p.apiCalls += Number(r.calls);
    p.costUsd += cost;
    p.daySet.add(r.day);
    p.firstAt = earlier(p.firstAt, r.first_at);
    p.lastAt = later(p.lastAt, r.last_at);
    const total = providers.get(r.provider) ?? { provider: r.provider, calls: 0, chars: 0, searches: 0, costUsd: 0, people: 0 };
    total.calls += Number(r.calls);
    total.chars += Number(r.chars);
    total.searches += Number(r.searches);
    total.costUsd += cost;
    providers.set(r.provider, total);
    const set = providerPeople.get(r.provider) ?? new Set();
    set.add(p.key);
    providerPeople.set(r.provider, set);
  }

  // Every registered user, active in the period or not.
  let newRegistered = 0;
  let registered = 0;
  for (const u of users) {
    if (isAdminEmail(u.email)) continue;
    registered++;
    if (since && u.created_at >= since) newRegistered++;
    const p = person(`u:${u.id}`, u.email ?? null);
    p.signedUpAt = u.created_at;
    p.lastSignInAt = u.last_sign_in_at ?? null;
  }
  if (!since) newRegistered = registered;

  const list = [...people.values()].map(({ daySet, ...p }) => ({ ...p, activeDays: daySet.size }));
  // Guests numbered by when they were first seen.
  list.filter((p) => p.kind === 'guest')
    .sort((a, b) => (a.firstAt ?? '').localeCompare(b.firstAt ?? ''))
    .forEach((p, i) => { p.guestNo = i + 1; });
  list.sort((a, b) => (b.lastAt ?? b.signedUpAt ?? '').localeCompare(a.lastAt ?? a.signedUpAt ?? ''));
  for (const p of list) p.api.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const active = list.filter((p) => p.eventsTotal + p.apiCalls > 0);
  const byEvent: EventUsage[] = [...eventPeople.entries()]
    .map(([event, set]) => ({ event, people: set.size, count: list.reduce((n, p) => n + (p.events[event] ?? 0), 0) }))
    .sort((a, b) => b.count - a.count);
  const byProvider = [...providers.values()]
    .map((v) => ({ ...v, people: providerPeople.get(v.provider)?.size ?? 0 }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const report: UsersReport = {
    status: 'ok',
    days,
    eventsSince: firstEvent.data?.[0]?.created_at ?? null,
    apiSince: firstApi.data?.[0]?.created_at ?? null,
    summary: {
      registered,
      newRegistered,
      activeRegistered: active.filter((p) => p.kind === 'user').length,
      activeGuests: active.filter((p) => p.kind === 'guest').length,
      nativePeople: active.filter((p) => p.native).length,
      events: active.reduce((n, p) => n + p.eventsTotal, 0),
      apiCalls: active.reduce((n, p) => n + p.apiCalls, 0),
      costUsd: active.reduce((n, p) => n + p.costUsd, 0),
    },
    people: list,
    byEvent,
    byProvider,
    owner,
    excluded,
  };
  return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } });
}
