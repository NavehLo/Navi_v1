import { useCallback, useEffect, useRef } from "react";
import { getDistance } from "../utils/trailUtils";
import type { TrailPOI } from "./useTrailData";

export interface GeofenceOptions {
  radiusKm?: number;
  enabled: boolean;
  resetKey?: string; // clear the visited set when this changes (e.g. trail name)
}

const poiKey = (p: TrailPOI) => `${p.index}:${p.type}`;

// Fires onEnter once per POI when `position` (virtual camera or real GPS —
// the source is injected by the caller) comes within radiusKm of it.
// At tour speed x1 the camera moves ~22 m/s (SEC_PER_KM = 45), so a 50m
// radius cannot be stepped over between frames at normal speeds.
export function usePOIGeofence(
  pois: TrailPOI[],
  position: { lat: number; lon: number } | null,
  onEnter: (poi: TrailPOI) => void,
  { radiusKm = 0.05, enabled, resetKey }: GeofenceOptions
): { reset: () => void } {
  const visitedRef = useRef<Set<string>>(new Set());

  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  // New trail → fresh visited set
  useEffect(() => {
    visitedRef.current.clear();
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || !pois.length || !position) return;

    for (const poi of pois) {
      const key = poiKey(poi);
      if (visitedRef.current.has(key)) continue;
      const distKm = getDistance(position.lat, position.lon, poi.coord[0], poi.coord[1]);
      if (distKm < radiusKm) {
        visitedRef.current.add(key);
        onEnterRef.current(poi);
        break; // one trigger per position update
      }
    }
  }, [position?.lat, position?.lon, enabled, pois, radiusKm]);

  const reset = useCallback(() => {
    visitedRef.current.clear();
  }, []);

  return { reset };
}
