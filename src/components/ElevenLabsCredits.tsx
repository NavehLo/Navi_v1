import { useEffect, useState } from "react";
import { authHeaders } from "../lib/authHeaders";
import type { CreditsReport } from "../lib/creditsReport";

// The ElevenLabs allowance, for the admin: how much is left, how fast it is
// going, and which plan that pace would need. A card in settings; the alert on
// the map screen when it runs low is CreditsAlert, shared with Tavily.

// ElevenLabs' plans as of 2026-10-03 (elevenlabs.io/pricing), one credit per
// character.
const PLANS: Array<{ name: string; price: string; credits: number }> = [
  { name: "Free", price: "חינם", credits: 10_000 },
  { name: "Starter", price: "$6 לחודש", credits: 30_000 },
  { name: "Creator", price: "$22 לחודש", credits: 121_000 },
  { name: "Pro", price: "$99 לחודש", credits: 600_000 },
];

const num = (n: number) => Math.round(n).toLocaleString("he-IL");
const date = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
const daysBetween = (a: number, b: number) => Math.round((b - a) / 86_400_000);

export async function fetchCredits(): Promise<CreditsReport | null> {
  const headers = await authHeaders();
  // Nobody signed in: certainly not the admin, and no reason to ask.
  if (!headers.Authorization) return null;
  const res = await fetch("/api/admin/elevenlabs", { headers });
  if (!res.ok) return null; // 403 for everyone but the admin
  return (await res.json()) as CreditsReport;
}

export function ElevenLabsCreditsCard() {
  const [report, setReport] = useState<CreditsReport | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    fetchCredits().then((r) => live && setReport(r)).catch(() => live && setReport(null));
    return () => { live = false; };
  }, []);

  if (report === undefined) return <p className="text-white text-sm mb-3">בודק את הקרדיטים ב-ElevenLabs…</p>;
  if (report === null) return null;

  if (report.status === "error") {
    return (
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-sm leading-6 mb-3">
        {report.missingPermission
          ? "למפתח של ElevenLabs אין הרשאה לקרוא את פרטי החשבון. ב-ElevenLabs → API Keys → עריכת המפתח, יש לסמן User → Read. אין צורך במפתח חדש."
          : "לא הצלחתי לקרוא את הקרדיטים מ-ElevenLabs."}
        <p className="text-white text-xs mt-1 break-words" dir="ltr">{report.httpStatus ? `${report.httpStatus}: ` : ""}{report.detail}</p>
      </div>
    );
  }

  const pct = report.limit > 0 ? Math.min(100, (report.used / report.limit) * 100) : 0;
  const resetMs = report.resetAt ? Date.parse(report.resetAt) : null;
  const runsOutMs = report.runsOutAt ? Date.parse(report.runsOutAt) : null;
  const runsOutFirst = runsOutMs !== null && resetMs !== null && runsOutMs < resetMs;
  const fits = report.projectedMonth !== null ? PLANS.find((p) => p.credits >= report.projectedMonth!) : null;
  const barColor = report.level === "out" ? "bg-red-500" : report.level === "low" ? "bg-amber-400" : "bg-emerald-400";

  return (
    <div className="rounded-2xl bg-white/10 border border-white/15 p-4 mb-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-white text-sm font-bold">קרדיטים בהקראה (ElevenLabs)</span>
        <span className="text-white text-xs" dir="ltr">{report.tier}</span>
      </div>

      <div className="h-2.5 rounded-full bg-white/15 mt-3 overflow-hidden" dir="ltr">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-white text-sm mt-2">
        נוצלו <span className="text-yellow-300 font-bold">{num(report.used)}</span> מתוך {num(report.limit)} ·
        נשארו {num(report.remaining)}
        {report.narrationsLeft !== null && <> (בערך {num(report.narrationsLeft)} קריינויות חדשות)</>}
      </p>
      {report.resetAt && (
        <p className="text-white text-xs mt-1">
          מתחדש ב-{date(report.resetAt)}, בעוד {report.daysToReset} ימים.
        </p>
      )}

      <div className="border-t border-white/10 mt-3 pt-3 flex flex-col gap-1.5 text-sm text-white leading-6">
        <p>
          קצב: בממוצע <span className="text-sky-300 font-bold">{num(report.perDay)}</span> תווים ביום מתחילת החודש
          {report.perDayLastWeek !== null && <>, ו-{num(report.perDayLastWeek)} ביום בשבוע האחרון</>}.
        </p>
        {report.charsPerNarration !== null && (
          <p className="text-xs">קריינות אחת עולה בממוצע {num(report.charsPerNarration)} תווים. נקודה שכבר הוקראה לא עולה שוב.</p>
        )}
        {report.level === "out" ? (
          <p className="text-red-300 font-bold">הקרדיטים נגמרו. עד החידוש, נקודות חדשות יוקראו בקול של הטלפון. נקודות שכבר הוקראו ימשיכו להישמע כרגיל.</p>
        ) : runsOutFirst ? (
          <p className="text-amber-300 font-bold">
            בקצב הזה הקרדיטים ייגמרו בערך ב-{date(report.runsOutAt!)}, {daysBetween(runsOutMs!, resetMs!)} ימים לפני החידוש.
          </p>
        ) : report.projectedMonth !== null ? (
          <p>בקצב הזה הקרדיטים יספיקו עד החידוש.</p>
        ) : (
          <p>עוד לא היה שימוש החודש.</p>
        )}
        {report.projectedMonth !== null && (
          <p>
            צפי לחודש שלם: כ-{num(report.projectedMonth)} תווים.{" "}
            {fits
              ? fits.name === "Free"
                ? "המסלול החינמי מספיק."
                : <>מתאים לזה מסלול <span className="font-bold">{fits.name}</span> ({num(fits.credits)} בחודש, {fits.price}).</>
              : "זה יותר ממסלול Pro."}
          </p>
        )}
      </div>
      <p className="text-white text-xs mt-3 mb-1.5">המסלולים של ElevenLabs (תווים בחודש):</p>
      <div className="grid grid-cols-4 gap-1.5 text-center">
        {PLANS.map((p) => (
          <div
            key={p.name}
            className={`rounded-lg border px-1 py-1.5 ${p.name === fits?.name ? "border-sky-400/70 bg-sky-500/15" : "border-white/10 bg-white/5"}`}
          >
            <div className="text-white text-xs font-bold" dir="ltr">{p.name}</div>
            <div className="text-white text-xs">{num(p.credits)}</div>
            <div className="text-white text-[11px]">{p.price}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
