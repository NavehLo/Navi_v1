import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type mapboxgl from "mapbox-gl";
import { Pause, Play, Square, Loader2, Trash2, Undo2, Save, ChevronDown, ChevronUp } from "lucide-react";
import { useOutsideTap } from "../hooks/useOutsideTap";
import { defaultRecordingName, type Recorder } from "../hooks/useRecorder";
import { formatClock, formatPace } from "../lib/recording/stats";
import { EFFORT_LABELS } from "../lib/hikeEffort";
import type { RecStats } from "../lib/recording/types";

// The walk being recorded: a red line on the map behind the walker, a bar
// with the clock and the distance, and — tapped open — all the numbers.
// "סיים" opens the summary, where the walk is named and saved (or not).
//
// Sits at the top, under the place search: the bottom of a phone screen
// already holds the trail card and the trail list.

const SRC = "rec-track";
const LAYERS = ["rec-line-casing", "rec-line"];

function RecordingLine({ map, segments, styleRev }: { map: mapboxgl.Map; segments: { lat: number; lon: number }[][]; styleRev: number }) {
  const data = useMemo(() => ({
    type: "FeatureCollection",
    features: segments.filter((s) => s.length >= 2).map((s) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: s.map((p) => [p.lon, p.lat]) },
    })),
  }) as GeoJSON.FeatureCollection, [segments]);

  useEffect(() => {
    const sync = () => {
      if (!map.getStyle()) return;
      const src = map.getSource(SRC) as mapboxgl.GeoJSONSource | undefined;
      if (src) { src.setData(data); return; }
      map.addSource(SRC, { type: "geojson", data });
      // Under the walker's dot, over the trail.
      const before = map.getLayer("user-loc-dot") ? "user-loc-dot" : undefined;
      map.addLayer({
        id: "rec-line-casing", type: "line", source: SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#18181b", "line-width": 8, "line-opacity": 0.75 },
      }, before);
      map.addLayer({
        id: "rec-line", type: "line", source: SRC,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ef4444", "line-width": 4.5 },
      }, before);
    };
    try { sync(); } catch {}
    map.on("style.load", sync);
    return () => { map.off("style.load", sync); };
  }, [map, data, styleRev]);

  useEffect(() => () => {
    try {
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SRC)) map.removeSource(SRC);
    } catch {}
  }, [map]);

  return null;
}

function km(v: number) {
  return v < 10 ? v.toFixed(2) : v.toFixed(1);
}

// The numbers, as a grid — the open panel and the summary both use it.
export function RecStatsGrid({ stats, currentEle }: { stats: RecStats; currentEle?: number | null }) {
  // A clock reads left to right even on a Hebrew screen; the rest is Hebrew.
  const clock = (sec: number) => <span dir="ltr">{formatClock(sec)}</span>;
  const cells: [string, ReactNode, string?][] = [
    ["מרחק", `${km(stats.distanceKm)} ק״מ`, "text-yellow-300"],
    ["זמן הליכה", clock(stats.movingSec), "text-sky-300"],
    ["זמן כולל", clock(stats.totalSec)],
    ["עלייה", stats.gainM != null ? `${stats.gainM} מ׳` : "—", "text-emerald-300"],
    ["ירידה", stats.lossM != null ? `${stats.lossM} מ׳` : "—", "text-orange-300"],
  ];
  if (currentEle != null) cells.push(["גובה עכשיו", `${Math.round(currentEle)} מ׳`]);
  else if (stats.minEle != null && stats.maxEle != null) cells.push(["גובה", `${stats.minEle}–${stats.maxEle} מ׳`]);
  cells.push(["מהירות ממוצעת", stats.avgKmh != null ? `${stats.avgKmh} קמ״ש` : "—"]);
  const pace = formatPace(stats.paceMinPerKm);
  if (pace) cells.push(["קצב", pace]);
  if (stats.pausedSec >= 60) cells.push(["הפסקות", clock(stats.pausedSec)]);
  if (stats.effort) cells.push(["רמת מאמץ", EFFORT_LABELS[stats.effort]]);
  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map(([label, value, color]) => (
        <div key={label} className="bg-white/5 rounded-xl px-2 py-1.5 text-center">
          <div className="text-xs text-white">{label}</div>
          <div className={`text-sm font-bold ${color ?? "text-white"}`}>{value}</div>
        </div>
      ))}
    </div>
  );
}

export default function RecordPanel({
  map, rec, styleRev, openSignal, hidden, nativeApp, gpsOn, onSave,
}: {
  map: mapboxgl.Map;
  rec: Recorder;
  styleRev: number;
  // Bumped by the rail button: open the panel.
  openSignal: number;
  // "Hide all": the panel goes, the line stays (it is part of the map).
  hidden: boolean;
  nativeApp: boolean;
  gpsOn: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  useOutsideTap(panelRef, expanded && rec.status !== "review", () => setExpanded(false));
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (openSignal) setExpanded(true); }, [openSignal]);

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    // A fresh name for each summary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (rec.status === "review" && rec.startedAt) setName(defaultRecordingName(rec.startedAt));
  }, [rec.status, rec.startedAt]);

  const stats = rec.stats;
  const lastPoint = rec.segments.at(-1)?.at(-1) ?? null;
  const recording = rec.status === "recording";
  // No usable fix for a while: say so, rather than a clock running over a
  // distance that does not move.
  const waiting = recording && (!gpsOn || rec.lastFixAt == null || rec.now - rec.lastFixAt > 30_000);

  const save = async () => {
    setSaving(true);
    try { await onSave(name); } finally { setSaving(false); }
  };

  return (
    <>
      <RecordingLine map={map} segments={rec.segments} styleRev={styleRev} />

      {rec.status !== "review" && stats && (
        <div
          ref={panelRef}
          // Open on a phone it takes the full width and covers the rail, like
          // the other open panels; folded it sits beside the rail.
          className={`${hidden ? "hidden" : ""} absolute top-[112px] ${expanded ? "left-3 right-3 z-[45]" : "left-[124px] right-4 z-[44]"} md:top-[68px] md:left-20 md:right-[412px] md:max-w-md bg-zinc-900/95 border border-white/15 rounded-2xl shadow-2xl backdrop-blur-md text-white`}
          dir="rtl"
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <button onClick={() => setExpanded((v) => !v)} className="flex-1 min-w-0 flex items-center gap-2 text-right" aria-expanded={expanded}>
              <span className={`w-3 h-3 rounded-full shrink-0 ${recording ? "bg-red-500 animate-pulse" : "bg-amber-400"}`} />
              <span className="text-sm font-bold truncate">
                <span className="hidden sm:inline">{recording ? "מקליט" : "מושהה"} · </span><span dir="ltr">{formatClock(stats.totalSec)}</span> · <span className="text-yellow-300">{km(stats.distanceKm)} ק״מ</span>
              </span>
              {expanded ? <ChevronUp className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
            </button>
            {recording ? (
              <button onClick={rec.pause} className="p-2 rounded-xl bg-amber-500/20 text-amber-300 hover:bg-amber-500/30" aria-label="השהה הקלטה" title="השהה">
                <Pause className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={rec.resume} className="p-2 rounded-xl bg-red-500/20 text-red-300 hover:bg-red-500/30" aria-label="המשך הקלטה" title="המשך">
                <Play className="w-4 h-4" />
              </button>
            )}
            <button onClick={rec.finish} className="p-2 rounded-xl bg-white/10 text-white hover:bg-white/20" aria-label="סיים הקלטה" title="סיים">
              <Square className="w-4 h-4" />
            </button>
          </div>

          {expanded && (
            <div className="px-3 pb-3 flex flex-col gap-2">
              <RecStatsGrid stats={stats} currentEle={lastPoint?.ele ?? null} />
              {waiting && (
                <p className="text-sm text-amber-300">ממתין למיקום GPS מדויק…</p>
              )}
              {!recording && (
                <p className="text-sm text-amber-300">ההקלטה מושהית — המרחק והזמן לא נספרים. ״המשך״ ממשיך מהמקום שבו תהיו.</p>
              )}
              {!nativeApp && (
                <p className="text-xs text-white">בדפדפן ההקלטה נעצרת כשהמסך כבוי. באפליקציית האנדרואיד היא ממשיכה גם עם מסך כבוי.</p>
              )}
              <div className="flex gap-2">
                {recording ? (
                  <button onClick={rec.pause} className="flex-1 flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold text-sm py-2 rounded-xl">
                    <Pause className="w-4 h-4" /> השהה
                  </button>
                ) : (
                  <button onClick={rec.resume} className="flex-1 flex items-center justify-center gap-1.5 bg-red-500 hover:bg-red-400 text-white font-bold text-sm py-2 rounded-xl">
                    <Play className="w-4 h-4" /> המשך
                  </button>
                )}
                <button onClick={rec.finish} className="flex-1 flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 text-white font-bold text-sm py-2 rounded-xl">
                  <Square className="w-4 h-4" /> סיים
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The summary: name it and keep it, go back, or throw it away. */}
      {rec.status === "review" && stats && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900/95 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl p-5 flex flex-col gap-3 text-white" dir="rtl">
            <h2 className="font-extrabold text-base">סיכום ההליכה</h2>
            <RecStatsGrid stats={stats} />
            {rec.tooShort ? (
              <p className="text-sm text-amber-300">ההקלטה קצרה מדי לשמירה.</p>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-white">שם</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-zinc-800 border border-white/15 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-red-400"
                />
              </label>
            )}
            <div className="flex gap-2">
              {!rec.tooShort && (
                <button onClick={save} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 bg-red-500 hover:bg-red-400 disabled:opacity-60 text-white font-bold text-sm py-2.5 rounded-xl">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {saving ? "שומר…" : "שמור"}
                </button>
              )}
              <button onClick={rec.reopen} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 bg-white/10 hover:bg-white/20 text-white font-bold text-sm py-2.5 rounded-xl">
                <Undo2 className="w-4 h-4" /> חזרה להקלטה
              </button>
              <button
                onClick={() => { if (window.confirm("למחוק את ההקלטה? אי אפשר לשחזר אותה.")) rec.discard(); }}
                disabled={saving}
                className="px-3 flex items-center justify-center bg-white/5 hover:bg-red-500/30 text-red-300 rounded-xl"
                aria-label="מחק הקלטה"
                title="מחק"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {!rec.tooShort && <p className="text-xs text-white">ההקלטה נשמרת במכשיר, וכשמחוברים עם Google — גם בחשבון. היא פרטית: רק מי שתשלח לו קישור יראה אותה.</p>}
          </div>
        </div>
      )}
    </>
  );
}
