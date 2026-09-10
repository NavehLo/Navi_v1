import { useEffect, useState } from 'react';
import type { TrailData } from './useTrailData';
import { loadCanopyGrid } from '../lib/canopy';
import { computeShade, computeWater, type ShadeResult, type WaterResult } from '../lib/summerConditions';
import { readCachedWater, writeCachedWater, trailCacheKey } from '../lib/waterCache';
import { unpackBar } from '../lib/summerConditions';
import type { WaterSource } from '../app/api/water/route';
import type { TrailSummer } from '../lib/summerFilters';

// Whether the answer about water can be believed. 'unavailable' and
// 'rate-limited' are not "no water here" — they are "we could not ask" — and
// the panel has to be able to say so. Getting this wrong in the POI feature is
// what once made trails silently lose their points.
export type WaterStatus = 'loading' | 'ok' | 'cached' | 'precomputed' | 'unavailable' | 'rate-limited';

// The bundled trails carry their water figures in trails.json, worked out at
// build time by scripts/buildSummerIndex.mjs. Reading them costs nothing and
// works offline, so a trail that has them never touches Overpass — which is
// most of the app's use. Only a GPX the user brought in has to ask.
//
// Matched by name, because that is the one thing the loaded trail and the index
// entry both carry. Two bundled trails sharing a name would be a problem for
// the trail list long before it was a problem here.
let indexPromise: Promise<Map<string, TrailSummer>> | null = null;

function loadSummerIndex(): Promise<Map<string, TrailSummer>> {
  if (!indexPromise) {
    indexPromise = fetch('/trails.json')
      .then((r) => r.json())
      .then((rows: Array<{ name: string; summer?: TrailSummer }>) => {
        const byName = new Map<string, TrailSummer>();
        for (const row of rows) if (row.summer) byName.set(row.name, row.summer);
        return byName;
      })
      .catch(() => new Map<string, TrailSummer>());
  }
  return indexPromise;
}

export interface SummerConditions {
  shade: ShadeResult | null;
  // Distinguishes "still working it out" from "we have no answer for this
  // trail". Both render as no number, but only one of them is worth waiting on.
  shadeLoading: boolean;
  water: WaterResult | null;
  waterStatus: WaterStatus;
  attribution: string | null;
}

// Summer conditions for the open trail.
//
// The two halves behave quite differently and are deliberately not merged into
// one loading flag. Shade is read from a grid that ships with the app: no
// network, works offline, always an answer. Water goes out to Overpass, so it
// is slower, can fail, and falls back to whatever was cached for this trail.
export function useSummerConditions(trail: TrailData | null): SummerConditions {
  const [shade, setShade] = useState<ShadeResult | null>(null);
  const [shadeLoading, setShadeLoading] = useState(false);
  const [water, setWater] = useState<WaterResult | null>(null);
  const [waterStatus, setWaterStatus] = useState<WaterStatus>('loading');
  const [attribution, setAttribution] = useState<string | null>(null);

  useEffect(() => {
    if (!trail) {
      setShade(null);
      setShadeLoading(false);
      return;
    }

    let cancelled = false;
    setShade(null);
    setShadeLoading(true);

    loadCanopyGrid().then((grid) => {
      if (cancelled) return;
      setShadeLoading(false);
      if (!grid) return;
      setAttribution(grid.attribution);
      setShade(computeShade(trail.coords, trail.accumulatedDistances, grid));
    });

    return () => { cancelled = true; };
  }, [trail]);

  useEffect(() => {
    if (!trail) {
      setWater(null);
      setWaterStatus('loading');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setWater(null);
    setWaterStatus('loading');

    const key = trailCacheKey(trail.name, trail.coords);
    const apply = (sources: WaterSource[], status: WaterStatus) => {
      if (cancelled) return;
      setWater(computeWater(trail.coords, trail.accumulatedDistances, sources));
      setWaterStatus(status);
    };

    // Show the cached answer straight away rather than leaving the section
    // blank while Overpass thinks about it. A fresh 'ok' overwrites it below;
    // a failure leaves it standing, which is the whole point of the cache.
    const cached = readCachedWater(key);
    if (cached) apply(cached, 'cached');

    (async () => {
      const precomputed = (await loadSummerIndex()).get(trail.name);
      if (precomputed?.nearWaterPct != null && precomputed.waterBar) {
        if (cancelled) return;
        setWater({
          longestDryKm: precomputed.longestDryKm ?? 0,
          nearWaterPct: precomputed.nearWaterPct,
          points: (precomputed.waterPoints ?? []).map((p) => ({ ...p, index: 0 })),
          confidentCount: (precomputed.waterPoints ?? []).filter((p) => p.confident).length,
          bar: unpackBar(precomputed.waterBar),
        });
        setWaterStatus('precomputed');
        return;
      }

      try {
        const res = await fetch('/api/water', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ coords: trail.coords.map((c) => [c[0], c[1]]) }),
          signal: controller.signal,
        });
        const data = await res.json();
        const status: WaterStatus = data.status ?? 'unavailable';
        if (status === 'ok') {
          writeCachedWater(key, data.sources ?? []);
          apply(data.sources ?? [], 'ok');
          return;
        }
        // Overpass said no. If something was cached we are already showing it
        // and it stays; otherwise the panel gets to say we could not ask.
        if (!cancelled && !cached) setWaterStatus(status);
      } catch {
        if (controller.signal.aborted || cancelled) return;
        if (!cached) setWaterStatus('unavailable');
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [trail]);

  return { shade, shadeLoading, water, waterStatus, attribution };
}
