import type { AiProvider } from './aiPricing';
import { currentContext, payerOf, type Payer, type UsageRecord } from './aiUsage';
import { serviceClient } from './supabaseService';
import { sendAlertEmail } from './alertEmail';

// Limits on AI use, set by the admin in settings → "שימוש ועלויות AI".
//
// Every call to an AI or search service asks `ensureAllowed` first. The answer
// comes from what ai_usage holds since midnight (Israel time) for the person
// asking — a signed-in user by account, a guest by a hash of the IP — and for
// the whole app. The admin and the admin's scripts are exempt: recorded, never
// limited.
//
// Two kinds of service, limited differently:
//   paid  — OpenAI, paid Gemini, Claude: real money, so a budget in dollars per
//           person per day and for the whole app per day. Reaching it never
//           breaks a feature: the text engines fall through to the free one.
//   free  — the free Gemini key, ElevenLabs and Tavily on free plans: no money,
//           but a shared allowance one person could use up for everyone, so a
//           generous count per person per day.
//
// Crossing a paid threshold sends the admin an email (lib/alertEmail), once
// per person or per app per day.

export type AiResource = 'paid' | 'free-text' | 'voice' | 'search';

export function resourceOf(provider: AiProvider): AiResource {
  if (provider === 'gemini-free') return 'free-text';
  if (provider === 'elevenlabs') return 'voice';
  if (provider === 'tavily') return 'search';
  return 'paid';
}

export const PAID_PROVIDERS: ReadonlySet<AiProvider> = new Set(['openai', 'gemini', 'claude']);

export interface AiLimitSettings {
  // Paid keys, in USD per day.
  appPaidPerDayUsd: number;
  userPaidPerDayUsd: number;
  guestPaidPerDayUsd: number;
  // Email the admin when one person's paid use in a day passes this…
  alertPersonUsd: number;
  // …and when the whole app reaches this share of its daily cap.
  alertAppPct: number;
  // Free services, per person per day.
  freeTextUser: number;      // calls to the free Gemini key
  freeTextGuest: number;
  voiceCharsUser: number;    // ElevenLabs characters
  voiceCharsGuest: number;
  searchesUser: number;      // Tavily searches
  searchesGuest: number;
  // The app-wide paid cap lifted for this one day (Israel date, YYYY-MM-DD).
  // It applies again by itself the next day.
  liftedDay: string | null;
}

export const DEFAULT_LIMITS: AiLimitSettings = {
  appPaidPerDayUsd: 3,
  userPaidPerDayUsd: 0.3,
  guestPaidPerDayUsd: 0.05,
  alertPersonUsd: 0.1,
  alertAppPct: 80,
  freeTextUser: 300,
  freeTextGuest: 100,
  voiceCharsUser: 3000,
  voiceCharsGuest: 1000,
  searchesUser: 20,
  searchesGuest: 5,
  liftedDay: null,
};

// ── Days, in Israel time ─────────────────────────────────────────────────────

export function israelDate(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(at);
}

// Midnight in Israel, as an instant.
export function israelDayStart(at = new Date()): Date {
  const wall = new Date(at.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  // Whole minutes: the wall-clock string has no milliseconds.
  const offset = Math.round((wall.getTime() - at.getTime()) / 60_000) * 60_000;
  wall.setHours(0, 0, 0, 0);
  return new Date(wall.getTime() - offset);
}

// ── Settings ─────────────────────────────────────────────────────────────────

let settingsCache: { at: number; value: AiLimitSettings } | null = null;
const SETTINGS_TTL_MS = 30_000;

function clean(raw: unknown): AiLimitSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof AiLimitSettings>) {
    if (key === 'liftedDay') continue;
    const n = Number(r[key]);
    if (r[key] != null && Number.isFinite(n) && n >= 0) (out[key] as number) = n;
  }
  out.liftedDay = typeof r.liftedDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.liftedDay) ? r.liftedDay : null;
  return out;
}

export async function getLimitSettings(fresh = false): Promise<AiLimitSettings> {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const db = serviceClient();
  let value = DEFAULT_LIMITS;
  if (db) {
    const { data, error } = await db.from('ai_settings').select('limits').eq('id', 1).maybeSingle();
    if (!error) value = clean(data?.limits);
  }
  settingsCache = { at: Date.now(), value };
  return value;
}

export async function saveLimitSettings(patch: Partial<AiLimitSettings>): Promise<AiLimitSettings> {
  const db = serviceClient();
  if (!db) throw new Error('Supabase is not configured');
  const next = clean({ ...(await getLimitSettings(true)), ...patch });
  const { error } = await db.from('ai_settings').upsert({ id: 1, limits: next, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  settingsCache = { at: Date.now(), value: next };
  return next;
}

export function isLiftedToday(s: AiLimitSettings): boolean {
  return s.liftedDay === israelDate();
}

// ── Today's usage ────────────────────────────────────────────────────────────

export interface UsageSums {
  calls: number;
  chars: number;
  searches: number;
  costUsd: number;
}

export interface TodayUsage {
  person: Map<AiProvider, UsageSums>;
  app: Map<AiProvider, UsageSums>;
}

const zero = (): UsageSums => ({ calls: 0, chars: 0, searches: 0, costUsd: 0 });

export async function readTodayUsage(payer: Pick<Payer, 'userId' | 'client'>): Promise<TodayUsage | null> {
  const db = serviceClient();
  if (!db) return null;
  const { data, error } = await db.rpc('ai_usage_today', {
    p_since: israelDayStart().toISOString(),
    p_user: payer.userId,
    p_client: payer.client,
  });
  if (error || !data) {
    if (error) console.error('AI limits: could not read today\'s usage:', error.message);
    return null;
  }
  const today: TodayUsage = { person: new Map(), app: new Map() };
  for (const r of data as Array<{ scope: string; provider: AiProvider; calls: number; chars: number; searches: number; cost_usd: number }>) {
    (r.scope === 'person' ? today.person : today.app).set(r.provider, {
      calls: Number(r.calls), chars: Number(r.chars), searches: Number(r.searches), costUsd: Number(r.cost_usd),
    });
  }
  return today;
}

function paidCost(sums: Map<AiProvider, UsageSums>): number {
  let total = 0;
  for (const [provider, s] of sums) if (PAID_PROVIDERS.has(provider)) total += s.costUsd;
  return total;
}

function of(sums: Map<AiProvider, UsageSums>, provider: AiProvider): UsageSums {
  return sums.get(provider) ?? zero();
}

// ── The check ────────────────────────────────────────────────────────────────

// Plain fields rather than parameter properties: the admin's scripts load
// this file through Node's own type stripping, which does not accept them.
export class AiLimitError extends Error {
  resource: AiResource;
  scope: 'person' | 'app' | 'unknown';
  constructor(resource: AiResource, scope: 'person' | 'app' | 'unknown') {
    super(`AI limit reached: ${resource} (${scope})`);
    this.name = 'AiLimitError';
    this.resource = resource;
    this.scope = scope;
  }
}

export function isAiLimitError(e: unknown): e is AiLimitError {
  return e instanceof AiLimitError;
}

function who(payer: Payer): string {
  return payer.email ?? (payer.userId ? 'משתמש מחובר' : 'אורח (לא מחובר)');
}

// Throws AiLimitError when the call would go over a limit. `chars` is the size
// of a voice request, checked before it is sent.
export async function ensureAllowed(provider: AiProvider, opts: { chars?: number } = {}): Promise<void> {
  const ctx = currentContext();
  // Every route that reaches an AI service runs inside withAiUsage; outside
  // it there is nobody to charge and nothing to limit.
  if (!ctx) return;
  const payer = await payerOf(ctx);
  if (payer.exempt) return;

  const resource = resourceOf(provider);
  const settings = await getLimitSettings();
  ctx.today ??= readTodayUsage(payer);
  const today = await ctx.today;
  const signedIn = !!payer.userId;

  if (!today) {
    // Without the log there is no way to know what was spent: paid keys stay
    // shut, the free services carry on.
    if (resource === 'paid') throw new AiLimitError('paid', 'unknown');
    return;
  }

  if (resource === 'paid') {
    const personLimit = signedIn ? settings.userPaidPerDayUsd : settings.guestPaidPerDayUsd;
    const person = paidCost(today.person);
    if (person >= personLimit) {
      await alertOnce(`person-limit:${israelDate()}:${payer.userId ?? payer.client}`,
        `Navi: ${who(payer)} הגיע למגבלה היומית במפתחות בתשלום`,
        `${who(payer)} הוציא היום $${person.toFixed(3)} במפתחות בתשלום והגיע למגבלה האישית ($${personLimit}). ` +
        `מעכשיו ועד סוף היום הוא מקבל רק את השירותים החינמיים.`);
      throw new AiLimitError('paid', 'person');
    }
    const app = paidCost(today.app);
    if (app >= settings.appPaidPerDayUsd && !isLiftedToday(settings)) {
      await alertOnce(`app-limit:${israelDate()}`,
        'Navi: האפליקציה הגיעה לתקרה היומית במפתחות בתשלום',
        `ההוצאה היום במפתחות בתשלום הגיעה ל-$${app.toFixed(2)}, התקרה היומית ($${settings.appPaidPerDayUsd}). ` +
        `עד חצות כולם מקבלים רק את השירותים החינמיים. אפשר להסיר את התקרה להיום בהגדרות ← שימוש ועלויות AI.`);
      throw new AiLimitError('paid', 'app');
    }
    return;
  }

  const mine = of(today.person, provider);
  if (resource === 'free-text') {
    if (mine.calls >= (signedIn ? settings.freeTextUser : settings.freeTextGuest)) throw new AiLimitError(resource, 'person');
  } else if (resource === 'voice') {
    if (mine.chars + (opts.chars ?? 0) > (signedIn ? settings.voiceCharsUser : settings.voiceCharsGuest)) throw new AiLimitError(resource, 'person');
  } else if (resource === 'search') {
    if (mine.searches >= (signedIn ? settings.searchesUser : settings.searchesGuest)) throw new AiLimitError(resource, 'person');
  }
}

// How many voice characters this person may still use today; null when not
// limited (the admin, a script, or no log to go by).
export async function voiceCharsLeft(): Promise<{ left: number; signedIn: boolean } | null> {
  const ctx = currentContext();
  if (!ctx) return null;
  const payer = await payerOf(ctx);
  if (payer.exempt) return null;
  const settings = await getLimitSettings();
  ctx.today ??= readTodayUsage(payer);
  const today = await ctx.today;
  if (!today) return null;
  const signedIn = !!payer.userId;
  const limit = signedIn ? settings.voiceCharsUser : settings.voiceCharsGuest;
  return { left: Math.max(0, limit - of(today.person, 'elevenlabs').chars), signedIn };
}

// ── After a call ─────────────────────────────────────────────────────────────

type Ctx = NonNullable<ReturnType<typeof currentContext>>;

// Keeps the request's view of today current, and emails the admin when a paid
// threshold is crossed.
export async function afterRecorded(ctx: Ctx, payer: Payer, record: UsageRecord, costUsd: number): Promise<void> {
  const today = ctx.today ? await ctx.today : null;
  if (today && !payer.exempt) {
    for (const sums of [today.person, today.app]) {
      const s = { ...of(sums, record.provider) };
      s.calls += 1;
      s.chars += record.chars ?? 0;
      s.searches += record.searches ?? 0;
      s.costUsd += costUsd;
      sums.set(record.provider, s);
    }
  }
  if (payer.exempt || !PAID_PROVIDERS.has(record.provider) || costUsd <= 0) return;

  const settings = await getLimitSettings();
  const fresh = today ?? (await readTodayUsage(payer));
  if (!fresh) return;
  const person = paidCost(fresh.person);
  const app = paidCost(fresh.app);
  const day = israelDate();

  if (person >= settings.alertPersonUsd) {
    await alertOnce(`person:${day}:${payer.userId ?? payer.client}`,
      `Navi: שימוש חריג במפתחות בתשלום — ${who(payer)}`,
      `${who(payer)} הוציא היום $${person.toFixed(3)} במפתחות בתשלום (סף ההתראה: $${settings.alertPersonUsd}, ` +
      `המגבלה האישית: $${payer.userId ? settings.userPaidPerDayUsd : settings.guestPaidPerDayUsd}). ` +
      `השימוש האחרון: ${ctx.area}, ${record.provider} · ${record.model}.`);
  }
  if (app >= (settings.appPaidPerDayUsd * settings.alertAppPct) / 100) {
    await alertOnce(`app:${day}`,
      `Navi: ${settings.alertAppPct}% מהתקרה היומית במפתחות בתשלום`,
      `ההוצאה היום במפתחות בתשלום הגיעה ל-$${app.toFixed(2)} מתוך תקרה של $${settings.appPaidPerDayUsd}.`);
  }
}

// Each alert once: its key carries the day, and ai_alerts refuses a second row.
export async function alertOnce(key: string, subject: string, body: string): Promise<void> {
  try {
    const db = serviceClient();
    if (!db) return;
    const { error } = await db.from('ai_alerts').insert({ key, subject });
    if (error) {
      if (error.code !== '23505') console.error('AI alert not recorded:', error.message);
      return; // already sent today, or the table is missing
    }
    await sendAlertEmail(subject, body);
  } catch (e) {
    console.error('AI alert failed:', e);
  }
}
