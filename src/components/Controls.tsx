import { useState } from "react";
import {
  Home, Settings, UserCircle2, BookmarkPlus, Check, Share2, Headphones, HeadphoneOff,
  ListMusic, Layers, Maximize2, LocateFixed, Footprints, Play, Square, Eye, MoreHorizontal, X,
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
  isFieldMode?: boolean;
  onToggleFieldMode?: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onCompass: () => void;
  mapBearing: number;
  onFitToTrail: () => void;
  hasTrail: boolean;
  onHome?: () => void;
  tourProgress?: number;
  onOpenSettings?: () => void;
  authAvailable?: boolean;
  isSignedIn?: boolean;
  onAuthClick?: () => void;
  onSaveTrail?: () => void;
  saveTrailState?: 'idle' | 'saving' | 'saved';
  canShare?: boolean;
  onShare?: () => void;
  isGuideEnabled?: boolean;
  onToggleGuide?: () => void;
  onOpenGuidePoints?: () => void;
  guidePointCount?: number;
  onHideUI?: () => void;
}

// A 44px icon rail instead of the old 192px labelled column: the map is the
// point of the app, and on a phone the chrome was eating most of it. Anything
// that is not a one-tap map action lives behind the "עוד" sheet.
const RAIL_BTN =
  "w-10 h-10 flex items-center justify-center text-zinc-200 hover:bg-white/10 active:bg-white/20 transition-colors";
const PILL =
  "flex flex-col bg-zinc-900/90 rounded-2xl border border-white/10 backdrop-blur-md overflow-hidden shadow-xl";

export default function Controls(props: ControlsProps) {
  const {
    onStyleChange, onToggle3D, is3D,
    onLocateUser, isFieldMode, onToggleFieldMode, onZoomIn, onZoomOut, onCompass, mapBearing,
    onFitToTrail, hasTrail, onHome, onOpenSettings, authAvailable, isSignedIn,
    onAuthClick, onSaveTrail, saveTrailState, canShare, onShare, isGuideEnabled, onToggleGuide,
    onOpenGuidePoints, guidePointCount, onHideUI,
  } = props;

  const [showLayers, setShowLayers] = useState(false);
  const [showMore, setShowMore] = useState(false);

  const compass = (
    <svg width="17" height="17" viewBox="0 0 18 18" style={{ transform: `rotate(${-mapBearing}deg)`, transition: 'transform 0.15s linear' }}>
      <polygon points="9,1 11,9 9,8 7,9" fill="#ef4444" />
      <polygon points="9,17 11,9 9,10 7,9" fill="#a1a1aa" />
    </svg>
  );

  return (
    <>
      {/* Top-right: home + hide-everything */}
      <div className="absolute top-3 right-3 z-30 flex flex-col gap-2" dir="rtl">
        <div className={PILL}>
          {hasTrail && onHome && (
            <button onClick={onHome} className={RAIL_BTN} title="מסך הבית">
              <Home className="w-[18px] h-[18px]" />
            </button>
          )}
          {onHideUI && (
            <button onClick={onHideUI} className={`${RAIL_BTN} text-amber-400 ${hasTrail && onHome ? 'border-t border-white/10' : ''}`} title="הסתר את כל הנתונים מהמפה">
              <Eye className="w-[18px] h-[18px]" />
            </button>
          )}
        </div>
      </div>

      {/* Left rail — map actions, one tap each */}
      <div className="absolute top-3 left-3 z-20 flex flex-col gap-2" dir="rtl">
        <div className={PILL}>
          <button
            onClick={() => { setShowLayers(v => !v); setShowMore(false); }}
            className={`${RAIL_BTN} ${showLayers ? 'bg-white/10 text-orange-400' : ''}`}
            title="סוג מפה ותלת מימד"
          >
            <Layers className="w-[18px] h-[18px]" />
          </button>
          <button onClick={onZoomIn} className={`${RAIL_BTN} text-lg font-bold border-t border-white/10`} title="התקרב">+</button>
          <button onClick={onCompass} className={`${RAIL_BTN} border-t border-white/10`} title="הצפן למצפן צפון">{compass}</button>
          <button onClick={onZoomOut} className={`${RAIL_BTN} text-lg font-bold border-t border-white/10`} title="התרחק">&#8722;</button>
        </div>

        {hasTrail && (
          <div className={PILL}>
            <button onClick={onFitToTrail} className={`${RAIL_BTN} text-amber-400`} title="חזור למפת המסלול">
              <Maximize2 className="w-[18px] h-[18px]" />
            </button>
            <button onClick={onLocateUser} className={`${RAIL_BTN} text-sky-400 border-t border-white/10`} title="מיקום חי — קפיצה חד-פעמית למיקום שלי על המפה">
              <LocateFixed className="w-[18px] h-[18px]" />
            </button>
            {onToggleFieldMode && (
              <button
                onClick={onToggleFieldMode}
                className={`${RAIL_BTN} border-t border-white/10 ${isFieldMode ? 'bg-sky-500 text-white' : 'text-sky-400'}`}
                title={isFieldMode
                  ? 'מצב שטח פעיל — מעקב GPS רציף, המדריכה נכנסת אוטומטית כשמגיעים לנקודה'
                  : 'מצב שטח — לטיול אמיתי ברגליים: מעקב GPS רציף שמפעיל את המדריכה לפי המיקום'}
                aria-pressed={isFieldMode}
              >
                <Footprints className="w-[18px] h-[18px]" />
              </button>
            )}
            {onToggleGuide && (
              <button
                onClick={onToggleGuide}
                className={`${RAIL_BTN} border-t border-white/10 ${isGuideEnabled ? 'text-emerald-400' : 'text-zinc-500'}`}
                title={isGuideEnabled ? 'המדריכה פעילה — לחץ לכיבוי' : 'המדריכה כבויה — לחץ להפעלה'}
                aria-pressed={isGuideEnabled}
              >
                {isGuideEnabled ? <Headphones className="w-[18px] h-[18px]" /> : <HeadphoneOff className="w-[18px] h-[18px]" />}
              </button>
            )}
            {onOpenGuidePoints && (
              <button onClick={onOpenGuidePoints} className={`${RAIL_BTN} border-t border-white/10 relative`} title="נקודות המדריכה במסלול והורדה לאופליין">
                <ListMusic className="w-[18px] h-[18px]" />
                {!!guidePointCount && (
                  <span className="absolute top-1 left-1 text-[9px] font-bold text-emerald-400">{guidePointCount}</span>
                )}
              </button>
            )}
          </div>
        )}

        <div className={PILL}>
          <button
            onClick={() => { setShowMore(v => !v); setShowLayers(false); }}
            className={`${RAIL_BTN} ${showMore ? 'bg-white/10 text-orange-400' : ''}`}
            title="עוד — הגדרות, אזור אישי, שמירה ושיתוף"
          >
            <MoreHorizontal className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      {/* Layers popover, anchored beside the rail */}
      {showLayers && (
        <div className="absolute top-3 left-16 z-30 w-44 bg-zinc-900/95 rounded-2xl border border-white/10 backdrop-blur-md shadow-2xl p-2 flex flex-col gap-1" dir="rtl">
          <button onClick={() => { onStyleChange('satellite'); setShowLayers(false); }} className="text-xs text-white p-2 hover:bg-white/10 rounded-lg text-right">לוויין</button>
          <button onClick={() => { onStyleChange('terrain'); setShowLayers(false); }} className="text-xs text-white p-2 hover:bg-white/10 rounded-lg text-right">טופוגרפיה</button>
          <button onClick={() => { onStyleChange('light'); setShowLayers(false); }} className="text-xs text-white p-2 hover:bg-white/10 rounded-lg text-right">מפה בהירה</button>
          <button
            onClick={onToggle3D}
            className={`text-xs p-2 rounded-lg font-bold border-t border-white/10 mt-1 pt-2 text-right ${is3D ? 'text-orange-400' : 'text-zinc-400'}`}
          >
            {is3D ? 'תלת מימד פעיל — כבה' : 'תלת מימד כבוי — הפעל'}
          </button>
        </div>
      )}

      {/* "More" sheet — everything that is not a map action */}
      {showMore && (
        <div className="absolute inset-0 z-40 bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center p-4" onClick={() => setShowMore(false)}>
          <div className="bg-zinc-900/95 border border-white/10 rounded-3xl w-full max-w-sm shadow-2xl p-4 flex flex-col gap-2" dir="rtl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-white font-bold text-sm">עוד</h3>
              <button onClick={() => setShowMore(false)} className="text-zinc-500 hover:text-white p-1"><X size={18} /></button>
            </div>

            {onOpenSettings && (
              <button onClick={() => { setShowMore(false); onOpenSettings(); }} className="flex items-center gap-2.5 text-sm text-zinc-200 font-bold p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                <Settings size={16} /> הגדרות
              </button>
            )}
            {authAvailable && onAuthClick && (
              <button
                onClick={() => { setShowMore(false); onAuthClick(); }}
                className={`flex items-center gap-2.5 text-sm font-bold p-3 rounded-xl transition-colors ${isSignedIn ? 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20' : 'bg-white/5 text-zinc-200 hover:bg-white/10'}`}
              >
                <UserCircle2 size={16} /> {isSignedIn ? 'אזור אישי' : 'התחבר עם Google'}
              </button>
            )}
            {hasTrail && isSignedIn && onSaveTrail && (
              <button
                onClick={onSaveTrail}
                disabled={saveTrailState !== 'idle'}
                className={`flex items-center gap-2.5 text-sm font-bold p-3 rounded-xl transition-colors disabled:opacity-60 ${
                  saveTrailState === 'saved' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/5 text-sky-400 hover:bg-white/10'
                }`}
              >
                {saveTrailState === 'saved' ? <><Check size={16} /> נשמר באזור האישי</>
                  : saveTrailState === 'saving' ? <><BookmarkPlus size={16} /> שומר...</>
                  : <><BookmarkPlus size={16} /> שמור מסלול</>}
              </button>
            )}
            {hasTrail && canShare && onShare && (
              <button onClick={() => { setShowMore(false); onShare(); }} className="flex items-center gap-2.5 text-sm text-emerald-400 font-bold p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                <Share2 size={16} /> שתף מסלול
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Rendered inside the bottom stack in page.tsx so the narration card and the
// tour transport can never cover each other.
export function BottomBar({
  onToggleTour, isTourActive, tourSpeed, onTourSpeedChange, hasTrail, tourProgress,
}: Pick<ControlsProps, 'onToggleTour' | 'isTourActive' | 'tourSpeed' | 'onTourSpeedChange' | 'hasTrail' | 'tourProgress'>) {
  if (!hasTrail) return null;

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
          {onTourSpeedChange && (
            <>
              <button onClick={() => onTourSpeedChange(1)} className={`px-2.5 py-2 text-xs rounded-xl font-bold ${tourSpeed === 1 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}>x1</button>
              <button onClick={() => onTourSpeedChange(2)} className={`px-2.5 py-2 text-xs rounded-xl font-bold ${tourSpeed === 2 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}>x2</button>
            </>
          )}
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
