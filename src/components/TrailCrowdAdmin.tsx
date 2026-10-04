import { useEffect, useRef, useState } from "react";
import { Footprints, Loader2 } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import { countryName } from "../lib/worldTrailSearch";

// The admin's run of "מה אומרים מטיילים" for one country (settings → מתקדם).
// Each trail costs a web search and a short model call, so it is started by
// hand; the server does a few dozen trails per request, and this screen asks
// again until none remain. Stopping half way loses nothing.
//
// Greece only for now: a pilot, to see how many trails get numbers and what
// it costs before running other countries.

const PILOT_COUNTRIES = ["GR"];

interface Progress {
  status: string;
  total: number;
  done: number;
  remaining: number;
  withRating: number;
  withReviews: number;
  withWikipedia: number;
  withTraffic: number;
  costUsd: number;
  processed?: number;
  failed?: number;
}

const MESSAGES: Record<string, string> = {
  "no-table": "הטבלה trail_crowd עוד לא קיימת. צריך להריץ שוב את supabase/schema.sql.",
  "no-search-key": "אין מפתח TAVILY_API_KEY בשרת — בלי חיפוש אי אפשר לאסוף ציונים.",
  unavailable: "רשימת המסלולים של המדינה לא זמינה כרגע. נסו שוב בעוד רגע.",
  failing: "כל המסלולים בסבב האחרון נכשלו (מכסת חיפוש? מפתח AI?). העצירה אוטומטית — בדקו ונסו שוב.",
};

export default function TrailCrowdAdmin() {
  const [country] = useState(PILOT_COUNTRIES[0]);
  const [p, setP] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  const call = async (method: "GET" | "POST"): Promise<Progress | null> => {
    const res = await fetch(`/api/admin/trail-crowd?country=${country}`, { method, headers: await authHeaders() });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) {
      setError(d?.error ?? `השרת ענה ${res.status}`);
      return null;
    }
    if (d.status !== "ok") setError(MESSAGES[d.status] ?? d.status);
    else setError(null);
    if ("total" in d) setP(d);
    return d;
  };

  useEffect(() => {
    // `call` sets state only after its fetch answers, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    call("GET").catch(() => setError("אין חיבור לשרת"));
  }, [country]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    stop.current = false;
    setRunning(true);
    try {
      for (;;) {
        const d = await call("POST");
        if (!d || d.status !== "ok" || stop.current || d.remaining === 0 || !d.processed) break;
      }
    } catch {
      setError("אין חיבור לשרת");
    } finally {
      setRunning(false);
    }
  };

  const pct = (n: number) => (p && p.done ? ` (${Math.round((n / p.done) * 100)}%)` : "");

  return (
    <div className="mt-6">
      <h3 className="text-white font-bold text-sm mb-1 flex items-center gap-2">
        <Footprints size={15} className="text-sky-300" />
        מדדי מטיילים — {countryName(country)}
      </h3>
      <p className="text-white text-xs mb-3">
        אוסף לכל מסלול במדינה ציון ומספר ביקורות מאתרי מסלולים (חיפוש ברשת + מודל קטן) וקריאות בוויקיפדיה.
        בערך 1–2 סנט למסלול, פעם אחת. אפשר לעצור באמצע ולהמשיך אחר כך.
      </p>

      {p && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-xs text-white flex flex-col gap-1 mb-3">
          <div className="font-bold text-sm">
            {p.done} מתוך {p.total} מסלולים נאספו
            {p.remaining > 0 && <span className="text-amber-300"> · נותרו {p.remaining}</span>}
          </div>
          <div>עם ציון (5 ביקורות ומעלה): <b className="text-yellow-300">{p.withRating}</b>{pct(p.withRating)}</div>
          <div>עם ביקורות כלשהן: <b>{p.withReviews}</b>{pct(p.withReviews)}</div>
          <div>עם ערך בוויקיפדיה: <b>{p.withWikipedia}</b>{pct(p.withWikipedia)}</div>
          <div>עם רמת תנועה: <b className="text-sky-300">{p.withTraffic}</b>{pct(p.withTraffic)}</div>
          <div>עלות עד עכשיו (כל המדינות): <b>${p.costUsd.toFixed(2)}</b></div>
        </div>
      )}

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-200 text-xs mb-3">{error}</div>
      )}

      <button
        onClick={running ? () => { stop.current = true; } : run}
        disabled={!!p && p.remaining === 0 && !running}
        className="w-full rounded-xl border border-sky-400/50 bg-sky-600/30 hover:bg-sky-600/45 disabled:opacity-50 py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
      >
        {running && <Loader2 className="w-4 h-4 animate-spin" />}
        {running ? "עצור אחרי הסבב הנוכחי" : p && p.remaining === 0 ? "הכל נאסף" : p && p.done > 0 ? "המשך איסוף" : "התחל איסוף"}
      </button>
    </div>
  );
}
