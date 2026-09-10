// Tree cover along a trail, read from a grid that ships with the app.
//
// The obvious way to estimate shade is to ask OpenStreetMap which parts of the
// trail fall inside a landuse=forest polygon. Measured against real trails in
// public/trails, that answer is wrong by a factor of two to four: those
// polygons mark KKL *management areas*, not canopy. נחל יתלה ונחל חמישה comes
// out 32% forested that way and 8% by canopy; חרבת עתרי 91% against 31%. A
// walker who picked a trail in August on the strength of "91% shade" would be
// badly misled, so OSM is not used for shade at all.
//
// Instead this reads ESA WorldCover 10m (2021), reduced to ~100 m cells holding
// the fraction of the cell that is tree canopy. The whole country fits in a
// 1.3 MB greyscale PNG, which means: no Overpass, no API cost, no request per
// trail, and it keeps working offline once the service worker has the file.
// Reducing 10 m to 100 m costs almost nothing — checked against the full-
// resolution figures on six trails, the largest disagreement was 3.5 points.
//
// See scripts/buildCanopyRaster.sh for how the PNG is produced.

const PNG_URL = '/data/canopy-il-100m.png';
const META_URL = '/data/canopy-il-100m.json';

interface CanopyMeta {
  west: number;
  north: number;
  cellSize: number;
  cols: number;
  rows: number;
  attribution: string;
}

export interface CanopyGrid {
  // Canopy fraction 0..1 at a coordinate, or null outside the grid (abroad, or
  // far enough out to sea that the trail is not in the covered box).
  sample(lat: number, lon: number): number | null;
  attribution: string;
}

// Decoding 1944x4444 pixels through one getImageData would allocate ~35 MB of
// RGBA at once, which is a lot to ask of a phone. Doing it in horizontal bands
// keeps the peak near 4 MB and throws away three of every four bytes as it
// goes — the PNG is greyscale, so red alone carries the value.
const BAND_ROWS = 512;

async function decode(meta: CanopyMeta): Promise<Uint8Array> {
  const res = await fetch(PNG_URL);
  if (!res.ok) throw new Error(`canopy raster ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());

  if (bitmap.width !== meta.cols || bitmap.height !== meta.rows) {
    // The sidecar carries the affine transform; if it disagrees with the image
    // every sample would be silently offset. Better to lose the feature.
    bitmap.close();
    throw new Error(`canopy raster is ${bitmap.width}x${bitmap.height}, metadata says ${meta.cols}x${meta.rows}`);
  }

  const out = new Uint8Array(meta.cols * meta.rows);
  const canvas = document.createElement('canvas');
  canvas.width = meta.cols;
  canvas.height = Math.min(BAND_ROWS, meta.rows);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('no 2d context for canopy raster');
  }

  for (let top = 0; top < meta.rows; top += BAND_ROWS) {
    const height = Math.min(BAND_ROWS, meta.rows - top);
    ctx.clearRect(0, 0, meta.cols, height);
    ctx.drawImage(bitmap, 0, top, meta.cols, height, 0, 0, meta.cols, height);
    const rgba = ctx.getImageData(0, 0, meta.cols, height).data;
    for (let i = 0, px = top * meta.cols; i < rgba.length; i += 4, px++) {
      out[px] = rgba[i];
    }
  }

  bitmap.close();
  return out;
}

// One load per session, shared by every caller. Kept as the promise rather than
// the result so two trails opened in quick succession do not both fetch.
let pending: Promise<CanopyGrid | null> | null = null;

export function loadCanopyGrid(): Promise<CanopyGrid | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (pending) return pending;

  pending = (async () => {
    try {
      const metaRes = await fetch(META_URL);
      if (!metaRes.ok) throw new Error(`canopy metadata ${metaRes.status}`);
      const meta = (await metaRes.json()) as CanopyMeta;
      const values = await decode(meta);

      return {
        attribution: meta.attribution,
        sample(lat: number, lon: number): number | null {
          const col = Math.floor((lon - meta.west) / meta.cellSize);
          const row = Math.floor((meta.north - lat) / meta.cellSize);
          if (col < 0 || col >= meta.cols || row < 0 || row >= meta.rows) return null;
          return values[row * meta.cols + col] / 255;
        },
      };
    } catch (e) {
      // Shade is an extra, never a reason for the map to fail. The next trail
      // gets to try again rather than inheriting this failure forever.
      console.warn('Canopy grid unavailable:', e);
      pending = null;
      return null;
    }
  })();

  return pending;
}
