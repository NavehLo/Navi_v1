import { useCallback, useEffect, useRef } from "react";
import { getDistance } from "../utils/trailUtils";
import type { TrailData } from "./useTrailData";

type POI = TrailData["pois"][number];

export interface GeofenceOptions {
  radiusKm?: number;
  enabled: boolean;
}

// Fires onEnter once per POI when `position` (virtual camera or real GPS —
// the source is injected by the caller) comes within radiusKm of it.
// At tour speed x1 the camera moves ~22 m/s (SEC_PER_KM = 45), so a 50m
// radius cannot be stepped over between frames at normal speeds.
export function usePOIGeofence(
  trail: TrailData | null,
  position: { lat: number; lon: number } | null,
  onEnter: (poi: POI) => void,
  { radiusKm = 0.05, enabled }: GeofenceOptions
): { reset: () => void } {
  const visitedRef = useRef<Set<number>>(new Set());

  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  // New trail → fresh visited set
  useEffect(() => {
    visitedRef.current.clear();
  }, [trail]);

  useEffect(() => {
    if (!enabled || !trail?.pois || !position) return;

    for (const poi of trail.pois) {
      if (visitedRef.current.has(poi.index)) continue;
      const distKm = getDistance(position.lat, position.lon, poi.coord[0], poi.coord[1]);
      if (distKm < radiusKm) {
        visitedRef.current.add(poi.index);
        onEnterRef.current(poi);
        break; // one trigger per position update
      }
    }
  }, [position?.lat, position?.lon, enabled, trail, radiusKm]);

  const reset = useCallback(() => {
    visitedRef.current.clear();
  }, []);

  return { reset };
}
