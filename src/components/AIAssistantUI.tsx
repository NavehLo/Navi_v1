import { Volume2, Loader2, StopCircle, X, Smartphone, ChevronUp, ChevronDown, Minus, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
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
  onManualTrigger: () => void;
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
  onManualTrigger,
  queueLength = 0,
  voice = null,
  voiceFromDevice = false,
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
    return (
      <button
        onClick={onManualTrigger}
        className="pointer-events-auto bg-emerald-500/90 hover:bg-emerald-500 text-white shadow-xl rounded-full px-3.5 py-2 flex items-center gap-1.5 backdrop-blur-md transition-all border border-emerald-400/30"
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
          <div className="mt-1.5 pt-1.5 border-t border-white/10 flex items-center gap-1.5 text-[10px] text-zinc-500">
            {voiceFromDevice && <Smartphone size={10} className="shrink-0" />}
            {voice ? (
              <span className="truncate">
                <span className="text-zinc-400">{voiceName ?? PROVIDER_LABEL[voice.provider] ?? voice.provider}</span>
                {voiceName && <span> · {PROVIDER_LABEL[voice.provider] ?? voice.provider}</span>}
                {voiceFromDevice && <span> · מהמכשיר</span>}
              </span>
            ) : (
              <span className="text-amber-400/90 truncate">קול הדפדפן — לא נוצר קול בשרת</span>
            )}
            {queueLength > 0 && <span className="shrink-0 mr-auto">· עוד {queueLength} בתור</span>}
          </div>
        )}
      </div>
    </div>
  );
}
