// The Tavily allowance, for the admin: GET https://api.tavily.com/usage.
//
// The account is on the free "Researcher" plan: 1,000 credits a month, renewed
// on the 1st, with pay-as-you-go off — so running out stops the web search
// ("על המסלול", the hiker metrics) until the 1st, and never charges. A basic
// search costs one credit, an extract one per five pages.

export interface TavilyCredits {
  plan: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  paygoUsage: number;
  paygoLimit: number | null;
  resetAt: string;     // the 1st of next month
  daysToReset: number;
  perDay: number;      // credits a day since the 1st
  runsOutAt: string | null;
  level: 'ok' | 'low' | 'out';
}

export type TavilyOutcome =
  | { status: 'ok'; credits: TavilyCredits }
  | { status: 'error'; httpStatus: number | null; detail: string }
  | { status: 'not-configured' };

let cache: { at: number; outcome: TavilyOutcome } | null = null;
const TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export async function tavilyCredits(): Promise<TavilyOutcome> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { status: 'not-configured' };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.outcome;

  let outcome: TavilyOutcome;
  try {
    const res = await fetch('https://api.tavily.com/usage', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!res.ok) {
      outcome = { status: 'error', httpStatus: res.status, detail: (await res.text()).slice(0, 300) };
    } else {
      const d = await res.json();
      const account = d.account ?? {};
      const used = Number(account.plan_usage ?? d.key?.usage ?? 0);
      const limit = account.plan_limit == null ? null : Number(account.plan_limit);
      const now = new Date();
      const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      const perDay = used / Math.max(0.5, (now.getTime() - start) / DAY_MS);
      const remaining = limit == null ? null : Math.max(0, limit - used);
      const runsOutAt = remaining != null && remaining > 0 && perDay > 0
        ? new Date(now.getTime() + (remaining / perDay) * DAY_MS).toISOString()
        : null;
      const level: TavilyCredits['level'] = limit == null ? 'ok'
        : remaining! <= 0 ? 'out'
        : used / limit >= 0.9 || (runsOutAt !== null && Date.parse(runsOutAt) < reset) ? 'low'
        : 'ok';
      outcome = {
        status: 'ok',
        credits: {
          plan: String(account.current_plan ?? 'unknown'),
          used,
          limit,
          remaining,
          paygoUsage: Number(account.paygo_usage ?? 0),
          paygoLimit: account.paygo_limit == null ? null : Number(account.paygo_limit),
          resetAt: new Date(reset).toISOString(),
          daysToReset: Math.ceil((reset - now.getTime()) / DAY_MS),
          perDay: Math.round(perDay),
          runsOutAt,
          level,
        },
      };
    }
  } catch (e) {
    outcome = { status: 'error', httpStatus: null, detail: e instanceof Error ? e.message : String(e) };
  }
  cache = { at: Date.now(), outcome };
  return outcome;
}
