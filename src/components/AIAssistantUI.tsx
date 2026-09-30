import { Volume2, Loader2, StopCircle, X, Smartphone, ChevronUp, ChevronDown, Minus, MessageSquareText, Headphones, HeadphoneOff, RotateCw, CloudOff, AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type PlayingVoice } from "../hooks/useAIGuide";
import { voiceNameFor } from "../lib/voicePrefs";

const PROVIDER_LABEL: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  gemini: "Gemini",
};

interface AIAssistantUIProps {
  isLoading: boolean;
  isSpeaking: boolean;
  currentScript: string | null;
  onStop: () => void;
  // The guide is opt-in per tour. When it is off, the idle pill is the way to
  // switch it on; when it is on, the same pill says so and switches it off.
  guideEnabled: boolean;
  onToggleGuide: () => void;
  // Whether this trail has anything for the guide to say. Without points the
  // pill would promise a narration that can never come.
  hasPoints: boolean;
  // Narrations waiting their turn. Points can be reached faster than they can
  // be spoken, so saying how many are queued explains why the guide is talking
  // about somewhere you have already walked past.
  queueLength?: number;
  // Which voice rendered the narration being played, as reported with the clip
  // itself. The settings panel can only say what the server would use next; the
  // question worth answering here is what was used *this time*, since a voice
  // change leaves earlier renderings in the caches untouched.
  voice?: PlayingVoice | null;
  // Played from the copy stored on the device rather than fetched. Worth saying
  // out loud: it is the one path where the audio predates the current settings.
  voiceFromDevice?: boolean;
  // Why the guide is silent, or not in the voice that was chosen. Shown in
  // place of the bare "browser voice" line, which said what was happening but
  // never why — and read as a settings note when it was in fact a failure.
  voiceNotice?: string | null;
}

// Lives inside the bottom stack, so it never sits on top of the tour controls
// the way the old floating card did. The transcript is the part that used to
// swallow a phone screen: it is clamped to two lines, opens to the full text on
// demand, and can be shut to a single pill that still shows the guide is talking.
export default function AIAssistantUI({
  isLoading,
  isSpeaking,
  currentScript,
  onStop,
  guideEnabled,
  onToggleGuide,
  hasPoints,
  queueLength = 0,
  voice = null,
  voiceFromDevice = false,
  voiceNotice = null,
}: AIAssistantUIProps) {
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);

  // Each new narration starts clamped again rather than inheriting the last
  // one's open state. Minimizing, being a deliberate choice, does stick.
  useEffect(() => {
    setExpanded(false);
  }, [currentScript]);

  const voiceName = voiceNameFor(voice?.voiceId);

  if (!isLoading && !currentScript) {
    // Nothing to narrate: said by a small icon beside the tour button (see
    // NoGuidePointsHint) rather than a pill here, which sat on the trail card.
    if (!hasPoints) return null;
    return guideEnabled ? (
      <button
        onClick={onToggleGuide}
        aria-pressed
        title="המדריכה תקריין אוטומטית בהגעה לכל נקודה — לחץ לכיבוי"
        className="pointer-events-auto bg-zinc-900/90 text-emerald-400 shadow-xl rounded-full px-3.5 py-2 flex items-center gap-1.5 backdrop-blur-md transition-all border border-emerald-500/40 hover:border-emerald-400"
        dir="rtl"
      >
        <Headphones className="w-4 h-4" />
        <span className="text-xs font-bold">מדריכה פעילה</span>
      </button>
    ) : (
      <button
        onClick={onToggleGuide}
        aria-pressed={false}
        title="המדריכה כבויה ולא תקריין מעצמה — לחץ להפעלה לסיור הזה"
        className="pointer-events-auto bg-emerald-500/90 hover:bg-emerald-500 text-white shadow-xl rounded-full px-3.5 py-2 flex items-center gap-1.5 backdrop-blur-md transition-all border border-emerald-400/30"
        dir="rtl"
      >
        <Volume2 className="w-4 h-4" />
        <span className="text-xs font-bold">הפעל מדריכה</span>
      </button>
    );
  }

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="pointer-events-auto bg-zinc-900/95 border border-emerald-500/40 shadow-xl rounded-full px-3.5 py-2 flex items-center gap-2 backdrop-blur-md"
        dir="rtl"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
        ) : (
          <MessageSquareText className="w-4 h-4 text-emerald-400" />
        )}
        <span className="text-xs font-bold text-emerald-400">
          {isLoading ? "המדריכה חושבת..." : isSpeaking ? "המדריכה מדברת" : "הצג קריינות"}
          {queueLength > 0 && <span className="text-emerald-600 font-normal"> · עוד {queueLength}</span>}
        </span>
      </button>
    );
  }

  return (
    <div className="pointer-events-auto w-full max-w-lg" dir="rtl">
      <div className="bg-zinc-900/95 backdrop-blur-xl border border-emerald-500/30 shadow-2xl rounded-2xl px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0 mt-0.5">
            {isLoading ? (
              <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
            ) : (
              <Volume2 className="w-4 h-4 text-emerald-400 animate-pulse" />
            )}
          </div>

          <p
            className={`flex-1 min-w-0 text-white text-[13px] leading-snug ${
              expanded ? "max-h-40 overflow-y-auto" : "line-clamp-2"
            }`}
          >
            {isLoading ? "חושבת ומנתחת את הסביבה..." : currentScript}
          </p>

          <div className="flex items-center gap-0.5 shrink-0">
            {!isLoading && currentScript && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-zinc-500 hover:text-white transition-colors p-1"
                title={expanded ? "צמצם טקסט" : "הצג את כל הטקסט"}
              >
                {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              </button>
            )}
            {isSpeaking ? (
              <button onClick={onStop} className="text-zinc-500 hover:text-red-400 transition-colors p-1" title="עצור קריינות">
                <StopCircle className="w-5 h-5" />
              </button>
            ) : (
              <button onClick={onStop} className="text-zinc-500 hover:text-white transition-colors p-1" title="סגור">
                <X className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setMinimized(true)}
              className="text-zinc-500 hover:text-white transition-colors p-1"
              title="כווץ לפס קטן"
            >
              <Minus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Who is actually speaking, and how deep the queue is. Without it there
            is no way, from inside the app, to tell the voice you just chose from
            the one it replaced. */}
        {!isLoading && (
          <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center gap-1.5 text-xs text-white/70">
            {voiceFromDevice && <Smartphone size={12} className="shrink-0" />}
            {voice ? (
              <span className="truncate">
                <span className="text-white">{voiceName ?? PROVIDER_LABEL[voice.provider] ?? voice.provider}</span>
                {voiceName && <span> · {PROVIDER_LABEL[voice.provider] ?? voice.provider}</span>}
                {voiceFromDevice && <span> · מהמכשיר</span>}
              </span>
            ) : (
              <span className="text-amber-300 truncate">קול הדפדפן — לא נוצר קול בשרת</span>
            )}
            {queueLength > 0 && <span className="shrink-0 mr-auto">· עוד {queueLength} בתור</span>}
          </div>
        )}

        {/* The actual reason, when there is one. Without it the line above is
            a description of a symptom: "browser voice" told the walker what
            was happening but never that a voice had been refused, or that the
            phone has no Hebrew voice to read with at all. */}
        {!isLoading && voiceNotice && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-amber-500/15 border border-amber-400/30 px-2 py-1.5 text-xs text-amber-100 leading-relaxed">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>{voiceNotice}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Why the guide has nothing to offer on this trail, as an icon the size of a
// button. Tapped, it says so in a bubble that goes away by itself — the
// full-width pill that used to say it permanently sat on top of the trail card.
//
// Which of the three things it says matters. OpenStreetMap's public service
// answers one request and returns a gateway error for the next, so an empty
// list is very often an outage rather than a fact about the trail; saying
// "nothing worth hearing here" about Yehiam fortress, which has a Wikipedia
// article of its own, is simply wrong. A failure says so and offers to ask
// again.
export function NoGuidePointsHint({
  state,
  onRetry,
}: {
  state: 'searching' | 'failed' | 'empty' | 'skipped';
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = () => {
    setOpen(true);
    if (timer.current) clearTimeout(timer.current);
    // A message with a button in it must not vanish while it is being reached
    // for; only the two that are purely informational time out.
    if (state !== 'failed') timer.current = setTimeout(() => setOpen(false), 3500);
  };

  const label =
    state === 'searching'
      ? 'מחפשת נקודות למדריכה במסלול'
      : state === 'failed'
        ? 'לא הצלחתי לטעון את נקודות המדריכה'
        : state === 'skipped'
          ? 'המסלול ארוך מדי לחיפוש נקודות'
          : 'אין נקודות למדריכה במסלול';

  return (
    <div className="pointer-events-auto relative" dir="rtl">
      <button
        onClick={show}
        aria-label={label}
        title={label}
        className={`w-10 h-10 flex items-center justify-center rounded-full border backdrop-blur-md shadow-xl ${
          state === 'failed'
            ? 'bg-amber-500/20 text-amber-300 border-amber-400/40'
            : 'bg-zinc-900/90 text-white border-white/10'
        }`}
      >
        {state === 'searching' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : state === 'failed' ? (
          <CloudOff className="w-4 h-4" />
        ) : (
          <HeadphoneOff className="w-4 h-4" />
        )}
      </button>
      {open && (
        <div role="tooltip" className="absolute bottom-full mb-2 right-0 w-60 bg-zinc-900 text-white text-xs leading-relaxed rounded-xl border border-white/15 shadow-2xl px-3 py-2.5">
          {state === 'searching' && 'מחפשת במסלול מקומות שיש עליהם מידע ייחודי...'}
          {state === 'empty' && 'אין נקודות למדריכה במסלול — לא נמצאו בו מקומות שיש עליהם מידע ייחודי.'}
          {state === 'skipped' && 'המסלול ארוך מכדי לחפש בו נקודות עניין, ולכן לא חיפשתי. זה לא אומר שאין בו מה לספר.'}
          {state === 'failed' && (
            <>
              <div>לא הצלחתי לטעון את נקודות המדריכה מ-OpenStreetMap. זו תקלה זמנית בשירות, לא סימן שאין במסלול מה לספר.</div>
              {onRetry && (
                <button
                  onClick={() => { setOpen(false); onRetry(); }}
                  className="mt-2 w-full flex items-center justify-center gap-1.5 bg-amber-500/20 text-amber-200 font-bold rounded-lg py-1.5 border border-amber-400/40 hover:bg-amber-500/30 transition-colors"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  נסה שוב
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
