import { getDistance, computeElevationGain } from '../../utils/trailUtils';
import { estimateHike } from '../hikeEffort';
import type { EleSource, RecPoint, RecStats } from './types';

// The numbers of a recorded walk, and the one place they are computed: the
// live panel, the summary, the list and the shared copy all come from here.
//
// A phone's GPS wanders. Standing still it drifts a few metres back and
// forth, and now and then it jumps a hundred. Counted naively, a coffee
// break adds half a kilometre and a minute of "walking". So:
//   - the recorder keeps a point only once it is a few metres from the last
//     one (MIN_STEP_M, used by the recorder too), and only with a usable
//     accuracy (MAX_ACCURACY_M);
//   - a step faster than anyone walks or runs, over a short time, is a jump
//     and is dropped;
//   - "moving" is a step at walking pace or above. Ten minutes spent at one
//     spot, followed by a step of 4 m, is a slow step — not ten minutes of
//     walking.
// Distance never crosses a pause: the walk stops where it was paused and
// starts again where it was resumed.

export const MIN_STEP_M = 3;
export const MAX_ACCURACY_M = 35;
const JUMP_SPEED_MS = 10;     // ~36 km/h — no hiker; a GPS jump
const JUMP_WINDOW_S = 30;     // after a long gap a big step is real (screen was off)
const MOVING_SPEED_MS = 0.3;  // ~1 km/h

// The points of a segment that count, with the jumps taken out.
function cleanSegment(seg: RecPoint[]): RecPoint[] {
  const out: RecPoint[] = [];
  for (const p of seg) {
    const last = out[out.length - 1];
    if (!last) { out.push(p); continue; }
    const d = getDistance(last.lat, last.lon, p.lat, p.lon) * 1000;
    const dt = (p.t - last.t) / 1000;
    if (dt > 0 && dt < JUMP_WINDOW_S && d / dt > JUMP_SPEED_MS) continue;
    out.push(p);
  }
  return out;
}

// GPS heights are noisy (often ±10 m from one fix to the next); a short
// moving average takes the noise out before the 5 m hysteresis adds it up.
function smooth(values: number[], half = 2): number[] {
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) { sum += values[j]; n++; }
    return sum / n;
  });
}

export function computeRecStats(
  segments: RecPoint[][],
  opts: { activeMs: number; pausedMs: number; eleSource: EleSource },
): RecStats {
  let distanceM = 0, movingSec = 0, gain = 0, loss = 0, points = 0;
  let minEle: number | null = null, maxEle: number | null = null;
  let anyEle = false;

  for (const raw of segments) {
    const seg = cleanSegment(raw);
    points += seg.length;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1], b = seg[i];
      const d = getDistance(a.lat, a.lon, b.lat, b.lon) * 1000;
      const dt = (b.t - a.t) / 1000;
      distanceM += d;
      if (dt > 0 && d / dt >= MOVING_SPEED_MS) movingSec += dt;
    }
    const eles = seg.map((p) => p.ele).filter((e): e is number => e != null && Number.isFinite(e));
    // Heights for only some of the points (a browser that sometimes has
    // none) would make up climbs between the gaps; all or nothing.
    if (eles.length >= 2 && eles.length === seg.length) {
      anyEle = true;
      const series = opts.eleSource === 'gps' ? smooth(eles) : eles;
      const { gain: g, loss: l } = computeElevationGain(series);
      gain += g; loss += l;
      for (const e of series) {
        if (minEle == null || e < minEle) minEle = e;
        if (maxEle == null || e > maxEle) maxEle = e;
      }
    }
  }

  // The fixes carry the phone's GPS clock and the recording the page's; they
  // can disagree by a little. Walking never takes longer than the recording.
  if (opts.activeMs > 0) movingSec = Math.min(movingSec, opts.activeMs / 1000);
  const km = distanceM / 1000;
  const movingH = movingSec / 3600;
  const avgKmh = movingSec >= 60 && km > 0 ? km / movingH : null;
  return {
    distanceKm: Math.round(km * 100) / 100,
    gainM: anyEle ? Math.round(gain) : null,
    lossM: anyEle ? Math.round(loss) : null,
    minEle: minEle == null ? null : Math.round(minEle),
    maxEle: maxEle == null ? null : Math.round(maxEle),
    movingSec: Math.round(movingSec),
    totalSec: Math.round(opts.activeMs / 1000),
    pausedSec: Math.round(opts.pausedMs / 1000),
    avgKmh: avgKmh == null ? null : Math.round(avgKmh * 10) / 10,
    paceMinPerKm: avgKmh ? Math.round((60 / avgKmh) * 10) / 10 : null,
    // The same scale as the trail cards (hikeEffort.ts), so a walk recorded
    // here and a trail in the list read alike.
    effort: km >= 0.5 ? estimateHike(km, anyEle ? gain : 0, anyEle ? loss : 0).level : null,
    points,
    eleSource: anyEle ? opts.eleSource : 'none',
  };
}

// "1:05:30" / "12:04" — a clock, for the live panel and the list.
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// "5:30 דק׳/ק״מ"
export function formatPace(minPerKm: number | null): string | null {
  if (minPerKm == null || !Number.isFinite(minPerKm)) return null;
  const total = Math.round(minPerKm * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} דק׳/ק״מ`;
}
