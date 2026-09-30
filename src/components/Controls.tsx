import { useState, useEffect } from "react";
import type mapboxgl from "mapbox-gl";
import ScaleBar from "./ScaleBar";
import type { TrailKind } from "../hooks/useTrailData";
import { tourSpeedsFor } from "../hooks/useTour";
import {
  Home, Settings, Headphones, HeadphoneOff,
  ListMusic, Layers, Maximize2, LocateFixed, Play, Square, Eye, Tag, Ruler,
} from "lucide-react";

interface ControlsProps {
  onStyleChange: (style: string) => void;
  onToggle3D: () => void;
  is3D: boolean;
  onToggleTour: () => void;
  isTourActive: boolean;
  tourSpeed?: number;
  onTourSpeedChange?: (speed: number) => void;
  onLocateUser: () => void;
  // The live location is on: the dot follows the phone, and a tap recentres.
  isTracking?: boolean;
  onMeasure?: () => void;
  isMeasuring?: boolean;
  map?: mapboxgl.Map | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onCompass: () => void;
  mapBearing: number;
  onFitToTrail: () => void;
  hasTrail: boolean;
  onHome?: () => void;
  tourProgress?: number;
  onOpenSettings?: () => void;
  isGuideEnabled?: boolean;
  onToggleGuide?: () => void;
  onOpenGuidePoints?: () => void;
  guidePointCount?: number;
  onHideUI?: () => void;
  showWorldTrails?: boolean;
  onToggleWorldTrails?: () => void;
  // With no reception, only the style the trail was downloaded in has tiles
  // to show; the other two would be a blank screen. Set, it greys them out.
  offlineStyleKey?: string | null;
}

// A 44px icon rail instead of the old 192px labelled column: the map is the
// point of the app, and on a phone the chrome was eating most of it. Anything
// that is not a one-tap map action lives behind the settings button.
// One stacking order for the whole map UI, written down because it was drifting
// apart: every overlay had picked its own number and two of them had picked the
// same spot on the screen as well.
//
//   40  tour progress bar
//   41  collapsed stats card
//   42  these control rails — a control must never end up under a readout
//   43  the layers popover, which hangs off its rail
//   45  expanded stats card: it covers the rails on purpose, and a tap outside
//       puts it away again
//   46  (was the "עוד" sheet — now the settings window, at 70)
//   50  bottom stack (narration card + tour transport), toasts
//   60  map attribution, and the button that brings a hidden UI back
//   70  full-screen modals
const PILL =
  "flex flex-col bg-zinc-900/90 rounded-2xl border border-white/10 backdrop-blur-md overflow-hidden shadow-xl";


// Naming the icons without giving up the icon rail.
//
// A rail of unlabelled glyphs is clean and, for three of these, genuinely
// unguessable — the footprints, the headphones and the arrows that recentre the
// trail all had to be pressed to find out what they did. Rather than go back to
// the 192px labelled column this rail replaced, the name sits inline next to
// the glyph and the pill grows only as wide as the longest word. Off, it is the
// same 40px rail as before, to the pixel.
//
// It defaults to on: an icon nobody can read is not minimal, it is only quiet.
// One tap on the tag button at the bottom of the rail puts it back to bare
// glyphs, and the choice is remembered.
const LABELS_KEY = "navi:railLabels";

function RailBtn({
  label, labelsOn, onClick, className = "", title, children, ariaPressed,
}: {
  label: string;
  labelsOn: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
  ariaPressed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={ariaPressed}
      className={`${labelsOn ? "h-10 w-full px-3 gap-2 justify-start" : "w-10 h-10 justify-center"} flex items-center text-zinc-200 hover:bg-white/10 active:bg-white/20 transition-colors ${className}`}
    >
      {children}
      {labelsOn && <span className="text-[11px] font-medium whitespace-nowrap">{label}</span>}
    </button>
  );
}


export default function Controls(props: ControlsProps) {
  const {
    onStyleChange, onToggle3D, is3D,
    onLocateUser, onZoomIn, onZoomOut, onCompass, mapBearing,
    onFitToTrail, hasTrail, onHome, onOpenSettings, isGuideEnabled, onToggleGuide,
    onOpenGuidePoints, guidePointCount, onHideUI, showWorldTrails, onToggleWorldTrails,
    offlineStyleKey, isTracking, onMeasure, isMeasuring, map,
  } = props;

  const [showLayers, setShowLayers] = useState(false);
  const [labelsOn, setLabelsOn] = useState(true);

  // Read the stored preference after mount rather than in the initial state, so
  // the server-rendered markup and the first client render agree.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LABELS_KEY);
      if (stored !== null) setLabelsOn(stored === "1");
    } catch {
      // Storage blocked — labels simply stay on.
    }
  }, []);

  const toggleLabels = () => {
    setLabelsOn((on) => {
      const next = !on;
      try { localStorage.setItem(LABELS_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  };

  const compass = (
    <svg width="17" height="17" viewBox="0 0 18 18" style={{ transform: `rotate(${-mapBearing}deg)`, transition: 'transform 0.15s linear' }}>
      <polygon points="9,1 11,9 9,8 7,9" fill="#ef4444" />
      <polygon points="9,17 11,9 9,10 7,9" fill="#a1a1aa" />
    </svg>
  );

  return (
    <>
      {/* Top-right: home + hide-everything */}
      <div className="absolute top-3 right-3 z-[42] flex flex-col items-end gap-2" dir="rtl">
        <div className={PILL}>
          {hasTrail && onHome && (
            <RailBtn label="בית" labelsOn={labelsOn} onClick={onHome} title="מסך הבית — יציאה מהמסלול">
              <Home className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
          {onHideUI && (
            <RailBtn
              label="הסתר הכל"
              labelsOn={labelsOn}
              onClick={onHideUI}
              className={`text-amber-400 ${hasTrail && onHome ? 'border-t border-white/10' : ''}`}
              title="הסתר את כל הנתונים מהמפה"
            >
              <Eye className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
        </div>
      </div>

      {/* Left rail — map actions, one tap each */}
      <div className="absolute top-3 left-3 z-[42] flex flex-col items-start gap-2" dir="rtl">
        <div className={PILL}>
          <RailBtn
            label="תצוגת מפה"
            labelsOn={labelsOn}
            onClick={() => setShowLayers(v => !v)}
            className={showLayers ? 'bg-white/10 text-orange-400' : ''}
            title="סוג מפה ותלת מימד"
          >
            <Layers className="w-[18px] h-[18px]" />
          </RailBtn>
          <RailBtn label="התקרב" labelsOn={labelsOn} onClick={onZoomIn} className="border-t border-white/10">
            <span className="text-lg font-bold leading-none w-[18px] text-center">+</span>
          </RailBtn>
          <RailBtn label="צפון" labelsOn={labelsOn} onClick={onCompass} className="border-t border-white/10" title="הצפן למצפן צפון">{compass}</RailBtn>
          <RailBtn label="התרחק" labelsOn={labelsOn} onClick={onZoomOut} className="border-t border-white/10">
            <span className="text-lg font-bold leading-none w-[18px] text-center">&#8722;</span>
          </RailBtn>
          <RailBtn
            label="המיקום שלי"
            labelsOn={labelsOn}
            onClick={onLocateUser}
            className={`border-t border-white/10 ${isTracking ? 'bg-sky-500/20 text-sky-300' : 'text-sky-400'}`}
            title={isTracking ? 'מיקום חי פעיל — לחיצה ממרכזת את המפה עליי' : 'מיקום חי — הצג את המיקום שלי על המפה ועקוב אחריו'}
            ariaPressed={!!isTracking}
          >
            <LocateFixed className="w-[18px] h-[18px]" />
          </RailBtn>
          {onMeasure && (
            <RailBtn
              label="מדידה"
              labelsOn={labelsOn}
              onClick={onMeasure}
              className={`border-t border-white/10 ${isMeasuring ? 'bg-orange-500 text-white' : 'text-orange-300'}`}
              title={hasTrail ? 'מדידת מרחק בין שתי נקודות לאורך המסלול' : 'מדידת מרחק הליכה בין שתי נקודות על המפה'}
              ariaPressed={!!isMeasuring}
            >
              <Ruler className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
        </div>

        {hasTrail && (
          <div className={PILL}>
            <RailBtn label="כל המסלול" labelsOn={labelsOn} onClick={onFitToTrail} className="text-amber-400" title="מרכוז התצוגה על כל המסלול">
              <Maximize2 className="w-[18px] h-[18px]" />
            </RailBtn>
            {onToggleGuide && (
              <RailBtn
                label={isGuideEnabled ? 'מדריכה פעילה' : 'מדריכה כבויה'}
                labelsOn={labelsOn}
                onClick={onToggleGuide}
                className={`border-t border-white/10 ${isGuideEnabled ? 'text-emerald-400' : 'text-zinc-400'}`}
                title={isGuideEnabled ? 'המדריכה פעילה לסיור הזה — לחץ לכיבוי' : 'המדריכה כבויה ולא תקריין מעצמה — לחץ להפעלה לסיור הזה'}
                ariaPressed={isGuideEnabled}
              >
                {isGuideEnabled ? <Headphones className="w-[18px] h-[18px]" /> : <HeadphoneOff className="w-[18px] h-[18px]" />}
              </RailBtn>
            )}
            {onOpenGuidePoints && (
              <RailBtn
                label={guidePointCount ? `נקודות (${guidePointCount})` : 'נקודות'}
                labelsOn={labelsOn}
                onClick={onOpenGuidePoints}
                className="border-t border-white/10 relative"
                title="נקודות המדריכה במסלול והורדה לאופליין"
              >
                <ListMusic className="w-[18px] h-[18px]" />
                {!labelsOn && !!guidePointCount && (
                  <span className="absolute top-1 left-1 text-[10px] font-bold text-emerald-400">{guidePointCount}</span>
                )}
              </RailBtn>
            )}
          </div>
        )}

        <div className={PILL}>
          <RailBtn
            label="הגדרות"
            labelsOn={labelsOn}
            onClick={() => { setShowLayers(false); onOpenSettings?.(); }}
            title="הגדרות, אזור אישי, שמירה ושיתוף"
          >
            <Settings className="w-[18px] h-[18px]" />
          </RailBtn>
          <RailBtn
            label="הסתר שמות"
            labelsOn={labelsOn}
            onClick={toggleLabels}
            className={`border-t border-white/10 ${labelsOn ? 'text-zinc-400' : 'text-zinc-500'}`}
            title={labelsOn ? 'הסתר את שמות הכפתורים' : 'הצג את שמות הכפתורים'}
            ariaPressed={labelsOn}
          >
            <Tag className="w-[18px] h-[18px]" />
          </RailBtn>
        </div>

        {map && <ScaleBar map={map} />}
      </div>

      {/* Layers popover, anchored beside the rail */}
      {showLayers && (
        <div className="absolute top-3 left-16 z-[47] w-44 bg-zinc-900/95 rounded-2xl border border-white/10 backdrop-blur-md shadow-2xl p-2 flex flex-col gap-1" dir="rtl">
          {([['satellite', 'לוויין'], ['terrain', 'טופוגרפיה'], ['light', 'מפה בהירה']] as const).map(([key, label]) => {
            const locked = !!offlineStyleKey && offlineStyleKey !== key;
            return (
              <button
                key={key}
                onClick={() => { if (locked) return; onStyleChange(key); setShowLayers(false); }}
                disabled={locked}
                title={locked ? 'לא נשמר לשטח — זמין רק עם קליטה' : undefined}
                className={`text-xs p-2 rounded-lg text-right ${locked ? 'text-zinc-600 cursor-not-allowed' : 'text-white hover:bg-white/10'}`}
              >
                {label}{locked ? ' · לא שמור' : ''}
              </button>
            );
          })}
          <button
            onClick={onToggle3D}
            className={`text-xs p-2 rounded-lg font-bold border-t border-white/10 mt-1 pt-2 text-right ${is3D ? 'text-orange-400' : 'text-zinc-400'}`}
          >
            {is3D ? 'תלת מימד פעיל — כבה' : 'תלת מימד כבוי — הפעל'}
          </button>
          {onToggleWorldTrails && (
            <button
              onClick={onToggleWorldTrails}
              aria-pressed={!!showWorldTrails}
              className={`text-xs p-2 rounded-lg font-bold text-right ${showWorldTrails ? 'text-orange-400' : 'text-zinc-400'}`}
              title="מסלולי טיול מסומנים מ-OpenStreetMap, בכל העולם. לחיצה על מסלול פותחת את פרטיו."
            >
              {showWorldTrails ? 'מסלולים בעולם — הסתר' : 'מסלולים בעולם — הצג'}
            </button>
          )}
        </div>
      )}

    </>
  );
}

// Rendered inside the bottom stack in page.tsx so the narration card and the
// tour transport can never cover each other.
export function BottomBar({
  onToggleTour, isTourActive, tourSpeed, onTourSpeedChange, hasTrail, tourProgress, trailKind,
}: Pick<ControlsProps, 'onToggleTour' | 'isTourActive' | 'tourSpeed' | 'onTourSpeedChange' | 'hasTrail' | 'tourProgress'> & { trailKind?: TrailKind }) {
  if (!hasTrail) return null;
  const speeds = tourSpeedsFor(trailKind);

  return (
    <div className="pointer-events-auto flex items-center gap-2" dir="rtl">
      {isTourActive ? (
        <div className="flex items-center bg-zinc-900/90 rounded-2xl p-1.5 border border-white/10 backdrop-blur-md gap-1 shadow-2xl">
          <button
            onClick={onToggleTour}
            className="flex items-center gap-1.5 bg-red-500/20 text-red-400 font-bold px-3 py-2 rounded-xl text-xs hover:bg-red-500/30 transition-colors"
          >
            <Square className="w-3.5 h-3.5" /> עצור
          </button>
          {onTourSpeedChange && speeds.map((s) => (
            <button
              key={s}
              onClick={() => onTourSpeedChange(s)}
              aria-pressed={tourSpeed === s}
              className={`${speeds.length > 3 ? 'px-1.5 text-[11px]' : 'px-2.5 text-xs'} py-2 rounded-xl font-bold ${tourSpeed === s ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}
            >x{s}</button>
          ))}
        </div>
      ) : (
        <button
          onClick={onToggleTour}
          className="flex items-center gap-2 bg-orange-500 text-white text-sm font-bold px-4 py-2.5 rounded-2xl shadow-2xl hover:bg-orange-400 transition-colors"
        >
          <Play className="w-4 h-4" />
          {(tourProgress && tourProgress > 0 && tourProgress < 1) ? 'המשך סיור' : 'סיור וירטואלי'}
        </button>
      )}
    </div>
  );
}
