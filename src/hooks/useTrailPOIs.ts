import { useState, useEffect } from 'react';
import { TrailData, TrailPOI } from './useTrailData';
import { getDistance } from '../utils/trailUtils';

const MAX_SNAP_KM = 0.3;        // POI must be within 300m of the trail line
const MIN_SPACING_KM = 0.25;    // min distance along trail between narrated POIs
const MAX_DISCOVERED = 12;

interface DiscoveredPOI {
  lat: number;
  lon: number;
  type: string;
  name: string | null;
}

// Enriches the trail's hardcoded start/midway/end POIs with real points of
// interest (waterfalls, springs, viewpoints, ruins...) from OpenStreetMap.
// Falls back to the original POIs on any failure — discovery is best-effort.
export function useTrailPOIs(trail: TrailData | null): TrailPOI[] {
  const [pois, setPois] = useState<TrailPOI[]>([]);

  useEffect(() => {
    if (!trail) {
      setPois([]);
      return;
    }
    setPois(trail.pois); // immediate fallback while discovery runs

    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/pois', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ coords: trail.coords.map((c) => [c[0], c[1]]) }),
        });
        const data = await res.json();
        const discovered: DiscoveredPOI[] = data.pois ?? [];
        if (discovered.length === 0) return;

        // Snap each discovered POI to its nearest trail point
        const snapped: TrailPOI[] = [];
        for (const p of discovered) {
          let bestIdx = -1, bestDist = Infinity;
          for (let i = 0; i < trail.coords.length; i++) {
            const d = getDistance(p.lat, p.lon, trail.coords[i][0], trail.coords[i][1]);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
          }
          if (bestDist <= MAX_SNAP_KM && bestIdx >= 0) {
            snapped.push({ index: bestIdx, coord: trail.coords[bestIdx], type: p.type, name: p.name });
          }
        }
        if (snapped.length === 0) return;

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

        const merged: TrailPOI[] = [
          ...(startPoi ? [startPoi] : []),
          ...(interior.length > 0 ? interior : trail.pois.filter((p) => p.type === 'midway')),
          ...(endPoi ? [endPoi] : []),
        ].sort((a, b) => a.index - b.index);

        setPois(merged);
      } catch (e: any) {
        if (e?.name !== 'AbortError') console.warn('POI discovery failed:', e);
      }
    })();

    return () => controller.abort();
  }, [trail]);

  return pois;
}
