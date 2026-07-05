import { useState, useEffect } from "react";
import { X, Sparkles } from "lucide-react";
import { AI_PROVIDER_STORAGE_KEY } from "../hooks/useAIGuide";

interface SettingsPanelProps {
  onClose: () => void;
}

const PROVIDER_LABELS: Record<string, { name: string; desc: string }> = {
  auto: { name: "אוטומטי", desc: "המערכת בוחרת לפי המפתחות המוגדרים בשרת" },
  openai: { name: "OpenAI (ChatGPT)", desc: "טקסט + קול איכותי (מומלץ)" },
  gemini: { name: "Google Gemini", desc: "טקסט + קול של גוגל" },
  claude: { name: "Claude (Anthropic)", desc: "טקסט בלבד — הקול יגיע מ-OpenAI/Gemini או מהדפדפן" },
};

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [selected, setSelected] = useState<string>("auto");
  const [available, setAvailable] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    setSelected(localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "auto");
    fetch("/api/tour-guide")
      .then((r) => r.json())
      .then((d) => setAvailable(d.providers))
      .catch(() => setAvailable(null));
  }, []);

  const choose = (key: string) => {
    setSelected(key);
    if (key === "auto") localStorage.removeItem(AI_PROVIDER_STORAGE_KEY);
    else localStorage.setItem(AI_PROVIDER_STORAGE_KEY, key);
  };

  const noneConfigured = available && !available.openai && !available.gemini && !available.claude;

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-3xl p-6 w-full max-w-md shadow-2xl"
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
      </div>
    </div>
  );
}
