import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, Footprints, Loader2, RefreshCw, Search, Star, Trophy, X } from 'lucide-react';
import InfoButton from './help/InfoButton';
import Collapsible from './Collapsible';
import { RATING_DOT, RATING_TEXT } from './BestMonthsSection';
import { CLIMATE_VERSION, MONTH_NAMES, MONTH_SHORT, RATING_LABELS, type MonthRating } from '../lib/climate';
import { countryName } from '../lib/worldTrailSearch';
import { groupLabel, type WmtRouteSummary } from '../lib/waymarked';
import { readTripDate } from '../lib/weatherCache';
import type { CountryMonth } from '../lib/climateCountries';
import type { CountryTrail } from '../lib/countryTrails';
import type { RegionInfo } from '../lib/regions';
import {
  NO_CROWD_INFO, TRAFFIC_LABELS, TRAFFIC_ORDER, TRAFFIC_SHORT, byTraffic, leadersOf, type CrowdSummary, type Traffic,
} from '../lib/trailCrowd/score';
import { useLeaders } from '../lib/trailLeadersClient';

// "בעולם לפי חודש": marked trails abroad, chosen by when they are in season.
//
// Two ways in. By month: pick a month, see every country with land in season
// then (from the climate grid alone, instant), pick one. By country: pick a
// country, then a month and a rating. Either way the country's list comes
// from /api/world-trails/by-country, rated month by month by the same rules as
// the trail card, and filtered here — first into the country's areas
// (provinces, cantons, states; see lib/regions), each with how many of its
// trails match, then the trails of the area chosen. Hundreds of names mean
// little until one knows which part of the country they are in.
//
// Where the admin has collected "מה אומרים מטיילים" for a country (so far
// Greece, as a pilot), each trail also shows how busy it is compared with the
// country's other trails and how hikers rated it; the list opens busiest
// first and can be filtered by both; "המסלולים המובילים" heads it (of the
// country, or of the area chosen); and in the country picker such a country
// names its leading trails. Countries without it look exactly as before.
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
type ListTrail = CountryTrail & { crowd?: CrowdSummary };
interface CountryData {
  regions: RegionInfo[];
  trails: ListTrail[];
  hasCrowd: boolean;
}

type MinRating = 0 | 4 | 4.5;
type CrowdSort = 'default' | 'rating' | 'traffic';

interface CrowdFilter {
  traffic: Traffic[];       // empty: any
  minRating: MinRating;
  // Trails with no number for what is filtered on: kept by default — no
  // information is not a reason to hide a trail.
  keepUnknown: boolean;
  sort: CrowdSort;
}
// Busiest first by default, where there are numbers to sort by.
const NO_CROWD_FILTER: CrowdFilter = { traffic: [], minRating: 0, keepUnknown: true, sort: 'traffic' };

function passesCrowd(t: ListTrail, f: CrowdFilter): boolean {
  const c = t.crowd;
  if (f.traffic.length) {
    const tier = c?.traffic ?? 'unknown';
    if (tier === 'unknown' ? !f.keepUnknown : !f.traffic.includes(tier)) return false;
  }
  if (f.minRating > 0) {
    const r = c?.rating ?? null;
    if (r == null ? !f.keepUnknown : r < f.minRating) return false;
  }
  return true;
}

function crowdFilterCount(f: CrowdFilter): number {
  return (f.traffic.length ? 1 : 0) + (f.minRating ? 1 : 0) + (f.sort !== NO_CROWD_FILTER.sort ? 1 : 0);
}
const trailsMemo = new Map<string, CountryData>();

// Where the reader was: a trail opened from the list unmounts it (the list
// is not shown over an open trail), and coming back must not mean choosing
// the country, the area, the month and the filters all over again.
const kept: {
  mode?: Mode; month?: number; rating?: MonthRating; country?: string | null;
  region?: string | null; crowdFilter?: CrowdFilter; scroll?: number;
} = {};

function keepScroll(top: number) {
  kept.scroll = top;
}

function defaultMonth(): number {
  const d = readTripDate();
  const m = d ? Number(d.slice(5, 7)) - 1 : NaN;
  return Number.isInteger(m) && m >= 0 && m < 12 ? m : new Date().getMonth();
}

export default function WorldByMonth({ onPickTrail }: { onPickTrail: (summary: WmtRouteSummary) => void }) {
  const [mode, setMode] = useState<Mode>(kept.mode ?? 'month');
  const [month, setMonth] = useState(() => kept.month ?? defaultMonth());
  const [rating, setRating] = useState<MonthRating>(kept.rating ?? 'good');
  const [country, setCountry] = useState<string | null>(kept.country ?? null);
  // The area chosen in the country: null while choosing, 'all' for the whole.
  const [region, setRegion] = useState<string | null>(kept.region ?? null);
  const [query, setQuery] = useState('');
  const [crowdFilter, setCrowdFilter] = useState<CrowdFilter>(kept.crowdFilter ?? NO_CROWD_FILTER);
  useEffect(() => {
    Object.assign(kept, { mode, month, rating, country, region, crowdFilter });
  }, [mode, month, rating, country, region, crowdFilter]);
  // Another country or area is another list: from its top.
  const shownList = useRef(`${country}|${region}`);
  useEffect(() => {
    const now = `${country}|${region}`;
    if (shownList.current !== now) keepScroll(0);
    shownList.current = now;
  }, [country, region]);

  // The list's scroll position too, so the trail just opened is in view.
  const listRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);

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
  const [trails, setTrails] = useState<{ country: string; list: CountryData | null; status: Status } | null>(null);
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
          const data: CountryData = { regions: d.regions ?? [], trails: d.trails, hasCrowd: !!d.hasCrowd };
          trailsMemo.set(country, data);
          setTrails({ country, list: data, status: 'ok' });
        } else {
          setTrails({ country, list: null, status: d.status === 'rate-limited' ? 'rate-limited' : 'unavailable' });
        }
      })
      .catch(() => { if (!cancelled) setTrails({ country, list: null, status: 'unavailable' }); })
      .finally(() => { clearTimeout(slowTimer); if (!cancelled) setSlow(false); });
    return () => { cancelled = true; clearTimeout(slowTimer); };
  }, [country, trailsAttempt]);

  const countryData = country ? trailsMemo.get(country) ?? (trails?.country === country ? trails.list : null) : null;
  const countryList = countryData?.trails ?? null;
  const hasCrowd = !!countryData?.hasCrowd;
  const crowdF = hasCrowd ? crowdFilter : NO_CROWD_FILTER;
  // The month, the rating for it, and the hikers' filters: what every count
  // and list below is made of.
  const matchesFilters = (t: ListTrail) => t.months[month] === rating && passesCrowd(t, crowdF);
  const regionNames = useMemo(() => new Map((countryData?.regions ?? []).map((r) => [r.id, r])), [countryData]);
  // One area or none: straight to the trails.
  const hasRegionStep = (countryData?.regions.length ?? 0) > 1;
  const choosingRegion = hasRegionStep && region == null;
  const countryStatus: Status = country && trailsMemo.has(country) ? 'ok' : trails?.country === country ? trails.status : 'loading';
  useEffect(() => {
    if (restoredScroll.current || countryStatus !== 'ok' || !listRef.current) return;
    restoredScroll.current = true;
    if (kept.scroll) listRef.current.scrollTop = kept.scroll;
  }, [countryStatus]);

  const shownTrails = useMemo(
    // Day walks first — what most people opening a country are after — then
    // the long-distance paths; within each, the server's order (most
    // important first).
    () => (countryList ?? [])
      .filter(matchesFilters)
      .filter((t) => !region || region === 'all' || t.regions.includes(region))
      .sort((a, b) => {
        // Sorted by the hikers: those with no number go last, in the usual order.
        if (crowdF.sort === 'rating') {
          const d = (b.crowd?.rating ?? -1) - (a.crowd?.rating ?? -1);
          if (d) return d;
        } else if (crowdF.sort === 'traffic' && hasCrowd) {
          const d = byTraffic(a, b);
          if (d) return d;
        }
        return Number(a.multiDay) - Number(b.multiDay);
      }),
    [countryList, month, rating, region, crowdF], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The leading trails of what is being looked at — the country, or the area
  // chosen — whatever the month: a famous trail stays famous in January, and
  // its dot says whether January suits it.
  const leaders = useMemo(() => {
    if (!hasCrowd || !countryList) return null;
    const scope = region && region !== 'all' ? countryList.filter((t) => t.regions.includes(region)) : countryList;
    const l = leadersOf(scope);
    return l.day.length || l.long.length ? l : null;
  }, [hasCrowd, countryList, region]);

  // How many trails of each area match the month and rating — the number the
  // area list is chosen by. A long trail counts in every area it crosses.
  const regionRows = useMemo(() => {
    if (!countryData) return [];
    const counts = new Map<string, number>();
    for (const t of countryData.trails) {
      if (!matchesFilters(t)) continue;
      for (const id of t.regions) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return countryData.regions
      .map((r) => ({ ...r, count: counts.get(r.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'he'));
  }, [countryData, month, rating, crowdF]); // eslint-disable-line react-hooks/exhaustive-deps
  const matchingInCountry = useMemo(
    () => (countryList ?? []).filter(matchesFilters).length,
    [countryList, month, rating, crowdF], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const q = query.trim();
  const matches = (code: string) => !q || countryName(code).includes(q) || code.toLowerCase() === q.toLowerCase();

  const inSeason = useMemo(() => (climate?.months[month] ?? []).filter((c) => matches(c.country)), [climate, month, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const allCountries = useMemo(
    () => (climate?.countries ?? []).filter(matches).sort((a, b) => countryName(a).localeCompare(countryName(b), 'he')),
    [climate, q], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const allLeaders = useLeaders(!country);
  const leaderLine = (code: string) => {
    const l = allLeaders[code];
    return l ? (
      <span className="text-xs font-semibold text-sky-200 flex items-center gap-1 min-w-0">
        <Trophy className="w-3.5 h-3.5 shrink-0 text-amber-300" />
        <NameList names={l.day.slice(0, 3).map((t) => t.name_en ?? t.name)} />
      </span>
    ) : null;
  };

  const openCountry = (code: string) => {
    setCountry(code);
    setRegion(null);
    setQuery('');
    setCrowdFilter(NO_CROWD_FILTER);
    if (mode === 'month') setRating('good');
  };

  const back = () => {
    if (region != null && hasRegionStep) {
      setRegion(null);
      return;
    }
    setCountry(null);
    setRegion(null);
    setTrails(null);
  };

  const regionLabel = (id: string) => {
    const r = regionNames.get(id);
    return r ? (r.dir ? `${r.name} (${r.dir})` : r.name) : null;
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

  const chip = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${on ? 'bg-sky-600 text-white border-sky-400' : 'bg-transparent text-white border-white/20 hover:bg-white/5'}`;
  const setF = (patch: Partial<CrowdFilter>) => setCrowdFilter((f) => ({ ...f, ...patch }));
  const activeCrowd = crowdFilterCount(crowdFilter);

  const crowdFilters = (
    <Collapsible
      className="shrink-0"
      icon={<Footprints className="w-4 h-4 text-sky-300" />}
      title="סינון לפי מטיילים"
      summary={activeCrowd ? <span className="text-sky-300">{activeCrowd === 1 ? 'מסנן אחד פעיל' : `${activeCrowd} מסננים פעילים`}</span> : 'הכל'}
    >
      <div className="flex flex-col gap-3 text-sm text-white">
        <div className="flex flex-col gap-1.5">
          <span className="font-bold">כמות מטיילים</span>
          <span className="text-xs">בהשוואה לשאר המסלולים ב{country ? countryName(country) : 'מדינה'}. אפשר לבחור כמה.</span>
          <div className="flex flex-wrap gap-1.5">
            {TRAFFIC_ORDER.map((t) => {
              const on = crowdFilter.traffic.includes(t);
              return (
                <button
                  key={t}
                  aria-pressed={on}
                  onClick={() => setF({ traffic: on ? crowdFilter.traffic.filter((x) => x !== t) : [...crowdFilter.traffic, t] })}
                  className={chip(on)}
                >
                  {TRAFFIC_SHORT[t]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-bold">ציון מטיילים</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="ציון מינימלי">
            {([[0, 'הכל'], [4, '4 ומעלה'], [4.5, '4.5 ומעלה']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={crowdFilter.minRating === v} onClick={() => setF({ minRating: v })} className={chip(crowdFilter.minRating === v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={crowdFilter.keepUnknown}
            onChange={(e) => setF({ keepUnknown: e.target.checked })}
            className="w-4 h-4 accent-sky-500"
          />
          להשאיר מסלולים שאין עליהם מספיק מידע
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="font-bold">סדר</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="סדר הרשימה">
            {([['traffic', 'הכי הרבה מטיילים'], ['rating', 'לפי ציון'], ['default', 'טיולי יום קודם']] as const).map(([v, label]) => (
              <button key={v} role="radio" aria-checked={crowdFilter.sort === v} onClick={() => setF({ sort: v })} className={chip(crowdFilter.sort === v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {activeCrowd > 0 && (
          <button onClick={() => setCrowdFilter(NO_CROWD_FILTER)} className="self-start text-xs font-bold text-sky-300 underline">
            ניקוי הסינון
          </button>
        )}
      </div>
    </Collapsible>
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
          <span className="text-base font-extrabold text-white min-w-0">
            {countryName(country)}
            {region && region !== 'all' && regionNames.get(region) && (
              <span className="font-bold"> › {regionNames.get(region)!.name}</span>
            )}
          </span>
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

        <div
          ref={listRef}
          onScroll={(e) => keepScroll(e.currentTarget.scrollTop)}
          className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-2 min-h-0"
        >
          {/* Inside the scrolling part: opened, they are taller than a phone's
              panel, and above the list they would leave the list no room. */}
          {leaders && (
            <LeadersSection
              area={region && region !== 'all' ? regionNames.get(region)?.name ?? null : null}
              leaders={leaders}
              month={month}
              regionLabel={region && region !== 'all' ? null : regionLabel}
              onPick={(t) => onPickTrail({ type: 'relation', id: t.id, name: t.name, group: t.group, linear: t.linear })}
            />
          )}
          {hasCrowd && crowdFilters}
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
              {MONTH_NAMES[month]}: <span className={`font-bold ${RATING_TEXT[rating]}`}>{choosingRegion ? matchingInCountry : shownTrails.length} מסלולים ב&quot;{RATING_LABELS[rating]}&quot;</span>
              {choosingRegion ? ` מתוך ${countryList.length} שנמצאו. בחרו אזור:` : ` מתוך ${countryList.length} שנמצאו`}
            </div>
          )}

          {/* The areas, each with how many of its trails match. */}
          {choosingRegion && (
            <>
              <button
                onClick={() => setRegion('all')}
                className="text-right bg-white/10 border border-white/15 px-3 py-2.5 rounded-xl hover:bg-white/15 transition-all flex items-center justify-between gap-2"
              >
                <span className="text-sm font-bold text-white">כל {countryName(country)}</span>
                <span className="text-xs font-bold text-sky-300 flex items-center gap-1 shrink-0">{matchingInCountry} מסלולים <ChevronLeft className="w-4 h-4" /></span>
              </button>
              {regionRows.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRegion(r.id)}
                  className="text-right bg-white/5 border border-white/5 px-3 py-2.5 rounded-xl hover:bg-white/10 hover:border-orange-500/40 transition-all flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
                      {r.name}
                      {r.dir && <span className="text-xs font-bold text-amber-200 bg-white/10 rounded-md px-1.5 py-0.5">{r.dir}</span>}
                    </span>
                    {r.latin && <span className="text-xs text-white" dir="ltr">{r.latin}</span>}
                  </span>
                  <span className={`text-xs font-bold shrink-0 flex items-center gap-1 ${r.count ? 'text-sky-300' : 'text-white'}`}>
                    {r.count ? `${r.count} מסלולים` : 'אין'} <ChevronLeft className="w-4 h-4" />
                  </span>
                </button>
              ))}
            </>
          )}

          {countryList && !choosingRegion && shownTrails.length === 0 && (
            <div className="text-sm text-white py-3">
              {countryList.length === 0
                ? 'לא נמצאו מסלולים מסומנים במדינה הזו.'
                : activeCrowd
                  ? `אין מסלולים ב"${RATING_LABELS[rating]}" ב${MONTH_NAMES[month]} שעונים על הסינון לפי מטיילים. נסו לרכך אותו.`
                  : `אין מסלולים ב"${RATING_LABELS[rating]}" ב${MONTH_NAMES[month]} מבין אלה שנמצאו. נסו חודש או דרגה אחרים.`}
            </div>
          )}
          {!choosingRegion && shownTrails.map((t) => (
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
              {hasCrowd && <CrowdLine crowd={t.crowd} />}
              {/* Across the whole country, where each one is. */}
              {region === 'all' && t.regions.length > 0 && (
                <span className="text-xs text-amber-200">
                  {t.regions.slice(0, 3).map(regionLabel).filter(Boolean).join(' · ')}
                  {t.regions.length > 3 ? ` ועוד ${t.regions.length - 3}` : ''}
                </span>
              )}
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
          <p className="mt-2">
            <b>מה אומרים מטיילים</b> (כרגע ביוון): ליד כל מסלול כמה מטיילים יש בו ביחס לשאר המסלולים במדינה, וציון
            המטיילים — לפי המסלולים המובילים של כל אזור ב-Komoot ולפי ויקיפדיה. אפשר לסנן ולמיין לפי שניהם. מסלול שלא
            מופיע שם מסומן &quot;אין מספיק מידע&quot; — זה לא אומר שיש בו מעט מטיילים.
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
                  <span className="min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm font-bold text-white">{countryName(c.country)}</span>
                    {leaderLine(c.country)}
                  </span>
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
            className="text-right bg-white/5 border border-white/5 px-3 py-2.5 rounded-xl hover:bg-white/10 hover:border-orange-500/40 transition-all text-sm font-bold text-white flex flex-col gap-0.5"
          >
            {countryName(code)}
            {leaderLine(code)}
          </button>
        ))}
      </div>
    </div>
  );
}

// What hikers say, in one line: how busy, and how they rated it.
function CrowdLine({ crowd }: { crowd?: CrowdSummary }) {
  const traffic = crowd && crowd.traffic !== 'unknown' ? crowd.traffic : null;
  const rating = crowd?.rating ?? null;
  if (!traffic && rating == null) {
    return <span className="text-xs text-white flex items-center gap-1"><Footprints className="w-3.5 h-3.5 shrink-0" /> מטיילים: {NO_CROWD_INFO}</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold">
      <span className="flex items-center gap-1 text-sky-200">
        <Footprints className="w-3.5 h-3.5 shrink-0" />
        {traffic ? TRAFFIC_LABELS[traffic] : `כמות מטיילים: ${NO_CROWD_INFO}`}
      </span>
      <span className="flex items-center gap-1 text-yellow-300">
        <Star className="w-3.5 h-3.5 shrink-0 fill-yellow-300" />
        {rating != null
          ? <>{rating.toFixed(1)} <span className="font-semibold text-white">({crowd!.ratingCount.toLocaleString('he-IL')} דירוגים)</span></>
          : <span className="font-semibold text-white">ציון: {NO_CROWD_INFO}</span>}
      </span>
    </span>
  );
}

// "המסלולים המובילים": the busiest day walks and long-distance paths of the
// country or area, ranked, each with its numbers and this month's dot.
function LeadersSection({ area, leaders, month, regionLabel, onPick }: {
  // The area chosen, or null for the whole country (named in the header).
  area: string | null;
  leaders: { day: ListTrail[]; long: ListTrail[] };
  month: number;
  // Across the whole country, where each one is.
  regionLabel: ((id: string) => string | null) | null;
  onPick: (t: ListTrail) => void;
}) {
  const row = (t: ListTrail, i: number) => (
    <button
      key={t.id}
      onClick={() => onPick(t)}
      className="text-right flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-white/10 transition-colors"
    >
      <span className="text-sm font-extrabold text-amber-300 w-5 shrink-0 text-center">{i + 1}</span>
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          <span className="min-w-0">{t.name}</span>
          <span className={`w-2 h-2 rounded-full shrink-0 ${RATING_DOT[t.months[month]]}`} title={RATING_LABELS[t.months[month]]} />
        </span>
        {t.name_en && t.name_en !== t.name && <span className="text-xs text-white" dir="ltr">{t.name_en}</span>}
        <span className="text-xs text-white">
          {t.km >= 10 ? Math.round(t.km) : t.km} ק״מ
          {regionLabel && t.regions[0] && regionLabel(t.regions[0]) ? ` · ${regionLabel(t.regions[0])}` : ''}
        </span>
        <CrowdLine crowd={t.crowd} />
      </span>
    </button>
  );
  const top = leaders.day.length ? leaders.day : leaders.long;
  return (
    <Collapsible
      className="shrink-0"
      icon={<Trophy className="w-4 h-4 text-amber-300" />}
      title={<span className="whitespace-nowrap">{area ? `המובילים ב${area}` : 'המסלולים המובילים'}</span>}
      summary={<span className="max-w-[8rem] text-sky-200 flex min-w-0"><NameList names={[top[0].name_en ?? top[0].name]} /></span>}
    >
      <div className="flex flex-col gap-1">
        <span className="text-xs text-white">לפי מספר המטיילים, בלי קשר לעונה. הנקודה ליד השם: ירוק — מומלץ בחודש שנבחר, צהוב — בהיערכות, אדום — לא מומלץ.</span>
        {leaders.day.length > 0 && (
          <>
            <span className="text-xs font-bold text-white mt-1">טיולי יום</span>
            {leaders.day.map(row)}
          </>
        )}
        {leaders.long.length > 0 && (
          <>
            <span className="text-xs font-bold text-white mt-2">שבילים ארוכים</span>
            {leaders.long.map(row)}
          </>
        )}
      </div>
    </Collapsible>
  );
}

// Names in any script, in reading order from the right, cut at the last one
// when the line runs out — each isolated, or an English run of them would be
// laid out left to right and lose its first name instead.
function NameList({ names }: { names: string[] }) {
  return (
    <span className="truncate min-w-0">
      {names.map((n, i) => <span key={i}>{i > 0 && ' · '}<bdi>{n}</bdi></span>)}
    </span>
  );
}
