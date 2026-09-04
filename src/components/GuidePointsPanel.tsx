import { X, Play, Headphones } from "lucide-react";
import { TrailData, TrailPOI } from "../hooks/useTrailData";

// Answers, directly, the question "how many narrations are there and where?".
// Until now the only way to find out was to run the tour and count.

const TYPE_LABEL: Record<string, string> = {
  start: "נקודת פתיחה",
  midway: "אמצע המסלול",
  end: "נקודת סיום",
};

export type PointOfflineState = "missing" | "saved";

interface GuidePointsPanelProps {
  trail: TrailData;
  pois: TrailPOI[];
  onClose: () => void;
  onPlay: (poi: TrailPOI) => void;
  // Filled in by the offline downloader; without it every point simply shows
  // as "plays in the field".
  offlineStateFor?: (poi: TrailPOI) => PointOfflineState;
}

export default function GuidePointsPanel({
  trail,
  pois,
  onClose,
  onPlay,
  offlineStateFor,
}: GuidePointsPanelProps) {
  const acc = trail.accumulatedDistances;

  return (
    <div
      className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]"
        dir="rtl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center p-6 pb-4 shrink-0">
          <h2 className="text-white font-extrabold text-lg flex items-center gap-2">
            <Headphones className="text-emerald-400" size={20} />
            נקודות המדריכה
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors p-1">
            <X size={20} />
          </button>
        </div>

        <p className="text-zinc-500 text-xs px-6 pb-3 shrink-0">
          {pois.length} נקודות קריינות במסלול הזה. הקריינות תופעל אוטומטית בהגעה לכל נקודה,
          ואפשר להשמיע כל אחת גם מכאן.
        </p>

        <div className="overflow-y-auto px-6 pb-6 flex flex-col gap-2">
          {pois.length === 0 && (
            <div className="text-zinc-500 text-sm text-center py-6">
              עדיין לא נמצאו נקודות במסלול הזה.
            </div>
          )}

          {pois.map((poi) => {
            const km = acc[poi.index] ?? 0;
            const state = offlineStateFor?.(poi);
            return (
              <div
                key={`${poi.index}:${poi.type}`}
                className="flex items-center gap-3 bg-white/5 border border-white/5 rounded-xl p-3"
              >
                <button
                  onClick={() => onPlay(poi)}
                  title="השמע קריינות"
                  className="shrink-0 w-9 h-9 rounded-full bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors flex items-center justify-center"
                >
                  <Play size={15} />
                </button>

                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-bold truncate">
                    {poi.name || TYPE_LABEL[poi.type] || poi.type}
                  </div>
                  <div className="text-zinc-500 text-[11px]">
                    {poi.name ? `${TYPE_LABEL[poi.type] || poi.type} · ` : ""}
                    ק״מ {km.toFixed(1)}
                  </div>
                </div>

                <div className="shrink-0 text-[11px] font-bold">
                  {state === "saved" ? (
                    <span className="text-sky-400" title="שמור לשימוש בלי קליטה">✓ אופליין</span>
                  ) : state === "missing" ? (
                    <span className="text-zinc-500" title="עדיין לא הורד למכשיר">⬇ להורדה</span>
                  ) : (
                    <span className="text-zinc-600" title="ינוגן אוטומטית בהגעה לנקודה">● בשטח</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
