import { NextResponse } from 'next/server';
import { isIP } from 'node:net';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { deviceOf, describeDevice } from '../../../../lib/clientHash';
import { forgetOwnerLists } from '../../../../lib/ownerExclusion';

// The admin's devices and IPs (lib/ownerExclusion), edited from
// "משתמשים ושימוש":
//   POST   { kind: 'device' }                → this device is the admin's
//   POST   { kind: 'ip', ip, label? }        → so is this address
//   DELETE { kind: 'device' | 'ip', id }     → no longer

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: 'חסר מפתח השירות של Supabase.' }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { kind?: string; ip?: string; label?: string };

  let error;
  if (body.kind === 'device') {
    const device = deviceOf(request);
    if (!device) return NextResponse.json({ error: 'למכשיר הזה אין מזהה.' }, { status: 400 });
    ({ error } = await db.from('owner_devices').upsert({ device_id: device, label: describeDevice(request) }));
  } else if (body.kind === 'ip') {
    const ip = (body.ip ?? '').trim();
    if (!isIP(ip)) return NextResponse.json({ error: 'זו לא כתובת IP תקינה.' }, { status: 400 });
    ({ error } = await db.from('owner_ips').upsert({ ip, label: body.label?.slice(0, 60) || null }));
  } else {
    return NextResponse.json({ error: 'בקשה לא מוכרת.' }, { status: 400 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  forgetOwnerLists();
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  if (!(await isAdminRequest(request))) return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  const db = serviceClient();
  if (!db) return NextResponse.json({ error: 'חסר מפתח השירות של Supabase.' }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as { kind?: string; id?: string };
  if (!body.id) return NextResponse.json({ error: 'חסר מזהה.' }, { status: 400 });
  const { error } = body.kind === 'device'
    ? await db.from('owner_devices').delete().eq('device_id', body.id)
    : body.kind === 'ip'
      ? await db.from('owner_ips').delete().eq('ip', body.id)
      : { error: { message: 'בקשה לא מוכרת.' } };
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  forgetOwnerLists();
  return NextResponse.json({ ok: true });
}
