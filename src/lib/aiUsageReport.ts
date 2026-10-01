// The shape of /api/admin/ai-usage's answer, shared with the admin page.

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  searches: number;
  costUsd: number;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  // feature: area + kind; model: provider + model; user: id or email
  area?: string;
  kind?: string;
  provider?: string;
  model?: string;
  email?: string | null;
  // The models a use ran on, or the uses a model served — the second level of
  // detail, cheapest last.
  parts: Array<{ label: string; calls: number; costUsd: number }>;
}

export type UsageReport =
  | { status: 'not-configured' | 'no-table' | 'error' }
  | {
      status: 'ok';
      days: number;
      trackingSince: string | null;
      total: UsageTotals;
      byFeature: UsageGroup[];
      byModel: UsageGroup[];
      byUser: UsageGroup[];
    };
