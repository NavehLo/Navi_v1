import { useState, useEffect } from 'react';
import { TrailData, TrailPOI } from './useTrailData';
import { getDistance } from '../utils/trailUtils';
import {
  type DiscoveredPOI,
  readCachedPois,
  trailCacheKey,
  writeCachedPois,
} from '../lib/poiCache';

const MAX_SNAP_KM = 0.3;        // POI must be within 300m of the trail line
const MIN_SPACING_KM = 0.25;    // min distance along trail between narrated POIs
const MAX_DISCOVERED = 12;

// Where the list on screen came from. 'base' means the three synthetic
// start/midway/end points and nothing else — which used to be reported the same
// as a full list, so an Overpass outage looked like a trail losing its points.
export type PoiSource = 'base' | 'live' | 'cache';

export interface TrailPOIsResult {
  pois: TrailPOI[];
  source: PoiSource;
  // Set when discovery could not be done at all, as opposed to being done and
  // finding nothing.
  discoveryFailed: boolean;
}

// Enriches the trail's hardcoded start/midway/end POIs with real points of
// interest (waterfalls, springs, viewpoints, ruins...) from OpenStreetMap.
// Discovery is best-effort, and its failures are common enough — Overpass is a
// free service that throttles and times out — that the last successful result
// is kept on the device and used when a new one cannot be had.
export function useTrailPOIs(trail: TrailData | null): TrailPOIsResult {
  const [pois, setPois] = useState<TrailPOI[]>([]);
  const [source, setSource] = useState<PoiSource>('base');
  const [discoveryFailed, setDiscoveryFailed] = useState(false);

  useEffect(() => {
    if (!trail) {
      setPois([]);
      setSource('base');
      setDiscoveryFailed(false);
      return;
    }
    setPois(trail.pois); // immediate fallback while discovery runs
    setSource('base');
    setDiscoveryFailed(false);

    const cacheKey = trailCacheKey(trail.name, trail.coords);

    // Whatever was discovered last time, shown immediately. Overpass takes
    // seconds even when it works, and this is the same list it will return.
    const cached = readCachedPois(cacheKey);
    if (cached) {
      setPois(merge(trail, cached));
      setSource('cache');
    }

    const controller = new AbortController();
    (async () => {
      let discovered: DiscoveredPOI[] = [];
      try {
        const res = await fetch('/api/pois', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ coords: trail.coords.map((c) => [c[0], c[1]]) }),
        });
        const data = await res.json();
        discovered = data.pois ?? [];
        // 'ok' with nothing found is a real answer about this trail; anything
        // else is a failure, and a failure must not overwrite what we have.
        if (data.status && data.status !== 'ok') {
          setDiscoveryFailed(true);
          return;
        }
      } catch (e: unknown) {
        if ((e as { name?: string })?.name !== 'AbortError') {
          console.warn('POI discovery failed:', e);
          setDiscoveryFailed(true);
        }
        return;
      }

      if (discovered.length === 0) return;
      writeCachedPois(cacheKey, discovered);
      setPois(merge(trail, discovered));
      setSource('live');
    })();

    return () => controller.abort();
  }, [trail]);

  return { pois, source, discoveryFailed };
}

// Snaps discovered points onto the trail line, spaces them out and merges them
// with the trail's own start and end. Returns the trail's own points unchanged
// when nothing lands close enough to be worth narrating.
function merge(trail: TrailData, discovered: DiscoveredPOI[]): TrailPOI[] {
  const snapped: TrailPOI[] = [];
  for (const p of discovered) {
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < trail.coords.length; i++) {
      const d = getDistance(p.lat, p.lon, trail.coords[i][0], trail.coords[i][1]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestDist <= MAX_SNAP_KM && bestIdx >= 0) {
      snapped.push({
        index: bestIdx,
        coord: trail.coords[bestIdx],
        type: p.type,
        name: p.name,
        osmType: p.osmType,
        osmId: p.osmId,
        tags: p.tags,
      });
    }
  }
  if (snapped.length === 0) return trail.pois;

  // Order along the trail, enforce spacing, cap
  snapped.sort((a, b) => a.index - b.index);
  const acc = trail.accumulatedDistances;
  const spaced: TrailPOI[] = [];
  for (const p of snapped) {
    const last = spaced[spaced.length - 1];
    if (last && p.index !== last.index && acc[p.index] - acc[last.index] < MIN_SPACING_KM) continue;
    if (last && p.index === last.index) continue; // two POIs on same point — keep first
    spaced.push(p);
    if (spaced.length >= MAX_DISCOVERED) break;
  }

  // Keep start/end; keep the synthetic midway only when nothing real was found
  const startPoi = trail.pois.find((p) => p.type === 'start');
  const endPoi = trail.pois.find((p) => p.type === 'end');
  const totalKm = acc[acc.length - 1] ?? 0;
  const interior = spaced.filter(
    (p) => acc[p.index] > MIN_SPACING_KM && acc[p.index] < totalKm - MIN_SPACING_KM
  );

  return [
    ...(startPoi ? [startPoi] : []),
    ...(interior.length > 0 ? interior : trail.pois.filter((p) => p.type === 'midway')),
    ...(endPoi ? [endPoi] : []),
  ].sort((a, b) => a.index - b.index);
}
