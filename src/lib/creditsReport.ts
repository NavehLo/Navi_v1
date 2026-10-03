// The shape of /api/admin/elevenlabs's answer, shared with the admin's credit
// card in settings and the alert on the map screen.

export type CreditsLevel =
  | 'ok'
  | 'low'  // 90% used, or at this pace it runs out before the renewal
  | 'out'; // not enough left for one more narration

export type CreditsReport =
  | { status: 'error'; httpStatus: number | null; detail: string; missingPermission: boolean }
  | {
      status: 'ok';
      tier: string;
      used: number;
      limit: number;
      remaining: number;
      resetAt: string | null;
      periodStart: string | null;
      daysToReset: number | null;
      // Characters a day: the average since the period began, and over the
      // last 7 days from the app's own log (lib/aiUsage).
      perDay: number;
      perDayLastWeek: number | null;
      // At the period's average pace: when it runs out, and what a whole
      // month comes to. Null when nothing has been used yet.
      runsOutAt: string | null;
      projectedMonth: number | null;
      // Average characters per spoken narration, from the log; and how many
      // more that leaves.
      charsPerNarration: number | null;
      narrationsLeft: number | null;
      level: CreditsLevel;
    };
