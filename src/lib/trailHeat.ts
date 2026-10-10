// "מפת חום של מטיילים": how much a trail adds to the heat, and the colours the
// map and its legend share. One place, so the map, the legend and the server
// never disagree (see the rule in CLAUDE.md).
//
// The weight is Komoot's hiker count on a log scale against a fixed ceiling —
// the same ceiling as popularityScore (trailCrowd/score.ts) — never against the
// largest value seen, or every colour would shift when a country is collected.

export const HEAT_CEILING = 50_000;

export function heatWeight(hikers: number): number {
  if (!(hikers > 0)) return 0;
  const w = Math.log10(1 + hikers) / Math.log10(1 + HEAT_CEILING);
  return Math.round(Math.min(1, Math.max(0, w)) * 1000) / 1000;
}

// From few hikers to many, readable on the light map (ColorBrewer YlOrRd).
export const HEAT_STOPS: Array<[number, string]> = [
  [0, 'rgba(255,237,160,0)'],
  [0.15, '#ffeda0'],
  [0.35, '#feb24c'],
  [0.55, '#fd8d3c'],
  [0.75, '#e31a1c'],
  [1, '#800026'],
];

export type Bounds = [number, number, number, number]; // west, south, east, north

// The box around most of a country's trails: the outer 2% on each side left
// out, so one stray point does not stretch the view across a sea.
export function trimmedBounds(points: Array<{ lat: number; lon: number }>): Bounds | null {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return null;
  const lons = pts.map((p) => p.lon).sort((a, b) => a - b);
  const lats = pts.map((p) => p.lat).sort((a, b) => a - b);
  const at = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(q * (arr.length - 1))))];
  const trim = pts.length >= 20 ? 0.02 : 0;
  return [at(lons, trim), at(lats, trim), at(lons, 1 - trim), at(lats, 1 - trim)];
}
