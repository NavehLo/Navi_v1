import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import { TrailData, TrailKind } from "./useTrailData";
import { getBearing } from "../utils/trailUtils";

const SEC_PER_KM = 45;

// Playback multipliers the transport bar offers. The engine accepts any
// number; these are only what is shown. A drive can be hundreds of
// kilometres, hence its long tail.
export const TOUR_SPEEDS = [1, 2, 5] as const;
export const DRIVE_TOUR_SPEEDS = [1, 2, 5, 10, 20, 50] as const;
export function tourSpeedsFor(kind: TrailKind | undefined): readonly number[] {
  return kind === 'drive' ? DRIVE_TOUR_SPEEDS : TOUR_SPEEDS;
}

// The camera height that keeps the ground moving at a readable pace. At x1 the
// traveller covers ~22 m/s; at x5 it is ~110 m/s, and at zoom 17 that is a
// blur the satellite tiles cannot even load fast enough for. Pulling back a
// little per step keeps the route legible and the tiles ahead of the camera.
// The drive speeds go further: at x50 (1.1 km/s) a zoom-12 tile is ~10 km
// across, so a new column arrives every ~9 s — enough time to load it.
const ZOOM_BY_SPEED: Record<number, number> = { 1: 17, 2: 16.5, 5: 15.5, 10: 14.5, 20: 13.5, 50: 12.5 };
function zoomForSpeed(speed: number): number {
  return ZOOM_BY_SPEED[speed] ?? Math.max(11, 17 - Math.log2(Math.max(speed, 1)) * 1.1);
}
// Terrain seen from low zoom at a steep pitch looks like a flat sheet with a
// horizon far too close; the faster we go, the more we look down.
function pitchForSpeed(speed: number): number {
  return speed >= 50 ? 45 : speed >= 20 ? 50 : speed >= 10 ? 55 : 60;
}

// The traveller dot is a GeoJSON source; rewriting it 60 times a second is
// wasted work nobody can see. Every 50 ms is still 20 updates a second.
const DOT_UPDATE_MS = 50;
const MAX_FRAME_MS = 1000;

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
  // A zoom/pitch the loop is easing towards after a speed change. The loop
  // repositions the camera every frame, and that cancels any easeTo — so the
  // easing has to happen here. Once reached it lets go, and the zoom is the
  // user's again (they may want to lean in or out mid-tour).
  const cameraTargetRef = useRef<{ zoom: number; pitch: number } | null>(null);

  // Keep speedRef in sync with speed state
  useEffect(() => { speedRef.current = speed; }, [speed]);

  const cancelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const lerpByDist = useCallback((dist: number) => {
    if (!trail || !trail.accumulatedDistances) return [0, 0, 0];
    const n = trail.accumulatedDistances.length;

    // Fast boundary checks
    if (dist <= 0) return trail.coords[0] || [0, 0, 0];
    if (dist >= trail.totalDistance) return trail.coords[n - 1] || [0, 0, 0];

    // Binary search to find the segment
    let low = 0;
    let high = n - 1;
    let lo = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (trail.accumulatedDistances[mid] <= dist) {
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

    const frac = (dist - distLo) / (distHi - distLo);
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
      // A frame that took ages is either a tab switch (many seconds — don't
      // leap ahead) or the map struggling to render (a weak GPU at a wide,
      // pitched view can drop to a few frames a second — real time the
      // traveller should still cover, or a "x50" runs at x10). Capping at a
      // second keeps the tour honest without letting a tab switch teleport it.
      if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;

      virtualElapsedRef.current += dt * speedRef.current;
      const t = Math.min(virtualElapsedRef.current / totalDuration, 1);
      setProgress(t);

      const targetDistance = t * trail.totalDistance;
      const pt = lerpByDist(targetDistance);
      // Look ahead exactly 30 meters (0.03 km) for bearing, regardless of trail length
      const ptAhead = lerpByDist(Math.min(targetDistance + 0.03, trail.totalDistance));

      let targetBearing = currentBearingRef.current;
      if (ptAhead[0] !== pt[0] || ptAhead[1] !== pt[1]) {
        targetBearing = getBearing(pt[0], pt[1], ptAhead[0], ptAhead[1]);
      }

      let diff = targetBearing - currentBearingRef.current;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      const smoothFactor = 1.0 - Math.exp(-dt * 0.0015 * speedRef.current);
      currentBearingRef.current += diff * smoothFactor;

      // Move camera — centre and bearing every frame; zoom and pitch only
      // while easing to a new speed's height, otherwise they stay the user's.
      const target = cameraTargetRef.current;
      if (target) {
        const k = 1 - Math.exp(-dt / 350);
        const zoom = map.getZoom() + (target.zoom - map.getZoom()) * k;
        const pitch = map.getPitch() + (target.pitch - map.getPitch()) * k;
        const arrived = Math.abs(target.zoom - zoom) < 0.01 && Math.abs(target.pitch - pitch) < 0.1;
        if (arrived) cameraTargetRef.current = null;
        map.jumpTo({
          center: [pt[1], pt[0]],
          bearing: currentBearingRef.current,
          zoom: arrived ? target.zoom : zoom,
          pitch: arrived ? target.pitch : pitch,
        });
      } else {
        map.jumpTo({ center: [pt[1], pt[0]], bearing: currentBearingRef.current });
      }

      if (map.getSource('fly-pos') && (ts - lastGeoJsonUpdateRef.current >= DOT_UPDATE_MS || t >= 1)) {
        lastGeoJsonUpdateRef.current = ts;
        (map.getSource('fly-pos') as mapboxgl.GeoJSONSource).setData({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [pt[1], pt[0], pt[2] || 0] },
          properties: {}
        });
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        isActiveRef.current = false;
        setIsActive(false);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [map, trail, lerpByDist]);

  const startTour = useCallback(() => {
    if (!map || !trail) return;

    const totalDuration = trail.totalDistance * SEC_PER_KM * 1000;
    const currentProgress = Math.min(virtualElapsedRef.current / totalDuration, 1);
    const isResume = currentProgress > 0 && currentProgress < 1;

    isActiveRef.current = true;
    setIsActive(true);
    cameraTargetRef.current = null;
    lastTsRef.current = null; // Reset dt on next tick to avoid a jumpy first frame
    currentBearingRef.current = map.getBearing();

    if (isResume) {
      // Resume from exact position
      runLoop();
    } else {
      // Fresh start
      virtualElapsedRef.current = 0;
      setProgress(0);
      
      const startPt = lerpByDist(0);
      const targetZoom = Math.max(map.getZoom(), zoomForSpeed(speedRef.current));
      map.jumpTo({
        center: [startPt[1], startPt[0]],
        zoom: targetZoom,
        pitch: pitchForSpeed(speedRef.current),
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
  }, [map, trail, lerpByDist, runLoop]);

  // Reset tour state when a new trail is loaded. x50 is a drive speed; a hike
  // opened after one starts back at x1.
  useEffect(() => {
    if (!tourSpeedsFor(trail?.kind).includes(speedRef.current)) {
      speedRef.current = 1;
      setSpeed(1);
    }
    setProgress(0);
    virtualElapsedRef.current = 0;
    isActiveRef.current = false;
    setIsActive(false);
    cancelLoop();
  }, [trail, cancelLoop]);

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
    setSpeed: (s: number) => {
      const prev = speedRef.current;
      setSpeed(s);
      speedRef.current = s;
      // Only while flying: changing speed on a paused tour must not move the map
      if (isActiveRef.current && map && s !== prev) {
        cameraTargetRef.current = { zoom: zoomForSpeed(s), pitch: pitchForSpeed(s) };
      }
    },
    progress,
    setProgressByJump: (pct: number) => {
      if (!trail) return;
      virtualElapsedRef.current = (pct / 100) * (trail.totalDistance * SEC_PER_KM * 1000);
      const newT = pct / 100;
      setProgress(newT);
    }
  };
}
