import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Footprints, Loader2, RefreshCw, Star, Trophy } from 'lucide-react';
import { RATING_DOT, RATING_TEXT } from './BestMonthsSection';
import { LandscapeLine } from './LandscapeFilters';
import { MONTH_NAMES, RATING_LABELS } from '../lib/climate';
import { countryName } from '../lib/worldTrailSearch';
import { groupLabel, type WmtRouteSummary } from '../lib/waymarked';
import { CONTINENTS, inContinent, type Continent } from '../lib/continents';
import { NO_CROWD_INFO, RANK_SORTS, byRank, type RankSort } from '../lib/trailCrowd/score';
import type { RankedTrail, Ranking } from '../lib/trailCrowd/ranking';
import { NO_DIFFICULTY_FILTER, passesDifficulty, type DifficultyFilter } from '../lib/difficulty';
import { DifficultyBadge, DifficultyFilterPanel } from './DifficultyFilter';

// "לפי דירוג" in "מסלולים בעולם": every world trail Komoot has numbers
// for, across all the countries collected, by how popular it is — the
// weighted score of its hikers, its number of ratings and its rating
// (popularityScore in lib/trailCrowd/score.ts). Filtered by continent,
// country, month and Komoot's difficulty grade (lib/difficulty.ts), and
// ordered by the score or by any one of the three.
//
// Read outdoors on a phone — white text, nothing under text-xs (CLAUDE.md).

type Status = 'loading' | 'ok' | 'unavailable';

// The same for everybody, and changed only by an admin's run: once a session.
let rankingMemo: Ranking | null = null;

const PAGE = 100;

// Where the reader was: a trail opened from the list unmounts it, and coming
// back must find the same filters, order and place in the list.
const kept: {
  continent?: Continent | null; country?: string | null; month?: number | null;
  sort?: RankSort; shown?: number; scroll?: number; difficulty?: DifficultyFilter;
} = {};

export default function WorldRanking({ onPickTrail }: { onPickTrail: (summary: WmtRouteSummary) => void }) {
  const [ranking, setRanking] = useState<Ranking | null>(rankingMemo);
  const [status, setStatus] = useState<Status>(rankingMemo ? 'ok' : 'loading');
  const [attempt, setAttempt] = useState(0);
  const [continent, setContinent] = useState<Continent | null>(kept.continent ?? null);
  const [country, setCountry] = useState<string | null>(kept.country ?? null);
  // null: the whole year; a month: only the trails in season then.
  const [month, setMonth] = useState<number | null>(kept.month ?? null);
  const [sort, setSort] = useState<RankSort>(kept.sort ?? 'score');
  const [shown, setShown] = useState(kept.shown ?? PAGE);
  const [difficulty, setDifficulty] = useState<DifficultyFilter>(kept.difficulty ?? NO_DIFFICULTY_FILTER);
  useEffect(() => {
    Object.assign(kept, { continent, country, month, sort, shown, difficulty });
  }, [continent, country, month, sort, shown, difficulty]);

  useEffect(() => {
    if (rankingMemo) return;
    let cancelled = false;
    fetch('/api/world-trails/ranking')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.status === 'ok' && Array.isArray(d.trails)) {
          rankingMemo = { trails: d.trails, reliefBins: d.reliefBins ?? null };
          setRanking(rankingMemo);
          setStatus('ok');
        } else {
          setStatus('unavailable');
        }
      })
      .catch(() => { if (!cancelled) setStatus('unavailable'); });
    return () => { cancelled = true; };
  }, [attempt]);

  // The list's scroll position, so the trail just opened is in view again.
  const listRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  useEffect(() => {
    if (restoredScroll.current || status !== 'ok' || !listRef.current) return;
    restoredScroll.current = true;
    if (kept.scroll) listRef.current.scrollTop = kept.scroll;
  }, [status]);
  // Another filter or order is another list: from its top.
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setShown(PAGE);
    kept.scroll = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const trails = useMemo(() => ranking?.trails ?? [], [ranking]);
  // Only the continents and countries that have ranked trails.
  const continents = useMemo(
    () => CONTINENTS.filter((c) => trails.some((t) => inContinent(t.country, c.id))),
    [trails],
  );
  const countries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of trails) if (inContinent(t.country, continent)) counts.set(t.country, (counts.get(t.country) ?? 0) + 1);
    return [...counts].sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0]), 'he'));
  }, [trails, continent]);

  // Continent, country and month: what the difficulty filter counts its
  // ungraded trails in.
  const placed = useMemo(
    () => trails
      .filter((t) => (country ? t.country === country : inContinent(t.country, continent)))
      .filter((t) => month == null || t.months[month] === 'good'),
    [trails, continent, country, month],
  );
  const list = useMemo(
    () => placed.filter((t) => passesDifficulty(t.difficulty, difficulty)).sort(byRank(sort)),
    [placed, difficulty, sort],
  );

  const select = 'w-full bg-zinc-900 text-white text-sm font-bold border border-white/20 rounded-lg px-2 py-1.5 focus:outline-none focus:border-orange-500/60';
  const field = (label: string, control: ReactNode) => (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-xs font-bold text-white">{label}</span>
      {control}
    </label>
  );

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="grid grid-cols-2 gap-2 shrink-0">
        {field('יבשת', (
          <select
            className={select}
            value={continent ?? ''}
            onChange={(e) => { change(setContinent)((e.target.value || null) as Continent | null); setCountry(null); }}
          >
            <option value="">כל העולם</option>
            {continents.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        ))}
        {field('מדינה', (
          <select className={select} value={country ?? ''} onChange={(e) => change(setCountry)(e.target.value || null)}>
            <option value="">כל המדינות</option>
            {countries.map(([code, n]) => <option key={code} value={code}>{countryName(code)} ({n})</option>)}
          </select>
        ))}
        {field('בעונה מומלצת', (
          <select
            className={select}
            value={month ?? ''}
            onChange={(e) => change(setMonth)(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">כל השנה</option>
            {MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}
          </select>
        ))}
        {field('סדר לפי', (
          <select className={select} value={sort} onChange={(e) => change(setSort)(e.target.value as RankSort)}>
            {RANK_SORTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        ))}
      </div>
      <DifficultyFilterPanel
        filter={difficulty}
        onChange={change(setDifficulty)}
        unknown={placed.filter((t) => !t.difficulty).length}
        explanation={<>לפי הדירוג של Komoot — כושר ושטח יחד. מסלול שהדרך ב-Komoot מכסה רק חלק קטן ממנו נשאר בלי רמת קושי.</>}
      />

      <div
        ref={listRef}
        onScroll={(e) => { kept.scroll = e.currentTarget.scrollTop; }}
        className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-2 min-h-0"
      >
        {status === 'loading' && (
          <div className="flex items-center gap-2 text-sm text-white py-4">
            <Loader2 className="w-4 h-4 animate-spin text-orange-400 shrink-0" />
            טוען את דירוג המסלולים…
          </div>
        )}
        {status === 'unavailable' && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-400/35 p-2 text-sm text-amber-100 flex items-center justify-between gap-2">
            <span>לא הצלחנו לטעון את הדירוג. נסו שוב בעוד רגע.</span>
            <button
              onClick={() => { setStatus('loading'); setAttempt((n) => n + 1); }}
              className="shrink-0 p-1.5 bg-white/10 hover:bg-white/20 rounded-full"
              title="נסה שוב"
            >
              <RefreshCw className="w-4 h-4 text-white" />
            </button>
          </div>
        )}
        {ranking && (
          <div className="text-xs text-white">
            <span className="font-bold text-sky-300">{list.length.toLocaleString('he-IL')} מסלולים</span>
            {country ? ` ב${countryName(country)}` : continent ? ` ב${CONTINENTS.find((c) => c.id === continent)?.label}` : ''}
            {month != null && <> ב<span className={`font-bold ${RATING_TEXT.good}`}>עונה מומלצת</span> ב{MONTH_NAMES[month]}</>}
            {' '}עם נתוני Komoot
            {difficulty.levels.length > 0 && ' ברמת הקושי שנבחרה'}
          </div>
        )}
        {ranking && list.length === 0 && (
          <div className="text-sm text-white py-3">
            {trails.length === 0 ? 'עוד לא נאספו נתוני מטיילים לאף מדינה.' : 'אין מסלולים שעונים על הסינון. נסו חודש, מדינה או רמת קושי אחרים.'}
          </div>
        )}
        {list.slice(0, shown).map((t, i) => (
          <RankedRow
            key={t.id}
            t={t}
            rank={i + 1}
            month={month}
            bins={ranking!.reliefBins}
            onPick={() => onPickTrail({ type: 'relation', id: t.id, name: t.name, group: t.group, linear: t.linear })}
          />
        ))}
        {list.length > shown && (
          <button
            onClick={() => setShown((n) => n + PAGE)}
            className="self-center my-1 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-sm font-bold text-white"
          >
            הצג עוד ({(list.length - shown).toLocaleString('he-IL')})
          </button>
        )}
      </div>
    </div>
  );
}

function RankedRow({ t, rank, month, bins, onPick }: {
  t: RankedTrail;
  rank: number;
  month: number | null;
  bins: number[] | null;
  onPick: () => void;
}) {
  const k = t.komoot;
  return (
    <button
      onClick={onPick}
      className="text-right bg-white/5 border border-white/5 p-3 rounded-2xl hover:bg-white/10 hover:border-orange-500/40 transition-all flex items-start gap-2"
    >
      <span className="text-sm font-extrabold text-amber-300 min-w-5 shrink-0 text-center">{rank}</span>
      <span className="min-w-0 flex-1 flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          {month != null && <span className={`w-2 h-2 rounded-full shrink-0 ${RATING_DOT[t.months[month]]}`} title={RATING_LABELS[t.months[month]]} />}
          <span className="min-w-0">{t.name}</span>
        </span>
        {t.name_en && t.name_en !== t.name && <span className="text-xs text-white" dir="ltr">{t.name_en}</span>}
        <span className="text-xs text-white">
          {t.multiDay ? 'רב-יומי' : groupLabel(t.group)} · {t.km >= 10 ? Math.round(t.km) : t.km} ק״מ · <span className="font-bold text-amber-200">{countryName(t.country)}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold">
          <span className="flex items-center gap-1 text-amber-300">
            <Trophy className="w-3.5 h-3.5 shrink-0" />
            ציון משוקלל {t.score}
          </span>
          <span className="flex items-center gap-1 text-sky-200">
            <Footprints className="w-3.5 h-3.5 shrink-0" />
            {k.hikers > 0 ? `${k.hikers.toLocaleString('he-IL')} מטיילים` : 'מטיילים: לא ידוע'}
          </span>
          <span className="flex items-center gap-1 text-yellow-300">
            <Star className="w-3.5 h-3.5 shrink-0 fill-yellow-300" />
            {k.rating != null
              ? <>{k.rating.toFixed(1)} <span className="font-semibold text-white">({k.ratings.toLocaleString('he-IL')} דירוגים)</span></>
              : <span className="font-semibold text-white">ציון: {NO_CROWD_INFO}{k.ratings > 0 ? ` (${k.ratings} דירוגים)` : ''}</span>}
          </span>
          <DifficultyBadge d={t.difficulty} />
        </span>
        {t.landscape && bins && <LandscapeLine s={t.landscape} bins={bins} kind="trail" />}
        {/* The whole year, small: when it is in season. */}
        <span className="flex gap-0.5 mt-0.5" aria-hidden>
          {t.months.map((r, i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full ${RATING_DOT[r]} ${month == null || i === month ? '' : 'opacity-60'}`} />
          ))}
        </span>
      </span>
    </button>
  );
}
