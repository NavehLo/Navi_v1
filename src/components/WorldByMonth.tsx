import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { track } from '../lib/track';
import { ArrowRight, BookOpen, ChevronLeft, Footprints, Loader2, RefreshCw, Search, Star, Trophy, X } from 'lucide-react';
import InfoButton from './help/InfoButton';
import Collapsible from './Collapsible';
import { RATING_DOT, RATING_TEXT } from './BestMonthsSection';
import { CLIMATE_VERSION, MONTH_NAMES, RATING_LABELS, type MonthRating } from '../lib/climate';
import { countryName } from '../lib/worldTrailSearch';
import { latinName } from '../lib/trailNames';
import { groupLabel, type WmtRouteSummary } from '../lib/waymarked';
import { readTripDate } from '../lib/weatherCache';
import type { CountryMonth } from '../lib/climateCountries';
import type { CountryTrail } from '../lib/countryTrails';
import type { RegionInfo } from '../lib/regions';
import {
  NO_CROWD_INFO, trailTitle, TRAFFIC_LABELS, TRAFFIC_ORDER, TRAFFIC_SHORT, byTraffic, leadersOf, type CrowdSummary, type Traffic,
} from '../lib/trailCrowd/score';
import { useLeaders } from '../lib/trailLeadersClient';
import {
  LANDSCAPE_SORTS, LANDSCAPE_VERSION, NO_LANDSCAPE_FILTER, SORT_LABELS, landscapeFilterCount, passesLandscape, rangeName, sortBadge, sortValue,
  type LandscapeData, type LandscapeFilter, type LandscapeSort, type LandscapeSummary,
} from '../lib/landscape';
import { LandscapeFilterParts, LandscapeLine } from './LandscapeFilters';
import { CONTINENTS, inContinent, type Continent } from '../lib/continents';
import CountryGuide from './CountryGuide';
import { guideCountries, loadGuide } from '../lib/countryGuide/client';
import type { CountryGuide as Guide } from '../lib/countryGuide/types';
import type { GuideMapView } from '../hooks/useCountryGuideMap';
import WorldRanking from './WorldRanking';
import { NO_DIFFICULTY_FILTER, passesDifficulty, type DifficultyFilter } from '../lib/difficulty';
import { DifficultyBadge, DifficultyFilterBody } from './DifficultyFilter';
import FilterDropdown, { SELECT_CLASS } from './FilterDropdown';

// "מסלולים בעולם": marked trails abroad, chosen by when they are in season,
// or by how popular they are.
//
// Three ways in. By rating ("לפי דירוג", WorldRanking): every trail
// with Komoot's numbers, from all the countries collected, in one list by
// its popularity score — no country to choose first. By month: pick a month, see every country with land in season
// then (from the climate grid alone, instant), pick one. By country: pick a
// country, then a month and a rating. Either way the country's list comes
// from /api/world-trails/by-country, rated month by month by the same rules as
// the trail card, and filtered here — first into the country's areas
// (provinces, cantons, states; see lib/regions), each with how many of its
// trails match, then the trails of the area chosen. Hundreds of names mean
// little until one knows which part of the country they are in.
//
// Where the admin has collected "מה אומרים מטיילים" for a country (16 so
// far, in the order of scripts/countryGroups.mjs), each trail also shows how busy it is compared with the
// country's other trails and how hikers rated it; the list opens busiest
// first and can be filtered by both; "המסלולים המובילים" heads it (of the
// country, or of the area chosen); and in the country picker such a country
// names its leading trails. Countries without it look exactly as before.
//
// Every country and every area also says what it looks like — mountains,
// forest, rivers (lib/landscape.ts) — and both lists can be filtered by it.
//
// A trail Komoot grades shows its "רמת קושי" (lib/difficulty.ts), and a
// collected country's list can be filtered by it.
//
// Read outdoors on a phone — white text, nothing under text-xs (CLAUDE.md).

type Status = 'loading' | 'ok' | 'unavailable' | 'rate-limited';
type Mode = 'month' | 'country' | 'ranking';

interface Climate {
  countries: string[];
  months: CountryMonth[][];
}

// Kept for the session: the country climate list is the same for everybody,
// and a country's trail list does not change in a sitting.
let climateMemo: Climate | null = null;
type ListTrail = CountryTrail & { crowd?: CrowdSummary; landscape?: LandscapeSummary };
interface CountryData {
  regions: RegionInfo[];
  trails: ListTrail[];
  hasCrowd: boolean;
  // The trails' landscape, where the country was collected (collectLandscape.mjs).
  landscape: LandscapeData | null;
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
  return (f.traffic.length ? 1 : 0) + (f.minRating ? 1 : 0);
}
const trailsMemo = new Map<string, CountryData>();

// What the countries look like, and each country's areas: the same for
// everybody, fetched once a session.
type CountriesLandscape = LandscapeData & { countries: Record<string, LandscapeSummary> };
type CountryLandscape = LandscapeData & { country: LandscapeSummary; regions: Record<string, LandscapeSummary> };
let landscapeMemo: CountriesLandscape | null = null;
const regionLandscapeMemo = new Map<string, CountryLandscape>();

// Where the reader was: a trail opened from the list unmounts it (the list
// is not shown over an open trail), and coming back must not mean choosing
// the country, the area, the month and the filters all over again.
const kept: {
  mode?: Mode; month?: number; rating?: MonthRating; country?: string | null;
  region?: string | null; crowdFilter?: CrowdFilter; landscapeFilter?: LandscapeFilter;
  landscapeSort?: LandscapeSort; continent?: Continent | null; scroll?: number;
  guideOpen?: boolean; difficulty?: DifficultyFilter;
} = {};

function keepScroll(top: number) {
  kept.scroll = top;
}

function defaultMonth(): number {
  const d = readTripDate();
  const m = d ? Number(d.slice(5, 7)) - 1 : NaN;
  return Number.isInteger(m) && m >= 0 && m < 12 ? m : new Date().getMonth();
}

export default function WorldByMonth({ onPickTrail, onGuideMap, guideShown = null }: {
  onPickTrail: (summary: WmtRouteSummary) => void;
  // "אזורי טיול" on the map: a region (or all), or nothing.
  onGuideMap?: (view: GuideMapView | null) => void;
  guideShown?: number | null;
}) {
  const [mode, setMode] = useState<Mode>(kept.mode ?? 'month');
  // For the users report: which way the world's trails were looked through.
  useEffect(() => { track(mode === 'ranking' ? 'world_ranking' : 'world_by_month', { mode }); }, [mode]);
  const [month, setMonth] = useState(() => kept.month ?? defaultMonth());
  const [rating, setRating] = useState<MonthRating>(kept.rating ?? 'good');
  const [country, setCountry] = useState<string | null>(kept.country ?? null);
  // The area chosen in the country: null while choosing, 'all' for the whole.
  const [region, setRegion] = useState<string | null>(kept.region ?? null);
  const [query, setQuery] = useState('');
  const [crowdFilter, setCrowdFilter] = useState<CrowdFilter>(kept.crowdFilter ?? NO_CROWD_FILTER);
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>(kept.difficulty ?? NO_DIFFICULTY_FILTER);
  const [landscapeFilter, setLandscapeFilter] = useState<LandscapeFilter>(kept.landscapeFilter ?? NO_LANDSCAPE_FILTER);
  const [landscapeSort, setLandscapeSort] = useState<LandscapeSort>(kept.landscapeSort ?? 'default');
  // One continent, or null for the whole world: both lists of countries.
  const [continent, setContinent] = useState<Continent | null>(kept.continent ?? null);
  useEffect(() => {
    Object.assign(kept, { mode, month, rating, country, region, crowdFilter, landscapeFilter, landscapeSort, continent, difficulty: difficultyFilter });
  }, [mode, month, rating, country, region, crowdFilter, landscapeFilter, landscapeSort, continent, difficultyFilter]);

  // "אזורי טיול": the countries that have one, and the open country's.
  const [guideSet, setGuideSet] = useState<Set<string> | null>(null);
  useEffect(() => { guideCountries().then(setGuideSet); }, []);
  const [guideOpen, setGuideOpen] = useState(kept.guideOpen ?? false);
  const [loadedGuide, setLoadedGuide] = useState<Guide | null>(null);
  const guide = loadedGuide && loadedGuide.country === country ? loadedGuide : null;
  useEffect(() => { kept.guideOpen = guideOpen; }, [guideOpen]);
  useEffect(() => {
    if (!country || !guideSet?.has(country)) return;
    let cancelled = false;
    loadGuide(country).then((g) => { if (!cancelled) setLoadedGuide(g); });
    return () => { cancelled = true; };
  }, [country, guideSet]);
  const onGuideMapRef = useRef(onGuideMap);
  useEffect(() => { onGuideMapRef.current = onGuideMap; });
  // Another country (or none) takes the last one's regions off the map.
  useEffect(() => { onGuideMapRef.current?.(null); }, [country]);
  const closeGuide = () => {
    setGuideOpen(false);
    onGuideMap?.(null);
  };
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

  // What every country looks like. Without it the lists work as before, only
  // without the line and the filter.
  const [landscape, setLandscape] = useState<CountriesLandscape | null>(landscapeMemo);
  useEffect(() => {
    if (landscapeMemo) return;
    let cancelled = false;
    fetch(`/api/landscape?v=${LANDSCAPE_VERSION}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || d.status !== 'ok' || !d.countries) return;
        landscapeMemo = d as CountriesLandscape;
        setLandscape(landscapeMemo);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // …and the areas of the country opened.
  const [, setRegionLandscapeTick] = useState(0);
  useEffect(() => {
    if (!country || regionLandscapeMemo.has(country)) return;
    let cancelled = false;
    fetch(`/api/landscape?country=${country}&v=${LANDSCAPE_VERSION}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || d.status !== 'ok' || !d.regions) return;
        regionLandscapeMemo.set(country, d as CountryLandscape);
        setRegionLandscapeTick((n) => n + 1);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [country]);
  const countryLandscape = country ? regionLandscapeMemo.get(country) ?? null : null;
  const activeLandscape = landscapeFilterCount(landscapeFilter);

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
          const data: CountryData = { regions: d.regions ?? [], trails: d.trails, hasCrowd: !!d.hasCrowd, landscape: d.landscape ?? null };
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
  // Komoot's grade comes with the hikers' numbers: no numbers, no filter.
  const difficultyF = hasCrowd ? difficultyFilter : NO_DIFFICULTY_FILTER;
  // The month, the rating for it, and the hikers' filters: what every count
  // and list below is made of.
  const trailLand = countryData?.landscape ?? null;
  const matchesFilters = (t: ListTrail) =>
    t.months[month] === rating && passesCrowd(t, crowdF) && passesDifficulty(t.crowd?.difficulty, difficultyF) &&
    (!trailLand || passesLandscape(t.landscape, trailLand.reliefBins, landscapeFilter, 'trail'));
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
        // By a landscape, when one is chosen and the trails have it.
        if (trailLand && landscapeSort !== 'default') {
          const bins = trailLand.reliefBins;
          const d = sortValue(b.landscape, bins, landscapeSort, 'trail') - sortValue(a.landscape, bins, landscapeSort, 'trail');
          if (d) return d;
        }
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
    [countryList, month, rating, region, crowdF, difficultyF, landscapeFilter, landscapeSort], // eslint-disable-line react-hooks/exhaustive-deps
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
      .map((r) => ({ ...r, count: counts.get(r.id) ?? 0, landscape: countryLandscape?.regions[r.id] }))
      .filter((r) => !activeLandscape || !countryLandscape || passesLandscape(r.landscape, countryLandscape.reliefBins, landscapeFilter))
      .sort((a, b) => {
        if (countryLandscape && landscapeSort !== 'default') {
          const bins = countryLandscape.reliefBins;
          const d = sortValue(b.landscape, bins, landscapeSort) - sortValue(a.landscape, bins, landscapeSort);
          if (d) return d;
        }
        return b.count - a.count || a.name.localeCompare(b.name, 'he');
      });
  }, [countryData, month, rating, crowdF, difficultyF, countryLandscape, landscapeFilter, landscapeSort]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchingInCountry = useMemo(
    () => (countryList ?? []).filter(matchesFilters).length,
    [countryList, month, rating, crowdF, difficultyF, landscapeFilter], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const q = query.trim();
  const matchesLandscape = (code: string) =>
    !activeLandscape || !landscape || passesLandscape(landscape.countries[code], landscape.reliefBins, landscapeFilter);
  const matches = (code: string) =>
    (!q || countryName(code).includes(q) || code.toLowerCase() === q.toLowerCase()) &&
    inContinent(code, continent) && matchesLandscape(code);

  // Ordered by a landscape when one is chosen; otherwise as before — the
  // share in season, or the alphabet.
  const byLandscape = (a: string, b: string) =>
    landscape && landscapeSort !== 'default'
      ? sortValue(landscape.countries[b], landscape.reliefBins, landscapeSort) - sortValue(landscape.countries[a], landscape.reliefBins, landscapeSort)
      : 0;
  const inSeason = useMemo(
    () => (climate?.months[month] ?? []).filter((c) => matches(c.country)).sort((a, b) => byLandscape(a.country, b.country)),
    [climate, month, q, continent, landscape, landscapeFilter, landscapeSort], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const allCountries = useMemo(
    () => (climate?.countries ?? []).filter(matches).sort((a, b) => byLandscape(a, b) || countryName(a).localeCompare(countryName(b), 'he')),
    [climate, q, continent, landscape, landscapeFilter, landscapeSort], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const landscapeLine = (code: string) => {
    const s = landscape?.countries[code];
    if (!s) return null;
    const badge = sortBadge(s, landscape!.reliefBins, landscapeSort);
    return (
      <>
        <LandscapeLine s={s} bins={landscape!.reliefBins} />
        {badge && <span className="text-xs font-bold text-emerald-300">{badge}</span>}
      </>
    );
  };

  const allLeaders = useLeaders(!country);
  const leaderLine = (code: string) => {
    const l = allLeaders[code];
    return l ? (
      <span className="text-xs font-semibold text-sky-200 flex items-center gap-1 min-w-0">
        <Trophy className="w-3.5 h-3.5 shrink-0 text-amber-300" />
        <NameList names={l.day.slice(0, 3).map((t) => latinName(t.name, t.name_en, code) ?? trailTitle(t.name, t.crowd.komootName).title)} />
      </span>
    ) : null;
  };

  const openCountry = (code: string) => {
    setCountry(code);
    setGuideOpen(false);
    setRegion(null);
    setQuery('');
    setCrowdFilter(NO_CROWD_FILTER);
    if (mode === 'month') setRating('good');
  };

  const back = () => {
    if (guideOpen) {
      closeGuide();
      return;
    }
    if (region != null && hasRegionStep) {
      setRegion(null);
      return;
    }
    setCountry(null);
    setRegion(null);
    setTrails(null);
    setGuideOpen(false);
  };

  const regionLabel = (id: string) => {
    const r = regionNames.get(id);
    return r ? (r.dir ? `${r.name} (${r.dir})` : r.name) : null;
  };

  // ── Pieces ──────────────────────────────────────────────────────────────

  // Drop-downs, not rows of chips: on a phone the chips took half the panel
  // and left the list little room.
  const select = 'w-full bg-zinc-900 text-white text-sm font-bold border border-white/20 rounded-lg px-2 py-1.5 focus:outline-none focus:border-orange-500/60';
  const monthSelect = (
    <select className={select} value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="בחירת חודש">
      {MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}
    </select>
  );

  const continentLabel = CONTINENTS.find((c) => c.id === continent)?.label;
  const continentSelect = (
    <select
      className={select}
      value={continent ?? ''}
      onChange={(e) => setContinent((e.target.value || null) as Continent | null)}
      aria-label="סינון לפי יבשת"
    >
      <option value="">כל העולם</option>
      {CONTINENTS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  );

  const ratingSelect = (
    <div className="relative min-w-0">
      <span className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${RATING_DOT[rating]}`} />
      <select className={`${select} pr-7`} value={rating} onChange={(e) => setRating(e.target.value as MonthRating)} aria-label="בחירת דרגה">
        {(['good', 'fair', 'bad'] as const).map((r) => <option key={r} value={r}>{RATING_LABELS[r]}</option>)}
      </select>
    </div>
  );

  const chip = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${on ? 'bg-sky-600 text-white border-sky-400' : 'bg-transparent text-white border-white/20 hover:bg-white/5'}`;
  const setF = (patch: Partial<CrowdFilter>) => setCrowdFilter((f) => ({ ...f, ...patch }));
  const activeCrowd = crowdFilterCount(crowdFilter);

  const crowdFilters = (
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
        {activeCrowd > 0 && (
          <button onClick={() => setCrowdFilter(NO_CROWD_FILTER)} className="self-start text-xs font-bold text-sky-300 underline">
            ניקוי הסינון
          </button>
        )}
      </div>
  );

  // Komoot grades only the trails it lists, so most of a country's have no
  // level; how many, of the ones in view, the checkbox says.
  const ungraded = (countryList ?? []).filter((t) => !t.crowd?.difficulty && (!region || region === 'all' || t.regions.includes(region))).length;
  const difficultyPanel = (
    <DifficultyFilterBody
      filter={difficultyFilter}
      onChange={setDifficultyFilter}
      unknown={ungraded}
      explanation={<>לפי הדירוג של Komoot (כושר ושטח יחד), למסלולים ש-Komoot מכיר מבין הנפוצים באזור. לשאר המסלולים אין רמת קושי, עד שפותחים אותם — אז היא מחושבת בכרטיס לפי האורך והעליות.</>}
    />
  );

  // The filters and the order, in one fixed row above the list — not in
  // the list, where they scrolled away, nor as sections that pushed it down.
  // "סינון" opens everything that narrows the list; "סדר" is one choice for
  // what used to be two (the landscape's order and the hikers').
  type View = 'countries' | 'regions' | 'trails';
  const filterRow = (view: View) => {
    const land = view === 'countries' ? landscape : view === 'regions' ? countryLandscape : trailLand;
    const crowd = view !== 'countries' && hasCrowd;
    const what = view === 'countries' ? 'מדינות' : view === 'regions' ? 'אזורים' : 'מסלולים';
    const kind = view === 'trails' ? 'trail' : 'area';
    const active = (land ? activeLandscape : 0) + (crowd ? activeCrowd + (difficultyFilter.levels.length ? 1 : 0) : 0);

    const sorts: Array<[string, string]> = view === 'trails' && hasCrowd
      ? [['crowd:traffic', 'הכי הרבה מטיילים'], ['crowd:rating', 'לפי ציון מטיילים'], ['crowd:default', 'טיולי יום קודם']]
      : [['default', view === 'trails' ? 'טיולי יום קודם' : 'סדר רגיל']];
    if (land) for (const v of LANDSCAPE_SORTS) if (v !== 'default') sorts.push([v, SORT_LABELS[v]]);
    const sortChoice = landscapeSort !== 'default' && land ? landscapeSort
      : view === 'trails' && hasCrowd ? `crowd:${crowdFilter.sort}` : 'default';
    const onSort = (v: string) => {
      if (v.startsWith('crowd:')) {
        setLandscapeSort('default');
        setF({ sort: v.slice(6) as CrowdSort });
      } else setLandscapeSort(v as LandscapeSort);
    };
    if (!land && !crowd && sorts.length < 2) return null;

    const section = (title: string, node: ReactNode) => (
      <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2 first:border-t-0 first:pt-0">
        <span className="text-sm font-extrabold text-sky-200">{title}</span>
        {node}
      </div>
    );
    return (
      <div className="relative grid grid-cols-2 gap-2 shrink-0">
        {land || crowd ? (
          <FilterDropdown label="סינון" value={active === 1 ? 'מסנן אחד' : `${active} מסננים`} active={active > 0}>
            {land && section('נוף', <LandscapeFilterParts filter={landscapeFilter} onChange={setLandscapeFilter} kind={kind} what={what} />)}
            {crowd && section('מטיילים', crowdFilters)}
            {crowd && section('רמת קושי', difficultyPanel)}
          </FilterDropdown>
        ) : <span />}
        <select className={SELECT_CLASS} value={sortChoice} onChange={(e) => onSort(e.target.value)} aria-label="סדר הרשימה">
          {sorts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
    );
  };

  // What is being looked at — the area chosen, or the whole country — and its
  // main mountain ranges.
  const shownLandscape = countryLandscape
    ? (region && region !== 'all' ? countryLandscape.regions[region] : countryLandscape.country) ?? null
    : null;
  const shownRanges = shownLandscape && countryLandscape
    ? shownLandscape.ranges.map((id) => rangeName(countryLandscape, id)).filter((n): n is string => !!n).slice(0, 3)
    : [];

  const failure = (status: Status, retry: () => void, what: string) => (
    <div className="rounded-lg bg-amber-500/10 border border-amber-400/35 p-2 text-sm text-amber-100 flex items-center justify-between gap-2">
      <span>{status === 'rate-limited' ? 'יותר מדי בקשות כרגע' : `לא הצלחנו לטעון ${what}`}. נסו שוב בעוד רגע.</span>
      <button onClick={retry} className="shrink-0 p-1.5 bg-white/10 hover:bg-white/20 rounded-full" title="נסה שוב">
        <RefreshCw className="w-4 h-4 text-white" />
      </button>
    </div>
  );

  // ── A country's hiking regions ("אזורי טיול") ──────────────────────────
  if (country && guideOpen && guide) {
    return (
      <CountryGuide
        guide={guide}
        onBack={closeGuide}
        shown={guideShown}
        onShow={(index) => onGuideMap?.({ guide, index })}
        onOpenTrail={onPickTrail}
      />
    );
  }

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
        {guide && (
          <button
            onClick={() => setGuideOpen(true)}
            className="shrink-0 flex items-center gap-2 rounded-xl bg-sky-600/25 border border-sky-400/40 hover:bg-sky-600/40 px-3 py-2 text-right transition-colors"
          >
            <BookOpen className="w-4 h-4 text-sky-200 shrink-0" />
            <span className="min-w-0 flex flex-col">
              <span className="text-sm font-bold text-white">אזורי הטיול ב{countryName(country)}</span>
              <span className="text-xs text-white truncate">{guide.regions.map((r) => r.name).join(' · ')}</span>
            </span>
            <ChevronLeft className="w-4 h-4 text-white shrink-0 mr-auto" />
          </button>
        )}
        {shownLandscape && countryLandscape && (
          <div className="flex flex-col gap-0.5 shrink-0">
            <LandscapeLine s={shownLandscape} bins={countryLandscape.reliefBins} />
            {shownRanges.length > 0 && (
              <span className="text-xs text-amber-200 flex min-w-0">רכסים:&nbsp;<NameList names={shownRanges} /></span>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 shrink-0">
          {monthSelect}
          {ratingSelect}
        </div>
        {countryList && filterRow(choosingRegion ? 'regions' : 'trails')}

        <div
          ref={listRef}
          onScroll={(e) => keepScroll(e.currentTarget.scrollTop)}
          className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-2 min-h-0"
        >
          {/* Inside the scrolling part: opened, they are taller than a phone's
              panel, and above the list they would leave the list no room. */}
          {leaders && (
            <LeadersSection
              country={country}
              area={region && region !== 'all' ? regionNames.get(region)?.name ?? null : null}
              leaders={leaders}
              month={month}
              regionLabel={region && region !== 'all' ? null : regionLabel}
              onPick={(t) => onPickTrail({ type: 'relation', id: t.id, name: t.name, group: t.group, linear: t.linear })}
            />
          )}
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
              {activeLandscape > 0 && countryLandscape && (
                <div className="text-xs text-emerald-200">
                  {regionRows.length
                    ? `${regionRows.length} מתוך ${countryData?.regions.length} האזורים עונים על הסינון לפי נוף`
                    : 'אף אזור לא עונה על הסינון לפי נוף. נסו לרכך אותו.'}
                </div>
              )}
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
                    {r.landscape && countryLandscape && <LandscapeLine s={r.landscape} bins={countryLandscape.reliefBins} />}
                    {countryLandscape && sortBadge(r.landscape, countryLandscape.reliefBins, landscapeSort) && (
                      <span className="text-xs font-bold text-emerald-300">{sortBadge(r.landscape, countryLandscape.reliefBins, landscapeSort)}</span>
                    )}
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
                : activeCrowd || difficultyF.levels.length || (trailLand && activeLandscape)
                  ? `אין מסלולים ב"${RATING_LABELS[rating]}" ב${MONTH_NAMES[month]} שעונים על הסינון. נסו לרכך אותו.`
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
                <span className="min-w-0">{trailTitle(t.name, t.crowd?.komootName).title}</span>
              </span>
              <LatinLine t={t} country={country} />
              {trailTitle(t.name, t.crowd?.komootName).waymark && <span className="text-xs font-semibold text-amber-200">סימון בשטח: <bdi>{t.name}</bdi></span>}
              <span className="text-xs text-white">
                {t.multiDay ? 'רב-יומי' : groupLabel(t.group)} · {t.km >= 10 ? Math.round(t.km) : t.km} ק״מ
                {t.crossesBorder ? ` ב${countryName(country)}, וממשיך מעבר לגבול` : ''}
              </span>
              {hasCrowd && <CrowdLine crowd={t.crowd} />}
              {trailLand && (t.landscape
                ? <LandscapeLine s={t.landscape} bins={trailLand.reliefBins} kind="trail" />
                : <span className="text-xs text-white">נוף: אין מידע על המסלול הזה</span>)}
              {trailLand && sortBadge(t.landscape, trailLand.reliefBins, landscapeSort, 'trail') && (
                <span className="text-xs font-bold text-emerald-300">{sortBadge(t.landscape, trailLand.reliefBins, landscapeSort, 'trail')}</span>
              )}
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

  // ── The three ways in ───────────────────────────────────────────────────
  const header = (
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex rounded-xl bg-white/5 border border-white/10 p-0.5 flex-1 min-w-0" role="tablist">
          {([['month', 'לפי חודש'], ['country', 'לפי מדינה'], ['ranking', 'לפי דירוג']] as const).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`flex-1 min-w-0 rounded-lg px-1 py-1.5 text-sm font-bold leading-tight transition-colors ${mode === m ? 'bg-white/20 text-white' : 'text-white hover:bg-white/10'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <InfoButton label="מסלולים בעולם">
          <p>
            <b>לפי דירוג:</b> כל המסלולים שיש עליהם נתונים מ-Komoot, מכל המדינות שנאספו, ברשימה אחת — מהפופולרי
            ביותר. הציון המשוקלל (0–100) בנוי מכמות המטיילים (55%), מספר הדירוגים (20%) והציון שלהם (25%). המטיילים
            והדירוגים נספרים בסקאלה לוגריתמית — המעבר מ-100 ל-1,000 מטיילים שווה כמו מ-1,000 ל-10,000 — וציון שמבוסס על
            מעט דירוגים נמשך לכיוון הממוצע, כך ש-5.0 משני מדרגים לא עוקף 4.8 ממאות. אפשר לסנן לפי יבשת, מדינה וחודש (רק
            מסלולים בעונה מומלצת בו), ולסדר לפי הציון המשוקלל או לפי כל אחד משלושת הנתונים.
          </p>
          <p className="mt-2">
            <b>לפי חודש:</b> בוחרים חודש ורואים את המדינות שיש בהן אזורים ב&quot;עונה מומלצת&quot; — לפי האקלים בלבד,
            ליום הליכה של כ-4 שעות. האחוז הוא כמה משטח המדינה מתאים. כמה מסלולים יש שם בפועל ידוע רק אחרי שהמדינה נפתחה
            פעם ראשונה, ואז המספר מופיע ליד שמה.
          </p>
          <p className="mt-2">
            <b>יבשות:</b> בשתי הדרכים אפשר לצמצם את הרשימה ליבשת אחת. המזרח התיכון הוא קבוצה בפני עצמה (לא חלק
            מאסיה); מרכז אמריקה והאיים הקריביים נמצאים תחת צפון אמריקה. רוסיה וארצות הקווקז מופיעות גם באירופה וגם
            באסיה, טורקיה גם באירופה וגם במזרח התיכון, ומצרים גם במזרח התיכון וגם באפריקה.
          </p>
          <p className="mt-2">
            <b>המסלולים</b> הם מסלולים מסומנים מ-Waymarked Trails: במדינה קטנה גם מקומיים, ובמדינה גדולה בעיקר אזוריים
            וארציים. כל מסלול מדורג לפי האקלים לאורכו, הגובה שלו והאורך, כמו בכרטיס המסלול.
          </p>
          <p className="mt-2">
            <b>מה אומרים מטיילים</b> (כרגע ב-16 מדינות באירופה): ליד כל מסלול כמה מטיילים יש בו ביחס לשאר המסלולים במדינה, וציון
            המטיילים — לפי המסלולים המובילים של כל אזור ב-Komoot ולפי ויקיפדיה. אפשר לסנן ולמיין לפי שניהם. מסלול שלא
            מופיע שם מסומן &quot;אין מספיק מידע&quot; — זה לא אומר שיש בו מעט מטיילים.
          </p>
          <p className="mt-2">
            <b>הנוף</b> — ליד כל מדינה וכל אזור: <b>הרים</b> לפי כמה הקרקע יורדת סביבך ברדיוס של כ-2.5 ק״מ (לא לפי הגובה —
            רמה גבוהה ושטוחה איננה דרמטית), <b>יער</b> וסוגו לפי מפת הכיסוי של Copernicus, ו<b>נהרות ונחלים</b> לפי מודל
            עולמי שמעריך לכל קטע נהר אם הוא זורם כל השנה או רק בעונה. המילה ליד ההרים היא הדרגה הגבוהה שמכסה לפחות עשירית
            מהשטח. נחלים קטנים מאוד (אגן קטן מ-10 קמ״ר) לא נספרים.
          </p>
        </InfoButton>
      </div>
  );

  if (mode === 'ranking') {
    return (
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        {header}
        <WorldRanking onPickTrail={onPickTrail} />
      </div>
    );
  }

  // ── Choosing a country ──────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {header}

      <div className={`grid gap-2 shrink-0 ${mode === 'month' ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {mode === 'month' && monthSelect}
        {continentSelect}
      </div>

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

      {filterRow('countries')}

      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar flex flex-col gap-1.5 min-h-0">
        {climateStatus === 'loading' && <div className="text-sm text-white py-3">טוען…</div>}
        {(climateStatus === 'unavailable' || climateStatus === 'rate-limited') &&
          failure(climateStatus, () => { setClimateStatus('loading'); setClimateAttempt((n) => n + 1); }, 'את רשימת המדינות')}

        {climate && mode === 'month' && (
          <>
            <div className="text-xs text-white">
              {MONTH_NAMES[month]}: <span className="font-bold text-emerald-300">{inSeason.length} מדינות</span>
              {continentLabel && ` ב${continentLabel}`} עם אזורים בעונה מומלצת
              {activeLandscape > 0 && ' שעונות על הסינון לפי נוף'}
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
                    {landscapeLine(c.country)}
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

        {climate && mode === 'country' && (activeLandscape > 0 || continentLabel) && (
          <div className="text-xs text-white">
            <span className="font-bold text-emerald-300">{allCountries.length} מדינות</span>
            {continentLabel && ` ב${continentLabel}`}
            {activeLandscape > 0 && ' שעונות על הסינון לפי נוף'}
          </div>
        )}
        {climate && mode === 'country' && allCountries.map((code) => (
          <button
            key={code}
            onClick={() => openCountry(code)}
            className="text-right bg-white/5 border border-white/5 px-3 py-2.5 rounded-xl hover:bg-white/10 hover:border-orange-500/40 transition-all text-sm font-bold text-white flex flex-col gap-0.5"
          >
            {countryName(code)}
            {landscapeLine(code)}
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
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-white flex items-center gap-1"><Footprints className="w-3.5 h-3.5 shrink-0" /> מטיילים: {NO_CROWD_INFO}</span>
        <DifficultyBadge d={crowd?.difficulty} />
      </span>
    );
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
      <DifficultyBadge d={crowd?.difficulty} />
    </span>
  );
}

// "המסלולים המובילים": the busiest day walks and long-distance paths of the
// country or area, ranked, each with its numbers and this month's dot.
function LeadersSection({ area, country, leaders, month, regionLabel, onPick }: {
  // The area chosen, or null for the whole country (named in the header).
  area: string | null;
  country: string | null;
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
          <span className="min-w-0">{trailTitle(t.name, t.crowd?.komootName).title}</span>
          <span className={`w-2 h-2 rounded-full shrink-0 ${RATING_DOT[t.months[month]]}`} title={RATING_LABELS[t.months[month]]} />
        </span>
        <LatinLine t={t} country={country} />
        {trailTitle(t.name, t.crowd?.komootName).waymark && <span className="text-xs font-semibold text-amber-200">סימון בשטח: <bdi>{t.name}</bdi></span>}
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
      summary={<span className="max-w-[8rem] text-sky-200 flex min-w-0"><NameList names={[latinName(top[0].name, top[0].name_en, country) ?? trailTitle(top[0].name, top[0].crowd?.komootName).title]} /></span>}
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
// The name in Latin letters, under a name in another script (trailNames.ts).
function LatinLine({ t, country }: { t: { name: string; name_en: string | null }; country: string | null }) {
  const latin = latinName(t.name, t.name_en, country);
  return latin ? <span className="text-xs text-white" dir="ltr">{latin}</span> : null;
}

function NameList({ names }: { names: string[] }) {
  return (
    <span className="truncate min-w-0">
      {names.map((n, i) => <span key={i}>{i > 0 && ' · '}<bdi>{n}</bdi></span>)}
    </span>
  );
}
