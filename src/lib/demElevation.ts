import mapboxgl from 'mapbox-gl';
import type { Coordinate3D } from '../utils/trailUtils';

// Elevation for a line that arrived without any — a walking route from the
// Directions API is flat zeros, and a profile of zeros is no profile at all.
//
// Read straight off Mapbox's Terrain-RGB tiles, the same elevation model the
// 3D map is drawn from, so the numbers match the relief on screen. It does not
// depend on the map's own terrain being switched on or on the tiles being in
// view, which queryTerrainElevation would. (Terrain-RGB and not
// mapbox-terrain-dem-v1: see offlineMap.ts for why the latter is unusable
// outside the SDK.)

const TILE = 512; // @2x
const MAX_TILES = 16;

function worldPixel(lon: number, lat: number, z: number): [number, number] {
  const scale = TILE * 2 ** z;
  const x = ((lon + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

async function loadTile(z: number, x: number, y: number, token: string): Promise<ImageData | null> {
  try {
    const res = await fetch(`https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}@2x.pngraw?access_token=${token}`);
    if (!res.ok) return null;
    // No colour management and no premultiplying: the colour *is* the number.
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  } catch {
    return null;
  }
}

// Fills in the elevation of every point. Leaves the line untouched if the
// tiles cannot be had (no token, no reception) — a flat profile is honest
// about knowing nothing; a wrong one is not.
export async function withElevation(coords: Coordinate3D[]): Promise<Coordinate3D[]> {
  const token = mapboxgl.accessToken;
  if (!token || coords.length === 0) return coords;

  // As fine as the tile budget allows. Zoom 12 is ~16 m a pixel in Israel,
  // finer than the 30 m model underneath it; a long route steps down.
  let z = 12;
  let keys: Set<string> = new Set();
  for (; z >= 7; z--) {
    keys = new Set(coords.map(([lat, lon]) => {
      const [px, py] = worldPixel(lon, lat, z);
      return `${Math.floor(px / TILE)}/${Math.floor(py / TILE)}`;
    }));
    if (keys.size <= MAX_TILES) break;
  }

  const tiles = new Map<string, ImageData | null>();
  await Promise.all([...keys].map(async (k) => {
    const [x, y] = k.split('/').map(Number);
    tiles.set(k, await loadTile(z, x, y, token));
  }));
  if ([...tiles.values()].every((t) => !t)) return coords;

  return coords.map(([lat, lon, ele]) => {
    const [px, py] = worldPixel(lon, lat, z);
    const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    const img = tiles.get(`${tx}/${ty}`);
    if (!img) return [lat, lon, ele] as Coordinate3D;
    const ix = Math.min(img.width - 1, Math.max(0, Math.floor(px - tx * TILE)));
    const iy = Math.min(img.height - 1, Math.max(0, Math.floor(py - ty * TILE)));
    const o = (iy * img.width + ix) * 4;
    const d = img.data;
    const metres = -10000 + (d[o] * 65536 + d[o + 1] * 256 + d[o + 2]) * 0.1;
    return [lat, lon, Math.round(metres * 10) / 10] as Coordinate3D;
  });
}
