import { useState } from "react";
import { RefreshCw, CalendarDays } from "lucide-react";
import Collapsible from "./Collapsible";
import InfoButton from "./help/InfoButton";
import type { TrailClimate } from "../hooks/useTrailClimate";
import { MONTH_NAMES, MONTH_SHORT, RATING_LABELS, monthRuns, rainWords, type MonthRating } from "../lib/climate";

// "מתי כדאי ללכת": the year at a glance, month by month, for this trail at its
// own place and height (src/lib/climate.ts decides; this only draws).
//
// Read outdoors on a phone — white text on strong colour, nothing under
// text-xs (see CLAUDE.md).

export const RATING_TILE: Record<MonthRating, string> = {
  good: "bg-emerald-500/30 border-emerald-400/70",
  fair: "bg-amber-500/25 border-amber-400/70",
  bad: "bg-red-500/25 border-red-400/70",
};

export const RATING_DOT: Record<MonthRating, string> = {
  good: "bg-emerald-400",
  fair: "bg-amber-400",
  bad: "bg-red-500",
};

export const RATING_TEXT: Record<MonthRating, string> = {
  good: "text-emerald-300",
  fair: "text-amber-300",
  bad: "text-red-300",
};

export function RatingLegend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-white">
      {(["good", "fair", "bad"] as const).map((r) => (
        <span key={r} className="flex items-center gap-1">
          <span className={`w-2.5 h-2.5 rounded-full ${RATING_DOT[r]}`} />
          {RATING_LABELS[r]}
        </span>
      ))}
    </div>
  );
}

export default function BestMonthsSection({ climate, month }: { climate: TrailClimate; month: number }) {
  const { status, months } = climate;
  // The month in view: the trip's (or this one) until another is tapped.
  const [tapped, setTapped] = useState<number | null>(null);
  const picked = tapped ?? month;

  const ratings = months?.map((m) => m.rating) ?? null;
  const runs = ratings ? monthRuns(ratings) : "";

  const summary = ratings ? (
    runs ? (
      <span className="text-emerald-300">עונה מומלצת: {runs}</span>
    ) : (
      <span className="text-amber-300">אין חודש מומלץ במיוחד — {monthRuns(ratings, "fair") ? `אפשרי: ${monthRuns(ratings, "fair")}` : "קשה כל השנה"}</span>
    )
  ) : status === "loading" ? "טוען…" : null;

  const v = months?.[picked] ?? null;

  return (
    <Collapsible
      variant="section"
      title="מתי כדאי ללכת"
      icon={<CalendarDays className="w-4 h-4 text-sky-300" />}
      summary={summary}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <RatingLegend />
        <InfoButton label="מתי כדאי ללכת">
          <p>
            כל חודש מדורג לפי האקלים הממוצע במקום של המסלול ובגובה שלו, ולפי
            אורך ההליכה: חום בנקודה הנמוכה, קור ושלג בנקודה הגבוהה, כמות הגשם, ושעות האור.
          </p>
          <p className="mt-2">
            הנתונים: ממוצע 30 שנה (1991–2020, TerraClimate), מותאם לעשור האחרון (2016–2025) — הטמפרטורות, הלחות
            והשלג זזו לפי מה שנמדד בעשור הזה, כי מאז העולם התחמם (בישראל בכ-0.7°, באלפים בכ-1.25°). כמות הגשם נשארת
            לפי 30 השנים, כי עשור אחד קצר מדי בשביל גשם.</p>
          <p className="mt-2">
            <b>גשם</b> (כמות חודשית): כמעט יבש — פחות מ-10 מ״מ · מעט גשם — עד 40 · גשם מתון — עד 100 · גשום — עד 200 ·
            גשום מאוד — מעל 200. מאותה כמות יכולה לרדת בסערה אחת או בהרבה ממטרים, אז זה תיאור של חודש רגיל ולא הבטחה.
          </p>
          <p className="mt-2">
            זה ממוצע רב-שנתי ולא תחזית — בכל חודש יש ימים חריגים. ליום מסוים, ראו &quot;מזג אוויר ליום הטיול&quot;.
          </p>
        </InfoButton>
      </div>

      {status === "loading" && !months && <div className="text-sm text-white">טוען נתוני אקלים…</div>}

      {(status === "unavailable" || status === "rate-limited") && !months && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-400/35 p-2 text-sm text-amber-100 flex items-center justify-between gap-2">
          <span>{status === "rate-limited" ? "יותר מדי בקשות כרגע" : "לא הצלחנו לטעון נתוני אקלים"} — אין מידע על החודשים.</span>
          <button onClick={climate.retry} className="shrink-0 p-1.5 bg-white/10 hover:bg-white/20 rounded-full" title="נסה שוב">
            <RefreshCw className="w-4 h-4 text-white" />
          </button>
        </div>
      )}

      {months && (
        <>
          <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="בחירת חודש">
            {months.map((m, i) => (
              <button
                key={i}
                role="radio"
                aria-checked={i === picked}
                aria-label={`${MONTH_NAMES[i]}: ${RATING_LABELS[m.rating]}`}
                onClick={() => setTapped(i)}
                className={`rounded-xl border py-1.5 flex flex-col items-center gap-0.5 transition-colors ${RATING_TILE[m.rating]} ${i === picked ? "ring-2 ring-white" : ""}`}
              >
                <span className="text-sm text-white font-bold leading-tight">{MONTH_SHORT[i]}</span>
                <span className="text-xs text-white leading-tight">{m.tmax}°</span>
              </button>
            ))}
          </div>

          {v && (
            <div className="mt-3 rounded-xl bg-white/5 border border-white/10 p-2.5">
              <div className="flex items-center gap-2 text-sm font-bold text-white">
                <span className={`w-2.5 h-2.5 rounded-full ${RATING_DOT[v.rating]}`} />
                {MONTH_NAMES[picked]}: <span className={RATING_TEXT[v.rating]}>{RATING_LABELS[v.rating]}</span>
              </div>
              <ul className="mt-1.5 space-y-1">
                {v.reasons.map((r, j) => (
                  <li key={j} className="text-sm text-white flex items-start gap-2">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${RATING_DOT[r.rating]}`} />
                    {r.text}
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-white">
                ביום כ-{v.tmax}° · בלילה כ-{v.tmin}° בחלק הגבוה · {v.daylight} שעות אור
              </div>
              <div className="mt-1 text-xs text-white">
                <span className="font-bold text-sky-300">{rainWords(v.ppt).label}</span>
                {" — "}{rainWords(v.ppt).hint} ({v.ppt} מ״מ בחודש)
              </div>
            </div>
          )}
        </>
      )}
    </Collapsible>
  );
}
