// What a trail is like in an Israeli summer: how much of it is shaded, and
// where along it you can get into water.
//
// Both numbers are coarse estimates from maps, and the UI says so. They exist
// to compare trails against each other when planning, not to be trusted in the
// field. Everything here is plain functions over the trail geometry the app
// already computes — no React, no network — so it can run in the browser for an
// uploaded GPX and in scripts/generateTrailIndex.js for the bundled trails.

import type { Coordinate3D } from '../utils/trailUtils';
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
