import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { MonthClimate } from './climate';

// The climate grid built by scripts/buildClimateGrid.mjs: TerraClimate's
// 1991–2020 monthly normals, moved to the 2016–2025 decade, in 0.25° land cells, each with its average
// height and its country. Server only — it is a few megabytes, read once per
// instance and kept.
//
// A point is answered from the cells around it, each moved from its own
// average height to the point's by the standard lapse rate (6.5° a
// kilometre) before they are blended. Without that, a ridge walk in the Alps
// would get the climate of the valley floor the cell averages over.

// CLIMATE_GRID_FILE lets a script compare another build against this one.
const FILE = process.env.CLIMATE_GRID_FILE ?? join(process.cwd(), 'src/data/climate-grid.bin.gz');
const LAPSE = 6.5 / 1000;

interface Grid {
  rows: number;
  cols: number;
  lat0: number;
  lon0: number;
  res: number;
  n: number;
  countries: string[];
  rowStart: Uint32Array;
  mask: Uint8Array;
  elev: Int16Array;
  country: Uint8Array;
  tmax: Int8Array;
  tmin: Int8Array;
  ppt: Uint8Array;
  vap: Uint8Array;
  swe: Uint8Array;
}

let grid: Grid | null = null;
let failed = false;

function load(): Grid | null {
  if (grid || failed) return grid;
  try {
    const buf = gunzipSync(readFileSync(FILE));
    if (buf.toString('latin1', 0, 4) !== 'CLIM') throw new Error('not a climate grid');
    const headLen = buf.readUInt32LE(4);
    const head = JSON.parse(buf.toString('utf8', 8, 8 + headLen));
    let at = 8 + headLen;
    const align = () => { at += (4 - (at % 4)) % 4; };
    align();
    // Copied out of the Buffer so every view starts on a clean offset.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const take = <T>(make: (b: ArrayBuffer, o: number, l: number) => T, count: number, bytes: number): T => {
      const view = make(ab, at, count);
      at += count * bytes;
      align();
      return view;
    };
    const { rows, cols, n } = head;
    grid = {
      rows, cols, n,
      lat0: head.lat0, lon0: head.lon0, res: head.res, countries: head.countries,
      rowStart: take((b, o, l) => new Uint32Array(b, o, l), rows + 1, 4),
      mask: take((b, o, l) => new Uint8Array(b, o, l), Math.ceil((rows * cols) / 8), 1),
      elev: take((b, o, l) => new Int16Array(b, o, l), n, 2),
      country: take((b, o, l) => new Uint8Array(b, o, l), n, 1),
      tmax: take((b, o, l) => new Int8Array(b, o, l), 12 * n, 1),
      tmin: take((b, o, l) => new Int8Array(b, o, l), 12 * n, 1),
      ppt: take((b, o, l) => new Uint8Array(b, o, l), 12 * n, 1),
      vap: take((b, o, l) => new Uint8Array(b, o, l), 12 * n, 1),
      swe: take((b, o, l) => new Uint8Array(b, o, l), 12 * n, 1),
    };
    return grid;
  } catch (e) {
    failed = true;
    console.error('Climate grid could not be loaded:', e);
    return null;
  }
}

export function climateGridAvailable(): boolean {
  return load() != null;
}

// Bits set in one byte, for counting the land cells before a column.
const POP = new Uint8Array(256).map((_, i) => {
  let c = 0;
  for (let v = i; v; v >>= 1) c += v & 1;
  return c;
});

// Index of a land cell in the packed arrays, or -1 for sea / off the grid.
function cellIndex(g: Grid, r: number, c: number): number {
  if (r < 0 || r >= g.rows) return -1;
  c = ((c % g.cols) + g.cols) % g.cols;
  const bit = r * g.cols + c;
  if (!(g.mask[bit >> 3] & (1 << (bit & 7)))) return -1;
  // Land cells before this one in its row: whole bytes, then the part byte.
  const rowBit = r * g.cols;
  let k = g.rowStart[r];
  let b = rowBit;
  // Rows are a whole number of bytes long (1440 / 8), so rowBit is aligned.
  for (; b + 8 <= bit; b += 8) k += POP[g.mask[b >> 3]];
  k += POP[g.mask[b >> 3] & ((1 << (bit - b)) - 1)];
  return k;
}

function unpack(g: Grid, k: number, m: number): MonthClimate {
  const i = m * g.n + k;
  const p = g.ppt[i] / 8;
  const s = g.swe[i] / 4;
  return {
    tmax: g.tmax[i] / 2,
    tmin: g.tmin[i] / 2,
    ppt: p * p,
    vap: g.vap[i] / 50,
    swe: s * s,
  };
}

// One cell's year, moved to `ele` (its own height when ele is null).
function cellYear(g: Grid, k: number, ele: number | null): MonthClimate[] {
  const cellEle = g.elev[k];
  const dz = ele == null ? 0 : ele - cellEle;
  const dt = -dz * LAPSE;
  // The snow on the ground is the cell's average. A point well below the
  // cell's average height gets less of it, fading out over 700 m — a valley
  // trail under a snowy massif is not under snow.
  const snowScale = dz >= -300 ? 1 : Math.max(0, 1 - (-dz - 300) / 700);
  return Array.from({ length: 12 }, (_, m) => {
    const c = unpack(g, k, m);
    return { ...c, tmax: c.tmax + dt, tmin: c.tmin + dt, swe: c.swe * snowScale };
  });
}

export interface PointClimate {
  months: MonthClimate[];
  gridEle: number;   // the blended cells' average height, metres
}

// The climate at a point, at height `ele` (metres; null for the ground's own,
// as far as the grid knows it). Null when there is no land near — a point at
// sea or past 60°S.
export function climateAt(lat: number, lon: number, ele: number | null): PointClimate | null {
  const g = load();
  if (!g || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Position in cell units, measured from the centre of the first cell.
  const y = (g.lat0 - lat) / g.res - 0.5;
  const x = (lon - g.lon0) / g.res - 0.5;
  const r0 = Math.floor(y);
  const c0 = Math.floor(x);
  const fy = y - r0;
  const fx = x - c0;

  // Bilinear over the four cells around the point, over those that are land.
  const parts: { k: number; w: number }[] = [];
  for (const [dr, dc, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]] as const) {
    const k = cellIndex(g, r0 + dr, c0 + dc);
    if (k >= 0 && w > 0) parts.push({ k, w });
  }
  // A point on a coast or an island the four miss: the nearest land within
  // two cells.
  if (parts.length === 0) {
    let best = -1, bestD = Infinity;
    for (let dr = -2; dr <= 3; dr++) {
      for (let dc = -2; dc <= 3; dc++) {
        const k = cellIndex(g, r0 + dr, c0 + dc);
        const d = (dr - fy) ** 2 + (dc - fx) ** 2;
        if (k >= 0 && d < bestD) { best = k; bestD = d; }
      }
    }
    if (best < 0) return null;
    parts.push({ k: best, w: 1 });
  }

  const total = parts.reduce((s, p) => s + p.w, 0);
  const gridEle = parts.reduce((s, p) => s + g.elev[p.k] * p.w, 0) / total;
  const target = ele ?? gridEle;
  const years = parts.map((p) => cellYear(g, p.k, target));
  const months = Array.from({ length: 12 }, (_, m) => {
    const acc: MonthClimate = { tmax: 0, tmin: 0, ppt: 0, vap: 0, swe: 0 };
    years.forEach((year, j) => {
      const w = parts[j].w / total;
      acc.tmax += year[m].tmax * w;
      acc.tmin += year[m].tmin * w;
      acc.ppt += year[m].ppt * w;
      acc.vap += year[m].vap * w;
      acc.swe += year[m].swe * w;
    });
    return acc;
  });
  return { months, gridEle: Math.round(gridEle) };
}

// Every land cell once, for passes over a whole country or the world:
// its centre, its country code ('' when none) and its year at its own height.
export function forEachCell(visit: (lat: number, lon: number, country: string, year: () => MonthClimate[]) => void): void {
  const g = load();
  if (!g) return;
  for (let r = 0; r < g.rows; r++) {
    let k = g.rowStart[r];
    const end = g.rowStart[r + 1];
    if (k === end) continue;
    const lat = g.lat0 - (r + 0.5) * g.res;
    for (let c = 0; c < g.cols && k < end; c++) {
      const bit = r * g.cols + c;
      if (!(g.mask[bit >> 3] & (1 << (bit & 7)))) continue;
      const kk = k++;
      visit(lat, g.lon0 + (c + 0.5) * g.res, g.countries[g.country[kk]], () => cellYear(g, kk, null));
    }
  }
}

// The centres of a country's land cells, [lat, lon] — where to look for its
// trails. Empty for a code the grid does not know.
export function countryCells(code: string): Array<[number, number]> {
  const g = load();
  if (!g) return [];
  const idx = g.countries.indexOf(code);
  if (idx <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let r = 0; r < g.rows; r++) {
    let k = g.rowStart[r];
    const end = g.rowStart[r + 1];
    if (k === end) continue;
    for (let c = 0; c < g.cols && k < end; c++) {
      const bit = r * g.cols + c;
      if (!(g.mask[bit >> 3] & (1 << (bit & 7)))) continue;
      if (g.country[k++] === idx) out.push([g.lat0 - (r + 0.5) * g.res, g.lon0 + (c + 0.5) * g.res]);
    }
  }
  return out;
}
