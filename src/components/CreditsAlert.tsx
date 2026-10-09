import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { fetchCredits } from "./ElevenLabsCredits";
import { fetchTavily } from "./TavilyCredits";

// The alert on the map screen when a free plan's credits run low or out —
// ElevenLabs (the voice) and Tavily (the web search). The admin's alone: both
// routes answer 403 to everyone else, and then nothing shows.

const num = (n: number) => Math.round(n).toLocaleString("he-IL");
const date = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });

interface Alert {
  // Dismissed per service, level and period: a "running low" that was
  // dismissed alerts again when it actually runs out, and again next month.
  key: string;
  out: boolean;
  title: string;
  body: string;
}

const DISMISS_KEY = "navi:creditsAlertDismissed.v2";

function readDismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]"); } catch { return []; }
}

export default function CreditsAlert({ signedInAs }: { signedInAs: string | null }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  useEffect(() => {
    if (!signedInAs) return;
    let live = true;
    Promise.all([fetchCredits().catch(() => null), fetchTavily().catch(() => null)]).then(([voice, search]) => {
      if (!live) return;
      const list: Alert[] = [];
      if (voice?.status === "ok" && voice.level !== "ok") {
        const out = voice.level === "out";
        list.push({
          key: `elevenlabs:${voice.level}:${voice.resetAt ?? ""}`,
          out,
          title: out ? "נגמרו הקרדיטים של ElevenLabs" : "הקרדיטים של ElevenLabs עומדים להיגמר",
          body: `נוצלו ${num(voice.used)} מתוך ${num(voice.limit)}${voice.resetAt ? `, מתחדש ב-${date(voice.resetAt)}` : ""}. ` +
            (out ? "עד אז נקודות חדשות יוקראו בקול של הטלפון." : voice.runsOutAt ? `בקצב הנוכחי ייגמרו בערך ב-${date(voice.runsOutAt)}.` : ""),
        });
      }
      if (search?.status === "ok" && search.credits.level !== "ok") {
        const c = search.credits;
        const out = c.level === "out";
        list.push({
          key: `tavily:${c.level}:${c.resetAt}`,
          out,
          title: out ? "נגמרו הקרדיטים של Tavily" : "הקרדיטים של Tavily עומדים להיגמר",
          body: `נוצלו ${num(c.used)}${c.limit !== null ? ` מתוך ${num(c.limit)}` : ""}, מתחדש ב-${date(c.resetAt)}. ` +
            (out ? "עד אז אין חיפוש ברשת — אין חיוב, השירות פשוט ממתין." : c.runsOutAt ? `בקצב הנוכחי ייגמרו בערך ב-${date(c.runsOutAt)}.` : ""),
        });
      }
      setAlerts(list);
    });
    return () => { live = false; };
  }, [signedInAs]);

  const shown = signedInAs ? alerts.filter((a) => !dismissed.includes(a.key)) : [];
  if (shown.length === 0) return null;

  const dismiss = (key: string) => {
    const next = [...dismissed.filter((k) => alerts.some((a) => a.key === k)), key];
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch {}
  };

  return (
    <div className="absolute bottom-24 inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[420px] z-[56] flex flex-col gap-2" dir="rtl">
      {shown.map((a) => (
        <div
          key={a.key}
          className={`rounded-2xl shadow-2xl border p-3 flex items-start gap-2 ${a.out ? "bg-red-700 border-red-300/40" : "bg-amber-600 border-amber-200/40"}`}
          role="alert"
        >
          <AlertTriangle size={20} className="text-white shrink-0 mt-0.5" />
          <div className="flex-1 text-white text-sm leading-6">
            <p className="font-bold">{a.title}</p>
            <p>{a.body}</p>
            <p className="text-xs mt-1">הפרטים בהגדרות ← שימוש ועלויות AI. ההתראה מוצגת רק לך, כמנהל.</p>
          </div>
          <button onClick={() => dismiss(a.key)} className="text-white p-1 shrink-0" aria-label="סגור התראה">
            <X size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}
