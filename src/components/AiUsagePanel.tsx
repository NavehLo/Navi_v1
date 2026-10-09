import { type ReactNode, useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import { ElevenLabsCreditsCard } from "./ElevenLabsCredits";
import { TavilyCreditsCard } from "./TavilyCredits";
import AiLimitsPanel from "./AiLimitsPanel";
import type { UsageGroup, UsageReport, UsageTotals } from "../lib/aiUsageReport";

// The admin's view of the app's AI: the paid keys (today's spend, the daily
// cap, the limits and the email alerts — AiLimitsPanel), the free plans'
// credits, and every call logged by lib/aiUsage, summed for a period and
// broken down by use, by model and by user. Only the paid keys cost money;
// the free ones are counted in their own units. Settings → "שימוש ועלויות AI".

const FEATURE_LABELS: Record<string, string> = {
  "guide:text": "המדריך הקולי — כתיבת הקריינות",
  "guide:voice": "המדריך הקולי — הקראה בקול",
  "guide_offline:text": "הורדת מסלול לשטח — כתיבת הקריינות",
  "guide_offline:voice": "הורדת מסלול לשטח — הקראה בקול",
  "voice_test:voice": "בדיקת קול בהגדרות",
  "trail_info:text": "על המסלול — סיכום המידע שנאסף",
  "trail_info:search": "על המסלול — חיפוש מידע ברשת",
  "trail_translate:text": "תרגום שמות של מסלולי עולם",
  "trip_advice:text": "הסבר על מזג האוויר ביום הטיול",
  "trail_crowd:search": "מדדי מטיילים — חיפוש באתרי ביקורות",
  "trail_crowd:text": "מדדי מטיילים — קריאת הציונים מהעמודים",
  "country_guide:text": "אזורי טיול — סקירת מדינה עם חיפוש ברשת",
  "help_chat:text": "שאלו את Navi — צ׳אט העזרה",
  "trail_photos:text": "תמונות מהמסלול — בדיקת התמונות",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  "gemini-free": "Gemini",
  claude: "Claude",
  elevenlabs: "ElevenLabs",
  tavily: "Tavily",
};

// Which keys cost money. Kept beside the names, outside the English, so the
// Hebrew word reads in its own direction.
const PAID = new Set(["openai", "gemini", "claude"]);

const PERIODS: Array<{ days: number; label: string }> = [
  { days: 7, label: "7 ימים" },
  { days: 30, label: "30 יום" },
  { days: 90, label: "90 יום" },
  { days: 0, label: "הכול" },
];

const featureLabel = (key: string) => FEATURE_LABELS[key] ?? key;

// "openai · gpt-4.1-mini" → "OpenAI · gpt-4.1-mini". Each half isolated, so
// the English and the Hebrew around it keep their own reading order.
function modelLabel(key: string): ReactNode {
  const [provider, model] = key.split(" · ");
  return (
    <>
      <bdi>{PROVIDER_LABELS[provider] ?? provider}</bdi> · <bdi>{model}</bdi> ·{" "}
      <span className={PAID.has(provider) ? "text-yellow-300" : "text-emerald-300"}>{PAID.has(provider) ? "בתשלום" : "חינמי"}</span>
    </>
  );
}

const num = (n: number) => Math.round(n).toLocaleString("he-IL");

function cost(n: number): string {
  if (n === 0) return "חינם";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// What was consumed, in each provider's own units.
function amount(t: UsageTotals): string {
  const parts = [`${num(t.calls)} פעמים`];
  if (t.paidCalls) parts.push(`${num(t.paidCalls)} בתשלום`);
  const tokens = t.inputTokens + t.outputTokens;
  if (tokens) parts.push(`${num(tokens)} טוקנים`);
  if (t.chars) parts.push(`${num(t.chars)} תווים שהוקראו`);
  if (t.searches) parts.push(`${num(t.searches)} חיפושים`);
  return parts.join(" · ");
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-white font-bold text-sm mt-5 mb-2 border-b border-white/10 pb-1">{children}</h3>;
}

function Group({ group, title, partLabel }: { group: UsageGroup; title: ReactNode; partLabel: (k: string) => ReactNode }) {
  return (
    <li className="rounded-xl bg-white/5 border border-white/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-white text-sm font-bold leading-5">{title}</span>
        <span className="text-yellow-300 text-sm font-bold shrink-0" dir="ltr">{cost(group.costUsd)}</span>
      </div>
      <p className="text-white text-xs mt-1">{amount(group)}</p>
      {group.parts.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-white/10 pt-2">
          {group.parts.map((p) => (
            <li key={p.label} className="flex items-start justify-between gap-3 text-xs text-white">
              <span className="leading-5">{partLabel(p.label)} · {num(p.calls)} פעמים</span>
              <span className="shrink-0" dir="ltr">{cost(p.costUsd)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

type Tab = "feature" | "model" | "user";

export default function AiUsagePanel() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<Tab>("feature");
  const [reload, setReload] = useState(0);
  // The answer for one period and one press of "רענן". Loading is simply
  // "the answer on screen is for a different request".
  const request = `${days}:${reload}`;
  const [result, setResult] = useState<{ request: string; report: UsageReport | null } | null>(null);
  const loading = result?.request !== request;
  const failed = !loading && result?.report === null;

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch(`/api/admin/ai-usage?days=${days}`, { headers: await authHeaders() });
      return (await res.json()) as UsageReport;
    })()
      .then((report) => live && setResult({ request, report }))
      .catch(() => live && setResult({ request, report: null }));
    return () => { live = false; };
  }, [days, request]);

  // The previous answer stays on screen, dimmed, while the next one loads.
  const report = result?.report ?? null;
  const ok = report?.status === "ok" ? report : null;
  const groups = ok ? (tab === "feature" ? ok.byFeature : tab === "model" ? ok.byModel : ok.byUser) : [];

  return (
    <div className="mt-4">
      <p className="text-white text-sm mb-3 leading-6">
        כל פנייה לשירות בינה מלאכותית, מכל המשתמשים. רק המפתחות בתשלום (OpenAI, Gemini, Claude) עולים כסף —
        העלות היא הערכה לפי המחירון של כל ספק, לא חשבונית. השירותים החינמיים נספרים ביחידות שלהם.
      </p>

      {report?.rateLimit === "upstash" && (
        <p className="text-white text-sm mb-3 leading-6">הגבלת קצב: משותפת לכל השרתים (Upstash).</p>
      )}
      {report?.rateLimit === "memory" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-3 text-amber-300 text-sm leading-6">
          הגבלת הקצב לדקה נספרת בכל שרת בנפרד, ולכן קל לעקוף אותה. כדי שתהיה משותפת לכל השרתים צריך חשבון
          חינמי ב-Upstash ושני משתנים ב-Vercel — ההוראות שלב אחר שלב ב-README, בפרק ״Upstash״. (המגבלות
          היומיות למעלה לא תלויות בזה: הן נספרות בבסיס הנתונים.)
        </div>
      )}

      <SectionTitle>מפתחות בתשלום</SectionTitle>
      <AiLimitsPanel />

      <SectionTitle>שירותים חינמיים</SectionTitle>
      <ElevenLabsCreditsCard />
      <TavilyCreditsCard />
      <p className="text-white text-xs mb-3 leading-5">
        Gemini עם המפתח החינמי: בלי עלות. Google מגביל את מספר הפניות ביום; כשהמכסה שלו נגמרת, הטקסט נכתב
        במפתח בתשלום — בתוך המגבלות שלמעלה.
      </p>

      <SectionTitle>פירוט השימוש</SectionTitle>

      <div className="flex gap-1.5 mb-3" role="group" aria-label="תקופה">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            aria-pressed={days === p.days}
            className={`flex-1 rounded-lg py-1.5 text-xs font-bold border transition-colors ${
              days === p.days ? "bg-orange-500/20 border-orange-500/60 text-orange-300" : "bg-white/5 border-white/10 text-white hover:bg-white/10"
            }`}
          >
            {p.label}
          </button>
        ))}
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
          טבלת המעקב עוד לא קיימת. יש להריץ את הקובץ <span dir="ltr">supabase/schema.sql</span> ב-Supabase (SQL Editor),
          ומאותו רגע כל שימוש יירשם.
        </div>
      )}
      {report?.status === "not-configured" && (
        <p className="text-amber-300 text-sm">המעקב לא פעיל: חסר מפתח השירות של Supabase בשרת.</p>
      )}
      {report?.status === "error" && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-sm leading-6">
          שגיאה בקריאת הנתונים מ-Supabase.
          {report.detail && <p className="text-white text-xs mt-1 break-words" dir="ltr">{report.detail}</p>}
        </div>
      )}

      {ok && (
        <div className={loading ? "opacity-60" : ""}>
          <div className="rounded-2xl bg-white/10 border border-white/15 p-4 mb-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-white text-sm font-bold">
                {days ? `בתשלום ב-${PERIODS.find((p) => p.days === days)?.label}` : "בתשלום מאז תחילת המעקב"}
              </span>
              <span className="text-yellow-300 text-2xl font-extrabold" dir="ltr">{cost(ok.total.costUsd)}</span>
            </div>
            <p className="text-white text-xs mt-1">{num(ok.total.paidCalls)} פניות למפתחות בתשלום.</p>
            <p className="text-white text-xs mt-1">
              חינמי: {num(ok.total.freeTextCalls)} פניות ל-Gemini החינמי · {num(ok.total.chars)} תווים שהוקראו ב-ElevenLabs ·{" "}
              {num(ok.total.searches)} חיפושים ב-Tavily.
            </p>
            {ok.trackingSince && (
              <p className="text-white text-xs mt-2">
                המעקב התחיל ב-{new Date(ok.trackingSince).toLocaleDateString("he-IL")}. שימוש מלפני כן לא נספר.
              </p>
            )}
          </div>

          <div className="flex gap-1.5 mb-3" role="tablist">
            {([["feature", "לפי שימוש"], ["model", "לפי מודל"], ["user", "לפי משתמש"]] as Array<[Tab, string]>).map(([t, label]) => (
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

          {groups.length === 0 ? (
            <p className="text-white text-sm">אין שימוש בתקופה הזו.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {groups.map((g) => (
                <Group
                  key={g.key}
                  group={g}
                  title={
                    tab === "feature" ? featureLabel(g.key)
                      : tab === "model" ? modelLabel(g.key)
                      : g.key === "scripts" ? "הסקריפטים שלך (מהמחשב) — פטורים מהמגבלות"
                      : g.key === "anonymous" ? "אורחים (לא מחוברים)"
                      : `${g.email ?? "משתמש ללא כתובת"}${g.exempt ? " — אתה, פטור מהמגבלות" : ""}`
                  }
                  partLabel={tab === "feature" ? modelLabel : featureLabel}
                />
              ))}
            </ul>
          )}

          <p className="text-white text-xs mt-3 leading-5">
            טוקנים הם יחידות הטקסט שלפיהן מחויבים מודלי השפה. ״חינם״ ליד שירות פירושו שהוא במסלול חינמי בלי חיוב:
            כשהמכסה שלו נגמרת הוא פשוט ממתין לחידוש.
          </p>
        </div>
      )}
    </div>
  );
}
