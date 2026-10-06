// "רמת קושי": how hard a walk is — easy, moderate or hard. Decided only here;
// the trail card, the Israeli list, the world lists and their filters all
// call these functions, so a trail never reads "easy" in one place and
// "hard" in another.
//
// Two measures, never blended into one:
//
// - Komoot's own grade, for the world trails Komoot lists among an area's
//   most walked (trailCrowd/komoot.ts). Komoot grades a route by the fitness
//   it takes and by its terrain together, which length and climb alone cannot
//   see (a scramble, a ledge), so it is preferred wherever it describes the
//   trail. It is kept only when the Komoot route covers most of the trail
//   (match.ts): a two-hour loop on one end of a 40 km trail says nothing
//   about the trail.
// - Otherwise, the walk's length and climb, through the same formula as the
//   walking time on the trail card (hikeEffort.ts). Every trail with a line
//   that has heights gets it: the bundled Israeli trails (burned into
//   trails.json by scripts/buildDifficultyIndex.mjs) and any trail open on
//   the map.
//
// A world trail with neither has no level, and a difficulty filter leaves it
// out unless the reader asks to keep it: "we do not know" is not "easy".
//
// Three levels, not the four of hikeEffort: Komoot has three, and a filter is
// chosen at a glance. Effort's "challenging" and "very hard" are both "hard".

import { estimateHike, type EffortLevel } from './hikeEffort';
import type { CrowdSource } from './trailCrowd/score';

export type Difficulty = 'easy' | 'moderate' | 'hard';
export const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'moderate', 'hard'];

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'קל',
  moderate: 'בינוני',
  hard: 'קשה',
};

// Bright on the dark panels (CLAUDE.md): green, yellow, orange-red.
export const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easy: 'text-emerald-300',
  moderate: 'text-yellow-300',
  hard: 'text-orange-400',
};

export type DifficultySource = 'komoot' | 'climb';
export const DIFFICULTY_SOURCE_LABELS: Record<DifficultySource, string> = {
  komoot: 'לפי Komoot',
  climb: 'לפי האורך והעליות',
};

const FROM_EFFORT: Record<EffortLevel, Difficulty> = {
  easy: 'easy',
  moderate: 'moderate',
  hard: 'hard',
  'very-hard': 'hard',
};

// From a walk's length (km) and its climb and descent (m).
export function difficultyFromClimb(km: number, gain: number, loss: number): Difficulty {
  return FROM_EFFORT[estimateHike(km, gain, loss).level];
}

export function difficultyFromEffort(level: EffortLevel): Difficulty {
  return FROM_EFFORT[level];
}

// A trail card's level: Komoot's grade when it has one, else from the line's
// length and climb when its heights are known, else none.
export function trailDifficulty(
  komoot: Difficulty | null | undefined,
  climb: { km: number; gain: number; loss: number } | null,
): { level: Difficulty; source: DifficultySource } | null {
  if (komoot) return { level: komoot, source: 'komoot' };
  if (climb) return { level: difficultyFromClimb(climb.km, climb.gain, climb.loss), source: 'climb' };
  return null;
}

// Komoot's words for its three grades.
export type KomootGrade = 'easy' | 'moderate' | 'difficult';
const FROM_KOMOOT: Record<KomootGrade, Difficulty> = { easy: 'easy', moderate: 'moderate', difficult: 'hard' };

export function isKomootGrade(s: unknown): s is KomootGrade {
  return s === 'easy' || s === 'moderate' || s === 'difficult';
}

// Komoot's grade for a trail, from the route its numbers come from (the most
// walked one, where two were matched). Null when Komoot gave none, or its
// route was too short a part of the trail to speak for it.
export function komootDifficulty(sources: CrowdSource[] | undefined): Difficulty | null {
  let best: CrowdSource | null = null;
  for (const s of sources ?? []) {
    if (s.site !== 'Komoot' || !isKomootGrade(s.grade)) continue;
    if (!best || (s.hikers ?? 0) > (best.hikers ?? 0)) best = s;
  }
  return best ? FROM_KOMOOT[best.grade as KomootGrade] : null;
}

// ── The filter ───────────────────────────────────────────────────────────────

export interface DifficultyFilter {
  levels: Difficulty[];     // empty: any
  // Trails with no level: left out unless asked for (see above).
  keepUnknown: boolean;
}

export const NO_DIFFICULTY_FILTER: DifficultyFilter = { levels: [], keepUnknown: false };

export function passesDifficulty(d: Difficulty | null | undefined, f: DifficultyFilter): boolean {
  if (f.levels.length === 0) return true;
  return d == null ? f.keepUnknown : f.levels.includes(d);
}
