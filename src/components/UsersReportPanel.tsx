import { type ReactNode, useEffect, useState } from "react";
import { Loader2, RotateCcw, Smartphone, Trash2 } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import { EVENT_LABELS } from "../lib/appEvents";
import { SELECT_CLASS } from "./FilterDropdown";
import Collapsible from "./Collapsible";
import type { OwnerExclusion, PersonUsage, UsersReport } from "../lib/usersReport";

// The admin's "משתמשים ושימוש": who used the app — registered users and
// guests — and what for, both in the app (lib/track → app_events) and in the
// API services behind it (ai_usage). The admin's own use is left out by
// address, device and IP; the last part of the screen edits that list.
// Settings → "משתמשים ושימוש".

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  gemini: "Gemini (בתשלום)",
  "gemini-free": "Gemini (חינמי)",
  claude: "Claude",
  elevenlabs: "ElevenLabs — הקראה",
  tavily: "Tavily — חיפוש",
};

const PERIODS: Array<{ days: number; label: string }> = [
  { days: 7, label: "7 ימים אחרונים" },
  { days: 30, label: "30 יום אחרונים" },
  { days: 90, label: "90 יום אחרונים" },
  { days: 0, label: "מאז ההתחלה" },
];

type Who = "all" | "user" | "guest";

const num = (n: number) => Math.round(n).toLocaleString("he-IL");
const eventLabel = (e: string) => (EVENT_LABELS as Record<string, string>)[e] ?? e;
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p;
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("he-IL") : "—");

function cost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-white font-bold text-sm mt-5 mb-2 border-b border-white/10 pb-1">{children}</h3>;
}

function apiAmount(a: { calls: number; chars: number; searches: number }) {
  const parts = [`${num(a.calls)} פניות`];
  if (a.chars) parts.push(`${num(a.chars)} תווים`);
  if (a.searches) parts.push(`${num(a.searches)} חיפושים`);
  return parts.join(" · ");
}

function personTitle(p: PersonUsage) {
  if (p.kind === "user") return <bdi>{p.email ?? "משתמש בלי כתובת"}</bdi>;
  return `אורח ${p.guestNo ?? ""}`;
}

function Person({ p }: { p: PersonUsage }) {
  const events = Object.entries(p.events).sort((a, b) => b[1] - a[1]);
  const where = [p.native && "אפליקציה", p.web && "דפדפן"].filter(Boolean).join(" + ");
  return (
    <Collapsible
      title={personTitle(p)}
      summary={p.eventsTotal + p.apiCalls === 0 ? "לא השתמש" : `${num(p.activeDays)} ימים${p.costUsd ? ` · ${cost(p.costUsd)}` : ""}`}
    >
      <div className="text-white text-sm leading-6">
        {p.kind === "user" && (
          <p>נרשם: {date(p.signedUpAt)} · התחבר לאחרונה: {date(p.lastSignInAt)}</p>
        )}
        <p>
          פעילות בתקופה: {date(p.firstAt)} – {date(p.lastAt)} · {num(p.activeDays)} ימים שונים
          {where && ` · ${where}`}
        </p>

        {events.length > 0 && (
          <>
            <p className="font-bold mt-2">באפליקציה</p>
            <ul className="text-sm">
              {events.map(([e, n]) => (
                <li key={e} className="flex justify-between gap-3">
                  <span>{eventLabel(e)}</span>
                  <span className="text-sky-300 font-bold shrink-0">{num(n)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {p.api.length > 0 && (
          <>
            <p className="font-bold mt-2">שירותי API</p>
            <ul className="text-sm">
              {p.api.map((a) => (
                <li key={a.provider} className="flex justify-between gap-3">
                  <span><bdi>{providerLabel(a.provider)}</bdi> · {apiAmount(a)}</span>
                  <span className="text-yellow-300 font-bold shrink-0" dir="ltr">{cost(a.costUsd)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Collapsible>
  );
}

function OwnerSection({ owner, onChange }: { owner: OwnerExclusion; onChange: () => void }) {
  const [ip, setIp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const thisDeviceListed = owner.devices.some((d) => d.current);

  const call = async (method: "POST" | "DELETE", body: object) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/owner-exclusion", {
        method,
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error ?? "הפעולה נכשלה.");
      else { setIp(""); onChange(); }
    } catch {
      setError("אין חיבור לשרת.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="text-white text-sm leading-6">
      <p>
        השימוש שלך לא נספר: לפי הכתובת שלך, לפי המכשירים שלך (מכשיר נוסף לכאן מעצמו כשאתה מחובר בו), ולפי
        כתובות ה-IP שלך — אלה חלות רק כשאף אחד לא מחובר, כי ברשת הביתית יכולים להיות גם אחרים.
      </p>

      <p className="font-bold mt-3">המכשירים שלך</p>
      {owner.devices.length === 0 && <p>עוד אין.</p>}
      <ul className="flex flex-col gap-1">
        {owner.devices.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-2 py-1.5">
            <span className="flex items-center gap-2">
              <Smartphone size={14} />
              {d.label ?? "מכשיר"} · מאז {date(d.createdAt)}
              {d.current && <span className="text-emerald-300 font-bold">· המכשיר הזה</span>}
            </span>
            <button onClick={() => call("DELETE", { kind: "device", id: d.id })} disabled={busy} aria-label="הסר מכשיר" className="p-1 text-white hover:text-red-300">
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!thisDeviceListed && (
        <button
          onClick={() => call("POST", { kind: "device" })}
          disabled={busy}
          className="mt-2 rounded-lg border border-sky-400/60 bg-sky-500/20 px-3 py-1.5 text-sm font-bold text-sky-100"
        >
          המכשיר הזה שלי
        </button>
      )}

      <p className="font-bold mt-3">כתובות ה-IP שלך</p>
      {owner.ips.length === 0 && <p>עוד אין.</p>}
      <ul className="flex flex-col gap-1">
        {owner.ips.map((r) => (
          <li key={r.ip} className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-2 py-1.5">
            <span><bdi dir="ltr">{r.ip}</bdi>{r.label && ` · ${r.label}`}</span>
            <button onClick={() => call("DELETE", { kind: "ip", id: r.ip })} disabled={busy} aria-label="הסר כתובת" className="p-1 text-white hover:text-red-300">
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 mt-2">
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="כתובת IP"
          dir="ltr"
          className="min-w-0 flex-1 rounded-lg bg-zinc-900 border border-white/20 px-2 py-1.5 text-sm text-white"
        />
        <button
          onClick={() => call("POST", { kind: "ip", ip })}
          disabled={busy || !ip.trim()}
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
        >
          הוסף
        </button>
      </div>
      {owner.currentIp && !owner.ips.some((r) => r.ip === owner.currentIp) && (
        <button
          onClick={() => call("POST", { kind: "ip", ip: owner.currentIp, label: "נוספה מהמסך" })}
          disabled={busy}
          className="mt-2 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-bold text-white"
        >
          הוסף את הכתובת שממנה אני מחובר עכשיו (<bdi dir="ltr">{owner.currentIp}</bdi>)
        </button>
      )}
      <p className="text-xs mt-2">
        כתובת IP ביתית מתחלפת מדי פעם, ובסלולר לטלפון יש כתובת אחרת — לכן ההחרגה העיקרית היא לפי מכשיר.
      </p>
      {error && <p className="text-amber-300 text-sm mt-1">{error}</p>}
    </div>
  );
}

type Tab = "people" | "events" | "api";

export default function UsersReportPanel() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<Tab>("people");
  const [who, setWho] = useState<Who>("all");
  const [reload, setReload] = useState(0);
  const request = `${days}:${reload}`;
  const [result, setResult] = useState<{ request: string; report: UsersReport | null } | null>(null);
  const loading = result?.request !== request;
  const failed = !loading && result?.report === null;

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`/api/admin/users-report?days=${days}`, { headers: await authHeaders() });
      return (await res.json()) as UsersReport;
    })()
      .then((report) => live && setResult({ request, report }))
      .catch(() => live && setResult({ request, report: null }));
    return () => { live = false; };
  }, [days, request]);

  const report = result?.report ?? null;
  const ok = report?.status === "ok" ? report : null;
  const people = ok ? ok.people.filter((p) => who === "all" || p.kind === who) : [];

  return (
    <div className="mt-4">
      <p className="text-white text-sm mb-3 leading-6">
        מי השתמש באפליקציה ובמה — משתמשים רשומים ואורחים (שלא התחברו). אורח מזוהה לפי מכשיר, ובלי מכשיר לפי
        כתובת IP מגובבת; שום כתובת IP לא נשמרת. השימוש שלך לא נספר.
      </p>

      <div className="flex gap-1.5 mb-3">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={SELECT_CLASS} aria-label="תקופה">
          {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
        </select>
        <button
          onClick={() => setReload((n) => n + 1)}
          className="rounded-lg px-2 border border-white/10 bg-white/5 text-white hover:bg-white/10"
          aria-label="רענן"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {loading && !ok && (
        <p className="text-white text-sm flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> טוען…</p>
      )}
      {failed && <p className="text-amber-300 text-sm">לא הצלחתי לטעון את הנתונים. נסה שוב.</p>}
      {report?.status === "no-table" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-sm leading-6">
          טבלאות הדו״ח עוד לא קיימות. יש להריץ את הקובץ <span dir="ltr">supabase/schema.sql</span> ב-Supabase (SQL Editor),
          ומאותו רגע כל שימוש יירשם.
        </div>
      )}
      {report?.status === "not-configured" && (
        <p className="text-amber-300 text-sm">הדו״ח לא פעיל: חסר מפתח השירות של Supabase בשרת.</p>
      )}
      {report?.status === "error" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-sm leading-6">
          שגיאה בקריאת הנתונים מ-Supabase.
          {report.detail && <p className="text-white text-xs mt-1 break-words" dir="ltr">{report.detail}</p>}
        </div>
      )}

      {ok && (
        <div className={loading ? "opacity-60" : ""}>
          <div className="rounded-2xl bg-white/10 border border-white/15 p-4 mb-3 text-white text-sm leading-6">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div><span className="text-2xl font-extrabold text-sky-300">{num(ok.summary.activeRegistered)}</span><br />רשומים פעילים</div>
              <div><span className="text-2xl font-extrabold text-sky-300">{num(ok.summary.activeGuests)}</span><br />אורחים פעילים</div>
            </div>
            <p>
              {num(ok.summary.registered)} רשומים בסך הכול
              {ok.days > 0 && ` · ${num(ok.summary.newRegistered)} נרשמו בתקופה`}
              {` · ${num(ok.summary.nativePeople)} השתמשו באפליקציית Android`}
            </p>
            <p>
              {num(ok.summary.events)} פעולות באפליקציה · {num(ok.summary.apiCalls)} פניות לשירותי API ·{" "}
              עלות <span className="text-yellow-300 font-bold" dir="ltr">{cost(ok.summary.costUsd)}</span>
            </p>
            <p className="text-xs mt-1">
              הפעולות באפליקציה נספרות {ok.eventsSince ? `מאז ${date(ok.eventsSince)}` : "מעכשיו (עוד לא נרשמה אף אחת)"};
              שירותי ה-API מאז {date(ok.apiSince)}. לא נספרו שלך: {num(ok.excluded.events)} פעולות ו-{num(ok.excluded.apiCalls)} פניות.
            </p>
          </div>

          <div className="flex gap-1.5 mb-3" role="tablist">
            {([["people", "לפי משתמש"], ["events", "לפי פעולה"], ["api", "לפי שירות"]] as Array<[Tab, string]>).map(([t, label]) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`flex-1 rounded-lg py-2 text-xs font-bold border transition-colors ${
                  tab === t ? "bg-sky-500/20 border-sky-400/60 text-sky-200" : "bg-white/5 border-white/10 text-white hover:bg-white/10"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "people" && (
            <>
              <select value={who} onChange={(e) => setWho(e.target.value as Who)} className={`${SELECT_CLASS} mb-2`} aria-label="מי">
                <option value="all">כולם</option>
                <option value="user">רשומים בלבד</option>
                <option value="guest">אורחים בלבד</option>
              </select>
              {people.length === 0 ? (
                <p className="text-white text-sm">אין אף אחד בתקופה הזו.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {people.map((p) => <Person key={p.key} p={p} />)}
                </div>
              )}
            </>
          )}

          {tab === "events" && (
            ok.byEvent.length === 0 ? (
              <p className="text-white text-sm">עוד לא נרשמו פעולות בתקופה הזו.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {ok.byEvent.map((e) => (
                  <li key={e.event} className="flex justify-between gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-white">
                    <span>{eventLabel(e.event)}</span>
                    <span className="shrink-0"><span className="text-sky-300 font-bold">{num(e.count)}</span> · {num(e.people)} אנשים</span>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === "api" && (
            ok.byProvider.length === 0 ? (
              <p className="text-white text-sm">אין שימוש בשירותי API בתקופה הזו.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {ok.byProvider.map((a) => (
                  <li key={a.provider} className="rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-white">
                    <div className="flex justify-between gap-3">
                      <span className="font-bold"><bdi>{providerLabel(a.provider)}</bdi></span>
                      <span className="text-yellow-300 font-bold" dir="ltr">{cost(a.costUsd)}</span>
                    </div>
                    <p className="text-sm">{apiAmount(a)} · {num(a.people)} אנשים</p>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}

      {report?.owner && (
        <>
          <SectionTitle>החרגת השימוש שלך</SectionTitle>
          <OwnerSection owner={report.owner} onChange={() => setReload((n) => n + 1)} />
        </>
      )}
    </div>
  );
}
