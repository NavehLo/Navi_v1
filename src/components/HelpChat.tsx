import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Loader2, WifiOff } from "lucide-react";
import { useOutsideTap } from "../hooks/useOutsideTap";
import { authHeaders } from "../lib/authHeaders";
import { HELP_ACTIONS, availableActions, type HelpActionId, type HelpScreen } from "../lib/helpChat/actions";

// "שאלו את Navi": a round button in the bottom corner that opens a short
// chat about using the app (api/help-chat). Answers can carry up to two
// buttons that open what they talk about; page.tsx runs them.
//
// The conversation is kept at module level, so hiding the screen ("הסתר
// הכל") or opening a trail does not lose it; a reload starts afresh.

interface Message {
  role: "user" | "model";
  text: string;
  actions?: HelpActionId[];
  // A note from the app itself (busy, offline…), not sent back to the model.
  note?: boolean;
}

let kept: Message[] = [];

const STARTERS = [
  "איך מורידים מסלול לשימוש בלי קליטה?",
  "איך מקליטים את ההליכה שלי?",
  "איך מוצאים מסלול בחו״ל?",
  "איך מפעילים את המדריכה הקולית?",
];

const NOTES: Record<string, string> = {
  "rate-limited": "הגעתם למספר השאלות להיום. אפשר לחזור מחר, או לחפש ב״מדריכים ומידע נוסף״ בהגדרות.",
  busy: "העוזר עמוס כרגע. נסו שוב בעוד כמה דקות.",
  "not-configured": "צ׳אט העזרה לא זמין כרגע. ההסברים נמצאים ב״מדריכים ומידע נוסף״ בהגדרות.",
  unavailable: "לא הצלחתי לענות הפעם. נסו לנסח אחרת, או חפשו ב״מדריכים ומידע נוסף״ בהגדרות.",
};

// What the model is sent: the questions it answered and its answers, and the
// new question. One the app answered with a note (busy, limit) is left out.
function history(messages: Message[]) {
  return messages
    .filter((m, i) => !m.note && !(m.role === "user" && messages[i + 1]?.note))
    .map(({ role, text }) => ({ role, text }));
}

const DEVICE_KEY = "navi:device.v1";
function deviceId(): string | undefined {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export default function HelpChat({
  screen, online, open, onOpenChange, onAction,
}: {
  screen: HelpScreen;
  online: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (id: HelpActionId) => void;
}) {
  const [messages, setMessages] = useState<Message[]>(kept);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { kept = messages; }, [messages]);
  useOutsideTap([panelRef, buttonRef], open, () => onOpenChange(false));

  // The newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || sending || !online) return;
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    setDraft("");
    setSending(true);
    let reply: Message;
    try {
      const res = await fetch("/api/help-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          messages: history(next),
          screen,
          deviceId: deviceId(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      reply = data.status === "ok" && data.answer
        ? { role: "model", text: data.answer, actions: data.actions ?? [] }
        : { role: "model", text: NOTES[data.status] ?? NOTES.unavailable, note: true };
    } catch {
      reply = { role: "model", text: NOTES.unavailable, note: true };
    }
    setMessages((m) => [...m, reply]);
    setSending(false);
  };

  // The screen may have changed since the answer: only the buttons that still
  // make sense are drawn.
  const usable = new Set(availableActions(screen));

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="שאלו את Navi"
        title="שאלו את Navi"
        className="absolute bottom-3 right-3 md:right-auto md:left-3 md:bottom-10 z-[43] w-12 h-12 flex items-center justify-center rounded-full bg-sky-500 text-white shadow-xl border border-white/20 hover:bg-sky-400 transition-colors"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>

      {/* Above the button, and above the bottom bar of an open trail (the
          tour button, the guide's pill), which would otherwise cover its input. */}
      {open && (
        <div
          ref={panelRef}
          dir="rtl"
          className="absolute bottom-[max(72px,calc(var(--bottom-stack-h,0px)+8px))] left-4 right-4 md:right-auto md:left-3 md:bottom-[max(100px,calc(var(--bottom-stack-h,0px)+8px))] md:w-[360px] z-[45] flex flex-col max-h-[60dvh] bg-black/85 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 border-b border-white/10">
            <span className="flex items-center gap-2 text-white font-bold text-sm">
              <MessageCircle size={16} className="text-sky-300" />
              שאלו את Navi
            </span>
            <button onClick={() => onOpenChange(false)} className="p-1.5 -m-1.5 text-white" aria-label="סגור">
              <X size={18} />
            </button>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 select-text">
            {messages.length === 0 && (
              <>
                <p className="text-white text-sm leading-relaxed px-1">
                  שאלו כל דבר על השימוש באפליקציה — איפה נמצא משהו ואיך עושים אותו.
                </p>
                <div className="flex flex-col gap-1.5 mt-1">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={() => ask(s)}
                      disabled={!online}
                      className="text-right text-sm text-white bg-white/10 hover:bg-white/15 disabled:opacity-60 rounded-xl px-3 py-2"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "self-start max-w-[85%]" : "self-end max-w-[90%]"}>
                <p
                  className={`text-sm leading-relaxed rounded-2xl px-3 py-2 whitespace-pre-line ${
                    m.role === "user" ? "bg-sky-600 text-white"
                      : m.note ? "bg-amber-500/15 text-amber-200 border border-amber-500/30"
                      : "bg-white/10 text-white"
                  }`}
                >
                  {m.text}
                </p>
                {m.actions?.filter((a) => usable.has(a)).map((a) => (
                  <button
                    key={a}
                    onClick={() => { onOpenChange(false); onAction(a); }}
                    className="mt-1.5 block w-full text-right text-sm font-bold text-sky-200 bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 rounded-xl px-3 py-2"
                  >
                    {HELP_ACTIONS[a].label} ←
                  </button>
                ))}
              </div>
            ))}
            {sending && (
              <div className="self-end flex items-center gap-2 text-white text-sm px-3 py-2">
                <Loader2 size={16} className="animate-spin text-sky-300" /> רגע…
              </div>
            )}
          </div>

          {online ? (
            <form
              onSubmit={(e) => { e.preventDefault(); ask(draft); }}
              className="flex items-center gap-2 p-3 border-t border-white/10"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={500}
                placeholder="כתבו שאלה…"
                enterKeyHint="send"
                className="flex-1 min-w-0 bg-white/10 text-white text-sm placeholder:text-zinc-300 rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-sky-400"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label="שלח"
                className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl bg-sky-500 text-white disabled:opacity-50"
              >
                <Send size={18} className="-scale-x-100" />
              </button>
            </form>
          ) : (
            <p className="flex items-center gap-2 p-3 border-t border-white/10 text-amber-200 text-sm">
              <WifiOff size={16} className="shrink-0" />
              צריך חיבור לאינטרנט. ההסברים זמינים גם בלי קליטה ב״מדריכים ומידע נוסף״ בהגדרות.
            </p>
          )}
        </div>
      )}
    </>
  );
}
