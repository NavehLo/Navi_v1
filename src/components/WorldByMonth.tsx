import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, RefreshCw, Search, X } from 'lucide-react';
import InfoButton from './help/InfoButton';
import { RATING_DOT, RATING_TEXT } from './BestMonthsSection';
import { CLIMATE_VERSION, MONTH_NAMES, MONTH_SHORT, RATING_LABELS, type MonthRating } from '../lib/climate';
import { countryName } from '../lib/worldTrailSearch';
import { groupLabel, type WmtRouteSummary } from '../lib/waymarked';
import { readTripDate } from '../lib/weatherCache';
import type { CountryMonth } from '../lib/climateCountries';
import type { CountryTrail } from '../lib/countryTrails';

// "בעולם לפי חודש": marked trails abroad, chosen by when they are in season.
//
// Two ways in. By month: pick a month, see every country with land in season
// then (from the climate grid alone, instant), pick one, see its trails. By
// country: pick a country, then a month and a rating. Either way the trail
// list is the country's list from /api/world-trails/by-country, rated month
// by month by the same rules as the trail card, and filtered here.
//
// Read outdoors on a phone — white text, nothing under text-xs (CLAUDE.md).

type Status = 'loading' | 'ok' | 'unavailable' | 'rate-limited';
type Mode = 'month' | 'country';

interface Climate {
  countries: string[];
  months: CountryMonth[][];
}

// Kept for the session: the country climate list is the same for everybody,
// and a country's trail list does not change in a sitting.
let climateMemo: Climate | null = null;
const trailsMemo = new Map<string, CountryTrail[]>();

function defaultMonth(): number {
  const d = readTripDate();
  const m = d ? Number(d.slice(5, 7)) - 1 : NaN;
  return Number.isInteger(m) && m >= 0 && m < 12 ? m : new Date().getMonth();
}

export default function WorldByMonth({ onPickTrail }: { onPickTrail: (summary: WmtRouteSummary) => void }) {
  const [mode, setMode] = useState<Mode>('month');
  const [month, setMonth] = useState(defaultMonth);
  const [rating, setRating] = useState<MonthRating>('good');
  const [country, setCountry] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // ── The countries' climate (instant, cached by the CDN) ─────────────────
  const [climate, setClimate] = useState<Climate | null>(climateMemo);
  const [climateStatus, setClimateStatus] = useState<Status>(climateMemo ? 'ok' : 'loading');
  const [counts, setCounts] = useState<Record<string, number[]>>({});
  const [climateAttempt, setClimateAttempt] = useState(0);

  useEffect(() => {
    if (climateMemo) return;
    let cancelled = false;
    fetch(`/api/climate?countries=1&v=${CLIMATE_VERSION}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.status === 'ok' && Array.isArray(d.months)) {
          climateMemo = { countries: d.countries ?? [], months: d.months };
          setClimate(climateMemo);
          setClimateStatus('ok');
        } else {
          setClimateStatus(d.status === 'rate-limited' ? 'rate-limited' : 'unavailable');
        }
      })
      .catch(() => { if (!cancelled) setClimateStatus('unavailable'); });
    return () => { cancelled = true; };
  }, [climateAttempt]);

  // How many trails are in season, for countries somebody has opened before.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/world-trails/by-country?counts=1')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.status === 'ok') setCounts(d.counts ?? {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [country]);

  // ── One country's trails ────────────────────────────────────────────────
  const [trails, setTrails] = useState<{ country: string; list: CountryTrail[] | null; status: Status } | null>(null);
  const [trailsAttempt, setTrailsAttempt] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!country) return;
    const known = trailsMemo.get(country);
    if (known) return;
    let cancelled = false;
    const slowTimer = setTimeout(() => { if (!cancelled) setSlow(true); }, 2500);
    fetch(`/api/world-trails/by-country?country=${country}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.status === 'ok' && Array.isArray(d.trails)) {
          trailsMemo.set(country, d.trails);
          setTrails({ country, list: d.trails, status: 'ok' });
        } else {
          setTrails({ country, list: null, status: d.status === 'rate-limited' ? 'rate-limited' : 'unavailable' });
        }
      })
      .catch(() => { if (!cancelled) setTrails({ country, list: null, status: 'unavailable' }); })
      .finally(() => { clearTimeout(slowTimer); if (!cancelled) setSlow(false); });
    return () => { cancelled = true; clearTimeout(slowTimer); };
  }, [country, trailsAttempt]);

  const countryList = country ? trailsMemo.get(country) ?? (trails?.country === country ? trails.list : null) : null;
  const countryStatus: Status = country && trailsMemo.has(country) ? 'ok' : trails?.country === country ? trails.status : 'loading';

  const shownTrails = useMemo(
    // Day walks first — what most people opening a country are after — then
    // the long-distance paths; within each, the server's order (most
    // important first).
    () => (countryList ?? []).filter((t) => t.months[month] === rating).sort((a, b) => Number(a.multiDay) - Number(b.multiDay)),
    [countryList, month, rating],
  );

  const q = query.trim();
  const matches = (code: string) => !q || countryName(code).includes(q) || code.toLowerCase() === q.toLowerCase();

  const inSeason = useMemo(() => (climate?.months[month] ?? []).filter((c) => matches(c.country)), [climate, month, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const allCountries = useMemo(
    () => (climate?.countries ?? []).filter(matches).sort((a, b) => countryName(a).localeCompare(countryName(b), 'he')),
    [climate, q], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const openCountry = (code: string) => {
    setCountry(code);
    setQuery('');
    if (mode === 'month') setRating('good');
  };

  const back = () => {
    setCountry(null);
    setTrails(null);
  };

  // ── Pieces ──────────────────────────────────────────────────────────────

  const monthChips = (
    <div className="grid grid-cols-6 gap-1 shrink-0" role="radiogroup" aria-label="בחירת חודש">
      {MONTH_SHORT.map((m, i) => (
        <button
          key={i}
          role="radio"
          aria-checked={i === month}
          aria-label={MONTH_NAMES[i]}
          onClick={() => setMonth(i)}
          className={`rounded-lg py-1.5 text-xs font-bold transition-colors border ${i === month ? 'bg-orange-500 text-white border-orange-400' : 'bg-white/5 text-white border-white/10 hover:bg-white/10'}`}
        >
          {m}
        </button>
      ))}
    </div>
  );

  const failure = (status: Status, retry: () => void, what: string) => (
    <div className="rounded-lg bg-amber-500/10 border border-amber-400/35 p-2 text-sm text-amber-100 flex items-center justify-between gap-2">
      <span>{status === 'rate-limited' ? 'יותר מדי בקשות כרגע' : `לא הצלחנו לטעון ${what}`}. נסו שוב בעוד רגע.</span>
      <button onClick={retry} className="shrink-0 p-1.5 bg-white/10 hover:bg-white/20 rounded-full" title="נסה שוב">
        <RefreshCw className="w-4 h-4 text-white" />
      </button>
    </div>
  );

  // ── A country's trails ──────────────────────────────────────────────────
  if (country) {
    return (
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={back} className="p-1.5 bg-white/10 hover:bg-white/20 rounded-full" aria-label="חזרה">
            <ArrowRight className="w-4 h-4 text-white" />
          </button>
          <span className="text-base font-extrabold text-white">{countryName(country)}</span>
        </div>
        {monthChips}
        <div className="flex flex-wrap gap-1.5 shrink-0" role="radiogroup" aria-label="בחירת דרגה">
          {(['good', 'fair', 'bad'] as const).map((r) => (
            <button
              key={r}
              role="radio"
              aria-checked={r === rating}
              onClick={() => setRating(r)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border transition-colors ${r === rating ? 'bg-white/20 text-white border-white/40' : 'bg-transparent text-white border-white/15 hover:bg-white/5'}`}
            >
              <span className={`w-2 h-2 rounded-full ${RATING_DOT[r]}`} />
              {RATING_LABELS[r]}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-2 min-h-0">
          {countryStatus === 'loading' && (
            <div className="flex items-center gap-2 text-sm text-white py-4">
              <Loader2 className="w-4 h-4 animate-spin text-orange-400 shrink-0" />
              {slow ? `מכין את רשימת המסלולים של ${countryName(country)} בפעם הראשונה — עד חצי דקה…` : 'טוען מסלולים…'}
            </div>
          )}
          {(countryStatus === 'unavailable' || countryStatus === 'rate-limited') &&
            failure(countryStatus, () => { setTrails(null); setTrailsAttempt((n) => n + 1); }, 'את המסלולים')}
          {countryList && (
            <div className="text-xs text-white">
              {MONTH_NAMES[month]}: <span className={`font-bold ${RATING_TEXT[rating]}`}>{shownTrails.length} מסלולים ב&quot;{RATING_LABELS[rating]}&quot;</span> מתוך {countryList.length} שנמצאו
            </div>
          )}
          {countryList && shownTrails.length === 0 && (
            <div className="text-sm text-white py-3">
              {countryList.length === 0
                ? 'לא נמצאו מסלולים מסומנים במדינה הזו.'
                : `אין מסלולים ב"${RATING_LABELS[rating]}" ב${MONTH_NAMES[month]} מבין אלה שנמצאו. נסו חודש או דרגה אחרים.`}
            </div>
          )}
          {shownTrails.map((t) => (
            <button
              key={t.id}
              onClick={() => onPickTrail({ type: 'relation', id: t.id, name: t.name, group: t.group, linear: t.linear })}
              className="text-right bg-white/5 border border-white/5 p-3 rounded-2xl hover:bg-white/10 hover:border-orange-500/40 transition-all flex flex-col gap-1"
            >
              <span className="flex items-center gap-2 text-sm font-bold text-white">
                <span className={`w-2 h-2 rounded-full shrink-0 ${RATING_DOT[t.months[month]]}`} />
                <span className="min-w-0">{t.name}</span>
              </span>
              {t.name_en && t.name_en !== t.name && <span className="text-xs text-white" dir="ltr">{t.name_en}</span>}
              <span className="text-xs text-white">
                {t.multiDay ? 'רב-יומי' : groupLabel(t.group)} · {t.km >= 10 ? Math.round(t.km) : t.km} ק״מ
                {t.crossesBorder ? ` ב${countryName(country)}, וממשיך מעבר לגבול` : ''}
              </span>
              {/* The whole year, small: what else this trail is good for. */}
              <span className="flex gap-0.5 mt-0.5" aria-hidden>
                {t.months.map((r, i) => (
                  <span key={i} className={`h-1.5 flex-1 rounded-full ${RATING_DOT[r]} ${i === month ? '' : 'opacity-60'}`} />
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Choosing a country ──────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex rounded-xl bg-white/5 border border-white/10 p-0.5 flex-1" role="tablist">
          {([['month', 'לפי חודש'], ['country', 'לפי מדינה']] as const).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-lg py-1.5 text-sm font-bold transition-colors ${mode === m ? 'bg-white/20 text-white' : 'text-white hover:bg-white/10'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <InfoButton label="מסלולים בעולם לפי חודש">
          <p>
            <b>לפי חודש:</b> בוחרים חודש ורואים את המדינות שיש בהן אזורים ב&quot;עונה מומלצת&quot; — לפי האקלים בלבד,
            ליום הליכה של כ-4 שעות. האחוז הוא כמה משטח המדינה מתאים. כמה מסלולים יש שם בפועל ידוע רק אחרי שהמדינה נפתחה
            פעם ראשונה, ואז המספר מופיע ליד שמה.
          </p>
          <p className="mt-2">
            <b>המסלולים</b> הם מסלולים מסומנים מ-Waymarked Trails: במדינה קטנה גם מקומיים, ובמדינה גדולה בעיקר אזוריים
            וארציים. כל מסלול מדורג לפי האקלים לאורכו, הגובה שלו והאורך, כמו בכרטיס המסלול.
          </p>
        </InfoButton>
      </div>

      {mode === 'month' && monthChips}

      <div className="relative shrink-0">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-300" size={16} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="חפש מדינה…"
          className="w-full bg-white/5 border border-white/10 rounded-xl py-2 pr-9 pl-9 text-sm text-white placeholder:text-zinc-300 focus:outline-none focus:border-orange-500/50"
        />
        {query && (
          <button onClick={() => setQuery('')} className="absolute left-3 top-1/2 -translate-y-1/2 text-white" aria-label="נקה חיפוש">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-1.5 min-h-0">
        {climateStatus === 'loading' && <div className="text-sm text-white py-3">טוען…</div>}
        {(climateStatus === 'unavailable' || climateStatus === 'rate-limited') &&
          failure(climateStatus, () => { setClimateStatus('loading'); setClimateAttempt((n) => n + 1); }, 'את רשימת המדינות')}

        {climate && mode === 'month' && (
          <>
            <div className="text-xs text-white">
              {MONTH_NAMES[month]}: <span className="font-bold text-emerald-300">{inSeason.length} מדינות</span> עם אזורים בעונה מומלצת
            </div>
            {inSeason.map((c) => {
              const n = counts[c.country]?.[month];
              return (
                <button
                  key={c.country}
                  onClick={() => openCountry(c.country)}
                  className="text-right bg-white/5 border border-white/5 px-3 py-2.5 rounded-xl hover:bg-white/10 hover:border-orange-500/40 transition-all flex items-center justify-between gap-2"
                >
                  <span className="text-sm font-bold text-white">{countryName(c.country)}</span>
                  <span className="text-xs text-white flex items-center gap-2 shrink-0">
                    {n != null && <span className="text-sky-300 font-bold">{n} מסלולים</span>}
                    <span className="text-emerald-300 font-bold">{Math.max(1, Math.round(c.share * 100))}% מהשטח</span>
                  </span>
                </button>
              );
            })}
          </>
        )}

        {climate && mode === 'country' && allCountries.map((code) => (
          <button
            key={code}
            onClick={() => openCountry(code)}
            className="text-right bg-white/5 border border-white/5 px-3 py-2.5 rounded-xl hover:bg-white/10 hover:border-orange-500/40 transition-all text-sm font-bold text-white"
          >
            {countryName(code)}
          </button>
        ))}
      </div>
    </div>
  );
}
