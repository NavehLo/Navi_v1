import { X, Play, Headphones, Download, Trash2, Loader2, CloudOff, Map as MapIcon } from "lucide-react";
import { TrailData, TrailPOI } from "../hooks/useTrailData";
import { PoiSource } from "../hooks/useTrailPOIs";
import type { OfflinePhase } from "../hooks/useOfflineTrail";
import { isIOS, isStandaloneDisplay, type MapPack, type MapPackProgress, type PackEstimate } from "../lib/offlineMap";

// Answers, directly, the question "how many narrations are there and where?".
// Until now the only way to find out was to run the tour and count.

export type PointOfflineState = "missing" | "saved";

export interface OfflineControls {
  savedCount: number;
  // Narrations, not points: two points can share one. Counting points made a
  // complete download read as "6 of 8".
  total: number;
  status: "idle" | "downloading" | "done" | "error";
  // Which half is downloading right now.
  phase: OfflinePhase;
  message: string | null;
  progress: { done: number; total: number; bytes: number };
  // The map along the trail, saved on the device (see lib/offlineMap).
  mapPack: MapPack | null;
  mapProgress: MapPackProgress;
  estimate: PackEstimate | null;
  mapDaysLeft: number | null;
  mapExpired: boolean;
  online: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

const BIG_PACK_BYTES = 100 * 1024 * 1024;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" });
}

interface GuidePointsPanelProps {
  trail: TrailData;
  pois: TrailPOI[];
  onClose: () => void;
  onPlay: (poi: TrailPOI) => void;
  // Filled in by the offline downloader; without it every point simply shows
  // as "plays in the field".
  offlineStateFor?: (poi: TrailPOI) => PointOfflineState;
  offline?: OfflineControls;
  // Where this list came from. Discovery through OpenStreetMap fails often
  // enough — it is a free, throttled public service — that a short list needs
  // to say whether it is the trail's real one or all that could be had.
  poiSource?: PoiSource;
  poiDiscoveryFailed?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function GuidePointsPanel({
  trail,
  pois,
  onClose,
  onPlay,
  offlineStateFor,
  offline,
  poiSource = "live",
  poiDiscoveryFailed = false,
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
          {pois.length} נקודות במסלול הזה שיש עליהן מידע ייחודי. כשהמדריכה מופעלת היא מקריינת
          אותן בהגעה לכל נקודה, ואפשר להשמיע כל אחת גם מכאן.
        </p>

        {/* A short list after a failed discovery is not the same as a short
            trail. Saying which one this is stops an OpenStreetMap outage from
            reading as "my points were deleted". */}
        {poiDiscoveryFailed && (
          <div className="mx-6 mb-3 shrink-0 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-300 text-[11px]">
            <CloudOff size={13} className="shrink-0 mt-0.5" />
            <span>
              {poiSource === "cache"
                ? "לא ניתן לרענן כרגע את נקודות העניין מ-OpenStreetMap — מוצגת הרשימה האחרונה שנשמרה במכשיר."
                : "לא ניתן לטעון כרגע את נקודות העניין מ-OpenStreetMap. הקריינויות שהורדו לא נמחקו — סגור ופתח את המסלול שוב בעוד רגע."}
            </span>
          </div>
        )}

        {/* Download the whole trail — narrations and map — for walking it
            with no reception. Shown for every trail: one with no guide points
            still needs its map. */}
        {offline && (() => {
          const o = offline;
          const downloading = o.status === "downloading";
          const hasNarrations = o.total > 0;
          const narrationsComplete = !hasNarrations || o.savedCount >= o.total;
          const mapReady = !!o.mapPack && !o.mapExpired;
          const allSaved = mapReady && narrationsComplete;
          const savedBytes = (o.mapPack?.bytes ?? 0) + o.progress.bytes;
          const iosHint = isIOS() && !isStandaloneDisplay();

          const download = () => {
            if (o.estimate && o.estimate.bytes > BIG_PACK_BYTES && !o.mapPack) {
              const ok = window.confirm(
                `המפה של המסלול הזה שוקלת בערך ${formatBytes(o.estimate.bytes)}. להוריד? עדיף דרך Wi-Fi.`
              );
              if (!ok) return;
            }
            o.onDownload();
          };

          const label = downloading
            ? o.phase === "map"
              ? `מפה ${o.mapProgress.done}/${o.mapProgress.total} · ${formatBytes(o.mapProgress.bytes)}`
              : `קריינות ${o.progress.done}/${o.progress.total} · ${formatBytes(o.progress.bytes)}`
            : o.mapExpired
              ? "הורד שוב — פג תוקף"
              : allSaved
                ? "רענן הורדה"
                : `הורד מסלול לשטח${o.estimate ? ` (~${formatBytes(o.estimate.bytes)})` : ""}`;

          return (
            <div className="px-6 pb-4 shrink-0">
              <div className="flex gap-2">
                <button
                  onClick={download}
                  disabled={downloading || !o.online}
                  title={!o.online ? "אין קליטה — ההורדה צריכה חיבור" : undefined}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 text-sky-300 font-bold text-xs py-2.5 px-3 hover:bg-sky-500/20 transition-colors disabled:opacity-60"
                >
                  {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {label}
                </button>
                {downloading && (
                  <button
                    onClick={o.onCancel}
                    title="עצור את ההורדה"
                    className="shrink-0 rounded-xl border border-white/10 text-zinc-400 hover:text-white hover:bg-white/5 py-2.5 px-3 transition-colors"
                  >
                    <X size={14} />
                  </button>
                )}
                {!downloading && (o.savedCount > 0 || o.mapPack) && (
                  <button
                    onClick={o.onDelete}
                    title="מחק את ההורדה ופנה מקום"
                    className="shrink-0 rounded-xl border border-white/10 text-zinc-400 hover:text-red-400 hover:bg-white/5 py-2.5 px-3 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {!downloading && o.mapPack && (
                <div className={`text-[11px] mt-2 flex items-start gap-1.5 ${o.mapExpired || (o.mapDaysLeft !== null && o.mapDaysLeft <= 5) ? "text-amber-400" : "text-zinc-500"}`}>
                  <MapIcon size={12} className="shrink-0 mt-0.5" />
                  <span>
                    {o.mapExpired
                      ? "המפה פגה (30 יום) ולא תוצג בלי קליטה — הורד שוב לפני היציאה לשטח."
                      : `מפה${hasNarrations ? ` ו-${o.savedCount} מתוך ${o.total} קריינויות` : ""} שמורות במכשיר · ${formatBytes(savedBytes)} · בתוקף עד ${formatDate(o.mapPack.expiresAt)} (עוד ${o.mapDaysLeft} ימים)`}
                    {o.mapPack.trimmed && !o.mapExpired ? ` · מסלול ארוך — נשמר עד zoom ${o.mapPack.maxZoom}` : ""}
                  </span>
                </div>
              )}
              {!downloading && !o.mapPack && o.savedCount > 0 && (
                <div className="text-zinc-500 text-[11px] mt-2">
                  {o.savedCount} מתוך {o.total} קריינויות שמורות במכשיר
                  {o.progress.bytes > 0 ? ` · ${formatBytes(o.progress.bytes)}` : ""} · המפה עדיין לא הורדה
                </div>
              )}
              {!downloading && !o.mapPack && o.savedCount === 0 && (
                <div className="text-zinc-500 text-[11px] mt-2">
                  שומר במכשיר את המפה לאורך המסלול{hasNarrations ? " ואת הקריינות" : ""}, ל-30 יום. אחרי זה צריך להוריד שוב.
                </div>
              )}
              {iosHint && (
                <div className="text-zinc-500 text-[11px] mt-1">
                  באייפון: כדי שההורדה תישאר, הוסף את Navi למסך הבית (שיתוף ← הוסף למסך הבית) ופתח משם.
                </div>
              )}
              {o.message && (
                <div className="text-amber-400 text-[11px] mt-2">{o.message}</div>
              )}
            </div>
          );
        })()}

        <div className="overflow-y-auto px-6 pb-6 flex flex-col gap-2">
          {pois.length === 0 && (
            <div className="text-zinc-500 text-sm text-center py-6 leading-relaxed">
              {poiSource === "pending" && !poiDiscoveryFailed
                ? "מחפשת נקודות במסלול..."
                : "לא נמצאו במסלול הזה נקודות שיש עליהן מידע ייחודי, ולכן למדריכה אין מה לספר כאן."}
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
                    {poi.name || poi.type}
                  </div>
                  <div className="text-zinc-500 text-[11px]">
                    {poi.name ? `${poi.type} · ` : ""}
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
