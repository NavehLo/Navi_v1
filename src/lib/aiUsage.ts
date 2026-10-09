import { AsyncLocalStorage } from 'node:async_hooks';
import { type AiProvider, type UsageUnits, estimateCost } from './aiPricing';
import { serviceClient } from './supabaseService';
import { bearerToken, isAdminEmail, userFromToken } from './supabaseServer';
import { clientIp } from './rateLimit';
import { deviceOf, hashClient } from './clientHash';
import { isOwnerDevice } from './ownerExclusion';
import { afterRecorded, type TodayUsage } from './aiLimits';

// A log of every paid AI call, for the admin's "שימוש ועלויות AI" page.
//
// The calls themselves happen deep in lib/ (narration, tts, elevenlabs, the
// trail description), far from the request that caused them. Rather than
// thread "which feature, which user" through every signature, each route wraps
// its work in `withAiUsage`, and the provider code calls `recordAiUsage` with
// only what it knows — provider, model, tokens. The two meet here.
//
// The same context says who is paying for the call — a signed-in user, a
// guest (by a hash of the IP, never the IP itself), or the admin and the
// admin's scripts, which are recorded but exempt from the limits
// (lib/aiLimits checks those before every call). The admin's own devices and
// IPs (lib/ownerExclusion) are exempt too, signed in or not.
//
// Only successful calls are recorded: a refused or failed request is not billed.
// Recording never throws and never holds a response up for long: a missing
// table or a Supabase outage costs the log a row, not the user a narration.

// Where in the app the call came from.
export type AiArea =
  | 'guide'          // the guide on a trail, point by point
  | 'guide_offline'  // a trail downloaded for use without reception
  | 'voice_test'     // the admin trying a voice in settings
  | 'trail_info'     // "על המסלול"
  | 'trail_translate'// English names for world trails
  | 'trip_advice'    // the weather explanation for the trip day
  | 'trail_crowd'    // "מה אומרים מטיילים": ratings read off review sites
  | 'country_guide'  // "אזורי טיול": a country's hiking regions, written by the admin
  | 'help_chat'      // "שאלו את Navi": questions about using the app
  | 'trail_photos'   // "תמונות מהמסלול": the free model looking at the photos
  | 'other';

// What the call did.
export type AiKind = 'text' | 'voice' | 'search';

interface UsageContext {
  area: AiArea;
  token: string | null;
  client: string | null;  // hashed IP, for guests
  device: string | null;  // the device's own random id (lib/deviceId)
  script: boolean;        // started on the admin's machine, not by a request
  who?: Promise<Payer>;
  // Today's usage, read once per request and kept current as calls are
  // recorded (lib/aiLimits).
  today?: Promise<TodayUsage | null>;
}

// Who a call is charged to, for the limits and the log.
export interface Payer {
  userId: string | null;
  email: string | null;
  client: string | null;
  exempt: boolean;
}

const context = new AsyncLocalStorage<UsageContext>();

export function withAiUsage<T>(request: Request, area: AiArea, work: () => Promise<T>): Promise<T> {
  return context.run({
    area, token: bearerToken(request), client: hashClient(clientIp(request)), device: deviceOf(request), script: false,
  }, work);
}

// The same, for work that no request started: the admin's scripts.
export function withAiArea<T>(area: AiArea, work: () => Promise<T>): Promise<T> {
  return context.run({ area, token: null, client: null, device: null, script: true }, work);
}

export function currentContext(): UsageContext | undefined {
  return context.getStore();
}

// One lookup per request, however many calls it makes.
export function payerOf(ctx: UsageContext): Promise<Payer> {
  ctx.who ??= (async () => {
    if (ctx.script) return { userId: null, email: null, client: null, exempt: true };
    const user = ctx.token ? await userFromToken(ctx.token) : null;
    return {
      userId: user?.id ?? null,
      email: user?.email ?? null,
      client: user ? null : ctx.client,
      exempt: isAdminEmail(user?.email) || (await isOwnerDevice(ctx.device, ctx.client, !!user)),
    };
  })();
  return ctx.who;
}

export interface UsageRecord extends UsageUnits {
  kind: AiKind;
  provider: AiProvider;
  model: string;
}

// Gemini's own count. Thinking tokens are billed as output.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the API's JSON
export function geminiTokens(data: any): { inputTokens: number; outputTokens: number } {
  const u = data?.usageMetadata ?? {};
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

let warnedUnconfigured = false;

export async function recordAiUsage(record: UsageRecord): Promise<void> {
  try {
    const db = serviceClient();
    if (!db) {
      if (!warnedUnconfigured) console.warn('AI usage not recorded: SUPABASE_SERVICE_ROLE_KEY is not set.');
      warnedUnconfigured = true;
      return;
    }
    const ctx = context.getStore();
    const payer = ctx ? await payerOf(ctx) : null;
    const costUsd = estimateCost(record.provider, record.model, record);

    const row = {
      area: ctx?.area ?? 'other',
      kind: record.kind,
      provider: record.provider,
      model: record.model,
      user_id: payer?.userId ?? null,
      user_email: payer?.email ?? null,
      input_tokens: Math.round(record.inputTokens ?? 0),
      output_tokens: Math.round(record.outputTokens ?? 0),
      chars: Math.round(record.chars ?? 0),
      searches: Math.round(record.searches ?? 0),
      cost_usd: costUsd,
    };
    const payerCols = { client_hash: payer?.client ?? null, exempt: payer?.exempt ?? false };
    let { error } = await db.from('ai_usage').insert({ ...row, ...payerCols, device_id: ctx?.device ?? null });
    // Before schema.sql adds the newer columns, the row still goes in.
    if (error && /device_id/.test(error.message)) ({ error } = await db.from('ai_usage').insert({ ...row, ...payerCols }));
    if (error && /client_hash|exempt/.test(error.message)) ({ error } = await db.from('ai_usage').insert(row));
    if (error) console.error('AI usage not recorded:', error.message);

    if (ctx && payer) await afterRecorded(ctx, payer, record, costUsd);
  } catch (e) {
    console.error('AI usage not recorded:', e);
  }
}
