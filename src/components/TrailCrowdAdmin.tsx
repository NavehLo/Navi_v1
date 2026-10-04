import { useEffect, useRef, useState } from "react";
import { Footprints, Loader2 } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import { countryName } from "../lib/worldTrailSearch";
import type { CrowdSource } from "../lib/trailCrowd/score";

// The admin's run of "מה אומרים מטיילים" for one country (settings → מתקדם),
// in the server's steps (api/admin/trail-crowd): find Komoot's pages for the
// country's areas, read them a few at a time and tie their routes to our
// trails, then Wikipedia, then save. This screen holds what the steps return
// in between; stopping half way loses the run, not the stored numbers.
//
// Greece only for now: a pilot. The same run from this Mac, without the time
// limit of a request: `node scripts/collectCrowd.mjs GR`.

const PILOT_COUNTRIES = ["GR"];
const READ_BATCH = 8;

interface Progress {
  status: string;
  total: number;
  done: number;
  withRating: number;
  withKomoot: number;
  withWikipedia: number;
  withTraffic: number;
  fetchedAt: string | null;
  costUsd: number;
}

const MESSAGES: Record<string, string> = {
  "no-table": "הטבלה trail_crowd עוד לא קיימת. צריך להריץ שוב את supabase/schema.sql.",
  "no-search-key": "אין מפתח TAVILY_API_KEY בשרת — בלי חיפוש אי אפשר למצוא את הדפים.",
  unavailable: "רשימת המסלולים של המדינה לא זמינה כרגע. נסו שוב בעוד רגע.",
  failing: "השלב נכשל (מכסת חיפוש? הטבלה?). שום דבר לא נשמר — בדקו ונסו שוב.",
};

export default function TrailCrowdAdmin() {
  const [country] = useState(PILOT_COUNTRIES[0]);
  const [p, setP] = useState<Progress | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each step answers in its own shape
  const call = async (method: "GET" | "POST", body?: object): Promise<any | null> => {
    const res = await fetch(`/api/admin/trail-crowd?country=${country}`, {
      method,
      headers: { ...(await authHeaders()), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) {
      setError(d?.error ?? `השרת ענה ${res.status}`);
      return null;
    }
    if (d.status !== "ok") {
      setError(MESSAGES[d.status] ?? d.status);
      return null;
    }
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
    setError(null);
    try {
      setStep("מחפש את דפי Komoot של האזורים…");
      const found = await call("POST", { step: "find" });
      if (!found) return;
      const guides: string[] = found.guides;

      const matches: Record<number, CrowdSource> = {};
      let routes = 0;
      for (let i = 0; i < guides.length; i += READ_BATCH) {
        if (stop.current) return setStep(null);
        setStep(`קורא דפים: ${i}/${guides.length} · ${routes} מסלולים · ${Object.keys(matches).length} מהמסלולים שלנו`);
        const r = await call("POST", { step: "read", urls: guides.slice(i, i + READ_BATCH) });
        if (!r) return;
        routes += r.routes;
        for (const [id, s] of Object.entries(r.matches as Record<string, CrowdSource>)) {
          const prev = matches[Number(id)];
          if (!prev || (prev.hikers ?? 0) < (s.hikers ?? 0)) matches[Number(id)] = s;
        }
      }
      // A page lists ten routes. Far fewer means the pages were not read, and
      // saving would replace good numbers with none.
      if (routes < guides.length * 3) {
        setError(`נקראו רק ${routes} מסלולים מ-${guides.length} דפים — כנראה ש-Komoot לא ענה. לא נשמר דבר.`);
        return;
      }

      const views: Record<number, number> = {};
      let from = 0;
      for (;;) {
        if (stop.current) return setStep(null);
        setStep(`ויקיפדיה… ${from}`);
        const r = await call("POST", { step: "finish", matches, views, from });
        if (!r) return;
        if (r.saved) break;
        Object.assign(views, r.views);
        from = r.next ?? r.of;
      }
    } catch {
      setError("אין חיבור לשרת");
    } finally {
      setStep(null);
    }
  };

  const pct = (n: number) => (p && p.total ? ` (${Math.round((n / p.total) * 100)}%)` : "");
  const when = p?.fetchedAt ? new Date(p.fetchedAt).toLocaleDateString("he-IL") : null;

  return (
    <div className="mt-6">
      <h3 className="text-white font-bold text-sm mb-1 flex items-center gap-2">
        <Footprints size={15} className="text-sky-300" />
        מדדי מטיילים — {countryName(country)}
      </h3>
      <p className="text-white text-xs mb-3">
        מוצא ב-Komoot את דפי &quot;המסלולים הטובים ביותר&quot; של כל אזור במדינה (כ-2 חיפושים לאזור), קורא מהם את
        המסלולים המובילים עם מספר המטיילים והציון, ומתאים אותם למסלולים שלנו לפי המיקום. בנוסף — קריאות בוויקיפדיה.
        כמה עשרות סנטים למדינה לכל היותר, ובתוך המכסה החינמית של Tavily — חינם.
      </p>

      {p && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-xs text-white flex flex-col gap-1 mb-3">
          <div className="font-bold text-sm">
            {p.done ? `נאסף${when ? ` ב-${when}` : ""} · ${p.total} מסלולים` : `טרם נאסף · ${p.total} מסלולים`}
          </div>
          <div>עם רמת תנועה: <b className="text-sky-300">{p.withTraffic}</b>{pct(p.withTraffic)}</div>
          <div>עם ציון (5 דירוגים ומעלה): <b className="text-yellow-300">{p.withRating}</b>{pct(p.withRating)}</div>
          <div>נמצאו ב-Komoot: <b>{p.withKomoot}</b> · עם ערך בוויקיפדיה: <b>{p.withWikipedia}</b></div>
          <div>עלות עד עכשיו (כל המדינות): <b>${p.costUsd.toFixed(2)}</b></div>
        </div>
      )}

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-200 text-xs mb-3">{error}</div>
      )}
      {step && <div className="text-xs text-white mb-2">{step}</div>}

      <button
        onClick={step ? () => { stop.current = true; } : run}
        className="w-full rounded-xl border border-sky-400/50 bg-sky-600/30 hover:bg-sky-600/45 py-2.5 text-sm font-bold text-white flex items-center justify-center gap-2"
      >
        {step && <Loader2 className="w-4 h-4 animate-spin" />}
        {step ? "עצור" : p?.done ? "איסוף מחדש" : "התחל איסוף"}
      </button>
    </div>
  );
}
