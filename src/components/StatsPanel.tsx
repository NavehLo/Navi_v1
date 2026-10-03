import { TrailData } from "../hooks/useTrailData";
import { SUN_MAX, SHADE_MIN, BAR_COLUMNS, type ShadeResult, type WaterResult } from "../lib/summerConditions";
import type { WaterStatus } from "../hooks/useSummerConditions";
import { ArrowRight, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Navigation, BookOpenText } from "lucide-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { computeElevationGain, sliceTrail } from "../utils/trailUtils";
import { formatDuration } from "./DrivePlanner";
import TripWeatherSection, { WeatherIcon } from "./TripWeatherSection";
import type { TripWeather } from "../hooks/useTripWeather";
import InfoButton from "./help/InfoButton";
import { useOutsideTap } from "../hooks/useOutsideTap";
import Collapsible from "./Collapsible";
import BestMonthsSection from "./BestMonthsSection";
import type { TrailClimate } from "../hooks/useTrailClimate";

// Sits above the bottom stack (narration card + tour bar) and starts collapsed
// on phones — expanded, this card alone used to cover a third of the screen.
// Where the walker is, from the live GPS, snapped onto the route.
export interface UserOnTrail {
  km: number;        // along the route
  offTrailM: number; // straight-line distance to it
  ele: number;       // elevation of the route at that point
}

// Past this the along-route figures stop meaning anything — the walker is
// somewhere else, not partway along this trail.
const ON_TRAIL_MAX_M = 300;

export default function StatsPanel({ trail, progress, onClose, isTourActive, shade, shadeLoading, water, waterStatus, userPos, weather, climate, waypoints, onShowInfo, inIsrael = false }: { trail: TrailData, progress: number, onClose?: () => void, isTourActive?: boolean, shade?: ShadeResult | null, shadeLoading?: boolean, water?: WaterResult | null, waterStatus?: WaterStatus, userPos?: UserOnTrail | null, weather?: TripWeather, climate?: TrailClimate, waypoints?: { label: string; km: number }[] | null, onShowInfo?: () => void, inIsrael?: boolean }) {
  const [collapsed, setCollapsed] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  // A drive has a road, a length and a time; none of the hiking readouts
  // (elevation, shade, water) mean anything for it.
  const isDrive = trail.kind === 'drive';

  // Sits right above whatever is at the bottom of the phone screen: the tour
  // transport, the guide's pill or its narration, and the tour progress bar
  // when a tour is under way. page.tsx measures those as they grow and shrink
  // (--bottom-stack-h, --progress-bar-h), so the card can never end up under
  // one of them — a fixed offset did, every time the guide started talking.
  const bottomOffset =
    "bottom-[calc(var(--bottom-stack-h,64px)_+_var(--progress-bar-h,0px)_+_8px)]";

  useEffect(() => {
    const isPhone = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    setCollapsed(!!isTourActive || isPhone);
  }, [isTourActive]);

  // Tapping the map puts the card away again. Expanded, it is deliberately
  // stacked above the control rails (see the z-index on the wrapper below), so
  // without this the buttons it covers would be unreachable — including the
  // one that collapses it.
  useOutsideTap(cardRef, !collapsed, () => setCollapsed(true));

  // Total climb and descent, with the usual 5 m hysteresis so GPS jitter does
  // not add up to a mountain. A flat profile means the file had no elevation.
  const climb = useMemo(
    () => (trail.maxEle > trail.minEle ? computeElevationGain(trail.elevations) : null),
    [trail]
  );

  const onTrail = !!userPos && userPos.offTrailM <= ON_TRAIL_MAX_M;

  // A measured walk's own points (א, ב, ג…): each leg as its own figures, and
  // how far it is to the next one.
  const legs = useMemo(() => {
    if (!waypoints || waypoints.length < 2) return null;
    return waypoints.slice(1).map((w, i) => {
      const from = waypoints[i];
      const eles = sliceTrail(trail.coords, trail.accumulatedDistances, from.km, w.km).map((c) => c[2] || 0);
      const hasEle = trail.maxEle > trail.minEle;
      return { from: from.label, to: w.label, km: w.km - from.km, climb: hasEle ? computeElevationGain(eles) : null };
    });
  }, [waypoints, trail]);
  const nextWaypoint = onTrail && waypoints ? waypoints.find((w) => w.km > userPos!.km + 0.01) ?? null : null;
  const remainingKm = userPos ? Math.max(0, trail.totalDistance - userPos.km) : null;
  const userFrac = userPos && trail.totalDistance > 0 ? Math.min(1, Math.max(0, userPos.km / trail.totalDistance)) : 0;

  // One line under the trail name: how far is left, or how far off it you are.
  const userLine = userPos && (
    onTrail ? (
      <span className="text-sky-300 font-bold flex items-center gap-1">
        <Navigation className="w-3 h-3" /> נותרו {remainingKm!.toFixed(1)} ק״מ
      </span>
    ) : (
      <span className="text-amber-400 font-bold flex items-center gap-1">
        <Navigation className="w-3 h-3" /> מחוץ למסלול · {userPos.offTrailM >= 1000 ? `${(userPos.offTrailM / 1000).toFixed(1)} ק״מ` : `${Math.round(userPos.offTrailM)} מ׳`}
      </span>
    )
  );

  // Drawn by distance along the trail, not by point number: GPS points are
  // unevenly spaced, and both the tour marker and the "you are here" marker
  // are placed by distance — drawn by index, the profile under them would be
  // stretched and squeezed and they would sit over the wrong hill.
  const generateElevationPath = () => {
    if (!trail.elevations || trail.elevations.length === 0) return "";
    const w = 300;
    const h = 64; 
    const minE = trail.minEle;
    const maxE = trail.maxEle;
    const range = maxE - minE || 1;
    const total = trail.totalDistance || 1;
    
    let path = `M 0,${h} `;
    for (let i = 0; i < trail.elevations.length; i++) {
       const x = ((trail.accumulatedDistances[i] ?? 0) / total) * w;
       const y = h - ((trail.elevations[i] - minE) / range) * (h * 0.8) - 4; 
       path += `L ${x},${y} `;
    }
    path += `L ${w},${h} Z`;
    return path;
  };

  // The shade strip answers "where is the shade", which a single percentage
  // cannot. It is drawn the same way as the elevation profile above — an SVG
  // in trail order, flipped with scaleX(-1) so the right edge is the start —
  // but as columns of colour rather than a line. The profile is downsampled to
  // a fixed number of columns so a 4,000-point GPX does not put 4,000 rects in
  // the DOM.
  const SHADE_COLUMNS = BAR_COLUMNS;
  const shadeColumns = () => {
    const profile = shade?.profile;
    if (!profile || profile.length === 0) return [];
    const cols: number[] = [];
    const per = profile.length / SHADE_COLUMNS;
    for (let c = 0; c < SHADE_COLUMNS; c++) {
      const from = Math.floor(c * per);
      const to = Math.max(from + 1, Math.floor((c + 1) * per));
      let sum = 0, n = 0;
      for (let i = from; i < to && i < profile.length; i++) { sum += profile[i]; n++; }
      cols.push(n > 0 ? sum / n : 0);
    }
    return cols;
  };

  // Amber where the sun is on you, green where the canopy is closed.
  const shadeColor = (f: number) =>
    f < SUN_MAX ? "#f59e0b" : f < SHADE_MIN ? "#84cc16" : "#16a34a";

  // Where each source sits along the strip, 0..1 from the start of the trail,
  // so a marker can be dropped on the bar at the point it was found.
  const waterMarkers = () =>
    (water?.points ?? []).map((p) => ({
      pos: trail.totalDistance > 0 ? Math.min(1, Math.max(0, p.km / trail.totalDistance)) : 0,
      confident: p.counted,
      label: p.name ? `${p.label} · ${p.name}` : p.label,
      km: p.km,
    }));

  if (collapsed) {
    return (
      // A tap anywhere on the folded card opens it — not only on "נתונים".
      // The two round buttons on it (back, about the trail) keep their own job.
      <div
        ref={cardRef}
        data-tour="stats"
        onClick={() => setCollapsed(false)}
        role="button"
        aria-expanded={false}
        aria-label="פתח את נתוני המסלול"
        className={`absolute ${bottomOffset} left-3 right-3 md:top-[104px] md:right-3 md:left-auto md:bottom-auto bg-zinc-900/90 py-2 px-3 rounded-2xl shadow-xl border border-white/10 z-[41] md:w-80 backdrop-blur-md flex justify-between items-center gap-2 cursor-pointer`}
        dir="rtl"
      >
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          {onClose && (
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-full transition-colors shrink-0" title="חזור למפה">
              <ArrowRight className="w-4 h-4 text-white" />
            </button>
          )}
          <div className="min-w-0">
            <div className="text-white font-bold text-xs truncate" title={trail.name}>{trail.name}</div>
            <div className="text-zinc-100 text-xs flex items-center gap-1 flex-wrap">
              {weather?.selected && (
                <span className="flex items-center gap-0.5 text-white font-bold">
                  <WeatherIcon code={weather.selected.summary.code} className="w-3.5 h-3.5 text-yellow-300" />
                  {Math.round(weather.selected.summary.tMax)}°
                  {weather.selected.rating === "bad" && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
                  <span className="text-zinc-300 font-normal">·</span>
                </span>
              )}
              {isDrive ? (
                <>{trail.totalDistance.toFixed(0)} ק״מ{trail.driveDurationSec != null && <> · <span className="text-sky-400">{formatDuration(trail.driveDurationSec)}</span></>}</>
              ) : (
                <>
                  {trail.totalDistance.toFixed(1)} ק״מ · {Math.round(trail.minEle)}–{Math.round(trail.maxEle)} מ׳
                  {shade && <> · <span className="text-lime-400">{Math.round(shade.shadePct)}% אפשרות לצל</span></>}
                </>
              )}
            </div>
            {userLine && <div className="text-[11px]">{userLine}</div>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onShowInfo && (
            <button
              onClick={(e) => { e.stopPropagation(); onShowInfo(); }}
              className="p-1.5 bg-sky-600 hover:bg-sky-500 rounded-full transition-colors"
              title="על המסלול"
              aria-label="על המסלול"
            >
              <BookOpenText className="w-4 h-4 text-white" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setCollapsed(false); }}
            className="text-xs bg-white/10 text-white px-2.5 py-1.5 rounded-full hover:bg-white/20 flex items-center gap-1 font-bold"
          >
            <ChevronUp className="w-3 h-3" />
            נתונים
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={cardRef} data-tour="stats" className={`absolute ${bottomOffset} left-3 right-3 md:top-[104px] md:right-3 md:left-auto md:bottom-auto bg-zinc-900/90 p-4 md:p-5 rounded-3xl shadow-xl border border-white/10 z-[45] max-h-[calc(100dvh_-_var(--bottom-stack-h,64px)_-_var(--progress-bar-h,0px)_-_80px)] md:max-h-[75vh] overflow-y-auto overscroll-contain md:w-80 backdrop-blur-md`} dir="rtl">
      <div className="flex justify-between items-center gap-3">
        {onClose && (
          <button 
            onClick={onClose} 
            className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
            title="חזור למפה"
          >
            <ArrowRight className="w-4 h-4 text-zinc-300" />
          </button>
        )}
        <div className="text-base font-bold text-white tracking-tight truncate flex-1" title={trail.name}>{trail.name}</div>
        <button onClick={() => setCollapsed(true)} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0" title="כווץ">
          <ChevronDown className="w-4 h-4 text-zinc-300" />
        </button>
      </div>
      {onShowInfo && (
        <button
          onClick={onShowInfo}
          className="mt-3 w-full flex items-center justify-center gap-2 text-sm font-bold text-white bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-2xl transition-colors"
        >
          <BookOpenText className="w-4 h-4" /> על המסלול: תיאור, הגעה, קטעים ומקורות
        </button>
      )}
      {userPos && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-sky-500/10 border border-sky-500/20 px-3 py-2 text-xs">
          {userLine}
          {onTrail && (
            <span className="text-white">
              עברת {userPos.km.toFixed(1)} ק״מ{!isDrive && trail.maxEle > trail.minEle && <> · גובה {Math.round(userPos.ele)} מ׳</>}
            </span>
          )}
        </div>
      )}
      {legs && (
        <div className="mt-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-white">
          <div className="font-bold mb-1 flex justify-between">
            <span>מקטעים</span>
            {nextWaypoint && (
              <span className="text-sky-300">לנקודה {nextWaypoint.label}׳: {(nextWaypoint.km - userPos!.km).toFixed(1)} ק״מ</span>
            )}
          </div>
          {legs.map((l, i) => (
            <div key={i} className="flex justify-between gap-2 py-0.5">
              <span>{l.from}׳ ← {l.to}׳</span>
              <span>
                <b className="text-yellow-300">{l.km.toFixed(2)} ק״מ</b>
                {l.climb && <> · ↑{l.climb.gain} ↓{l.climb.loss} מ׳</>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-between border-t border-white/10 pt-3 mt-3">
        <div className="text-center flex-1 px-1">
          <div className="text-xs text-white mb-1 font-bold">אורך מסלול</div>
          <div className="text-xl font-bold text-sky-400">
            {trail.totalDistance.toFixed(1)}
            <span className="text-xs font-normal text-white mr-1">ק״מ</span>
          </div>
        </div>
        {isDrive ? (
          <div className="text-center flex-1 border-r border-white/5 px-1">
            <div className="text-xs text-white mb-1 font-bold">זמן נסיעה</div>
            <div className="text-xl font-bold text-emerald-400">
              {trail.driveDurationSec != null ? formatDuration(trail.driveDurationSec) : '—'}
            </div>
          </div>
        ) : (<>
        <div className="text-center flex-1 border-r border-white/5 px-1">
          <div className="text-xs text-white mb-1 font-bold">גובה מינימלי</div>
          <div className="text-xl font-bold text-red-400">
            {Math.round(trail.minEle)}
            <span className="text-xs font-normal text-white mr-1">מ׳</span>
          </div>
        </div>
        <div className="text-center flex-1 border-r border-white/5 px-1">
          <div className="text-xs text-white mb-1 font-bold">גובה מקסימלי</div>
          <div className="text-xl font-bold text-emerald-400">
            {Math.round(trail.maxEle)}
            <span className="text-xs font-normal text-white mr-1">מ׳</span>
          </div>
        </div>
        </>)}
      </div>
      {climb && (
        <div className="flex justify-center gap-6 text-xs font-bold mt-2 pt-2 border-t border-white/5">
          <span className="text-emerald-400 flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> עלייה {climb.gain} {"מ'"}</span>
          <span className="text-red-400 flex items-center gap-1"><TrendingDown className="w-3.5 h-3.5" /> ירידה {climb.loss} {"מ'"}</span>
        </div>
      )}
      {isDrive && (
        <p className="mt-3 border-t border-white/10 pt-3 text-xs text-white leading-relaxed">
          מסלול נסיעה לפי Mapbox Directions. זמן הנסיעה הוא הערכה לתנאי דרך רגילים, בלי פקקים ועצירות.
          הסיור הווירטואלי מתקדם ב־80 קמ״ש ב־x1.
        </p>
      )}
      {isDrive && weather && <TripWeatherSection weather={weather} isDrive trail={trail} />}
      {!isDrive && (<>
      <div className="mt-3 border-t border-white/10 pt-3 relative" dir="ltr">
        <div className="text-xs text-white mb-2 font-bold flex items-center gap-1" dir="rtl">
          פרופיל גובה
          <InfoButton label="פרופיל הגובה">
            הצד הימני הוא תחילת המסלול. הקו הכתום מראה איפה נמצא הסיור הווירטואלי, והנקודה הכחולה מראה איפה אתם, כשהמיקום החי דלוק.
          </InfoButton>
        </div>
        <div className="relative w-full h-14 bg-zinc-800 rounded-lg overflow-hidden">
          {/* scaleX(-1) flips graph so right = trail start (RTL) */}
          <svg viewBox="0 0 300 64" preserveAspectRatio="none" className="absolute inset-0 w-full h-full opacity-60" style={{ transform: 'scaleX(-1)' }}>
            <path d={generateElevationPath()} fill="rgba(249,115,22,0.3)" stroke="#f97316" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* The measured walk's points, lettered along the profile */}
          {waypoints && waypoints.length > 1 && waypoints.map((w) => (
            <div
              key={w.label}
              className="absolute top-0 bottom-0 z-[5] pointer-events-none"
              style={{ right: `${(trail.totalDistance > 0 ? w.km / trail.totalDistance : 0) * 100}%` }}
            >
              <div className="absolute top-0 bottom-0 border-r border-dashed border-white/50" />
              <span className="absolute top-0 -translate-x-1/2 text-[11px] font-bold text-white bg-zinc-950/80 rounded px-0.5 leading-tight">{w.label}</span>
            </div>
          ))}
          {progress > 0 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-orange-300 shadow-[0_0_8px_#fdba74] z-10 transition-all duration-75"
              style={{ right: `${progress * 100}%` }}
            />
          )}
          {/* The walker, from the GPS: a line down the profile and a dot on
              it at their height, so "how much more climbing" can be read off
              at a glance. */}
          {onTrail && (
            <>
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-sky-400 z-20"
                style={{ right: `${userFrac * 100}%` }}
              />
              <div
                className="absolute w-3 h-3 rounded-full bg-sky-400 border-2 border-white shadow-[0_0_8px_#38bdf8] z-20"
                style={{
                  right: `calc(${userFrac * 100}% - 5px)`,
                  bottom: `calc(${((userPos!.ele - trail.minEle) / (trail.maxEle - trail.minEle || 1)) * 80 + 6}% - 6px)`,
                }}
              />
            </>
          )}
        </div>
        {onTrail && (
          <div className="flex justify-between text-xs mt-1" dir="rtl">
            <span className="text-sky-300 font-bold">● אתה כאן · נותרו {remainingKm!.toFixed(1)} ק״מ</span>
            {progress > 0 && <span className="text-orange-300">| סיור וירטואלי</span>}
          </div>
        )}
      </div>

      {weather && <TripWeatherSection weather={weather} isDrive={false} trail={trail} />}

      {/* The month of the chosen trip day, else this month, is the one shown. */}
      {climate && (
        <BestMonthsSection
          climate={climate}
          month={weather?.selected ? Number(weather.selected.date.slice(5, 7)) - 1 : new Date().getMonth()}
        />
      )}

      {/* ── קיץ ─────────────────────────────────────────────────────────── */}
      {/* Israel only: the shade grid covers nothing else, and which water is
          safe to get into was worked out against Israeli streams and pools. */}
      {inIsrael && (
      <Collapsible
        variant="section"
        title="מים לרחצה וצל בקיץ"
        summary={(shade || water) && (
          <>
            {shade && <span className="text-lime-300">{Math.round(shade.shadePct)}% צל</span>}
            {shade && water && <span>·</span>}
            {water && <span className="text-sky-300">{water.longestDryKm.toFixed(1)} ק״מ בלי מים לרחצה</span>}
          </>
        )}
      >
        <div className="text-xs text-white mb-2 flex items-center gap-1">
          מה רואים כאן
          <InfoButton label="מים לרחצה וצל בקיץ">
            <p>
              <b>מים לרחצה:</b> מקומות להיכנס למים ולהתרענן — לא מי שתייה. הפס הכחול מסמן קטעים שיש בהם מקום כזה עד 150 מ׳ מהשביל. עיגול מלא הוא בריכה או נחל איתן;
              עיגול חלול הוא מעיין או מקור לא מאומת, שעלול להיות יבש. ״ק״מ ברצף בלי מים לרחצה״ הוא הקטע הארוך ביותר בלי מקום כזה.
            </p>
            <p className="mt-2">
              <b>צל:</b> כמה עצים יש לאורך השביל. כתום זה שמש, ירוק זה צל.
            </p>
            <p className="mt-2">הכול הערכה לפי מפות, לא בדיקה בשטח. הצד הימני הוא תחילת המסלול.</p>
          </InfoButton>
        </div>

        {/* מים */}
        <div className="text-xs text-white font-bold mb-1">מים לרחצה <span className="font-normal">(לא מי שתייה)</span></div>

        {waterStatus === 'loading' && !water && (
          <div className="text-white text-xs mb-3">מחפש מקורות מים…</div>
        )}

        {/* Overpass could not be reached. Saying so matters more than it looks:
            rendering this as "no water on this trail" is a wrong answer someone
            could plan an August walk around. */}
        {(waterStatus === 'unavailable' || waterStatus === 'rate-limited') && !water && (
          <div className="text-amber-300 text-xs mb-3">
            {waterStatus === 'rate-limited' ? 'יותר מדי בקשות כרגע — ' : 'לא הצלחנו לבדוק כרגע — '}
            אין מידע על מים לרחצה במסלול הזה. זה לא אומר שאין בו.
          </div>
        )}

        {water && (
          <div className="mb-3">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-lg font-bold text-sky-400 leading-none">{water.longestDryKm.toFixed(1)}</span>
              <span className="text-xs text-white">ק״מ ברצף בלי מים לרחצה</span>
              <span className="text-white">·</span>
              <span className="text-xs text-white">{Math.round(water.nearWaterPct)}% ליד מים לרחצה</span>
            </div>

            {/* The water strip, drawn to line up column-for-column with the
                shade strip below it: same column count, same scaleX(-1) so the
                right edge is the start of the walk. Markers sit on the bar at
                the kilometre the source was found, hollow for the ones we
                cannot stand behind — the same solid/hollow distinction the map
                uses, so the two read the same way. */}
            <div dir="ltr" className="relative w-full h-4 bg-zinc-800 rounded-md overflow-hidden">
              <svg viewBox="0 0 120 10" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ transform: 'scaleX(-1)' }}>
                {(water?.bar ?? []).map((wet, i) => (
                  <rect key={i} x={i} y={0} width={1.02} height={10} fill={wet ? "#0ea5e9" : "#3f3f46"} />
                ))}
              </svg>
              {waterMarkers().map((m, i) => (
                <div
                  key={i}
                  title={`${m.label} · ${m.km.toFixed(1)} ק״מ`}
                  className={`absolute top-1/2 w-2 h-2 rounded-full border ${m.confident ? "bg-sky-300 border-white" : "bg-zinc-800 border-sky-300"}`}
                  style={{ right: `calc(${m.pos * 100}% - 4px)`, transform: "translateY(-50%)" }}
                />
              ))}
            </div>

            <div className="flex justify-between text-xs text-white mt-1 mb-2">
              <span>סוף</span>
              <span className="text-sky-400">מים לרחצה עד 150 מ׳</span>
              <span>התחלה</span>
            </div>

            {water.points.length === 0 && (
              <div className="text-white text-xs">אין מקומות ידועים לרחצה לאורך המסלול.</div>
            )}

            {water.points.map((p, i) => (
              <div key={i} className="flex items-baseline gap-2 text-xs py-0.5">
                <span className="text-white tabular-nums w-12 shrink-0">{p.km.toFixed(1)} ק״מ</span>
                <span className={p.counted ? "text-sky-300" : "text-white"}>{p.label}</span>
                {p.name && <span className="text-white truncate">{p.name}</span>}
                <span className={`text-xs shrink-0 ${p.counted ? "text-white" : "text-amber-300"}`}>{p.offTrailM} מ׳</span>
              </div>
            ))}

            {/* Springs and unnamed polygons are shown because they are the best
                information there is, but they do not shorten the dry stretch —
                so the panel has to say which of the two a line is. */}
            {water.points.some((p) => !p.counted) && (
              <div className="text-xs text-white mt-1.5 leading-relaxed">
                <span className="inline-block w-2 h-2 rounded-full bg-zinc-800 border border-sky-300 align-middle ml-1" />
                לא נספרים במספרים שלמעלה: מעיינות ובריכות לא מאומתות — אין במפה מידע אם יש בהם מים בקיץ —
                וכן מקורות שרחוקים יותר מ־150 מ׳ מהשביל, שמוצגים עם המרחק שלהם כדי שתוכלו להחליט בעצמכם.
              </div>
            )}

            {waterStatus === 'cached' && (
              <div className="text-xs text-white mt-1">מהזיכרון המקומי — לא נבדק עכשיו.</div>
            )}
          </div>
        )}

        {/* צל */}
        {shadeLoading && !shade && (
          <div className="text-white text-xs">מחשב צל…</div>
        )}

        {!shadeLoading && !shade && (
          <div className="text-white text-xs">אין נתוני צל למסלול הזה.</div>
        )}

        {shade && (
          <>
            <div className="flex justify-between items-baseline mb-1.5">
              <div className="text-xs text-white font-bold">אפשרות לצל</div>
              <div className="text-lg font-bold text-lime-400 leading-none">
                {Math.round(shade.shadePct)}%
                <span className="text-xs font-normal text-white mr-1">מהמסלול</span>
              </div>
            </div>

            <div dir="ltr" className="relative w-full h-4 bg-zinc-800 rounded-md overflow-hidden">
              {/* scaleX(-1) so the right edge is the start of the trail, as in
                  the elevation profile above */}
              <svg viewBox="0 0 120 10" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ transform: 'scaleX(-1)' }}>
                {shadeColumns().map((f, i) => (
                  <rect key={i} x={i} y={0} width={1.02} height={10} fill={shadeColor(f)} />
                ))}
              </svg>
            </div>

            <div className="flex justify-between text-xs text-white mt-1">
              <span>סוף</span>
              <span>
                <span className="text-amber-400">שמש</span> ·{' '}
                <span className="text-lime-400">חלקי</span> ·{' '}
                <span className="text-green-400">מוצל</span>
              </span>
              <span>התחלה</span>
            </div>
          </>
        )}

        <p className="text-xs text-white leading-relaxed mt-3">
          מעיינות ובריכות עלולים להיות יבשים בקיץ, ולמפה אין מידע על מצבם.
          <span className="text-amber-300 font-bold"> אלה לא מי שתייה.</span>{' '}
          הצל לפי כיסוי עצים במפות לוויין (ESA WorldCover 2021) — לא כולל צל של מדרונות וּואדיות,
          ולא מעודכן אחרי שריפות.
        </p>

        {/* Inside the section, where the figures it qualifies are: the one
            thing here that could get somebody hurt is reading them as a
            permission to swim. */}
        <div className="mt-3 rounded-lg bg-amber-500/10 border border-amber-500/25 p-2">
          <div className="text-xs text-amber-300 font-bold mb-1">לפני שיוצאים — לאמת ברט״ג</div>
          <p className="text-xs text-white leading-relaxed">
            המספרים כאן הם הערכה לפי מפות, לא אישור רחצה. ערב הטיול יש לוודא באתר רשות הטבע והגנים את
            פתיחת המסלול, היתר הכניסה למים, עומס החום, חשש לשיטפונות ואיכות המים.
          </p>
        </div>
      </Collapsible>
      )}

      </>)}
    </div>
  );
}
