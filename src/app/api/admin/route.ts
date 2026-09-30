import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../lib/supabaseServer';

// Whether the signed-in user is the site's admin (see isAdminRequest). The
// settings ask this before showing "מתקדם"; the answer is a yes or no, never
// the list of addresses.
export async function GET(request: Request) {
  return NextResponse.json({ admin: await isAdminRequest(request) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
