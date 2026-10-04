import type { EffortLevel } from '../hikeEffort';

// A walk recorded on the phone ("הקלטה"). Everything about it — the points,
// the numbers — is made on the device; the account only keeps a copy.

// One GPS fix that was kept. `t` is the phone's clock (ms since epoch).
export interface RecPoint {
  lat: number;
  lon: number;
  ele: number | null;
  t: number;
  acc: number | null;
}

export type EleSource = 'dem' | 'gps' | 'none';

// The numbers shown for a recording. Computed only in stats.ts.
export interface RecStats {
  distanceKm: number;
  gainM: number | null;
  lossM: number | null;
  minEle: number | null;
  maxEle: number | null;
  movingSec: number;   // walking, stops while recording left out
  totalSec: number;    // recording time, stops included, pauses not
  pausedSec: number;   // the time the recording was paused
  avgKmh: number | null;        // over the moving time
  paceMinPerKm: number | null;  // over the moving time
  effort: EffortLevel | null;
  points: number;
  eleSource: EleSource;
}

export interface Recording {
  id: string;            // made on the device, so the account copy shares it
  name: string;
  startedAt: number;     // ms
  endedAt: number;       // ms
  segments: RecPoint[][]; // a new one after every pause
  stats: RecStats;
  // The account it belongs to; null for one recorded while signed out, which
  // the next account to sign in on this device takes.
  ownerId: string | null;
  // When the account copy was last brought up to date; null = not yet (new,
  // renamed, or recorded with no reception).
  syncedAt: string | null;
  shared: boolean;
}
