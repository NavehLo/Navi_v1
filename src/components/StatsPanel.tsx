import { TrailData } from "../hooks/useTrailData";
import { SUN_MAX, SHADE_MIN, BAR_COLUMNS, type ShadeResult, type WaterResult } from "../lib/summerConditions";
import type { WaterStatus } from "../hooks/useSummerConditions";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { useState, useEffect, useRef } from "react";

// Sits above the bottom stack (narration card + tour bar) and starts collapsed
// on phones — expanded, this card alone used to cover a third of the screen.
export default function StatsPanel({ trail, progress, onClose, isTourActive, shade, shadeLoading, water, waterStatus }: { trail: TrailData, progress: number, onClose?: () => void, isTourActive?: boolean, shade?: ShadeResult | null, shadeLoading?: boolean, water?: WaterResult | null, waterStatus?: WaterStatus }) {
  const [collapsed, setCollapsed] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  // The tour progress bar claims the same strip of phone screen this card sits
  // on — both were pinned to bottom-[76px], so starting a tour dropped the bar
  // straight on top of the trail figures. The condition has to match the one
  // page.tsx renders the bar under, or the card lifts when there is nothing
  // there to avoid.
  const progressBarShowing =
    progress > 0 && Math.floor(progress * trail.coords.length) < trail.coords.length;
  // 76px clears the tour transport; the progress bar adds roughly 100 more.
  const bottomOffset = progressBarShowing ? "bottom-[184px]" : "bottom-[76px]";

  useEffect(() => {
    const isPhone = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    setCollapsed(!!isTourActive || isPhone);
  }, [isTourActive]);

  // Tapping the map puts the card away again. Expanded, it is deliberately
  // stacked above the control rails (see the z-index on the wrapper below), so
  // without this the buttons it covers would be unreachable — including the
  // one that collapses it. Listening on pointerdown rather than click means the
  // card is gone before the map starts handling the gesture.
  useEffect(() => {
    if (collapsed) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) setCollapsed(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [collapsed]);

  const generateElevationPath = () => {
    if (!trail.elevations || trail.elevations.length === 0) return "";
    const w = 300;
    const h = 64; 
    const minE = trail.minEle;
    const maxE = trail.maxEle;
    const range = maxE - minE || 1;
    
    let path = `M 0,${h} `;
    for (let i = 0; i < trail.elevations.length; i++) {
       const x = (i / (trail.elevations.length - 1)) * w;
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
      <div ref={cardRef} className={`absolute ${bottomOffset} left-3 right-3 md:top-[104px] md:right-3 md:left-auto md:bottom-auto bg-zinc-900/90 py-2 px-3 rounded-2xl shadow-xl border border-white/10 z-[41] md:w-80 backdrop-blur-md flex justify-between items-center gap-2`} dir="rtl">
        <div className="flex items-center gap-2 overflow-hidden min-w-0">
          {onClose && (
            <button onClick={onClose} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-full transition-colors shrink-0" title="חזור למפה">
              <ArrowRight className="w-4 h-4 text-zinc-300" />
            </button>
          )}
          <div className="min-w-0">
            <div className="text-white font-bold text-xs truncate" title={trail.name}>{trail.name}</div>
            <div className="text-zinc-400 text-[10px]">
              {trail.totalDistance.toFixed(1)} ק״מ · {Math.round(trail.minEle)}–{Math.round(trail.maxEle)} מ׳
              {shade && <> · <span className="text-lime-400">{Math.round(shade.shadePct)}% צל</span></>}
            </div>
          </div>
        </div>
        <button
          onClick={() => setCollapsed(false)}
          className="text-[11px] bg-white/10 text-white px-2.5 py-1.5 rounded-full hover:bg-white/20 shrink-0 flex items-center gap-1 font-bold"
        >
          <ChevronUp className="w-3 h-3" />
          נתונים
        </button>
      </div>
    );
  }

  return (
    <div ref={cardRef} className={`absolute ${bottomOffset} left-3 right-3 md:top-[104px] md:right-3 md:left-auto md:bottom-auto bg-zinc-900/90 p-4 md:p-5 rounded-3xl shadow-xl border border-white/10 z-[45] max-h-[75vh] overflow-y-auto overscroll-contain md:w-80 backdrop-blur-md`} dir="rtl">
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
      <div className="flex justify-between border-t border-white/10 pt-3 mt-3">
        <div className="text-center flex-1 px-1">
          <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-1 font-bold">אורך מסלול</div>
          <div className="text-xl font-bold text-sky-400">
            {trail.totalDistance.toFixed(1)}
            <span className="text-xs font-normal text-zinc-500 mr-1">ק"מ</span>
          </div>
        </div>
        <div className="text-center flex-1 border-r border-white/5 px-1">
          <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-1 font-bold">גובה מינימלי</div>
          <div className="text-xl font-bold text-red-400">
            {Math.round(trail.minEle)}
            <span className="text-xs font-normal text-zinc-500 mr-1">מ'</span>
          </div>
        </div>
        <div className="text-center flex-1 border-r border-white/5 px-1">
          <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-1 font-bold">גובה מקסימלי</div>
          <div className="text-xl font-bold text-emerald-400">
            {Math.round(trail.maxEle)}
            <span className="text-xs font-normal text-zinc-500 mr-1">מ'</span>
          </div>
        </div>
      </div>
      <div className="mt-3 border-t border-white/10 pt-3 relative" dir="ltr">
        <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-2 text-right font-bold">פרופיל גובה</div>
        <div className="relative w-full h-14 bg-zinc-800 rounded-lg overflow-hidden">
          {/* scaleX(-1) flips graph so right = trail start (RTL) */}
          <svg viewBox="0 0 300 64" preserveAspectRatio="none" className="absolute inset-0 w-full h-full opacity-60" style={{ transform: 'scaleX(-1)' }}>
            <path d={generateElevationPath()} fill="rgba(249,115,22,0.3)" stroke="#f97316" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
          {progress > 0 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-sky-400 shadow-[0_0_8px_#38bdf8] z-10 transition-all duration-75"
              style={{ right: `${progress * 100}%` }}
            />
          )}
        </div>
      </div>

      {/* ── קיץ ─────────────────────────────────────────────────────────── */}
      <div className="mt-3 border-t border-white/10 pt-3">
        <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-2 font-bold">בקיץ</div>

        {/* מים */}
        <div className="text-[11px] text-zinc-300 font-bold mb-1">מים להתרעננות</div>

        {waterStatus === 'loading' && !water && (
          <div className="text-zinc-300 text-[11px] mb-3">מחפש מקורות מים…</div>
        )}

        {/* Overpass could not be reached. Saying so matters more than it looks:
            rendering this as "no water on this trail" is a wrong answer someone
            could plan an August walk around. */}
        {(waterStatus === 'unavailable' || waterStatus === 'rate-limited') && !water && (
          <div className="text-amber-500/80 text-[11px] mb-3">
            {waterStatus === 'rate-limited' ? 'יותר מדי בקשות כרגע — ' : 'לא הצלחנו לבדוק כרגע — '}
            אין מידע על מים במסלול הזה. זה לא אומר שאין בו מים.
          </div>
        )}

        {water && (
          <div className="mb-3">
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-lg font-bold text-sky-400 leading-none">{water.longestDryKm.toFixed(1)}</span>
              <span className="text-[11px] text-zinc-300">ק״מ ברצף בלי מים</span>
              <span className="text-zinc-600">·</span>
              <span className="text-[11px] text-zinc-300">{Math.round(water.nearWaterPct)}% ליד מים</span>
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

            <div className="flex justify-between text-[10px] text-zinc-400 mt-1 mb-2">
              <span>סוף</span>
              <span className="text-sky-400">מים בטווח 150 מ׳</span>
              <span>התחלה</span>
            </div>

            {water.points.length === 0 && (
              <div className="text-zinc-300 text-[11px]">אין מקורות מים ידועים לאורך המסלול.</div>
            )}

            {water.points.map((p, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px] py-0.5">
                <span className="text-zinc-400 tabular-nums w-12 shrink-0">{p.km.toFixed(1)} ק״מ</span>
                <span className={p.counted ? "text-sky-300" : "text-zinc-300"}>{p.label}</span>
                {p.name && <span className="text-zinc-100 truncate">{p.name}</span>}
                <span className={`text-[10px] shrink-0 ${p.counted ? "text-zinc-400" : "text-amber-400/80"}`}>{p.offTrailM} מ׳</span>
              </div>
            ))}

            {/* Springs and unnamed polygons are shown because they are the best
                information there is, but they do not shorten the dry stretch —
                so the panel has to say which of the two a line is. */}
            {water.points.some((p) => !p.counted) && (
              <div className="text-[10px] text-zinc-300 mt-1.5 leading-relaxed">
                <span className="inline-block w-2 h-2 rounded-full bg-zinc-800 border border-sky-300 align-middle ml-1" />
                לא נספרים במספרים שלמעלה: מעיינות ובריכות לא מאומתות — אין במפה מידע אם יש בהם מים בקיץ —
                וכן מקורות שרחוקים יותר מ־150 מ׳ מהשביל, שמוצגים עם המרחק שלהם כדי שתוכלו להחליט בעצמכם.
              </div>
            )}

            {waterStatus === 'cached' && (
              <div className="text-[10px] text-zinc-400 mt-1">מהזיכרון המקומי — לא נבדק עכשיו.</div>
            )}
          </div>
        )}

        {/* צל */}
        {shadeLoading && !shade && (
          <div className="text-zinc-300 text-[11px]">מחשב צל…</div>
        )}

        {!shadeLoading && !shade && (
          <div className="text-zinc-300 text-[11px]">אין נתוני צל למסלול הזה.</div>
        )}

        {shade && (
          <>
            <div className="flex justify-between items-baseline mb-1.5">
              <div className="text-[11px] text-zinc-300 font-bold">צל</div>
              <div className="text-lg font-bold text-lime-400 leading-none">
                {Math.round(shade.shadePct)}%
                <span className="text-[10px] font-normal text-zinc-400 mr-1">מהמסלול</span>
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

            <div className="flex justify-between text-[10px] text-zinc-400 mt-1">
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

        {/* The warning is not tucked behind a toggle on purpose. Everything
            above it is an estimate read off a map, and the one thing that could
            actually get somebody hurt is treating it as a permission to swim. */}
        <div className="mt-3 rounded-lg bg-amber-500/10 border border-amber-500/25 p-2">
          <div className="text-[11px] text-amber-300 font-bold mb-1">לפני שיוצאים — לאמת ברט״ג</div>
          <p className="text-[10px] text-zinc-200 leading-relaxed">
            המספרים כאן הם הערכת תכנון לפי מפות, לא אישור רחצה ולא בדיקה בשטח.
            ערב הטיול יש לוודא באתר רשות הטבע והגנים את <span className="text-white font-semibold">פתיחת המסלול</span>,
            את <span className="text-white font-semibold">היתר הכניסה למים</span>, את <span className="text-white font-semibold">עומס החום</span>,
            <span className="text-white font-semibold"> חשש לשיטפונות</span> ואת <span className="text-white font-semibold">איכות המים</span>.
          </p>
          <p className="text-[10px] text-zinc-300 leading-relaxed mt-1.5">
            מים: מעיינות ובריכות עלולים להיות יבשים בקיץ, ולמפה אין מידע על מצבם.
            <span className="text-amber-300"> אלה לא מי שתייה.</span>{' '}
            צל: לפי כיסוי עצים במפות לוויין (ESA WorldCover 2021) — לא כולל צל של מדרונות וּואדיות,
            ולא מעודכן אחרי שריפות.
          </p>
        </div>
      </div>
    </div>
  );
}
