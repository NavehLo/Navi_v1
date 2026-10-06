import { AsyncLocalStorage } from 'node:async_hooks';
import { type AiProvider, type UsageUnits, estimateCost } from './aiPricing';
import { serviceClient } from './supabaseService';
import { bearerToken, userFromToken } from './supabaseServer';

// A log of every paid AI call, for the admin's "שימוש ועלויות AI" page.
//
// The calls themselves happen deep in lib/ (narration, tts, elevenlabs, the
// trail description), far from the request that caused them. Rather than
// thread "which feature, which user" through every signature, each route wraps
// its work in `withAiUsage`, and the provider code calls `recordAiUsage` with
// only what it knows — provider, model, tokens. The two meet here.
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
  | 'other';

// What the call did.
export type AiKind = 'text' | 'voice' | 'search';

interface UsageContext {
  area: AiArea;
  token: string | null;
  user?: Promise<{ id: string; email: string | null } | null>;
}

const context = new AsyncLocalStorage<UsageContext>();

export function withAiUsage<T>(request: Request, area: AiArea, work: () => Promise<T>): Promise<T> {
  return context.run({ area, token: bearerToken(request) }, work);
}

// The same, for work that no request started: the admin's scripts.
export function withAiArea<T>(area: AiArea, work: () => Promise<T>): Promise<T> {
  return context.run({ area, token: null }, work);
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
    // One lookup per request, however many calls it makes.
    if (ctx?.token) ctx.user ??= userFromToken(ctx.token);
    const user = ctx?.user ? await ctx.user : null;

    const { error } = await db.from('ai_usage').insert({
      area: ctx?.area ?? 'other',
      kind: record.kind,
      provider: record.provider,
      model: record.model,
      user_id: user?.id ?? null,
      user_email: user?.email ?? null,
      input_tokens: Math.round(record.inputTokens ?? 0),
      output_tokens: Math.round(record.outputTokens ?? 0),
      chars: Math.round(record.chars ?? 0),
      searches: Math.round(record.searches ?? 0),
      cost_usd: estimateCost(record.provider, record.model, record),
    });
    if (error) console.error('AI usage not recorded:', error.message);
  } catch (e) {
    console.error('AI usage not recorded:', e);
  }
}
