import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { tavilyCredits } from '../../../../lib/tavilyCredits';

// GET → the Tavily allowance (lib/tavilyCredits), for the admin's credit card
// and the alert when it runs out. The admin's alone.
export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  return NextResponse.json(await tavilyCredits(), { headers: { 'Cache-Control': 'no-store' } });
}
