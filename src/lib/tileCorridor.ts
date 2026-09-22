// Which map tiles a trail needs, so they can be fetched before the walk.
//
// Pure arithmetic on the Web Mercator tile grid; no map, no DOM. The map's
// zoom levels are the usual XYZ ones: at zoom z the world is 2^z tiles
// across, whatever the pixel size of a tile happens to be.

import type { Coordinate3D } from '../utils/trailUtils';

export interface TileXYZ {
  z: number;
  x: number;
  y: number;
}

// One band of zoom levels and how far either side of the line it reaches.
// Low zooms are for context — finding the trail on the map at all — and a
// tile there covers tens of kilometres, so the tiles under the line are
// enough; the high zooms are the ones walked on, and a narrow corridor is
// all a walker ever looks at.
export interface ZoomBand {
  zooms: number[];
  bufferKm: number;
}

export const DEFAULT_BANDS: ZoomBand[] = [
  { zooms: [5, 6, 7, 8, 9], bufferKm: 0 },
  { zooms: [10, 11, 12], bufferKm: 3 },
  { zooms: [13, 14, 15, 16], bufferKm: 1.5 },
];

// Above this many tiles per source the pack drops its highest zoom level and
// tries again: a 60 km trail at zoom 16 is a few hundred megabytes, and the
// walker is better served by a slightly softer map that finishes downloading.
export const MAX_TILES_PER_SOURCE = 3000;

const EARTH_CIRCUMFERENCE_KM = 40075.016686;
const KM_PER_DEG_LAT = 111.32;

export function tileWidthKm(z: number, lat: number): number {
  return (EARTH_CIRCUMFERENCE_KM * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
}

// Fractional tile coordinates: the integer part is the tile, the fraction
// where inside it the point falls.
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

export function tileKey(t: TileXYZ): string {
  return `${t.z}/${t.x}/${t.y}`;
}

// Every tile at the given zooms within `bufferKm` of the line. The line is
// sampled every half tile, and around each sample every tile touched by a
// square of that half-width is taken — a square rather than a circle costs
// a few corner tiles and saves arithmetic that would never show on the
// phone. The half-width is kept fractional: at a zoom where a tile is 30 km
// across, a 1.5 km margin means the tile under the line and at most its
// neighbour, not a block of nine.
export function corridorTiles(coords: Coordinate3D[], zooms: number[], bufferKm: number): TileXYZ[] {
  const out: TileXYZ[] = [];
  if (coords.length === 0) return out;
  const seen = new Set<string>();
  const midLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;

  for (const z of zooms) {
    const n = Math.pow(2, z);
    const width = tileWidthKm(z, midLat);
    const radius = bufferKm / width;
    const stepKm = Math.max(width / 2, 0.05);

    const add = (lon: number, lat: number) => {
      const t = lonLatToTile(lon, lat, z);
      const x0 = Math.floor(t.x - radius);
      const x1 = Math.floor(t.x + radius);
      const y0 = Math.floor(t.y - radius);
      const y1 = Math.floor(t.y + radius);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (y < 0 || y >= n) continue;
          // Longitude wraps; a trail near the antimeridian is not a case this
          // app will meet, but the arithmetic may as well be right.
          const wx = ((x % n) + n) % n;
          const key = `${z}/${wx}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ z, x: wx, y });
        }
      }
    };

    add(coords[0][1], coords[0][0]);
    for (let i = 1; i < coords.length; i++) {
      const [lat1, lon1] = coords[i - 1];
      const [lat2, lon2] = coords[i];
      const dLatKm = (lat2 - lat1) * KM_PER_DEG_LAT;
      const dLonKm = (lon2 - lon1) * KM_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
      const segKm = Math.hypot(dLatKm, dLonKm);
      const steps = Math.max(1, Math.ceil(segKm / stepKm));
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        add(lon1 + (lon2 - lon1) * f, lat1 + (lat2 - lat1) * f);
      }
    }
  }
  return out;
}

export interface CorridorPlan {
  tiles: TileXYZ[];
  // The highest zoom actually included, after any trimming.
  maxZoom: number;
  // True when the cap forced a zoom level out.
  trimmed: boolean;
  countByZoom: Record<number, number>;
}

// The tile list for one source, trimmed from the top until it fits the cap.
export function planCorridor(
  coords: Coordinate3D[],
  bands: ZoomBand[] = DEFAULT_BANDS,
  maxTiles: number = MAX_TILES_PER_SOURCE
): CorridorPlan {
  let currentBands = bands.map((b) => ({ ...b, zooms: [...b.zooms] }));
  let trimmed = false;

  for (;;) {
    const tiles = currentBands.flatMap((b) => corridorTiles(coords, b.zooms, b.bufferKm));
    const zooms = currentBands.flatMap((b) => b.zooms);
    const maxZoom = zooms.length ? Math.max(...zooms) : 0;
    if (tiles.length <= maxTiles || zooms.length <= 1) {
      const countByZoom: Record<number, number> = {};
      for (const t of tiles) countByZoom[t.z] = (countByZoom[t.z] || 0) + 1;
      return { tiles, maxZoom, trimmed, countByZoom };
    }
    trimmed = true;
    currentBands = currentBands
      .map((b) => ({ ...b, zooms: b.zooms.filter((z) => z !== maxZoom) }))
      .filter((b) => b.zooms.length > 0);
  }
}
