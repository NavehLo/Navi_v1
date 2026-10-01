import { useState } from 'react';
import { X, Loader2, ChevronDown, ExternalLink, RefreshCw, Search, BookOpenText } from 'lucide-react';
import { useTrailInfo } from '../hooks/useTrailInfo';
import { TIER_LABEL, type TrailInfo, type TrailInfoRequest, type TrailInfoSource } from '../lib/trailInfo/types';

// "על המסלול": what is known about a trail, in Hebrew — a short summary on
// top, the details by topic below it, and every source it was written from
// with a link to the original, for whoever wants the raw text.
//
// A sheet from the bottom on a phone, a centred window on a wide screen.
export default function TrailInfoPanel({ request, onClose }: { request: TrailInfoRequest; onClose: () => void }) {
  const { state, retry } = useTrailInfo(request);
  const title = state.status === 'ok' ? state.info.name : request.name;

  return (
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-end md:items-center justify-center" onClick={onClose} dir="rtl">
      <div
        className="w-full md:max-w-xl max-h-[88vh] md:max-h-[85vh] bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-t-3xl md:rounded-3xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="על המסלול"
      >
        <div className="flex items-start gap-2 p-4 pb-3 border-b border-white/10">
          <BookOpenText className="w-5 h-5 text-sky-300 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-sky-300">על המסלול</div>
            {title && <div className="text-lg font-extrabold text-white leading-tight break-words">{title}</div>}
          </div>
          <button onClick={onClose} className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors flex-shrink-0" title="סגור" aria-label="סגור">
            <X className="w-4 h-4 text-white" />
          </button>
        </div>

        <div className="overflow-y-auto overscroll-contain p-4 pb-8 flex flex-col gap-4">
          {state.status === 'loading' && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Loader2 className="w-7 h-7 text-sky-300 animate-spin" />
              <div className="text-sm font-bold text-white">{state.step}</div>
              <div className="text-xs text-white/90 max-w-xs leading-relaxed">
                בפעם הראשונה שמישהו פותח מסלול זה לוקח עד חצי דקה. אחר כך התיאור נשמר ונפתח מיד.
              </div>
            </div>
          )}

          {state.status === 'ok' && <InfoBody info={state.info} />}

          {state.status === 'no-sources' && (
            <Message text="לא מצאנו מקורות מידע על המסלול הזה.">
              <SearchLink name={title} />
            </Message>
          )}
          {state.status === 'offline' && (
            <Message text="אין חיבור לרשת, והתיאור של המסלול הזה עוד לא נשמר במכשיר." />
          )}
          {state.status === 'rate-limited' && (
            <Message text="יותר מדי בקשות ברגע זה. נסו שוב בעוד דקה.">
              <RetryButton onClick={retry} />
            </Message>
          )}
          {state.status === 'unavailable' && (
            <Message text="לא הצלחנו להכין את התיאור כרגע.">
              <RetryButton onClick={retry} />
              <SearchLink name={title} />
            </Message>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoBody({ info }: { info: TrailInfo }) {
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(info.sources.map((s) => [s.id, s]));

  return (
    <>
      <p className="text-sm text-white leading-relaxed">{info.summary}</p>

      {info.facts.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {info.facts.map((f) => (
            <div key={f.label} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2">
              <div className="text-xs font-bold text-sky-300">{f.label}</div>
              <div className="text-sm font-semibold text-white leading-snug break-words">{f.value}</div>
            </div>
          ))}
        </div>
      )}

      {info.sections.length > 0 && (
        <div className="flex flex-col gap-2">
          {info.sections.map((s) => {
            const isOpen = open === s.key;
            return (
              <div key={s.key} className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
                <button
                  onClick={() => setOpen(isOpen ? null : s.key)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-right"
                  aria-expanded={isOpen}
                >
                  <span className="text-sm font-bold text-white">{s.title}</span>
                  <ChevronDown className={`w-4 h-4 text-white transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 flex flex-col gap-2">
                    <div className="flex flex-col gap-1.5 text-sm text-white leading-relaxed">
                      {s.body.split('\n').filter((line) => line.trim()).map((line, i) => <p key={i}>{line}</p>)}
                    </div>
                    {s.sources.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-white">
                        <span className="font-bold">מקורות:</span>
                        {s.sources.map((id) => {
                          const src = byId.get(id);
                          return src?.url ? (
                            <a key={id} href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}
                              className="px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-400/30 text-sky-100 font-bold hover:bg-sky-500/30">
                              {id}
                            </a>
                          ) : (
                            <span key={id} className="px-2 py-0.5 rounded-full bg-white/10 font-bold">{id}</span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Sources sources={info.sources} />

      <p className="text-xs text-amber-200 leading-relaxed">
        התיאור נכתב אוטומטית על ידי מודל שפה מתוך המקורות שלמעלה, וייתכנו בו טעויות. לפני היציאה כדאי לבדוק את הפרטים החשובים במקור עצמו.
      </p>
    </>
  );
}

function Sources({ sources }: { sources: TrailInfoSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="border-t border-white/10 pt-3">
      <div className="text-sm font-bold text-white mb-2">המקורות המלאים</div>
      <ul className="flex flex-col gap-1.5">
        {sources.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            <span className="text-xs font-bold text-white bg-white/10 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">{s.id}</span>
            <span className="text-xs font-bold text-emerald-300 bg-emerald-500/10 border border-emerald-400/20 rounded-full px-2 py-0.5 flex-shrink-0">
              {TIER_LABEL[s.tier]}
            </span>
            {s.url ? (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-sky-200 hover:text-sky-100 underline underline-offset-2 break-words min-w-0 flex items-start gap-1">
                <span className="min-w-0 break-words" dir="auto">{s.title}</span>
                <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              </a>
            ) : (
              <span className="text-white break-words min-w-0" dir="auto">{s.title}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Message({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <div className="text-sm font-bold text-white">{text}</div>
      {children && <div className="flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 text-sm font-bold text-white bg-white/10 hover:bg-white/20 border border-white/10 px-4 py-2 rounded-full">
      <RefreshCw className="w-4 h-4" /> נסו שוב
    </button>
  );
}

function SearchLink({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <a
      href={`https://www.google.com/search?q=${encodeURIComponent(`${name} מסלול`)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 text-sm font-bold text-white bg-sky-600 hover:bg-sky-500 px-4 py-2 rounded-full"
    >
      <Search className="w-4 h-4" /> חיפוש בגוגל
    </a>
  );
}
