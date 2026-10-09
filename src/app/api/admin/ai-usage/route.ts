import { NextResponse } from 'next/server';
import { isAdminEmail, isAdminRequest } from '../../../../lib/supabaseServer';
import { serviceClient } from '../../../../lib/supabaseService';
import { isDistributedRateLimitConfigured } from '../../../../lib/rateLimit';
import type { RateLimitMode, UsageGroup, UsageTotals } from '../../../../lib/aiUsageReport';
import { PAID_PROVIDERS } from '../../../../lib/aiLimits';
import type { AiProvider } from '../../../../lib/aiPricing';

// GET ?days=7|30|90|0 → the AI usage logged by lib/aiUsage, for the admin's
// "שימוש ועלויות AI" page: one total, and the same numbers by use, by model
// and by user. days=0 is everything since logging began.

interface Row {
  area: string;
  kind: string;
  provider: string;
  model: string;
  user_id: string | null;
  user_email: string | null;
  exempt?: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  chars: number;
  searches: number;
  cost_usd: number;
  last_at: string;
}

function empty(): UsageTotals {
  return { calls: 0, paidCalls: 0, freeTextCalls: 0, inputTokens: 0, outputTokens: 0, chars: 0, searches: 0, costUsd: 0 };
}

const isPaid = (r: Row) => PAID_PROVIDERS.has(r.provider as AiProvider);
// What a row cost in money: only the paid keys are ever billed.
const costOf = (r: Row) => (isPaid(r) ? Number(r.cost_usd) : 0);

function add(t: UsageTotals, r: Row) {
  t.calls += Number(r.calls);
  if (isPaid(r)) t.paidCalls += Number(r.calls);
  if (r.provider === 'gemini-free') t.freeTextCalls += Number(r.calls);
  t.inputTokens += Number(r.input_tokens);
  t.outputTokens += Number(r.output_tokens);
  t.chars += Number(r.chars);
  t.searches += Number(r.searches);
  t.costUsd += costOf(r);
}

function groupBy(
  rows: Row[],
  keyOf: (r: Row) => string,
  init: (r: Row) => Partial<UsageGroup>,
  partOf: (r: Row) => string
): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  const parts = new Map<string, Map<string, { calls: number; costUsd: number }>>();
  for (const r of rows) {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, ...empty(), ...init(r), parts: [] };
      groups.set(key, g);
      parts.set(key, new Map());
    }
    add(g, r);
    const p = parts.get(key)!;
    const label = partOf(r);
    const part = p.get(label) ?? { calls: 0, costUsd: 0 };
    part.calls += Number(r.calls);
    part.costUsd += costOf(r);
    p.set(label, part);
  }
  for (const g of groups.values()) {
    g.parts = [...parts.get(g.key)!.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

const modelLabel = (r: Row) => `${r.provider} · ${r.model}`;
const featureKey = (r: Row) => `${r.area}:${r.kind}`;

export async function GET(request: Request) {
  if (!(await isAdminRequest(request))) {
    return NextResponse.json({ error: 'זמין למנהל האתר בלבד.' }, { status: 403 });
  }
  // Shown whatever the state of the usage log: it answers "is Upstash set in
  // production?", which nothing else on the site shows.
  const rateLimit: RateLimitMode = isDistributedRateLimitConfigured ? 'upstash' : 'memory';
  const db = serviceClient();
  if (!db) return NextResponse.json({ status: 'not-configured', rateLimit });

  const days = Math.max(0, Math.min(3650, parseInt(new URL(request.url).searchParams.get('days') ?? '30', 10) || 0));
  const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

  const [summary, first] = await Promise.all([
    db.rpc('ai_usage_summary', { p_since: since }),
    db.from('ai_usage').select('created_at').order('created_at', { ascending: true }).limit(1),
  ]);
  if (summary.error) {
    // 42883/42P01/PGRST202: the function or table is missing — schema.sql has
    // not been run since this page was added.
    const missing = /42883|42P01|PGRST202|PGRST205|does not exist|Could not find/i.test(
      `${summary.error.code} ${summary.error.message}`
    );
    console.error('AI usage summary failed:', summary.error);
    // The admin sees Supabase's own words: "error" alone could not be told
    // apart from any other failure, and this page is closed to everyone else.
    const detail = [summary.error.code, summary.error.message].filter(Boolean).join(': ');
    return NextResponse.json({ status: missing ? 'no-table' : 'error', detail, rateLimit });
  }

  const rows = (summary.data ?? []) as Row[];
  const total = empty();
  for (const r of rows) add(total, r);

  return NextResponse.json(
    {
      status: 'ok',
      rateLimit,
      days,
      trackingSince: first.data?.[0]?.created_at ?? null,
      total,
      byFeature: groupBy(rows, featureKey, (r) => ({ area: r.area, kind: r.kind }), modelLabel),
      byModel: groupBy(rows, modelLabel, (r) => ({ provider: r.provider, model: r.model }), featureKey),
      byUser: groupBy(
        rows,
        // The admin's scripts run with no user; guests have none either.
        (r) => r.user_id ?? r.user_email ?? (r.exempt ? 'scripts' : 'anonymous'),
        (r) => ({ email: r.user_email, exempt: !!r.exempt || isAdminEmail(r.user_email) }),
        featureKey
      ),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
