import { useEffect, useState } from 'react';
import { X, ExternalLink, BookOpen, Download, Loader2, TrendingUp, TrendingDown, ChevronDown, ChevronUp } from 'lucide-react';
import type { WorldTrailSelection } from '../hooks/useWorldTrails';
import { groupLabel, wikipediaUrl } from '../lib/waymarked';
import { englishFromTags, needsEnglish, usefulEnglish } from '../lib/trailNames';
import { knownEnglish, translateWorldTrails } from '../lib/worldTrailSearch';

// The trail's English name, when its own is in a script the reader may not
// read: OSM's, if a mapper wrote one, else a translation from the server.
function useEnglishName(id: number, name: string | undefined, tags: Record<string, string> | undefined) {
  const fromTags = englishFromTags(tags);
  const foreign = needsEnglish(name);
  const [translated, setTranslated] = useState<{ id: number; en: string | null } | null>(null);
  // Only once the details are in, so their tags get the first say.
  const ask = foreign && !!tags && !fromTags;
  useEffect(() => {
    if (!ask) return;
    let live = true;
    translateWorldTrails([id]).then((names) => { if (live) setTranslated({ id, en: names.get(id) ?? null }); });
    return () => { live = false; };
  }, [id, ask]);
  if (!foreign) return null;
  const en = fromTags ?? (translated?.id === id ? translated.en : null) ?? knownEnglish(id) ?? null;
  return usefulEnglish(name, en);
}

// The card that opens when a route in the world trails overlay is tapped.
// Sits where the stats card sits, so the two never share the screen — a
// tapped route either becomes the open trail or gets closed.
//
// It folds down to its name, one line of numbers and the load button, so the
// route it describes can be looked at on the map — on a phone the open card
// covers much of it. A new card always opens unfolded.
export default function WorldTrailCard({
  selection, onClose, onLoad,
}: {
  selection: WorldTrailSelection;
  onClose: () => void;
  onLoad: () => void;
}) {
  const d = selection.details;
  const name = d?.name ?? selection.summary?.name ?? 'מסלול מסומן';
  const english = useEnglishName(selection.id, d?.name ?? selection.summary?.name, d?.tags);
  const group = d?.group ?? selection.summary?.group ?? '';
  const wiki = wikipediaUrl(d?.wikipedia);
  const canLoad = selection.status === 'ok' && selection.coords.length >= 2;
  const elevationPending = selection.status === 'ok' && selection.elevationStatus === 'loading';
  const hasElevation = selection.elevationStatus === 'ok' && selection.gain != null;
  const [collapsed, setCollapsed] = useState(false);
  const toggleLabel = collapsed ? 'הרחב' : 'צמצם';

  const loadButton = (compact: boolean) => (
    <button
      onClick={onLoad}
      disabled={!canLoad}
      className={`flex items-center justify-center gap-2 bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-300 text-white text-sm font-bold rounded-2xl shadow-lg hover:bg-orange-400 transition-colors
        ${compact ? 'px-3 py-2 flex-shrink-0' : 'px-4 py-2.5 mt-1'}`}
    >
      <Download className="w-4 h-4" />
      {compact ? 'טען' : selection.partial ? 'טען את הקטע הארוך ביותר' : 'טען מסלול'}
    </button>
  );

  return (
    <div
      className={`absolute left-3 right-3 bottom-[76px] md:left-auto md:right-6 md:top-6 md:bottom-auto md:w-[360px] z-[45] bg-black/85 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl flex flex-col max-h-[60vh] md:max-h-[calc(100vh-3rem)] overflow-y-auto
        ${collapsed ? 'p-3 gap-2' : 'p-4 gap-3'}`}
      dir="rtl"
    >
      <div className="flex items-start gap-2">
        {/* The name is also a handle: tapping it folds or unfolds the card. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex-1 min-w-0 text-right"
        >
          <div className="text-xs text-orange-400 font-bold tracking-wide">{groupLabel(group)}</div>
          <div className={`font-extrabold text-white leading-tight break-words ${collapsed ? 'text-base line-clamp-2' : 'text-lg'}`}>{name}</div>
          {english && (
            <div
              className={`text-sm font-semibold text-sky-200 leading-snug break-words mt-0.5 ${collapsed ? 'truncate' : ''}`}
              dir="ltr"
              style={{ textAlign: 'right' }}
            >
              {english}
            </div>
          )}
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0"
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
        >
          {/* The card sits at the bottom on a phone and at the top on a wide
              screen; the arrow points the way the card will grow or shrink. */}
          {collapsed
            ? <><ChevronUp className="w-4 h-4 text-white md:hidden" /><ChevronDown className="w-4 h-4 text-white hidden md:block" /></>
            : <><ChevronDown className="w-4 h-4 text-white md:hidden" /><ChevronUp className="w-4 h-4 text-white hidden md:block" /></>}
        </button>
        <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0" title="סגור" aria-label="סגור">
          <X className="w-4 h-4 text-white" />
        </button>
      </div>

      {collapsed && (
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0 flex items-center gap-3 text-sm font-bold">
            {selection.status === 'loading' && (
              <span className="flex items-center gap-1.5 text-white"><Loader2 className="w-4 h-4 animate-spin" /> טוען…</span>
            )}
            {d && (
              <>
                <span className="text-sky-400">{selection.lengthKm != null ? selection.lengthKm.toFixed(1) : '—'} <span className="text-xs font-semibold text-zinc-200">{'ק"מ'}</span></span>
                {hasElevation && (
                  <>
                    <span className="text-emerald-400 flex items-center gap-0.5"><TrendingUp className="w-3.5 h-3.5" />{selection.gain}</span>
                    <span className="text-red-400 flex items-center gap-0.5"><TrendingDown className="w-3.5 h-3.5" />{selection.loss}</span>
                  </>
                )}
              </>
            )}
            {(selection.status === 'unavailable' || selection.status === 'rate-limited') && (
              <span className="text-amber-300 text-xs">הפרטים לא זמינים כרגע</span>
            )}
          </div>
          {d && loadButton(true)}
        </div>
      )}

      {!collapsed && (<>

      {selection.status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-white">
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
            <div className="text-xs text-white text-center -mt-1">
              גובה {selection.minEle} עד {selection.maxEle} {"מ'"}
            </div>
          )}
          {selection.elevationStatus !== 'ok' && selection.elevationStatus !== 'loading' && (
            <div className="text-xs text-zinc-200 text-center -mt-1">נתוני גובה לא זמינים למסלול הזה</div>
          )}

          {selection.partial && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 leading-relaxed">
              המסלול מפוצל ב־OpenStreetMap ל־{selection.segmentCount} קטעים נפרדים. {'"טען מסלול"'} יטען את הקטע הארוך ביותר.
            </div>
          )}

          {d.description && (
            <p className="text-sm text-white leading-relaxed line-clamp-4">{d.description}</p>
          )}

          <div className="flex flex-col gap-1 text-xs text-white">
            {d.operator && <div><span className="text-zinc-200 font-bold">מפעיל:</span> {d.operator}</div>}
            {d.symbol_description && <div><span className="text-zinc-200 font-bold">סימון:</span> {d.symbol_description}</div>}
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

          {loadButton(false)}

          <div className="text-[11px] text-zinc-300 text-center">
            נתונים: OpenStreetMap דרך Waymarked Trails
          </div>
        </>
      )}
      </>)}
    </div>
  );
}

function Stat({ label, value, unit, color, icon }: { label: string; value: string; unit: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="text-center flex-1 px-1">
      <div className="text-xs text-zinc-200 tracking-wide mb-1 font-bold">{icon}{label}</div>
      <div className={`text-xl font-bold ${color}`}>
        {value}
        <span className="text-xs font-normal text-zinc-200 mr-1">{unit}</span>
      </div>
    </div>
  );
}
