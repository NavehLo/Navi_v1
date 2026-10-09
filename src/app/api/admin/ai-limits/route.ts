import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import {
  DEFAULT_LIMITS, PAID_PROVIDERS, getLimitSettings, isLiftedToday, israelDate, israelDayStart, saveLimitSettings,
  type AiLimitSettings,
} from '../../../../lib/aiLimits';
import { alertRecipient, isAlertEmailConfigured, sendAlertEmail } from '../../../../lib/alertEmail';
import type { AiProvider } from '../../../../lib/aiPricing';
import type { LimitsReport } from '../../../../lib/aiLimitsReport';

// The admin's controls over AI use (lib/aiLimits):
//   GET                              the settings, today's paid spend, email, recent alerts
//   PUT  {…settings}                 save the limits
//   POST {action: 'lift-today'}      lift the app's daily paid cap until midnight
//   POST {action: 'restore'}         put it back now
//   POST {action: 'test-email'}      send a test alert

async function report(): Promise<LimitsReport> {
  const settings = await getLimitSettings(true);
  const db = serviceClient();
  let todayPaidUsd: number | null = null;
  let alerts: LimitsReport['alerts'] = [];
  let tableReady = true;
  if (db) {
    const [today, recent] = await Promise.all([
      db.rpc('ai_usage_today', { p_since: israelDayStart().toISOString(), p_user: null, p_client: null }),
      db.from('ai_alerts').select('key, subject, created_at').order('created_at', { ascending: false }).limit(15),
    ]);
    if (today.error) tableReady = false;
    else {
      todayPaidUsd = (today.data as Array<{ scope: string; provider: string; cost_usd: number }>)
        .filter((r) => r.scope === 'app' && PAID_PROVIDERS.has(r.provider as AiProvider))
        .reduce((t, r) => t + Number(r.cost_usd), 0);
    }
    if (!recent.error) alerts = (recent.data ?? []).map((a) => ({ subject: a.subject, at: a.created_at }));
    else tableReady = false;
  }
  return {
    settings,
    defaults: DEFAULT_LIMITS,
    today: israelDate(),
    todayPaidUsd,
    liftedToday: isLiftedToday(settings),
    tableReady,
    email: { configured: isAlertEmailConfigured(), recipient: alertRecipient() },
    alerts,
  };
}

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) return json({ error: 'זמין למנהל האתר בלבד.' }, 403);
  return json(await report());
}

export async function PUT(request: Request) {
  if (!(await isAdminRequest(request))) return json({ error: 'זמין למנהל האתר בלבד.' }, 403);
  const body = (await request.json().catch(() => null)) as Partial<AiLimitSettings> | null;
  if (!body || typeof body !== 'object') return json({ error: 'bad request' }, 400);
  // The lift has its own buttons; a form save never changes it.
  const { liftedDay: _ignored, ...patch } = body;
  void _ignored;
  try {
    await saveLimitSettings(patch);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json(await report());
}

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) return json({ error: 'זמין למנהל האתר בלבד.' }, 403);
  const { action } = ((await request.json().catch(() => ({}))) ?? {}) as { action?: string };
  try {
    if (action === 'lift-today') await saveLimitSettings({ liftedDay: israelDate() });
    else if (action === 'restore') await saveLimitSettings({ liftedDay: null });
    else if (action === 'test-email') {
      const sent = await sendAlertEmail('Navi: בדיקת התראות', 'זו הודעת בדיקה מ-Navi. אם היא הגיעה, התראות השימוש ב-AI יגיעו לכתובת הזו.');
      return json({ ...(await report()), test: sent });
    } else return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json(await report());
}
