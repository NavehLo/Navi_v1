import { useCallback, useEffect, useRef } from "react";
import { getDistance } from "../utils/trailUtils";
import type { TrailPOI } from "./useTrailData";

export interface GeofenceOptions {
  radiusKm?: number;
  enabled: boolean;
  resetKey?: string; // clear progress when this changes (e.g. trail name)
  // How far along the trail each POI sits, aligned index-for-index with `pois`.
  // Without it the fence falls back to plain proximity.
  poiDistancesKm?: number[] | null;
  // How far along the trail the traveler is. Exact during a virtual tour,
  // projected from GPS in field mode, null when it cannot be known.
  travelerKm?: number | null;
}

// Fires onEnter for POIs **in trail order**, once each.
//
// Plain proximity is not enough: a route that returns near its own trailhead —
// a shared parking lot, a road crossed twice — puts the finish line within
// metres of the start, so the "you have reached the end" narration used to fire
// as the second thing the walker heard. Ordering plus an along-trail position
// check is what keeps the guide honest: point N+1 cannot speak before point N,
// and a point only speaks when the traveler is actually at that stretch of the
// walk, not merely standing near its coordinates.
export function usePOIGeofence(
  pois: TrailPOI[],
  position: { lat: number; lon: number } | null,
  onEnter: (poi: TrailPOI) => void,
  { radiusKm = 0.05, enabled, resetKey, poiDistancesKm = null, travelerKm = null }: GeofenceOptions
): { reset: () => void } {
  // Index into `pois` of the next point allowed to speak. Everything before it
  // has either been narrated or been walked past.
  const cursorRef = useRef(0);
  const lastTravelerKmRef = useRef<number | null>(null);

  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    cursorRef.current = 0;
    lastTravelerKmRef.current = null;
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || !pois.length || !position) return;

    const kmOf = (i: number): number | null => {
      const km = poiDistancesKm?.[i];
      return typeof km === "number" && Number.isFinite(km) ? km : null;
    };

    // Scrubbing the progress bar backwards should re-arm the points ahead
    // rather than leaving the walker in silence for the rest of the trail.
    if (travelerKm != null) {
      const previous = lastTravelerKmRef.current;
      if (previous != null && travelerKm < previous - 0.3) {
        let rewound = 0;
        while (rewound < pois.length) {
          const km = kmOf(rewound);
          if (km == null || km >= travelerKm - radiusKm) break;
          rewound++;
        }
        cursorRef.current = Math.min(cursorRef.current, rewound);
      }
      lastTravelerKmRef.current = travelerKm;

      // Consume points already walked past without narrating them — a skipped
      // point stays skipped instead of ambushing the walker kilometres later.
      while (cursorRef.current < pois.length) {
        const km = kmOf(cursorRef.current);
        if (km == null || travelerKm <= km + radiusKm) break;
        cursorRef.current++;
      }
    }

    if (cursorRef.current >= pois.length) return;

    const i = cursorRef.current;
    const poi = pois[i];
    const poiKm = kmOf(i);

    // With a known along-trail position the distance along the route decides,
    // so the narration starts ~radiusKm early and finishes around arrival.
    // Without one, fall back to straight-line proximity.
    const arrived =
      travelerKm != null && poiKm != null
        ? travelerKm >= poiKm - radiusKm && travelerKm <= poiKm + radiusKm
        : getDistance(position.lat, position.lon, poi.coord[0], poi.coord[1]) < radiusKm;

    if (arrived) {
      cursorRef.current = i + 1;
      onEnterRef.current(poi);
    }
  }, [position?.lat, position?.lon, enabled, pois, radiusKm, poiDistancesKm, travelerKm]);

  const reset = useCallback(() => {
    cursorRef.current = 0;
    lastTravelerKmRef.current = null;
  }, []);

  return { reset };
}
