import { X, ExternalLink, BookOpen, Download, Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import type { WorldTrailSelection } from '../hooks/useWorldTrails';
import { groupLabel, wikipediaUrl } from '../lib/waymarked';

// The card that opens when a route in the world trails overlay is tapped.
// Sits where the stats card sits, so the two never share the screen — a
// tapped route either becomes the open trail or gets closed.
export default function WorldTrailCard({
  selection, onClose, onLoad,
}: {
  selection: WorldTrailSelection;
  onClose: () => void;
  onLoad: () => void;
}) {
  const d = selection.details;
  const name = d?.name ?? selection.summary?.name ?? 'מסלול מסומן';
  const group = d?.group ?? selection.summary?.group ?? '';
  const wiki = wikipediaUrl(d?.wikipedia);
  const canLoad = selection.status === 'ok' && selection.coords.length >= 2;
  const elevationPending = selection.status === 'ok' && selection.elevationStatus === 'loading';
  const hasElevation = selection.elevationStatus === 'ok' && selection.gain != null;

  return (
    <div
      className="absolute left-3 right-3 bottom-[76px] md:left-auto md:right-6 md:top-6 md:bottom-auto md:w-[360px] z-[45] bg-black/85 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl p-4 flex flex-col gap-3 max-h-[60vh] md:max-h-[calc(100vh-3rem)] overflow-y-auto"
      dir="rtl"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-orange-400 font-bold uppercase tracking-widest">{groupLabel(group)}</div>
          <div className="text-lg font-extrabold text-white leading-tight break-words">{name}</div>
        </div>
        <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0" title="סגור">
          <X className="w-4 h-4 text-zinc-300" />
        </button>
      </div>

      {selection.status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="w-4 h-4 animate-spin" /> טוען פרטים…
        </div>
      )}

      {(selection.status === 'unavailable' || selection.status === 'rate-limited') && (
        <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
          {selection.status === 'rate-limited'
            ? 'יותר מדי בקשות ברגע זה — נסה שוב בעוד רגע.'
            : 'פרטי המסלול לא זמינים כרגע. שירות Waymarked Trails לא ענה.'}
        </div>
      )}

      {d && (
        <>
          <div className="flex justify-between border-t border-white/10 pt-3">
            <Stat label="אורך" value={selection.lengthKm != null ? selection.lengthKm.toFixed(1) : '—'} unit={'ק"מ'} color="text-sky-400" />
            <Stat
              label="עלייה"
              value={hasElevation ? String(selection.gain) : elevationPending ? '…' : '—'}
              unit="מ'"
              color="text-emerald-400"
              icon={<TrendingUp className="w-3 h-3 inline ml-1" />}
            />
            <Stat
              label="ירידה"
              value={hasElevation ? String(selection.loss) : elevationPending ? '…' : '—'}
              unit="מ'"
              color="text-red-400"
              icon={<TrendingDown className="w-3 h-3 inline ml-1" />}
            />
          </div>

          {hasElevation && selection.minEle != null && selection.maxEle != null && (
            <div className="text-xs text-zinc-400 text-center -mt-1">
              גובה {selection.minEle} עד {selection.maxEle} {"מ'"}
            </div>
          )}
          {selection.elevationStatus !== 'ok' && selection.elevationStatus !== 'loading' && (
            <div className="text-xs text-zinc-500 text-center -mt-1">נתוני גובה לא זמינים למסלול הזה</div>
          )}

          {selection.partial && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 leading-relaxed">
              המסלול מפוצל ב־OpenStreetMap ל־{selection.segmentCount} קטעים נפרדים. {'"טען מסלול"'} יטען את הקטע הארוך ביותר.
            </div>
          )}

          {d.description && (
            <p className="text-xs text-zinc-300 leading-relaxed line-clamp-4">{d.description}</p>
          )}

          <div className="flex flex-col gap-1 text-xs text-zinc-400">
            {d.operator && <div><span className="text-zinc-500">מפעיל:</span> {d.operator}</div>}
            {d.symbol_description && <div><span className="text-zinc-500">סימון:</span> {d.symbol_description}</div>}
          </div>

          {(wiki || d.url) && (
            <div className="flex flex-wrap gap-2">
              {wiki && (
                <a href={wiki} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full transition-colors">
                  <BookOpen className="w-3.5 h-3.5" /> ויקיפדיה
                </a>
              )}
              {d.url && (
                <a href={d.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-full transition-colors">
                  <ExternalLink className="w-3.5 h-3.5" /> אתר המסלול
                </a>
              )}
            </div>
          )}

          <button
            onClick={onLoad}
            disabled={!canLoad}
            className="flex items-center justify-center gap-2 bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white text-sm font-bold px-4 py-2.5 rounded-2xl shadow-lg hover:bg-orange-400 transition-colors mt-1"
          >
            <Download className="w-4 h-4" />
            {selection.partial ? 'טען את הקטע הארוך ביותר' : 'טען מסלול'}
          </button>

          <div className="text-[10px] text-zinc-500 text-center">
            נתונים: OpenStreetMap דרך Waymarked Trails
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, unit, color, icon }: { label: string; value: string; unit: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="text-center flex-1 px-1">
      <div className="text-[10px] text-zinc-400 uppercase tracking-widest mb-1 font-bold">{icon}{label}</div>
      <div className={`text-xl font-bold ${color}`}>
        {value}
        <span className="text-xs font-normal text-zinc-500 mr-1">{unit}</span>
      </div>
    </div>
  );
}
