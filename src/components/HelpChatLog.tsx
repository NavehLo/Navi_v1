import { useEffect, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { authHeaders } from "../lib/authHeaders";
import { HELP_ACTIONS, type HelpActionId } from "../lib/helpChat/actions";
import type { HelpChatLogRow } from "../app/api/admin/help-chat/route";

// The admin's list of what was asked in "שאלו את Navi" (api/admin/help-chat),
// newest first, under settings. A question the chat could not answer is
// marked: that is where the help text (components/help/features.ts) is
// missing something.

const STATUS_LABELS: Record<string, string> = {
  busy: "המכסה החינמית נגמרה",
  unavailable: "לא נענתה",
  "rate-limited": "מעל המגבלה",
};

const unsure = (r: HelpChatLogRow) => r.status !== "ok" || /לא בטוח|לא יודע/.test(r.answer ?? "");

export default function HelpChatLog() {
  const [onlyUnsure, setOnlyUnsure] = useState(false);
  // Bumped by the refresh button; an answer counts only for the request it answers.
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<{ request: number; rows?: HelpChatLogRow[]; error?: string } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const d = await fetch("/api/admin/help-chat", { headers: await authHeaders() }).then((r) => r.json());
      if (d.status === "ok") return { rows: d.rows as HelpChatLogRow[] };
      return {
        error: d.status === "table-missing"
          ? "הטבלה help_chat_log עוד לא קיימת — צריך להריץ את supabase/schema.sql."
          : d.error ?? "לא ניתן לטעון את השאלות.",
      };
    })()
      .catch(() => ({ error: "לא ניתן לטעון את השאלות." }))
      .then((r) => live && setResult({ request, ...r }));
    return () => { live = false; };
  }, [request]);

  const reload = () => setRequest((n) => n + 1);
  const current = result?.request === request ? result : null;
  if (current?.error) return <p className="text-amber-300 text-sm mt-2">{current.error}</p>;
  const rows = current?.rows;
  if (!rows) return <p className="flex items-center gap-2 text-white text-sm mt-2"><Loader2 size={16} className="animate-spin" /> טוען…</p>;

  const shown = onlyUnsure ? rows.filter(unsure) : rows;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-white text-sm">
          <input type="checkbox" checked={onlyUnsure} onChange={(e) => setOnlyUnsure(e.target.checked)} />
          רק מה שלא נענה טוב ({rows.filter(unsure).length})
        </label>
        <button onClick={reload} className="p-1.5 text-white" aria-label="רענן"><RotateCcw size={16} /></button>
      </div>
      {shown.length === 0 && <p className="text-white text-sm">עוד לא נשאלו שאלות.</p>}
      <ul className="flex flex-col gap-2">
        {shown.map((r) => (
          <li key={r.id} className={`rounded-xl border p-3 ${unsure(r) ? "bg-amber-500/10 border-amber-500/30" : "bg-white/5 border-white/10"}`}>
            <div className="flex items-start justify-between gap-3">
              <span className="text-white text-sm font-bold leading-5">{r.question}</span>
              <span className="text-white text-xs shrink-0">
                {new Date(r.created_at).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}
              </span>
            </div>
            <p className="text-white text-sm mt-1 leading-relaxed">
              {r.answer ?? <span className="text-amber-300">{STATUS_LABELS[r.status] ?? r.status}</span>}
            </p>
            {!!r.actions?.length && (
              <p className="text-sky-200 text-xs mt-1">
                כפתורים: {r.actions.map((a) => HELP_ACTIONS[a as HelpActionId]?.label ?? a).join(" · ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
