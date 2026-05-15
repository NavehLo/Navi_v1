export default function Controls({
    onStyleChange,
    onToggle3D,
    is3D,
    onToggleTour,
    isTourActive,
    tourSpeed,
    onTourSpeedChange,
    onLocateUser,
    onZoomIn,
    onZoomOut,
    onCompass,
    mapBearing,
    onFitToTrail,
    hasTrail,
  }: {
    onStyleChange: (style: string) => void;
    onToggle3D: () => void;
    is3D: boolean;
    onToggleTour: () => void;
    isTourActive: boolean;
    tourSpeed?: number;
    onTourSpeedChange?: (speed: number) => void;
    onLocateUser: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onCompass: () => void;
    mapBearing: number;
    onFitToTrail: () => void;
    hasTrail: boolean;
  }) {
    return (
      <div className="absolute left-4 top-4 flex flex-col gap-3 z-10 w-48">

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
            חזור למסלול
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

        {/* Virtual tour */}
        <div className="flex flex-col bg-zinc-900/90 rounded-lg p-1.5 border border-white/10 backdrop-blur-md gap-1">
          <button
            onClick={onToggleTour}
            className={`w-full text-sm font-bold py-2.5 rounded transition-colors ${isTourActive ? 'bg-red-500/20 text-red-400' : 'bg-orange-500 text-white'}`}
          >
            {isTourActive ? 'עצור סיור' : 'סיור וירטואלי'}
          </button>
          
          {isTourActive && onTourSpeedChange && (
            <div className="flex gap-1 border-t border-white/5 pt-1">
              <button 
                onClick={() => onTourSpeedChange(1)} 
                className={`flex-1 text-xs py-1.5 rounded font-bold ${tourSpeed === 1 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}
              >
                x1
              </button>
              <button 
                onClick={() => onTourSpeedChange(2)} 
                className={`flex-1 text-xs py-1.5 rounded font-bold ${tourSpeed === 2 ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:bg-white/10'}`}
              >
                x2
              </button>
            </div>
          )}
        </div>

      </div>
    );
  }
