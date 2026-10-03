import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TrailData } from './useTrailData';
import type { MonthVerdict } from '../lib/climate';
import { readCachedClimate, writeCachedClimate, trailCacheKey } from '../lib/climateCache';

export type ClimateStatus = 'loading' | 'ok' | 'unavailable' | 'rate-limited';

export interface TrailClimate {
  status: ClimateStatus;
  months: MonthVerdict[] | null;
  retry: () => void;
}

// The trail's lowest and highest points: the heat is judged at the one and
// the cold at the other. A walk with no heights is asked about at its start,
// and the server takes the ground's own height there.
function extremes(coords: TrailData['coords'], hasElevation: boolean) {
  const [slat, slon, sele] = coords[0];
  if (!hasElevation) {
    const p = { lat: slat, lon: slon, ele: null };
    return { low: p, high: p };
  }
  let lo = 0, hi = 0;
  for (let i = 1; i < coords.length; i++) {
    if (coords[i][2] < coords[lo][2]) lo = i;
    if (coords[i][2] > coords[hi][2]) hi = i;
  }
  return {
    low: { lat: coords[lo][0], lon: coords[lo][1], ele: Math.round(coords[lo][2] ?? sele) },
    high: { lat: coords[hi][0], lon: coords[hi][1], ele: Math.round(coords[hi][2] ?? sele) },
  };
}

// The twelve months for the open trail ("מתי כדאי ללכת"). `hours` is the
// walk's length with breaks, the same figure the forecast works from.
//
// The device's copy is shown at once and never expires (the climate does not
// change); the server is only asked when there is none.
export function useTrailClimate(trail: TrailData | null, hours: number): TrailClimate {
  const isDrive = trail?.kind === 'drive';
  const key = trail && !isDrive && trail.coords.length >= 2 && hours > 0 ? trailCacheKey(trail.name, trail.coords) : null;

  // The server's answer, tagged with the trail it is for, so a quick switch
  // between trails never shows one trail's months on another.
  const [fetched, setFetched] = useState<{ key: string; months: MonthVerdict[] | null; status: ClimateStatus } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // `fetched` is a dependency so a copy just written is read back.
  const cached = useMemo(() => readCachedClimate(key), [key, fetched]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!trail || !key || cached) return;
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      let result: { months: MonthVerdict[] | null; status: ClimateStatus };
      try {
        const res = await fetch('/api/climate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...extremes(trail.coords, trail.maxEle > trail.minEle), hours }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (data.status === 'ok' && Array.isArray(data.months) && data.months.length === 12) {
          writeCachedClimate(key, data.months);
          result = { months: data.months, status: 'ok' };
        } else {
          result = { months: null, status: data.status === 'rate-limited' ? 'rate-limited' : 'unavailable' };
        }
      } catch {
        if (controller.signal.aborted) return;
        result = { months: null, status: 'unavailable' };
      }
      if (!cancelled) setFetched({ key, ...result });
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [trail, key, cached, hours, attempt]);

  const retry = useCallback(() => {
    setFetched(null);
    setAttempt((n) => n + 1);
  }, []);

  const mine = fetched?.key === key ? fetched : null;
  const months = cached ?? mine?.months ?? null;
  const status: ClimateStatus = cached ? 'ok' : mine?.status ?? 'loading';
  return useMemo(() => ({ status, months, retry }), [status, months, retry]);
}
