import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import { TrailData } from "./useTrailData";
import { getBearing } from "../utils/trailUtils";

const SEC_PER_KM = 45;

export function useTour(map: mapboxgl.Map | null, trail: TrailData | null) {
  // External state just for UI reactivity
  const [isActive, setIsActive] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0); // 0 to 1

  // Internal refs — these are the source of truth for the animation loop
  const isActiveRef = useRef(false);
  const speedRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const virtualElapsedRef = useRef(0); // never reset on resume
  const currentBearingRef = useRef(0);
  const lastGeoJsonUpdateRef = useRef(0);

  // Keep speedRef in sync with speed state
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const cancelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const lerpCoord = useCallback((t: number) => {
    if (!trail || !trail.accumulatedDistances) return [0, 0, 0];
    const targetDistance = t * trail.totalDistance;
    const n = trail.accumulatedDistances.length;

    // Fast boundary checks
    if (targetDistance <= 0) return trail.coords[0] || [0, 0, 0];
    if (targetDistance >= trail.totalDistance) return trail.coords[n - 1] || [0, 0, 0];

    // Binary search to find the segment
    let low = 0;
    let high = n - 1;
    let lo = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (trail.accumulatedDistances[mid] <= targetDistance) {
        lo = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const hi = Math.min(lo + 1, n - 1);
    const distLo = trail.accumulatedDistances[lo];
    const distHi = trail.accumulatedDistances[hi];
    
    if (hi === lo || distHi === distLo) {
      return trail.coords[lo] || [0,0,0];
    }

    const frac = (targetDistance - distLo) / (distHi - distLo);
    const c1 = trail.coords[lo];
    const c2 = trail.coords[hi];
    
    return [
      c1[0] + (c2[0] - c1[0]) * frac,
      c1[1] + (c2[1] - c1[1]) * frac,
      (c1[2] || 0) + ((c2[2] || 0) - (c1[2] || 0)) * frac
    ];
  }, [trail]);

  const runLoop = useCallback(() => {
    if (!map || !trail) return;
    const totalDuration = trail.totalDistance * SEC_PER_KM * 1000;

    const tick = (ts: DOMHighResTimeStamp) => {
      if (!isActiveRef.current) return; // paused — stop silently

      if (!lastTsRef.current) lastTsRef.current = ts;
      let dt = ts - lastTsRef.current;
      lastTsRef.current = ts;
      if (dt > 100) dt = 16; // clamp spikes

      virtualElapsedRef.current += dt * speedRef.current;
      const t = Math.min(virtualElapsedRef.current / totalDuration, 1);
      setProgress(t);

      const pt = lerpCoord(t);
      const ptAhead = lerpCoord(Math.min(t + 0.015, 1));

      let targetBearing = currentBearingRef.current;
      if (ptAhead[0] !== pt[0] || ptAhead[1] !== pt[1]) {
        targetBearing = getBearing(pt[0], pt[1], ptAhead[0], ptAhead[1]);
      }

      let diff = targetBearing - currentBearingRef.current;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      const smoothFactor = 1.0 - Math.exp(-dt * 0.0015 * speedRef.current);
      currentBearingRef.current += diff * smoothFactor;

      // Move camera — preserve zoom entirely, only update center + bearing
      map.setCenter([pt[1], pt[0]]);
      map.setBearing(currentBearingRef.current);

      if (map.getSource('fly-pos')) {
        if (ts - lastGeoJsonUpdateRef.current > 40) {
          (map.getSource('fly-pos') as mapboxgl.GeoJSONSource).setData({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [pt[1], pt[0], pt[2] || 0] },
            properties: {}
          });
          lastGeoJsonUpdateRef.current = ts;
        }
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        isActiveRef.current = false;
        setIsActive(false);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [map, trail, lerpCoord]);

  const startTour = useCallback(() => {
    if (!map || !trail) return;

    const totalDuration = trail.totalDistance * SEC_PER_KM * 1000;
    const currentProgress = Math.min(virtualElapsedRef.current / totalDuration, 1);
    const isResume = currentProgress > 0 && currentProgress < 1;

    isActiveRef.current = true;
    setIsActive(true);
    lastTsRef.current = null; // Reset dt on next tick to avoid a jumpy first frame
    currentBearingRef.current = map.getBearing();

    if (isResume) {
      // Resume from exact position
      runLoop();
    } else {
      // Fresh start — jump immediately to trail start point
      const startPt = lerpCoord(0);
      const targetZoom = Math.max(map.getZoom(), 17);
      map.jumpTo({
        center: [startPt[1], startPt[0]],
        zoom: targetZoom,
        pitch: 60,
        bearing: map.getBearing()
      });
      // Ensure the fly-pos is updated immediately for the first frame
      if (map.getSource('fly-pos')) {
        (map.getSource('fly-pos') as mapboxgl.GeoJSONSource).setData({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [startPt[1], startPt[0]] },
          properties: {}
        });
      }
      // Give the map a tiny timeout to render the jump before animation ticks
      setTimeout(() => {
        if (isActiveRef.current) runLoop();
      }, 50);
    }
  }, [map, trail, lerpCoord, runLoop]);

  const stopTour = useCallback(() => {
    isActiveRef.current = false;
    setIsActive(false);
    cancelLoop();
  }, [cancelLoop]);

  // Cleanup on unmount
  useEffect(() => () => cancelLoop(), [cancelLoop]);

  return {
    isActive,
    startTour,
    stopTour,
    speed,
    setSpeed: (s: number) => { setSpeed(s); speedRef.current = s; },
    progress,
    setProgressByJump: (pct: number) => {
      if (!trail) return;
      virtualElapsedRef.current = (pct / 100) * (trail.coords.length * FLY_SEC_PER_PT * 1000);
      const newT = pct / 100;
      setProgress(newT);
    }
  };
}
