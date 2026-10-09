import type { AiLimitSettings } from './aiLimits';

// The shape of /api/admin/ai-limits's answer, shared with the admin page.
export interface LimitsReport {
  settings: AiLimitSettings;
  defaults: AiLimitSettings;
  today: string;               // Israel date
  todayPaidUsd: number | null; // the whole app on paid keys today, without the admin
  liftedToday: boolean;
  // false until schema.sql has been run with the limits section
  tableReady: boolean;
  email: { configured: boolean; recipient: string | null };
  alerts: Array<{ subject: string; at: string }>;
  test?: { ok: boolean; detail: string };
}
