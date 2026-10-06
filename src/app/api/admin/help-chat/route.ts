import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';

// GET → the latest questions asked in "שאלו את Navi" (help_chat_log), for the
// admin's list under settings → מתקדם: what users look for and do not find.

export interface HelpChatLogRow {
  id: number;
  created_at: string;
  question: string;
  answer: string | null;
  actions: string[] | null;
  status: string;
}

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const db = serviceClient();
  if (!db) return NextResponse.json({ status: 'not-configured' });
  const { data, error } = await db
    .from('help_chat_log')
    .select('id, created_at, question, answer, actions, status')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    const missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message);
    return NextResponse.json({ status: missing ? 'table-missing' : 'error', error: error.message });
  }
  return NextResponse.json({ status: 'ok', rows: data as HelpChatLogRow[] });
}
