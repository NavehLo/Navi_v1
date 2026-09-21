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
// A national trail loaded from the world overlay can run hundreds of km. An
// Overpass "around" query over that is a request that times out for everyone;
// past this length we do not ask, and the trail has no guide points.
export const MAX_KM_FOR_OSM_QUERIES = 100;

// Where the list on screen came from. 'pending' means discovery has not
// answered yet and 'skipped' that it was not attempted — an empty list used to
// be reported the same as a full one, so an Overpass outage looked like a
// trail losing its points.
export type PoiSource = 'pending' | 'skipped' | 'live' | 'cache';

export interface TrailPOIsResult {
  pois: TrailPOI[];
  source: PoiSource;
  // Set when discovery could not be done at all, as opposed to being done and
  // finding nothing.
  discoveryFailed: boolean;
}

// The trail's guide points: real places along it (waterfalls, springs,
// viewpoints, ruins...) from OpenStreetMap that have something of their own to
// be said about them — the server keeps only points with a Hebrew Wikipedia
// article or a written description. There are no synthetic start, midway or
// end points any more: a greeting at the trailhead told the walker nothing
// about the trailhead, and a trail where nothing is known has no guide points.
//
// Discovery is best-effort, and its failures are common enough — Overpass is a
// free service that throttles and times out — that the last successful result
// is kept on the device and used when a new one cannot be had.
export function useTrailPOIs(trail: TrailData | null): TrailPOIsResult {
  const [pois, setPois] = useState<TrailPOI[]>([]);
  const [source, setSource] = useState<PoiSource>('pending');
  const [discoveryFailed, setDiscoveryFailed] = useState(false);

  useEffect(() => {
    setPois([]);
    setSource('pending');
    setDiscoveryFailed(false);
    if (!trail) return;

    if (trail.totalDistance > MAX_KM_FOR_OSM_QUERIES) {
      setSource('skipped');
      return;
    }

    const cacheKey = trailCacheKey(trail.name, trail.coords);

    // Whatever was discovered last time, shown immediately. Overpass takes
    // seconds even when it works, and this is the same list it will return.
    const cached = readCachedPois(cacheKey);
    if (cached) {
      setPois(snapToTrail(trail, cached));
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

      writeCachedPois(cacheKey, discovered);
      setPois(snapToTrail(trail, discovered));
      setSource('live');
    })();

    return () => controller.abort();
  }, [trail]);

  return { pois, source, discoveryFailed };
}

// Snaps discovered points onto the trail line, orders them along it, spaces
// them out and caps their number.
function snapToTrail(trail: TrailData, discovered: DiscoveredPOI[]): TrailPOI[] {
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

  snapped.sort((a, b) => a.index - b.index);
  const acc = trail.accumulatedDistances;
  const spaced: TrailPOI[] = [];
  for (const p of snapped) {
    const last = spaced[spaced.length - 1];
    if (last && p.index === last.index) continue; // two POIs on same point — keep first
    if (last && acc[p.index] - acc[last.index] < MIN_SPACING_KM) continue;
    spaced.push(p);
    if (spaced.length >= MAX_DISCOVERED) break;
  }
  return spaced;
}
