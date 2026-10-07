import { useState, useEffect, useRef } from "react";
import type mapboxgl from "mapbox-gl";
import ScaleBar from "./ScaleBar";
import { useOutsideTap } from "../hooks/useOutsideTap";
import type { TrailKind } from "../hooks/useTrailData";
import { tourSpeedsFor } from "../hooks/useTour";
import {
  Home, Settings, Headphones, HeadphoneOff,
  ListMusic, Layers, Maximize2, LocateFixed, Play, Square, Eye, Tag, Route, Circle, Pause, Car,
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
  // Recording a walk: the button starts one, or opens the one under way.
  onRecord?: () => void;
  recStatus?: 'idle' | 'recording' | 'paused' | 'review';
  // A drive between two places, on the home screen: the button switches
  // the home screen to the drive planner and back.
  onDrive?: () => void;
  isDriving?: boolean;
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
export const LABELS_KEY = "navi:railLabels";

function RailBtn({
  label, labelsOn, onClick, className = "", title, children, ariaPressed, dataTour, btnRef,
}: {
  btnRef?: React.Ref<HTMLButtonElement>;
  label: string;
  labelsOn: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
  ariaPressed?: boolean;
  // What the first-visit tour points at (see components/help/tours.tsx).
  dataTour?: string;
}) {
  return (
    <button
      ref={btnRef}
      onClick={onClick}
      data-tour={dataTour}
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
    offlineStyleKey, isTracking, onMeasure, isMeasuring, onRecord, recStatus = 'idle', onDrive, isDriving, map,
  } = props;

  const [showLayers, setShowLayers] = useState(false);
  // Where the popover opens: just right of the rail, which is 40px wide with
  // bare icons and much wider with the names showing.
  const [layersLeft, setLayersLeft] = useState(64);
  // The layers popover closes on a tap anywhere else, like every other panel.
  const layersBtnRef = useRef<HTMLButtonElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  useOutsideTap([layersRef, layersBtnRef], showLayers, () => setShowLayers(false));
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
      {/* Left rail — map actions, one tap each. items-end, because in RTL
          that is the left: with items-start the pills lined up on the right
          of the column, which is as wide as the scale bar under them, and so
          stood off the edge of the screen by however long the bar was. */}
      <div className="absolute top-3 left-3 z-[42] flex flex-col items-end gap-2 select-none" dir="rtl" data-tour="rail">
        {/* Out of the open trail, first of all. */}
        {hasTrail && onHome && (
          <div className={PILL}>
            <RailBtn label="בית" labelsOn={labelsOn} onClick={onHome} dataTour="home" className="text-orange-400" title="מסך הבית — יציאה מהמסלול">
              <Home className="w-[18px] h-[18px]" />
            </RailBtn>
          </div>
        )}
        <div className={PILL}>
          <RailBtn
            btnRef={layersBtnRef}
            label="תצוגת מפה"
            labelsOn={labelsOn}
            dataTour="layers"
            onClick={() => {
              const r = layersBtnRef.current?.getBoundingClientRect();
              if (r) setLayersLeft(Math.round(r.right + 8));
              setShowLayers(v => !v);
            }}
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
            dataTour="locate"
            title={isTracking ? 'מיקום חי פעיל — לחיצה ממרכזת את המפה עליי' : 'מיקום חי — הצג את המיקום שלי על המפה ועקוב אחריו'}
            ariaPressed={!!isTracking}
          >
            <LocateFixed className="w-[18px] h-[18px]" />
          </RailBtn>
          {onMeasure && (
            <RailBtn
              label="תכנון מסלול"
              labelsOn={labelsOn}
              dataTour="plan"
              onClick={onMeasure}
              className={`border-t border-white/10 ${isMeasuring ? 'bg-orange-500 text-white' : 'text-orange-300'}`}
              title={hasTrail ? 'תכנון מסלול בין נקודות לאורך המסלול הפתוח, עם המרחק ביניהן' : 'תכנון מסלול הליכה בין נקודות על המפה, עם המרחק ביניהן'}
              ariaPressed={!!isMeasuring}
            >
              <Route className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
          {onRecord && (
            <RailBtn
              label={recStatus === 'recording' ? 'מקליט' : recStatus === 'paused' ? 'מושהה' : 'הקלטה'}
              labelsOn={labelsOn}
              onClick={onRecord}
              className={`border-t border-white/10 ${
                recStatus === 'recording' ? 'bg-red-500/25 text-red-300'
                  : recStatus === 'paused' ? 'bg-amber-500/20 text-amber-300'
                  : 'text-red-400'
              }`}
              dataTour="record"
              title={recStatus === 'idle' ? 'הקלטת מסלול — שומרת את הדרך שהלכת, המרחק, העלייה והזמן' : 'ההקלטה פעילה — לחיצה פותחת אותה'}
              ariaPressed={recStatus !== 'idle'}
            >
              {recStatus === 'paused'
                ? <Pause className="w-[18px] h-[18px]" />
                : <Circle className={`w-[18px] h-[18px] fill-current ${recStatus === 'recording' ? 'animate-pulse' : ''}`} />}
            </RailBtn>
          )}
          {onDrive && (
            <RailBtn
              label="נסיעה ברכב"
              labelsOn={labelsOn}
              onClick={onDrive}
              className={`border-t border-white/10 ${isDriving ? 'bg-orange-500 text-white' : 'text-white'}`}
              dataTour="drive"
              title={isDriving ? 'חזרה למסלולים' : 'נסיעה בכביש — מוצא, יעד ועצירות בדרך'}
              ariaPressed={!!isDriving}
            >
              <Car className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
        </div>

        {hasTrail && (
          <div className={PILL} data-tour="trail-rail">
            <RailBtn label="כל המסלול" labelsOn={labelsOn} onClick={onFitToTrail} dataTour="fit" className="text-amber-400" title="מרכוז התצוגה על כל המסלול">
              <Maximize2 className="w-[18px] h-[18px]" />
            </RailBtn>
            {onToggleGuide && (
              <RailBtn
                label={isGuideEnabled ? 'מדריכה פעילה' : 'מדריכה כבויה'}
                labelsOn={labelsOn}
                dataTour="guide"
                onClick={onToggleGuide}
                className={`border-t border-white/10 ${isGuideEnabled ? 'text-emerald-400' : 'text-white'}`}
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
                dataTour="points"
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
            dataTour="settings"
            title="הגדרות, אזור אישי, שמירה ושיתוף"
          >
            <Settings className="w-[18px] h-[18px]" />
          </RailBtn>
          {onHideUI && (
            <RailBtn
              label="הסתר הכל"
              labelsOn={labelsOn}
              dataTour="hide-all"
              onClick={onHideUI}
              className="border-t border-white/10 text-amber-400"
              title="הסתר את כל הנתונים מהמפה"
            >
              <Eye className="w-[18px] h-[18px]" />
            </RailBtn>
          )}
          <RailBtn
            label="הסתר שמות"
            labelsOn={labelsOn}
            dataTour="labels"
            onClick={toggleLabels}
            className="border-t border-white/10 text-white"
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
        <div ref={layersRef} style={{ left: layersLeft }} className="absolute top-3 z-[47] w-56 bg-zinc-900/95 rounded-2xl border border-white/10 backdrop-blur-md shadow-2xl p-2 flex flex-col gap-1" dir="rtl">
          {([['satellite', 'לוויין'], ['terrain', 'טופוגרפיה'], ['light', 'מפה בהירה']] as const).map(([key, label]) => {
            const locked = !!offlineStyleKey && offlineStyleKey !== key;
            return (
              <button
                key={key}
                onClick={() => { if (locked) return; onStyleChange(key); setShowLayers(false); }}
                disabled={locked}
                title={locked ? 'לא נשמר לשטח — זמין רק עם קליטה' : undefined}
                className={`text-sm p-2 rounded-lg text-right ${locked ? 'text-white/60 cursor-not-allowed' : 'text-white hover:bg-white/10'}`}
              >
                {label}{locked ? ' · לא שמור' : ''}
              </button>
            );
          })}
          <button
            onClick={onToggle3D}
            className={`text-sm p-2 rounded-lg font-bold border-t border-white/10 mt-1 pt-2 text-right ${is3D ? 'text-orange-400' : 'text-white'}`}
          >
            {is3D ? 'תלת מימד פעיל — כבה' : 'תלת מימד כבוי — הפעל'}
          </button>
          {onToggleWorldTrails && (
            <button
              onClick={onToggleWorldTrails}
              aria-pressed={!!showWorldTrails}
              className={`text-sm p-2 rounded-lg font-bold text-right ${showWorldTrails ? 'text-orange-400' : 'text-white'}`}
              title="מסלולי טיול מסומנים מ-OpenStreetMap, בכל העולם. לחיצה על מסלול פותחת את פרטיו."
            >
              {showWorldTrails ? 'מסלולים בעולם — הסתר' : 'מסלולים בעולם — הצג'}
            </button>
          )}
          <MapLegend />
        </div>
      )}

    </>
  );
}

// What the marks drawn on the map mean. The colours are the ones page.tsx
// paints the layers with; change one there, change it here.
function MapLegend() {
  const dot = (fill: string, stroke: string) => (
    <span className="w-3 h-3 rounded-full shrink-0 border-2" style={{ background: fill, borderColor: stroke }} />
  );
  const line = (color: string) => <span className="w-4 h-1.5 rounded-full shrink-0" style={{ background: color }} />;
  const items: Array<[React.ReactNode, string]> = [
    [line('#f97316'), 'מסלול טיול'],
    [line('#3b82f6'), 'מסלול נסיעה'],
    [dot('#22d3ee', '#ffffff'), 'נקודת מדריכה — לחיצה משמיעה'],
    [dot('#0ea5e9', '#e0f2fe'), 'מים לרחצה'],
    [dot('#1e293b', '#7dd3fc'), 'מים לרחצה — לא מאומת'],
    [dot('#38bdf8', '#ffffff'), 'המיקום שלכם'],
  ];
  return (
    <div className="border-t border-white/10 mt-1 pt-2 px-2 pb-1 flex flex-col gap-1.5">
      <div className="text-white text-xs font-bold">מקרא</div>
      {items.map(([mark, label]) => (
        <div key={label} className="flex items-center gap-2 text-white text-xs">
          <span className="w-4 flex justify-center">{mark}</span>{label}
        </div>
      ))}
    </div>
  );
}

// Rendered inside the bottom stack in page.tsx so the narration card and the
// tour transport can never cover each other.
export function BottomBar({
  onToggleTour, isTourActive, tourSpeed, onTourSpeedChange, hasTrail, tourProgress, trailKind,
}: Pick<ControlsProps, 'onToggleTour' | 'isTourActive' | 'tourSpeed' | 'onTourSpeedChange' | 'hasTrail' | 'tourProgress'> & { trailKind?: TrailKind }) {
  // A new speed says so, briefly, above the buttons: on screen the ground does
  // not look anywhere near five times faster (the camera pulls back as it
  // speeds up), and a press that seems to do nothing gets pressed again.
  const [speedNote, setSpeedNote] = useState<number | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (noteTimer.current) clearTimeout(noteTimer.current); }, []);
  const chooseSpeed = (s: number) => {
    onTourSpeedChange?.(s);
    setSpeedNote(s);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setSpeedNote(null), 1800);
  };

  if (!hasTrail) return null;
  const speeds = tourSpeedsFor(trailKind);

  return (
    <div className="pointer-events-auto relative flex items-center gap-2" dir="rtl" data-tour="tour-button">
      {isTourActive && speedNote != null && (
        <div role="status" className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 whitespace-nowrap bg-orange-500 text-white text-sm font-bold px-3 py-1.5 rounded-full shadow-2xl pointer-events-none">
          מהירות x{speedNote}{speedNote > 1 ? ` — פי ${speedNote} מהר יותר` : ' — רגילה'}
        </div>
      )}
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
              onClick={() => chooseSpeed(s)}
              aria-pressed={tourSpeed === s}
              className={`${speeds.length > 3 ? 'px-1.5 text-[11px]' : 'px-2.5 text-xs'} py-2 rounded-xl font-bold ${tourSpeed === s ? 'bg-orange-500 text-white' : 'text-white hover:bg-white/10'}`}
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
