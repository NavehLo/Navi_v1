import { useEffect, useRef } from 'react';
import { ArrowRight, Footprints, Map as MapIcon, MapPin, Route } from 'lucide-react';
import { countryName } from '../lib/worldTrailSearch';
import { hostOf } from '../lib/countryGuide/client';
import type { CountryGuide as Guide, GuideSource } from '../lib/countryGuide/types';
import type { WmtRouteSummary } from '../lib/waymarked';

// "אזורי טיול": a country's main hiking regions, each followed by its
// best-known trails, with the pages every paragraph came from. Opened from a
// country in "בעולם לפי חודש", in a view of its own — it is a long read. Each
// region can be shown on the map, and so can all of them at once.

// Where the reader was, for coming back from the map or from a trail.
const kept = { scroll: 0, country: '' };

function Sources({ ids, byId }: { ids: number[]; byId: Map<number, GuideSource> }) {
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle mr-1">
      {ids.map((id) => {
        const s = byId.get(id);
        if (!s) return null;
        return (
          <a
            key={id}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            className="text-xs font-bold text-sky-300 hover:text-sky-200 underline underline-offset-2 whitespace-nowrap"
            dir="ltr"
          >
            [{hostOf(s.url)}]
          </a>
        );
      })}
    </span>
  );
}

export default function CountryGuide({
  guide, onBack, onShow, shown, onOpenTrail,
}: {
  guide: Guide;
  onBack: () => void;
  // A trail that is a marked route the app knows opens its card.
  onOpenTrail: (route: WmtRouteSummary) => void;
  // A region's index, or -1 for all of them.
  onShow: (index: number) => void;
  shown: number | null;
}) {
  const byId = new Map(guide.sources.map((s) => [s.id, s]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const regionRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (kept.country !== guide.country) Object.assign(kept, { scroll: 0, country: guide.country });
    if (scrollRef.current) scrollRef.current.scrollTop = kept.scroll;
  }, [guide.country]);

  const jumpTo = (i: number) => {
    const el = regionRefs.current[i];
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  };

  const written = new Date(guide.generatedAt);

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-full" aria-label="חזרה למסלולים">
          <ArrowRight className="w-4 h-4 text-white" />
        </button>
        <span className="text-base font-extrabold text-white min-w-0 flex-1">אזורי טיול ב{countryName(guide.country)}</span>
        <button
          onClick={() => onShow(-1)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${shown === -1 ? 'bg-sky-600 border-sky-400 text-white' : 'bg-white/10 border-white/15 text-white hover:bg-white/20'}`}
        >
          <MapIcon className="w-3.5 h-3.5" />
          כולם על המפה
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => { kept.scroll = e.currentTarget.scrollTop; }}
        className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-3 min-h-0 relative"
      >
        {/* The regions at a glance; a tap goes to one. */}
        <div className="flex flex-wrap gap-1.5">
          {guide.regions.map((r, i) => (
            <button
              key={i}
              onClick={() => jumpTo(i)}
              className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/5 border border-white/15 text-white hover:bg-white/15"
            >
              {i + 1}. {r.name}
            </button>
          ))}
        </div>

        {guide.intro && (
          <p className="text-sm text-white leading-relaxed">
            {guide.intro} <Sources ids={guide.introSources} byId={byId} />
          </p>
        )}

        {guide.regions.map((r, i) => (
          <section
            key={i}
            ref={(el) => { regionRefs.current[i] = el; }}
            className={`rounded-xl border p-3 flex flex-col gap-2 ${shown === i ? 'bg-sky-500/10 border-sky-400/50' : 'bg-white/5 border-white/10'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-base font-extrabold text-white leading-tight">
                  {i + 1}. {r.name}
                  {r.nameLatin && r.nameLatin !== r.name && <span className="text-xs font-bold text-white mr-1.5" dir="ltr">{r.nameLatin}</span>}
                </h3>
                {r.where && <div className="text-xs font-bold text-sky-200 mt-0.5">{r.where}</div>}
              </div>
              {(r.shape || r.places.length > 0) && (
                <button
                  onClick={() => onShow(i)}
                  className={`shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${shown === i ? 'bg-sky-500 text-white' : 'bg-sky-600 text-white hover:bg-sky-500'}`}
                >
                  <MapPin className="w-3.5 h-3.5" />
                  הצג על המפה
                </button>
              )}
            </div>
            <p className="text-sm text-white leading-relaxed">
              {r.body} <Sources ids={r.sources} byId={byId} />
            </p>
            {r.trails.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
                <div className="text-xs font-bold text-amber-200 flex items-center gap-1">
                  <Footprints className="w-3.5 h-3.5" />
                  טרקים ומסלולים מוכרים
                </div>
                {r.trails.map((t, j) => (
                  <div key={j} className="text-sm text-white leading-relaxed">
                    <span className="font-extrabold text-amber-100">{t.name}</span>
                    {t.nameLatin && t.nameLatin !== t.name && <span className="text-xs font-bold text-white mx-1" dir="ltr">({t.nameLatin})</span>}
                    {': '}
                    {t.body} <Sources ids={t.sources} byId={byId} />
                    {t.wmt && (
                      <button
                        onClick={() => onOpenTrail(t.wmt!)}
                        className="mt-1 flex items-center gap-1 px-2.5 py-1 rounded-full bg-orange-500 hover:bg-orange-400 text-xs font-bold text-white"
                      >
                        <Route className="w-3.5 h-3.5" />
                        פתח מסלול
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}

        {guide.closing && (
          <p className="text-sm text-white leading-relaxed">
            {guide.closing} <Sources ids={guide.closingSources} byId={byId} />
          </p>
        )}

        {guide.sources.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
            <div className="text-xs font-bold text-white">מקורות</div>
            <ol className="flex flex-col gap-0.5">
              {guide.sources.map((s) => (
                <li key={s.id} className="text-xs text-white flex gap-1 min-w-0">
                  <span className="shrink-0">{s.id}.</span>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline underline-offset-2 truncate min-w-0">
                    {s.title} <span dir="ltr">({hostOf(s.url)})</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        )}

        <p className="text-xs text-white pb-2">
          נכתב בעזרת מודל שפה מחיפוש ברשת ({written.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })}). כל פסקה מפנה לדפים שמהם נלקחה.
          לפני יציאה כדאי לבדוק עונה, סגירות, תשלום והזמנת לינה באתר הרשמי.
        </p>
      </div>
    </div>
  );
}
