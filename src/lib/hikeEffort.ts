// How long a walk takes and how hard it is, from its length and its climb.
//
// Nothing in the app estimated a hike's time before the weather needed one:
// the forecast has to be read for the hours somebody is actually out there,
// and the water they need scales with those hours.
//
// Walking time is Naismith's rule, slowed to Israeli trail reality — 4 km/h on
// the flat rather than his 5, since most trails here are stony — plus an hour
// for every 600 m up and a smaller allowance for steep descent, which is
// slower than people plan for. Then 15% for stops: a walk is never walked
// without them.

export type EffortLevel = 'easy' | 'moderate' | 'hard' | 'very-hard';

export interface HikeEffort {
  movingHours: number;
  totalHours: number;      // with breaks — the figure everything else uses
  equivalentKm: number;    // km + climb / 100: a 100 m climb costs about a flat km
  level: EffortLevel;
  levelLabel: string;
}

const FLAT_KMH = 4;
const CLIMB_M_PER_HOUR = 600;
const DESCENT_M_PER_HOUR = 1500;
const BREAKS = 1.15;

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  easy: 'קל',
  moderate: 'בינוני',
  hard: 'מאתגר',
  'very-hard': 'קשה מאוד',
};

export function estimateHike(km: number, gain: number, loss: number): HikeEffort {
  const moving = km / FLAT_KMH + gain / CLIMB_M_PER_HOUR + loss / DESCENT_M_PER_HOUR;
  // Rounded to the quarter hour — anything finer promises a precision the
  // formula does not have.
  const total = Math.max(0.25, Math.round(moving * BREAKS * 4) / 4);
  const equivalentKm = km + gain / 100;
  const level: EffortLevel =
    equivalentKm <= 10 ? 'easy' : equivalentKm <= 18 ? 'moderate' : equivalentKm <= 28 ? 'hard' : 'very-hard';
  return {
    movingHours: Math.round(moving * 100) / 100,
    totalHours: total,
    equivalentKm: Math.round(equivalentKm * 10) / 10,
    level,
    levelLabel: EFFORT_LABELS[level],
  };
}

// "3:45" style, for the panel.
export function formatHours(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  if (whole === 0) return `${mins} דק׳`;
  return mins === 0 ? `${whole} שע׳` : `${whole}:${String(mins).padStart(2, '0')} שע׳`;
}
