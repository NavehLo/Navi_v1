import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TrailData } from './useTrailData';
import { computeElevationGain } from '../utils/trailUtils';
import { weatherPointsFor, isDesertArea, type WeatherBundle, type WeatherStatus } from '../lib/weather';
import { estimateHike, type HikeEffort } from '../lib/hikeEffort';
import { adviseWeek, findTodayIndex, type DayAdvice } from '../lib/hikeAdvice';
import {
  readCachedWeather, writeCachedWeather, readTripDate, writeTripDate, readTripStart, writeTripStart,
  trailCacheKey, WEATHER_FRESH_MS,
} from '../lib/weatherCache';

export interface TripWeather {
  status: WeatherStatus;
  fetchedAt: number | null;
  effort: HikeEffort | null;   // null on drives
  hours: number;               // time out there, breaks included
  days: DayAdvice[];           // today and the six after it
  selected: DayAdvice | null;
  selectDate: (date: string) => void;
  startHour: number | null;    // chosen start; null for the default
  selectStart: (hour: number | null) => void;
  retry: () => void;
}

// The forecast for the open trail and what it means for walking it.
//
// Built like useSummerConditions' water half: show what the device has at
// once, ask the server, and keep the cached answer standing if the server
// cannot be reached — 'unavailable' is "we could not ask", never "fine day".
export function useTripWeather(trail: TrailData | null): TripWeather {
  const [bundle, setBundle] = useState<WeatherBundle | null>(null);
  const [status, setStatus] = useState<WeatherStatus>('loading');
  const [date, setDate] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startHour, setStartHour] = useState<number | null>(() => (typeof window === 'undefined' ? null : readTripStart()));

  const isDrive = trail?.kind === 'drive';

  const { effort, hours } = useMemo(() => {
    if (!trail) return { effort: null, hours: 0 };
    if (isDrive) {
      const h = trail.driveDurationSec != null ? trail.driveDurationSec / 3600 : trail.totalDistance / 60;
      return { effort: null, hours: Math.max(0.5, Math.round(h * 4) / 4) };
    }
    const climb = trail.maxEle > trail.minEle ? computeElevationGain(trail.elevations) : { gain: 0, loss: 0 };
    const e = estimateHike(trail.totalDistance, climb.gain, climb.loss);
    return { effort: e, hours: e.totalHours };
  }, [trail, isDrive]);

  useEffect(() => {
    if (!trail || trail.coords.length < 2) {
      setBundle(null);
      setStatus('loading');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    const key = trailCacheKey(trail.name, trail.coords);
    const cached = readCachedWeather(key);
    setBundle(cached);
    setStatus(cached ? 'cached' : 'loading');

    // Fresh enough — do not ask again just because the trail was reopened.
    if (cached && Date.now() - cached.fetchedAt < WEATHER_FRESH_MS) {
      setStatus('ok');
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/weather', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: weatherPointsFor(trail.coords, trail.maxEle > trail.minEle) }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (cancelled) return;
        if (data.status === 'ok' && data.bundle) {
          writeCachedWeather(key, data.bundle);
          setBundle(data.bundle);
          setStatus('ok');
          return;
        }
        if (!cached) setStatus(data.status === 'rate-limited' ? 'rate-limited' : 'unavailable');
      } catch {
        if (controller.signal.aborted || cancelled) return;
        if (!cached) setStatus('unavailable');
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [trail, attempt]);

  const days = useMemo(() => {
    if (!bundle || !trail) return [];
    const mid = trail.coords[Math.floor(trail.coords.length / 2)];
    return adviseWeek(bundle, findTodayIndex(bundle), {
      kind: isDrive ? 'drive' : 'hike',
      hours,
      isDesert: isDesertArea(mid[0], mid[1]),
      startHour,
    });
  }, [bundle, trail, isDrive, hours, startHour]);

  // The day picked here, else the trip day remembered from another trail,
  // else today — whichever is still one of the choosable days.
  const selected = useMemo(() => {
    const find = (d: string | null) => (d ? days.find((x) => x.date === d) : undefined);
    return find(date) ?? find(readTripDate()) ?? days[0] ?? null;
  }, [days, date]);

  const selectDate = useCallback((d: string) => {
    setDate(d);
    writeTripDate(d);
  }, []);

  const selectStart = useCallback((h: number | null) => {
    setStartHour(h);
    writeTripStart(h);
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // One object per real change: the stats panel is memoised, and a fresh
  // object on every page render (the GPS alone re-renders it every second)
  // would redraw it for nothing.
  const fetchedAt = bundle?.fetchedAt ?? null;
  return useMemo(
    () => ({ status, fetchedAt, effort, hours, days, selected, selectDate, startHour, selectStart, retry }),
    [status, fetchedAt, effort, hours, days, selected, selectDate, startHour, selectStart, retry],
  );
}
