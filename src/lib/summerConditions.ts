// What a trail is like in an Israeli summer: how much of it is shaded, and
// where along it you can get into water.
//
// Both numbers are coarse estimates from maps, and the UI says so. They exist
// to compare trails against each other when planning, not to be trusted in the
// field. Everything here is plain functions over the trail geometry the app
// already computes — no React, no network — so it can run in the browser for an
// uploaded GPX and in scripts/generateTrailIndex.js for the bundled trails.

import { getDistance, type Coordinate3D } from '../utils/trailUtils';
import type { CanopyGrid } from './canopy';

// ── Shade ────────────────────────────────────────────────────────────────────

// Canopy fraction below SUN_MAX reads as open ground, above SHADE_MIN as walking
// under trees. The middle is scattered trees, where you get shade some of the
// time. These are the boundaries of a three-colour bar, not physics — worth
// re-cutting against how the bar actually looks on a range of trails.
export const SUN_MAX = 0.2;
export const SHADE_MIN = 0.5;

export interface ShadeResult {
  // Length-weighted mean canopy fraction, 0-100.
  shadePct: number;
  // Percentage of trail length in each band; the three add up to 100.
  bands: { sun: number; partial: number; shade: number };
  // Canopy fraction per trail point, for drawing a profile bar. Parallel to
  // trail.coords, same as trail.elevations.
  profile: number[];
}

// Returns null when the trail lies outside the grid — a trail in Sinai or
// Jordan must read "we don't know", never "0% shade", which would be a
// confident wrong answer about a place we have no data for.
export function computeShade(
  coords: Coordinate3D[],
  accumulatedDistances: number[],
  grid: CanopyGrid
): ShadeResult | null {
  if (coords.length < 2) return null;

  const profile: number[] = [];
  for (const c of coords) {
    const v = grid.sample(c[0], c[1]);
    profile.push(v ?? 0);
  }

  let total = 0;
  let weighted = 0;
  let sun = 0, partial = 0, shade = 0;
  let sampledLength = 0;

  for (let i = 1; i < coords.length; i++) {
    // Segment lengths come straight off the accumulated distances the trail
    // already carries, rather than re-running haversine over every point.
    const len = accumulatedDistances[i] - accumulatedDistances[i - 1];
    if (!(len > 0)) continue;
    total += len;

    const a = grid.sample(coords[i - 1][0], coords[i - 1][1]);
    const b = grid.sample(coords[i][0], coords[i][1]);
    if (a == null || b == null) continue;  // off-grid: not counted either way

    const f = (a + b) / 2;
    sampledLength += len;
    weighted += f * len;
    if (f < SUN_MAX) sun += len;
    else if (f < SHADE_MIN) partial += len;
    else shade += len;
  }

  // A trail only half inside the grid would give a number that silently
  // describes the other half as bare. Below this it is not worth reporting.
  if (total === 0 || sampledLength / total < 0.8) return null;

  return {
    shadePct: (weighted / sampledLength) * 100,
    bands: {
      sun: (sun / sampledLength) * 100,
      partial: (partial / sampledLength) * 100,
      shade: (shade / sampledLength) * 100,
    },
    profile,
  };
}

// ── Water ────────────────────────────────────────────────────────────────────

// How far off the trail a source still counts. 150 m is a two-to-three minute
// detour each way — close enough that "there is water here" is a true statement
// about the walk rather than about the map. Deliberately tighter than the 250 m
// the app uses to find points of interest: a viewpoint is worth knowing about
// from a distance, water is only worth knowing about if you can reach it.
export const WATER_BUFFER_KM = 0.15;

// How far out a source is still worth *showing*, as opposed to counting.
//
// Calibrated against real trails rather than guessed. Widening the counting
// buffer from 150 m to 250 m takes נחל כזיב from 38% near water to 62%, and to
// 77% at 400 m — the number becomes flattering rather than true, which is the
// wrong direction for a figure someone plans an August walk around. So the
// count stays at 150 m.
//
// But the same measurement showed 150 m hiding two real pools on כזיב that sit
// between 150 m and 250 m off the path. Dropping them entirely is its own kind
// of wrong answer, so they are listed with their distance and left out of the
// arithmetic — the same treatment springs already get. The walker can see that
// a pool is 210 m away and decide; what they cannot do is see one that was
// never drawn.
export const WATER_SHOW_KM = 0.25;

export interface WaterSourceInput {
  lat: number;
  lon: number;
  category: string;
  label: string;
  confident: boolean;
  name: string | null;
  // Streams carry their line; a pool or spring is just its point. See the note
  // in api/water/route.ts for why the difference matters.
  geometry?: Array<[number, number]>;
}

export interface WaterPoint extends WaterSourceInput {
  // Where along the trail it sits, and how far off it. For a stream this is the
  // nearest approach — the point where you are closest to the water.
  km: number;
  offTrailM: number;
  // Index of the nearest trail point, for putting a marker on the line.
  index: number;
  // Whether it fed the numbers. False for anything we cannot stand behind
  // (springs, unverified pools) and for anything further off than the counting
  // buffer, however solid it is.
  counted: boolean;
}

export interface WaterResult {
  // The headline number: the longest stretch you walk with nothing in reach.
  // Built only from sources we can stand behind — a spring that may well be dry
  // in August does not get to shorten it.
  longestDryKm: number;
  // Secondary: how much of the walk is within reach of something.
  nearWaterPct: number;
  points: WaterPoint[];
  // Split out so the panel can say "one of these is a maybe" honestly.
  confidentCount: number;
  // Where along the trail water was in reach, as a fixed number of columns.
  //
  // A single percentage cannot say *where* the water is, which is what the
  // strip in the panel shows. It is a fixed width rather than one entry per
  // trail point for two reasons: it lines up column-for-column with the shade
  // strip drawn above it, and it is small enough to store — 120 characters per
  // trail in trails.json, which is what lets a bundled trail draw its water
  // without asking Overpass anything.
  bar: boolean[];
}

// Shared by the water strip and the shade strip so the two describe the same
// stretch of trail at the same x.
export const BAR_COLUMNS = 120;

// Packs the strip for storage, and back. '1' is "water in reach here".
export function packBar(bar: boolean[]): string {
  return bar.map((b) => (b ? '1' : '0')).join('');
}

export function unpackBar(packed: string): boolean[] {
  return Array.from(packed, (c) => c === '1');
}

// One degree of latitude is about 111 km everywhere; longitude shrinks with
// latitude but never grows, so this over-estimates the box and never clips it.
// Used only to skip the trigonometry for trail points that are obviously far
// away — a 4,000-point trail against a few hundred stream vertices is close to
// a million comparisons otherwise.
const KM_PER_DEGREE = 111;

export function computeWater(
  coords: Coordinate3D[],
  accumulatedDistances: number[],
  sources: WaterSourceInput[],
  bufferKm: number = WATER_BUFFER_KM,
  showKm: number = WATER_SHOW_KM
): WaterResult | null {
  if (coords.length < 2) return null;
  const totalKm = accumulatedDistances[accumulatedDistances.length - 1] ?? 0;
  if (!(totalKm > 0)) return null;

  // Coverage is measured from the trail rather than from the sources: for every
  // point of the walk, is there water within reach of *here*. That is the
  // question a walker actually asks, and unlike snapping each source to one
  // spot it gives the right answer for a stream running alongside the path.
  const covered = new Array<boolean>(coords.length).fill(false);
  const points: WaterPoint[] = [];
  const reach = Math.max(bufferKm, showKm);
  const degrees = reach / KM_PER_DEGREE;

  for (const source of sources) {
    const positions = source.geometry?.length ? source.geometry : [[source.lat, source.lon] as [number, number]];
    let bestIdx = -1;
    let bestKm = Infinity;

    for (const [plat, plon] of positions) {
      for (let i = 0; i < coords.length; i++) {
        if (Math.abs(coords[i][0] - plat) > degrees) continue;
        if (Math.abs(coords[i][1] - plon) > degrees) continue;
        const d = getDistance(plat, plon, coords[i][0], coords[i][1]);
        if (d > reach) continue;
        // Only what is both trustworthy and close enough moves the numbers.
        if (source.confident && d <= bufferKm) covered[i] = true;
        if (d < bestKm) { bestKm = d; bestIdx = i; }
      }
    }

    // Nothing on this trail came anywhere near it.
    if (bestIdx < 0) continue;
    points.push({
      ...source,
      index: bestIdx,
      km: accumulatedDistances[bestIdx],
      offTrailM: Math.round(bestKm * 1000),
      counted: source.confident && bestKm <= bufferKm,
    });
  }
  points.sort((a, b) => a.km - b.km);

  // A segment counts as walked-near-water when either end is in reach. Dry
  // stretches are measured the same way, so the two are consistent: they are
  // the two sides of the same partition of the trail.
  let coveredKm = 0;
  let longestDryKm = 0;
  let dryRun = 0;
  for (let i = 1; i < coords.length; i++) {
    const len = accumulatedDistances[i] - accumulatedDistances[i - 1];
    if (!(len > 0)) continue;
    if (covered[i - 1] || covered[i]) {
      coveredKm += len;
      dryRun = 0;
    } else {
      dryRun += len;
      if (dryRun > longestDryKm) longestDryKm = dryRun;
    }
  }

  // Downsample to the strip's fixed width: a column is wet if water was in
  // reach anywhere inside it.
  const bar: boolean[] = [];
  const per = covered.length / BAR_COLUMNS;
  for (let c = 0; c < BAR_COLUMNS; c++) {
    const from = Math.floor(c * per);
    const to = Math.max(from + 1, Math.floor((c + 1) * per));
    let wet = false;
    for (let i = from; i < to && i < covered.length; i++) if (covered[i]) { wet = true; break; }
    bar.push(wet);
  }

  return {
    longestDryKm,
    nearWaterPct: (coveredKm / totalKm) * 100,
    points,
    confidentCount: points.filter((p) => p.counted).length,
    bar,
  };
}
