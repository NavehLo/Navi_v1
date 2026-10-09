import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../lib/supabaseServer';
import { deviceOf, describeDevice } from '../../../lib/clientHash';
import { markOwnerDevice } from '../../../lib/ownerExclusion';

// Whether the signed-in user is the site's admin (see isAdminRequest). The
// settings ask this before showing "מתקדם"; the answer is a yes or no, never
// the list of addresses. An admin asking marks the device as the admin's, so
// its use stays out of the users report even when signed out.
export async function GET(request: Request) {
  const admin = await isAdminRequest(request);
  if (admin) await markOwnerDevice(deviceOf(request), describeDevice(request));
  return NextResponse.json({ admin }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
