import { Home, Settings, UserCircle2, BookmarkPlus, Check } from "lucide-react";

export default function Controls({
    onStyleChange,
    onToggle3D,
    is3D,
    onToggleTour,
    isTourActive,
    tourSpeed,
    onTourSpeedChange,
    onLocateUser,
    isFieldMode,
    onToggleFieldMode,
    onZoomIn,
    onZoomOut,
    onCompass,
    mapBearing,
    onFitToTrail,
    hasTrail,
    onHome,
    tourProgress,
    onOpenSettings,
    authAvailable,
    isSignedIn,
    onAuthClick,
    onSaveTrail,
    saveTrailState,
  }: {
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
  }) {
    return (
      <>
        {/* Persistent Home Button */}
        {hasTrail && onHome && (
          <div className="absolute top-4 right-4 z-30 bg-zinc-900/90 rounded-full p-2 border border-white/10 backdrop-blur-md shadow-2xl">
            <button
              onClick={onHome}
              className="flex items-center justify-center text-white hover:text-orange-400 transition-colors rounded-full"
              title="מסך הבית"
            >
              <Home className="w-5 h-5" />
            </button>
          </div>
        )}

        {isTourActive ? (
          <div className="absolute bottom-12 left-4 right-4 md:left-1/2 md:top-auto md:right-auto md:-translate-x-1/2 flex flex-col md:flex-row gap-2 z-20" dir="rtl">
            {/* Virtual Tour Primary Button */}
            <div className="flex bg-zinc-900/90 rounded-xl p-1.5 border border-white/10 backdrop-blur-md gap-1 shadow-2xl flex-1 md:w-48">
              <button
                onClick={onToggleTour}
                className="flex-1 bg-red-500/20 text-red-400 font-bold py-2 rounded-lg text-sm hover:bg-red-500/30 transition-colors"
              >
                עצור סיור
              </button>
              {onTourSpeedChange && (
                <div className="flex gap-1">
                  <button onClick={() => onTourSpeedChange(1)} className={`px-2 md:px-3 text-xs rounded-lg font-bold ${tourSpeed === 1 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}>x1</button>
                  <button onClick={() => onTourSpeedChange(2)} className={`px-2 md:px-3 text-xs rounded-lg font-bold ${tourSpeed === 2 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}>x2</button>
                </div>
              )}
            </div>

            {/* Secondary Compact Controls */}
            <div className="flex gap-2 h-10 md:h-auto">
              <div className="flex flex-1 md:w-32 bg-zinc-900/90 rounded-xl border border-white/10 backdrop-blur-md overflow-hidden shadow-2xl">
                <button onClick={onZoomIn} className="flex-1 text-white text-lg font-bold hover:bg-white/10 transition-colors border-l border-white/10">+</button>
                <button onClick={onCompass} className="flex-1 flex items-center justify-center hover:bg-white/10 transition-colors border-l border-white/10" title="הצפן למצפן צפון">
                  <svg width="16" height="16" viewBox="0 0 18 18" style={{ transform: `rotate(${-mapBearing}deg)`, transition: 'transform 0.15s linear' }}>
                    <polygon points="9,1 11,9 9,8 7,9" fill="#ef4444" />
                    <polygon points="9,17 11,9 9,10 7,9" fill="#a1a1aa" />
                  </svg>
                </button>
                <button onClick={onZoomOut} className="flex-1 text-white text-lg font-bold hover:bg-white/10 transition-colors">&#8722;</button>
              </div>
              <div className="flex md:w-16 bg-zinc-900/90 rounded-xl border border-white/10 backdrop-blur-md p-1 shadow-2xl">
                <button onClick={onToggle3D} className={`flex-1 text-xs px-4 md:px-0 rounded-lg transition-colors ${is3D ? 'bg-orange-500 text-white font-bold' : 'text-zinc-400 hover:bg-white/10'}`}>
                  {is3D ? '3D' : '2D'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute left-4 top-4 flex flex-col gap-3 z-10 w-48" dir="rtl">
            {/* Settings + personal area */}
            <div className="flex gap-2">
              {onOpenSettings && (
                <button
                  onClick={onOpenSettings}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-zinc-900/90 rounded-lg border border-white/10 backdrop-blur-md text-xs text-zinc-300 font-bold py-2 hover:bg-white/10 transition-colors"
                  title="הגדרות"
                >
                  <Settings size={14} /> הגדרות
                </button>
              )}
              {authAvailable && onAuthClick && (
                <button
                  onClick={onAuthClick}
                  className={`flex-1 flex items-center justify-center gap-1.5 bg-zinc-900/90 rounded-lg border backdrop-blur-md text-xs font-bold py-2 transition-colors ${
                    isSignedIn
                      ? 'border-orange-500/40 text-orange-400 hover:bg-orange-500/10'
                      : 'border-white/10 text-zinc-300 hover:bg-white/10'
                  }`}
                  title={isSignedIn ? 'האזור האישי' : 'התחבר עם Google'}
                >
                  <UserCircle2 size={14} /> {isSignedIn ? 'אזור אישי' : 'התחבר'}
                </button>
              )}
            </div>

            {/* Map style + live location */}
            <div className="flex flex-col bg-zinc-900/90 rounded-lg p-1.5 border border-white/10 backdrop-blur-md gap-1">
              <div className="flex gap-1">
                <button onClick={() => onStyleChange('satellite')} className="flex-1 text-[11px] text-white p-2 hover:bg-white/10 rounded">לוויין</button>
                <button onClick={() => onStyleChange('terrain')} className="flex-1 text-[11px] text-white p-2 hover:bg-white/10 rounded">טופוגרפיה</button>
              </div>
              <button
                onClick={onLocateUser}
                className="text-xs text-sky-400 p-2 hover:bg-white/10 rounded text-center border-t border-white/5 font-bold"
              >
                מיקום חי
              </button>
              {hasTrail && onToggleFieldMode && (
                <button
                  onClick={onToggleFieldMode}
                  className={`text-xs p-2 rounded text-center border-t border-white/5 font-bold transition-colors ${isFieldMode ? 'bg-sky-500 text-white' : 'text-sky-400 hover:bg-white/10'}`}
                  title="מעקב GPS רציף — המדריך יופעל אוטומטית ליד נקודות עניין"
                >
                  {isFieldMode ? 'מצב שטח פעיל' : 'מצב שטח'}
                </button>
              )}
            </div>

            {/* Zoom + Compass */}
            <div className="flex bg-zinc-900/90 rounded-lg border border-white/10 backdrop-blur-md overflow-hidden">
              <button onClick={onZoomIn} className="flex-1 text-white text-lg font-bold py-2 hover:bg-white/10 transition-colors border-l border-white/10">+</button>
              <button
                onClick={onCompass}
                className="flex-1 flex items-center justify-center py-2 hover:bg-white/10 transition-colors border-l border-white/10"
                title="הצפן למצפן צפון"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: `rotate(${-mapBearing}deg)`, transition: 'transform 0.15s linear' }}>
                  <polygon points="9,1 11,9 9,8 7,9" fill="#ef4444" />
                  <polygon points="9,17 11,9 9,10 7,9" fill="#a1a1aa" />
                </svg>
              </button>
              <button onClick={onZoomOut} className="flex-1 text-white text-lg font-bold py-2 hover:bg-white/10 transition-colors">&#8722;</button>
            </div>

            {/* Fit to trail */}
            {hasTrail && (
              <button
                onClick={onFitToTrail}
                className="w-full bg-zinc-900/90 rounded-lg border border-white/10 backdrop-blur-md text-xs text-amber-400 font-bold py-2 px-3 hover:bg-white/10 transition-colors"
              >
                חזור למפת המסלול
              </button>
            )}

            {/* Save trail to personal area */}
            {hasTrail && isSignedIn && onSaveTrail && (
              <button
                onClick={onSaveTrail}
                disabled={saveTrailState !== 'idle'}
                className={`w-full flex items-center justify-center gap-1.5 rounded-lg border backdrop-blur-md text-xs font-bold py-2 px-3 transition-colors ${
                  saveTrailState === 'saved'
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                    : 'bg-zinc-900/90 border-white/10 text-sky-400 hover:bg-white/10'
                }`}
              >
                {saveTrailState === 'saved' ? (
                  <><Check size={14} /> נשמר באזור האישי</>
                ) : saveTrailState === 'saving' ? (
                  'שומר...'
                ) : (
                  <><BookmarkPlus size={14} /> שמור מסלול</>
                )}
              </button>
            )}

            {/* 3D / 2D toggle */}
            <div className="flex bg-zinc-900/90 rounded-lg p-1.5 border border-white/10 backdrop-blur-md">
              <button
                onClick={onToggle3D}
                className={`flex-1 text-xs p-2 rounded transition-colors ${is3D ? 'bg-orange-500 text-white font-bold' : 'text-zinc-400 hover:bg-white/10'}`}
              >
                {is3D ? '3D' : '2D'}
              </button>
            </div>

            {/* Virtual tour start */}
            <div className="flex flex-col bg-zinc-900/90 rounded-lg p-1.5 border border-white/10 backdrop-blur-md gap-1">
              <button
                onClick={onToggleTour}
                className="w-full text-sm font-bold py-2.5 rounded transition-colors bg-orange-500 text-white hover:bg-orange-400"
              >
                {(tourProgress && tourProgress > 0 && tourProgress < 1) ? 'המשך סיור' : 'סיור וירטואלי'}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }
