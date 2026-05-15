import { TrailData } from "../hooks/useTrailData";
import { X, ArrowRight } from "lucide-react";

export default function StatsPanel({ trail, progress, onClose }: { trail: TrailData, progress: number, onClose?: () => void }) {
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

  return (
    <div className="absolute top-4 right-4 bg-zinc-900/90 p-6 rounded-3xl shadow-xl border border-white/10 z-10 w-96 backdrop-blur-md transition-all">
      <div className="flex items-center gap-4">
        {onClose && (
          <button 
            onClick={onClose} 
            className="p-2.5 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
            title="חזור למפה"
          >
            <ArrowRight className="w-6 h-6 text-zinc-300" />
          </button>
        )}
        <div className="text-xl font-bold text-white tracking-tight truncate flex-1" title={trail.name}>{trail.name}</div>
      </div>
      <div className="flex justify-between border-t border-white/10 pt-4 mt-5">
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
