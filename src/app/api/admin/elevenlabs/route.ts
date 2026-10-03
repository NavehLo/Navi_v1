import { NextResponse } from 'next/server';
import { isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { elevenLabsCredits } from '../../../../lib/elevenlabs';
import type { CreditsLevel, CreditsReport } from '../../../../lib/creditsReport';

// GET → the ElevenLabs allowance and how fast it is going (see
// lib/creditsReport). The admin's alone: the app asks on every open for a
// signed-in user, and everyone else gets a 403 and no alert.

const DAY_MS = 86_400_000;
// A typical narration when the log has nothing to go on yet.
const DEFAULT_NARRATION_CHARS = 600;

interface VoiceUse { calls: number; chars: number }

// The app's own record of spoken characters since a moment.
async function voiceUseSince(since: Date): Promise<VoiceUse | null> {
  const db = serviceClient();
  if (!db) return null;
  const { data, error } = await db.rpc('ai_usage_summary', { p_since: since.toISOString() });
  if (error || !data) return null;
  return (data as Array<{ provider: string; kind: string; calls: number; chars: number }>)
    .filter((r) => r.provider === 'elevenlabs' && r.kind === 'voice')
    .reduce((t, r) => ({ calls: t.calls + Number(r.calls), chars: t.chars + Number(r.chars) }), { calls: 0, chars: 0 });
}

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  const headers = { 'Cache-Control': 'no-store' };

  const outcome = await elevenLabsCredits();
  if (!outcome.ok) {
    const body: CreditsReport = {
      status: 'error',
      httpStatus: outcome.status,
      detail: outcome.detail,
      missingPermission: /missing_permissions|user_read/i.test(outcome.detail),
    };
    return NextResponse.json(body, { headers });
  }

  const { tier, used, limit, resetAt, periodStart } = outcome.credits;
  const now = Date.now();
  const remaining = Math.max(0, limit - used);

  const [week, month] = await Promise.all([
    voiceUseSince(new Date(now - 7 * DAY_MS)),
    voiceUseSince(new Date(now - 30 * DAY_MS)),
  ]);

  const start = periodStart ? Date.parse(periodStart) : now - 30 * DAY_MS;
  const end = resetAt ? Date.parse(resetAt) : start + 30 * DAY_MS;
  // Half a day at least, so the first hours of a period don't project a
  // single narration into a month's worth.
  const elapsedDays = Math.max(0.5, (now - start) / DAY_MS);
  const perDay = used / elapsedDays;
  const runsOutAt = used > 0 && perDay > 0 ? new Date(now + (remaining / perDay) * DAY_MS).toISOString() : null;
  const projectedMonth = used > 0 ? Math.round(perDay * ((end - start) / DAY_MS)) : null;

  const charsPerNarration = month && month.calls > 0 ? Math.round(month.chars / month.calls) : null;
  const narrationSize = charsPerNarration ?? DEFAULT_NARRATION_CHARS;
  const narrationsLeft = Math.floor(remaining / narrationSize);

  let level: CreditsLevel = 'ok';
  if (limit > 0 && remaining < narrationSize) level = 'out';
  else if (limit > 0 && (used / limit >= 0.9 || (runsOutAt !== null && Date.parse(runsOutAt) < end))) level = 'low';

  const body: CreditsReport = {
    status: 'ok',
    tier,
    used,
    limit,
    remaining,
    resetAt,
    periodStart,
    daysToReset: resetAt ? Math.max(0, Math.round((end - now) / DAY_MS)) : null,
    perDay: Math.round(perDay),
    perDayLastWeek: week ? Math.round(week.chars / 7) : null,
    runsOutAt,
    projectedMonth,
    charsPerNarration,
    narrationsLeft,
    level,
  };
  return NextResponse.json(body, { headers });
}
