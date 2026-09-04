import { useState, useEffect, useRef } from "react";
import { X, Sparkles, Volume2, Loader2, RotateCcw } from "lucide-react";
import { AI_PROVIDER_STORAGE_KEY } from "../hooks/useAIGuide";
import { type VoicePrefs, readVoicePrefs, writeVoicePrefs } from "../lib/voicePrefs";

interface SettingsPanelProps {
  onClose: () => void;
}

// These choose who *writes* the narration. The voice is a separate decision
// entirely — see the section below — and saying otherwise here was misleading:
// when ElevenLabs is configured it speaks every narration, whichever model
// wrote it.
const PROVIDER_LABELS: Record<string, { name: string; desc: string }> = {
  auto: { name: "אוטומטי", desc: "המערכת בוחרת לפי המפתחות המוגדרים בשרת" },
  openai: { name: "OpenAI (ChatGPT)", desc: "כותב את הטקסט" },
  gemini: { name: "Google Gemini", desc: "כותב את הטקסט" },
  claude: { name: "Claude (Anthropic)", desc: "כותב את הטקסט" },
};

interface TtsInfo {
  provider: "elevenlabs" | "openai" | "gemini";
  model: string;
  voiceId: string | null;
  tunable: boolean;
}

const TTS_LABEL: Record<string, string> = {
  elevenlabs: "ElevenLabs",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

// The dials the ElevenLabs Voice Library exposes. Its preview plays each voice
// with that voice's own saved settings, which is why a voice can sound
// different in the app than it did on the site until these match.
const VOICE_SLIDERS: Array<{ key: keyof VoicePrefs; label: string; hint: string; min: number; max: number; step: number; fallback: number }> = [
  { key: "stability", label: "יציבות", hint: "נמוך = יותר הבעה ושונות; גבוה = אחיד וצפוי", min: 0, max: 1, step: 0.05, fallback: 0.5 },
  { key: "similarityBoost", label: "דמיון למקור", hint: "כמה להיצמד לקול המקורי", min: 0, max: 1, step: 0.05, fallback: 0.75 },
  { key: "style", label: "סגנון", hint: "הגזמה רגשית. גבוה פוגע ביציבות", min: 0, max: 1, step: 0.05, fallback: 0 },
  { key: "speed", label: "קצב", hint: "1.0 הוא הקצב הטבעי", min: 0.7, max: 1.2, step: 0.05, fallback: 1 },
];

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [selected, setSelected] = useState<string>("auto");
  const [available, setAvailable] = useState<Record<string, boolean> | null>(null);
  const [tts, setTts] = useState<TtsInfo | null | undefined>(undefined);

  const [voice, setVoice] = useState<VoicePrefs>({});
  const [testState, setTestState] = useState<"idle" | "loading" | "error">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setSelected(localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "auto");
    setVoice(readVoicePrefs() ?? {});
    fetch("/api/tour-guide")
      .then((r) => r.json())
      .then((d) => { setAvailable(d.providers); setTts(d.tts ?? null); })
      .catch(() => { setAvailable(null); setTts(undefined); });
  }, []);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const updateVoice = (patch: Partial<VoicePrefs>) => {
    setVoice((prev) => {
      const next = { ...prev, ...patch };
      for (const k of Object.keys(next) as (keyof VoicePrefs)[]) {
        if (next[k] === undefined || next[k] === "") delete next[k];
      }
      writeVoicePrefs(next);
      return next;
    });
  };

  const resetVoice = () => {
    writeVoicePrefs(null);
    setVoice({});
    setTestMessage(null);
    setTestState("idle");
  };

  // Plays one fixed Hebrew sentence with the current settings. The sample text
  // never changes, so re-hearing a voice already tried costs nothing.
  const testVoice = async () => {
    setTestState("loading");
    setTestMessage(null);
    try {
      const res = await fetch("/api/tour-guide/voice-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: Object.keys(voice).length > 0 ? voice : undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.audio) {
        setTestState("error");
        // data.detail is ElevenLabs' own wording. Showing it verbatim is the
        // whole point — the previous generic message hid the one fact needed
        // to tell a rejected setting from an expired key.
        setTestMessage([data.error, data.detail].filter(Boolean).join(" "));
        return;
      }
      const bytes = atob(data.audio);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const url = URL.createObjectURL(
        new Blob([buf], { type: data.audioFormat === "wav" ? "audio/wav" : "audio/mpeg" })
      );
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.pause();
      audioRef.current.onended = audioRef.current.onerror = () => URL.revokeObjectURL(url);
      audioRef.current.src = url;
      await audioRef.current.play();
      setTestState("idle");
      const from = TTS_LABEL[data.provider] || data.provider;
      const cached = data.cached ? " (מה-cache — לא נצרכו קרדיטים)" : "";
      // A degraded request means some of the settings below were dropped to get
      // a response at all; saying so beats letting them look effective.
      const degraded =
        data.degraded === "basic"
          ? " המודל לא קיבל את הסגנון והקצב, והיציבות עוגלה לערך הקרוב מבין 0 / 0.5 / 1."
          : data.degraded === "bare"
            ? " המודל לא קיבל אף אחת מההגדרות, והושמע עם ברירות המחדל של הקול."
            : "";
      setTestMessage(`הושמע מ-${from}${cached}.${degraded}`);
    } catch (e: any) {
      setTestState("error");
      setTestMessage(e?.message || "ייצור הקול נכשל.");
    }
  };

  const choose = (key: string) => {
    setSelected(key);
    if (key === "auto") localStorage.removeItem(AI_PROVIDER_STORAGE_KEY);
    else localStorage.setItem(AI_PROVIDER_STORAGE_KEY, key);
  };

  const noneConfigured = available && !available.openai && !available.gemini && !available.claude;

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl max-h-[85vh] overflow-y-auto"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-5">
          <h2 className="text-white font-extrabold text-lg flex items-center gap-2">
            <Sparkles className="text-orange-500" size={20} />
            הגדרות
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-1">
            <X size={20} />
          </button>
        </div>

        <h3 className="text-zinc-300 font-bold text-sm mb-1">ספק הבינה המלאכותית של המדריך</h3>
        <p className="text-zinc-500 text-xs mb-4">
          הבחירה נשמרת במכשיר הזה. מוצגים רק ספקים שהוגדר להם מפתח בשרת.
        </p>

        {noneConfigured && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs mb-4">
            לא הוגדר אף מפתח AI בשרת — המדריך יעבוד במצב הדגמה עם קול הדפדפן.
          </div>
        )}

        <div className="flex flex-col gap-2">
          {Object.entries(PROVIDER_LABELS).map(([key, info]) => {
            const isConfigured = key === "auto" || !available || available[key];
            if (key !== "auto" && available && !available[key]) return null;
            return (
              <button
                key={key}
                onClick={() => choose(key)}
                disabled={!isConfigured}
                className={`text-right p-3.5 rounded-2xl border transition-all ${
                  selected === key
                    ? "bg-orange-500/15 border-orange-500/60"
                    : "bg-white/5 border-white/10 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`font-bold text-sm ${selected === key ? "text-orange-400" : "text-white"}`}>
                    {info.name}
                  </span>
                  {selected === key && (
                    <span className="text-[10px] font-bold text-orange-400 bg-orange-500/20 px-2 py-0.5 rounded-full">
                      פעיל
                    </span>
                  )}
                </div>
                <p className="text-zinc-400 text-xs mt-1">{info.desc}</p>
              </button>
            );
          })}
        </div>

        {/* Voice — changeable here so trying one needs no redeploy */}
        <h3 className="text-zinc-300 font-bold text-sm mt-6 mb-1 flex items-center gap-2">
          <Volume2 size={15} className="text-emerald-400" />
          הקול של המדריכה
        </h3>

        {/* Which voice is actually speaking. Without this the fallback to
            OpenAI/Gemini is invisible: the sliders below simply stop having
            any effect and nothing says why. */}
        {tts === undefined ? (
          <p className="text-zinc-500 text-xs mb-3">בודק איזה קול פעיל…</p>
        ) : tts === null ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs mb-3">
            אין ספק קול בשרת — הקריינות תוקרא בקול של הדפדפן. ההגדרות למטה לא
            ישפיעו עד שיוגדר <span dir="ltr">ELEVENLABS_API_KEY</span>.
          </div>
        ) : tts.provider === "elevenlabs" ? (
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-xs mb-3">
            <div className="text-emerald-300 font-bold">הקול מגיע מ-ElevenLabs</div>
            <div className="text-zinc-400 mt-0.5" dir="ltr">
              {tts.model} · {tts.voiceId}
            </div>
          </div>
        ) : (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs mb-3">
            <div className="font-bold">
              הקול מגיע מ-{TTS_LABEL[tts.provider] || tts.provider}, לא מ-ElevenLabs.
            </div>
            <div className="mt-1 text-amber-200/80">
              ההגדרות למטה חלות על ElevenLabs בלבד, ולכן לא ישנו כלום כרגע. בדוק
              ש-<span dir="ltr">ELEVENLABS_API_KEY</span> ו-
              <span dir="ltr">ELEVENLABS_VOICE_ID</span> מוגדרים ב-Vercel, ושבוצע
              Redeploy אחרי ההוספה.
            </div>
          </div>
        )}

        <p className="text-zinc-500 text-xs mb-3">
          הבחירה נשמרת במכשיר הזה בלבד ואינה משנה את הגדרת השרת. השאר ריק כדי
          להשתמש בקול שמוגדר ב-Vercel.
        </p>

        <label className="block text-zinc-400 text-[11px] font-bold mb-1">
          מזהה קול (Voice ID)
        </label>
        <input
          type="text"
          value={voice.id ?? ""}
          onChange={(e) => updateVoice({ id: e.target.value.trim() || undefined })}
          placeholder="ברירת המחדל של השרת"
          dir="ltr"
          className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-white text-xs placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500 mb-3"
          autoComplete="off"
          spellCheck={false}
        />

        <div className="flex flex-col gap-3">
          {VOICE_SLIDERS.map((slider) => {
            const value = (voice[slider.key] as number | undefined) ?? slider.fallback;
            return (
              <div key={slider.key}>
                <div className="flex justify-between items-baseline">
                  <span className="text-zinc-400 text-[11px] font-bold">{slider.label}</span>
                  <span className="text-zinc-500 text-[11px] tabular-nums">{value.toFixed(2)}</span>
                </div>
                {/* dir=ltr: inside the RTL panel a range input renders
                    mirrored, so the handle sat opposite its own number. */}
                <input
                  dir="ltr"
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={value}
                  onChange={(e) => updateVoice({ [slider.key]: parseFloat(e.target.value) } as Partial<VoicePrefs>)}
                  className="w-full accent-emerald-500"
                />
                <p className="text-zinc-600 text-[10px]">{slider.hint}</p>
              </div>
            );
          })}
        </div>

        {/* Niqqud. A toggle rather than a setting, so it can be A/B'd against
            the sample sentence in two clicks. */}
        <label className="flex items-start gap-2 mt-4 cursor-pointer">
          <input
            type="checkbox"
            checked={voice.niqqud !== false}
            onChange={(e) => updateVoice({ niqqud: e.target.checked ? undefined : false })}
            className="mt-0.5 accent-emerald-500"
          />
          <span>
            <span className="text-zinc-300 text-xs font-bold">ניקוד שמות גיאוגרפיים</span>
            <span className="block text-zinc-600 text-[10px]">
              מנקד נחל, עין, חורבת וכדומה לפני ההקראה, כדי למנוע &quot;עַיִן&quot; במקום
              &quot;עֵין&quot;. שמות פרטיים נשארים ללא ניקוד בכוונה.
            </span>
          </span>
        </label>

        <div className="flex gap-2 mt-4">
          <button
            onClick={testVoice}
            disabled={testState === "loading"}
            className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 font-bold text-xs py-2.5 hover:bg-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {testState === "loading" ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
            השמע משפט לדוגמה
          </button>
          <button
            onClick={resetVoice}
            title="חזור להגדרת השרת"
            className="shrink-0 rounded-xl border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 py-2.5 px-3 transition-colors"
          >
            <RotateCcw size={14} />
          </button>
        </div>

        {testMessage && (
          <p
            className={`text-[11px] mt-2 break-words ${testState === "error" ? "text-red-400" : "text-zinc-500"}`}
            dir="auto"
          >
            {testMessage}
          </p>
        )}
      </div>
    </div>
  );
}
