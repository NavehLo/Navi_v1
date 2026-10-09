import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Mail } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import type { LimitsReport } from "../lib/aiLimitsReport";
import type { AiLimitSettings } from "../lib/aiLimits";

// The admin's controls over AI use (lib/aiLimits, /api/admin/ai-limits):
// today's spend on the paid keys against the app's daily cap, with a way to
// lift the cap until midnight; and the limits themselves, per person and per
// day, with the email alerts.

type NumberKey = Exclude<keyof AiLimitSettings, "liftedDay">;

const FIELDS: Array<{ title: string; note: string; rows: Array<{ key: NumberKey; label: string; unit: string; step: number }> }> = [
  {
    title: "מפתחות בתשלום — OpenAI, Gemini, Claude",
    note: "בדולרים ליום. מי שמגיע למגבלה ממשיך רק עם השירותים החינמיים עד חצות.",
    rows: [
      { key: "appPaidPerDayUsd", label: "תקרה לכל האפליקציה", unit: "$", step: 0.5 },
      { key: "userPaidPerDayUsd", label: "למשתמש מחובר", unit: "$", step: 0.05 },
      { key: "guestPaidPerDayUsd", label: "לאורח (לא מחובר)", unit: "$", step: 0.01 },
    ],
  },
  {
    title: "התראה במייל",
    note: "על שימוש במפתחות בתשלום בלבד, ולא על השימוש שלך. כל התראה נשלחת פעם אחת ביום.",
    rows: [
      { key: "alertPersonUsd", label: "כשאדם אחד מוציא ביום יותר מ-", unit: "$", step: 0.05 },
      { key: "alertAppPct", label: "כשהאפליקציה מגיעה לאחוז מהתקרה", unit: "%", step: 5 },
    ],
  },
  {
    title: "שירותים חינמיים — לכל אדם ביום",
    note: "לא עולים כסף, אבל המכסה שלהם משותפת לכולם — כדי שאדם אחד לא ינצל אותה.",
    rows: [
      { key: "freeTextUser", label: "פניות ל-Gemini החינמי, משתמש מחובר", unit: "פניות", step: 10 },
      { key: "freeTextGuest", label: "פניות ל-Gemini החינמי, אורח", unit: "פניות", step: 10 },
      { key: "voiceCharsUser", label: "הקראה ב-ElevenLabs, משתמש מחובר", unit: "תווים", step: 500 },
      { key: "voiceCharsGuest", label: "הקראה ב-ElevenLabs, אורח", unit: "תווים", step: 500 },
      { key: "searchesUser", label: "חיפוש ב-Tavily, משתמש מחובר", unit: "חיפושים", step: 1 },
      { key: "searchesGuest", label: "חיפוש ב-Tavily, אורח", unit: "חיפושים", step: 1 },
    ],
  },
];

const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

async function call(method: "GET" | "PUT" | "POST", body?: unknown): Promise<LimitsReport> {
  const res = await fetch("/api/admin/ai-limits", {
    method,
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as LimitsReport;
}

export default function AiLimitsPanel() {
  const [report, setReport] = useState<LimitsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Record<NumberKey, string>>>({});
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    call("GET").then((r) => live && setReport(r)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, []);

  const run = async (label: string, work: () => Promise<LimitsReport>, done?: (r: LimitsReport) => string | null) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const r = await work();
      setReport(r);
      setNotice(done?.(r) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!report) {
    return error
      ? <p className="text-amber-300 text-sm mb-3">לא הצלחתי לטעון את המגבלות: {error}</p>
      : <p className="text-white text-sm mb-3 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> טוען מגבלות…</p>;
  }

  const s = report.settings;
  const cap = s.appPaidPerDayUsd;
  const spent = report.todayPaidUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 100;
  const reached = !report.liftedToday && spent >= cap;
  const value = (k: NumberKey) => draft[k] ?? String(s[k]);
  const dirty = Object.entries(draft).some(([k, v]) => v !== String(s[k as NumberKey]));

  const save = () => run("save", () => {
    const patch: Partial<AiLimitSettings> = {};
    for (const [k, v] of Object.entries(draft)) {
      const n = Number(v);
      if (v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0) (patch[k as NumberKey] as number) = n;
    }
    return call("PUT", patch);
  }, () => { setDraft({}); return "המגבלות נשמרו. הן חלות מעכשיו."; });

  return (
    <>
      {!report.tableReady && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3 text-amber-300 text-sm leading-6">
          כדי שהמגבלות יעבדו יש להריץ שוב את <span dir="ltr">supabase/schema.sql</span> ב-Supabase. עד אז המפתחות
          בתשלום סגורים, והשירותים החינמיים ממשיכים כרגיל.
        </div>
      )}

      {/* Today on the paid keys */}
      <div className="rounded-2xl bg-white/10 border border-white/15 p-4 mb-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-white text-sm font-bold">מפתחות בתשלום — היום</span>
          <span className="text-yellow-300 text-xl font-extrabold" dir="ltr">{report.todayPaidUsd == null ? "—" : usd(spent)}</span>
        </div>
        <div className="h-2.5 rounded-full bg-white/15 mt-3 overflow-hidden" dir="ltr">
          <div className={`h-full ${reached ? "bg-red-500" : pct >= s.alertAppPct ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="text-white text-sm mt-2 leading-6">
          {report.liftedToday
            ? <>התקרה היומית (<span dir="ltr">{usd(cap)}</span>) <span className="text-amber-300 font-bold">מוסרת עד חצות</span>. מחר היא חוזרת לבד.</>
            : reached
              ? <><span className="text-red-300 font-bold">הגיע לתקרה היומית ({usd(cap)}).</span> עד חצות כולם מקבלים רק את השירותים החינמיים.</>
              : <>מתוך תקרה יומית של <span dir="ltr">{usd(cap)}</span> לכל האפליקציה. מתאפס בחצות (שעון ישראל). השימוש שלך לא נספר.</>}
        </p>
        <button
          onClick={() => run("lift", () => call("POST", { action: report.liftedToday ? "restore" : "lift-today" }))}
          disabled={!!busy}
          className={`w-full mt-3 rounded-xl border py-2.5 text-sm font-bold transition-colors ${
            report.liftedToday
              ? "border-white/15 bg-white/5 text-white hover:bg-white/10"
              : "border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
          }`}
        >
          {busy === "lift" ? "…" : report.liftedToday ? "החזר את התקרה עכשיו" : "הסר את התקרה להיום בלבד"}
        </button>
        <p className="text-white text-xs mt-2 leading-5">
          ההסרה חלה רק על התקרה של כל האפליקציה. המגבלה של כל אדם נשארת.
        </p>
      </div>

      {/* The limits themselves */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-right rounded-xl bg-white/5 hover:bg-white/10 p-3 transition-colors mb-3"
      >
        <span className="text-white font-bold text-sm">
          מגבלות שימוש והתראות
          <span className="font-normal text-white text-xs mr-2">
            {usd(s.userPaidPerDayUsd)} למשתמש · {usd(s.guestPaidPerDayUsd)} לאורח · התראה מ-{usd(s.alertPersonUsd)}
          </span>
        </span>
        <ChevronDown size={16} className={`text-white shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3 flex flex-col gap-4">
          {FIELDS.map((group) => (
            <div key={group.title}>
              <h4 className="text-white text-sm font-bold">{group.title}</h4>
              <p className="text-white text-xs mt-0.5 mb-2 leading-5">{group.note}</p>
              <div className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <label key={row.key} className="flex items-center justify-between gap-3 text-sm text-white">
                    <span className="leading-5">{row.label}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={row.step}
                        value={value(row.key)}
                        onChange={(e) => setDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                        className="w-24 rounded-lg bg-black/40 border border-white/20 px-2 py-1.5 text-white text-sm text-left"
                        dir="ltr"
                      />
                      <span className="text-white text-xs w-12">{row.unit}</span>
                    </span>
                  </label>
                ))}
              </div>
              {group.title === "התראה במייל" && (
                <div className="mt-2 flex flex-col gap-2">
                  {report.email.configured ? (
                    <p className="text-white text-xs leading-5">
                      ההתראות נשלחות ל-<span dir="ltr">{report.email.recipient}</span>.
                    </p>
                  ) : (
                    <p className="text-amber-300 text-xs leading-5">
                      שליחת מייל עוד לא מוגדרת: חסר <span dir="ltr">RESEND_API_KEY</span> ב-Vercel. ההתראות נרשמות
                      ומופיעות כאן למטה בינתיים.
                    </p>
                  )}
                  <button
                    onClick={() => run("test", () => call("POST", { action: "test-email" }), (r) =>
                      r.test?.ok ? `נשלח מייל בדיקה ל-${r.email.recipient}.` : `המייל לא נשלח: ${r.test?.detail ?? ""}`)}
                    disabled={!!busy}
                    className="self-start flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10"
                  >
                    <Mail size={14} /> {busy === "test" ? "שולח…" : "שלח מייל בדיקה"}
                  </button>
                </div>
              )}
            </div>
          ))}

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!dirty || !!busy}
              className="flex-1 rounded-xl bg-orange-500 disabled:bg-white/10 disabled:text-white/60 text-white text-sm font-bold py-2.5"
            >
              {busy === "save" ? "שומר…" : "שמור"}
            </button>
            <button
              onClick={() => setDraft(Object.fromEntries(
                (Object.keys(report.defaults) as Array<keyof AiLimitSettings>)
                  .filter((k): k is NumberKey => k !== "liftedDay")
                  .map((k) => [k, String(report.defaults[k])])
              ))}
              disabled={!!busy}
              className="rounded-xl border border-white/15 bg-white/5 px-3 text-white text-xs font-bold hover:bg-white/10"
            >
              ברירות מחדל
            </button>
          </div>

          {report.alerts.length > 0 && (
            <div>
              <h4 className="text-white text-sm font-bold mb-1.5">התראות אחרונות</h4>
              <ul className="flex flex-col gap-1">
                {report.alerts.map((a) => (
                  <li key={a.at + a.subject} className="text-white text-xs leading-5">
                    <span dir="ltr">{new Date(a.at).toLocaleString("he-IL", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    {" · "}{a.subject.replace(/^Navi: /, "")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {notice && <p className="text-emerald-300 text-sm mb-3">{notice}</p>}
      {error && <p className="text-amber-300 text-sm mb-3 break-words">{error}</p>}
    </>
  );
}
