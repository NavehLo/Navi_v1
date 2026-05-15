import { TrailData } from "../hooks/useTrailData";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { useState, useEffect } from "react";

export default function StatsPanel({ trail, progress, onClose, isTourActive }: { trail: TrailData, progress: number, onClose?: () => void, isTourActive?: boolean }) {
  const [collapsed, setCollapsed] = useState(isTourActive || false);

  useEffect(() => {
    if (isTourActive) {
      setCollapsed(true);
    }
  }, [isTourActive]);
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

  if (collapsed) {
    return (
      <div className={`absolute ${isTourActive ? 'top-[140px] md:top-[120px]' : 'bottom-16'} left-4 right-4 md:top-4 md:right-4 md:left-auto md:bottom-auto bg-zinc-900/90 p-4 rounded-2xl shadow-xl border border-white/10 z-10 md:w-96 backdrop-blur-md flex justify-between items-center transition-all`} dir="rtl">
        <div className="flex items-center gap-3 overflow-hidden">
          {onClose && (
            <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0">
              <ArrowRight className="w-4 h-4 text-zinc-300" />
            </button>
          )}
          <div className="text-white font-bold text-sm truncate" title={trail.name}>{trail.name}</div>
        </div>
        <button onClick={() => {
          if (!isTourActive) setCollapsed(false);
          else alert("אנא עצור את הסיור כדי להרחיב את נתוני המסלול.");
        }} className="text-xs bg-white/10 text-white px-3 py-1.5 rounded-full hover:bg-white/20 flex-shrink-0 mr-2 flex items-center gap-1">
          <ChevronUp className="w-3 h-3" />
          הרחב
        </button>
      </div>
    );
  }

  return (
    <div className={`absolute ${isTourActive ? 'top-[140px] md:top-[120px]' : 'bottom-16'} left-4 right-4 md:top-4 md:right-4 md:left-auto md:bottom-auto bg-zinc-900/90 p-5 md:p-6 rounded-3xl shadow-xl border border-white/10 z-10 md:w-96 backdrop-blur-md transition-all`} dir="rtl">
      <div className="flex justify-between items-center gap-4">
        {onClose && (
          <button 
            onClick={onClose} 
            className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
            title="חזור למפה"
          >
            <ArrowRight className="w-5 h-5 text-zinc-300" />
          </button>
        )}
        <div className="text-lg md:text-xl font-bold text-white tracking-tight truncate flex-1" title={trail.name}>{trail.name}</div>
        <button onClick={() => setCollapsed(true)} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0">
          <ChevronDown className="w-5 h-5 text-zinc-300" />
        </button>
      </div>
      <div className="flex justify-between border-t border-white/10 pt-4 mt-4">
        <div className="text-center flex-1 z-border-l border-white/5 last:border-0 px-2">
          <div className="text-xs text-zinc-400 uppercase tracking-widest mb-1.5 font-bold">אורך מסלול</div>
          <div className="text-2xl font-bold text-sky-400">
            {trail.totalDistance.toFixed(1)}
            <span className="text-sm font-normal text-zinc-500 mr-1">ק"מ</span>
          </div>
        </div>
        <div className="text-center flex-1 border-r border-white/5 px-2">
          <div className="text-xs text-zinc-400 uppercase tracking-widest mb-1.5 font-bold">גובה מינימלי</div>
          <div className="text-2xl font-bold text-red-400">
            {Math.round(trail.minEle)}
            <span className="text-sm font-normal text-zinc-500 mr-1">מ'</span>
          </div>
        </div>
        <div className="text-center flex-1 border-r border-white/5 px-2">
          <div className="text-xs text-zinc-400 uppercase tracking-widest mb-1.5 font-bold">גובה מקסימלי</div>
          <div className="text-2xl font-bold text-emerald-400">
            {Math.round(trail.maxEle)}
            <span className="text-sm font-normal text-zinc-500 mr-1">מ'</span>
          </div>
        </div>
      </div>
      <div className="mt-5 border-t border-white/10 pt-4 relative" dir="ltr">
        <div className="text-xs text-zinc-400 uppercase tracking-widest mb-3 text-right font-bold">פרופיל גובה</div>
        <div className="relative w-full h-20 bg-zinc-800 rounded-lg overflow-hidden">
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
    </div>
  );
}
