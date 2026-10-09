import { useEffect, useState } from "react";
import { authHeaders } from "../lib/authHeaders";
import type { TavilyOutcome } from "../lib/tavilyCredits";

// The Tavily allowance, for the admin (lib/tavilyCredits): the free plan's
// 1,000 credits a month, renewed on the 1st. With pay-as-you-go off, running
// out stops the web search until then — it never charges.

const num = (n: number) => Math.round(n).toLocaleString("he-IL");
const date = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });

export async function fetchTavily(): Promise<TavilyOutcome | null> {
  const headers = await authHeaders();
  if (!headers.Authorization) return null;
  const res = await fetch("/api/admin/tavily", { headers });
  if (!res.ok) return null;
  return (await res.json()) as TavilyOutcome;
}

export function TavilyCreditsCard() {
  const [outcome, setOutcome] = useState<TavilyOutcome | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetchTavily().then((r) => live && setOutcome(r)).catch(() => live && setOutcome(null));
    return () => { live = false; };
  }, []);

  if (outcome === undefined) return <p className="text-white text-sm mb-3">בודק את הקרדיטים ב-Tavily…</p>;
  if (outcome === null || outcome.status === "not-configured") return null;
  if (outcome.status === "error") {
    return (
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-sm leading-6 mb-3">
        לא הצלחתי לקרוא את הקרדיטים מ-Tavily.
        <p className="text-white text-xs mt-1 break-words" dir="ltr">{outcome.httpStatus ? `${outcome.httpStatus}: ` : ""}{outcome.detail}</p>
      </div>
    );
  }

  const c = outcome.credits;
  const pct = c.limit ? Math.min(100, (c.used / c.limit) * 100) : 0;
  const bar = c.level === "out" ? "bg-red-500" : c.level === "low" ? "bg-amber-400" : "bg-emerald-400";
  const runsOutFirst = c.runsOutAt !== null && Date.parse(c.runsOutAt) < Date.parse(c.resetAt);

  return (
    <div className="rounded-2xl bg-white/10 border border-white/15 p-4 mb-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-white text-sm font-bold">קרדיטים בחיפוש ברשת (Tavily)</span>
        <span className="text-white text-xs" dir="ltr">{c.plan}</span>
      </div>
      {c.limit !== null && (
        <div className="h-2.5 rounded-full bg-white/15 mt-3 overflow-hidden" dir="ltr">
          <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="text-white text-sm mt-2">
        נוצלו <span className="text-yellow-300 font-bold">{num(c.used)}</span>
        {c.limit !== null && <> מתוך {num(c.limit)} · נשארו {num(c.remaining ?? 0)}</>}
      </p>
      <p className="text-white text-xs mt-1">מתחדש ב-{date(c.resetAt)}, בעוד {c.daysToReset} ימים. בממוצע {num(c.perDay)} ביום החודש.</p>
      <div className="border-t border-white/10 mt-3 pt-3 text-sm text-white leading-6">
        {c.level === "out" ? (
          <p className="text-red-300 font-bold">
            הקרדיטים נגמרו. עד החידוש אין חיפוש ברשת: ״על המסלול״ נכתב רק מהמקורות האחרים, ואיסוף מדדי המטיילים ממתין.
          </p>
        ) : runsOutFirst ? (
          <p className="text-amber-300 font-bold">בקצב הזה הקרדיטים ייגמרו בערך ב-{date(c.runsOutAt!)}, לפני החידוש.</p>
        ) : (
          <p>בקצב הזה הקרדיטים יספיקו עד החידוש.</p>
        )}
        <p className="text-xs mt-1">
          {c.paygoLimit === null && c.paygoUsage === 0
            ? "תשלום לפי שימוש (pay as you go) כבוי — כשהקרדיטים נגמרים אין חיוב."
            : `תשלום לפי שימוש: ${num(c.paygoUsage)} קרדיטים${c.paygoLimit !== null ? ` מתוך ${num(c.paygoLimit)}` : ""}.`}
        </p>
      </div>
    </div>
  );
}
