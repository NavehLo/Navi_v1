import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  readOffRouteThreshold, subscribeOffRouteThreshold, serverOffRouteThreshold, soundAlarm, stopAlarm,
} from '../lib/offRouteAlert';

// Sounds the alarm once when the walker strays past the set distance from the
// route, and not again until they have come back to it.
//
// It only arms after the walker has actually been on the route. Opening a
// trail at home and switching on the location would otherwise sound it the
// moment the first fix arrives — you are kilometres from a trail you have not
// started — and that is not straying from anything.
//
// Coming back re-arms it a little inside the line (70% of the distance), so a
// walker standing right at the edge, with GPS wobbling either side of it, gets
// one alarm and not one every few seconds.
export function useOffRouteAlert(
  offTrailM: number | null,
  accuracyM: number | null,
  resetKey: unknown
) {
  const threshold = useSyncExternalStore(subscribeOffRouteThreshold, readOffRouteThreshold, serverOffRouteThreshold);
  const armedRef = useRef(false);
  // The route the banner is about. A different route (or none) and it goes.
  const [firedFor, setFiredFor] = useState<unknown>(null);

  const [silenced, setSilenced] = useState(false);
  useEffect(() => { armedRef.current = false; stopAlarm(); }, [resetKey]);
  // A threshold switched off mid-alarm, or the page going away, ends the sound.
  useEffect(() => { if (!threshold) stopAlarm(); }, [threshold]);
  useEffect(() => () => stopAlarm(), []);

  // Reacting to each GPS fix is exactly what this effect is for: the alarm is
  // a sound and a vibration, not something a render can produce.
  useEffect(() => {
    if (!threshold || offTrailM == null) return;
    // A fix too rough to tell on-route from off-route decides nothing.
    if (accuracyM != null && accuracyM > Math.max(threshold, 30)) return;

    if (offTrailM <= threshold * 0.7) {
      if (!armedRef.current) stopAlarm(); // back on the route: the siren stops by itself
      armedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFiredFor(null);
    } else if (offTrailM > threshold && armedRef.current) {
      armedRef.current = false;
      setFiredFor(resetKey);
      setSilenced(false);
      soundAlarm();
    }
  }, [offTrailM, accuracyM, threshold, resetKey]);

  const showing = !!threshold && firedFor != null && firedFor === resetKey && offTrailM != null;
  return {
    alert: showing ? { distanceM: Math.round(offTrailM!), silenced } : null,
    threshold,
    // Stops the siren; the banner stays, so the distance can still be read.
    silence: () => { stopAlarm(); setSilenced(true); },
    dismiss: () => { stopAlarm(); setFiredFor(null); },
  };
}
