// Builds src/data/climate-grid.bin.gz: what each month is like, everywhere on
// land, for "מתי כדאי ללכת" (src/lib/climate.ts reads it).
//
// The source is TerraClimate's 1991–2020 monthly normals (Abatzoglou et al.,
// University of Idaho; public domain, CC0) — a 4 km grid of the average daily
// high and low, rain, vapour pressure and snow on the ground, for every month.
// It is read here through the university's OPeNDAP server, every third pixel
// (1/8°), and averaged into 0.25° cells together with the same grid's own
// elevation. The temperature is moved to a trail's real height later, by the
// lapse rate, so a cell's average height matters as much as its average
// temperature.
//
// What comes out is a few megabytes, land only, south to 60°S (nothing below
// is walked). Each cell also carries the country it lies in, from the borders
// that ship with country-coder, so "which countries are in season in May" is a
// pass over the grid and not a question to anyone.
//
// Run once; the raw downloads (about a gigabyte) are kept in a cache folder so
// a second run, after changing the packing below, takes seconds.
//
//   node scripts/buildClimateGrid.mjs [cacheDir]

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { iso1A2Code } from '@rapideditor/country-coder';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/data/climate-grid.bin.gz');
const CACHE = process.argv[2] ?? join(tmpdir(), 'navi-terraclimate');
mkdirSync(CACHE, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const BASE = 'http://thredds.northwestknowledge.net:8080/thredds/dodsC/TERRACLIMATE_ALL';
const SRC_ROWS = 4320, SRC_COLS = 8640;   // 1/24°, from 90°N and 180°W
const STRIDE = 3;                          // every third pixel: 1/8°
const SUB_ROWS = SRC_ROWS / STRIDE, SUB_COLS = SRC_COLS / STRIDE;
const RES = 0.25;
const ROWS = 600;                          // 90°N … 60°S
const COLS = 1440;
const PER = RES * 24 / STRIDE;             // sub-pixels per cell side (2)

// ── Download ────────────────────────────────────────────────────────────────

const enc = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

async function fetchSlab(file, variable, month) {
  const name = `${variable}${month == null ? '' : `-${month}`}.bin`;
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
  const time = month == null ? '' : `[${month}:1:${month}]`;
  const url = `${BASE}/${file}.dods?${enc(`${variable}.${variable}${time}[1:${STRIDE}:${SRC_ROWS - 1}][1:${STRIDE}:${SRC_COLS - 1}]`)}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      console.log(`  ${name}  ${(buf.length / 1e6).toFixed(1)} MB`);
      return buf;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.log(`  ${name}: ${e.message}, again…`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

// The values of a DAP2 binary answer: the text header, "Data:\n", the length
// twice, then one big-endian 4-byte word per value (Int16 is sent widened).
function values(buf, kind) {
  const at = buf.indexOf('\nData:\n') + 7;
  const n = buf.readUInt32BE(at);
  if (n !== SUB_ROWS * SUB_COLS) throw new Error(`expected ${SUB_ROWS * SUB_COLS} values, got ${n}`);
  const out = new Float32Array(n);
  const start = at + 8;
  for (let i = 0; i < n; i++) {
    out[i] = kind === 'f32' ? buf.readFloatBE(start + i * 4) : buf.readInt32BE(start + i * 4);
  }
  return out;
}

// ── Averaging into cells ────────────────────────────────────────────────────

// Mean of a cell's valid sub-pixels; NaN when it has none (sea).
function cellMeans(raw, isValid, scale, offset) {
  const out = new Float32Array(ROWS * COLS).fill(NaN);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let sum = 0, n = 0;
      for (let dr = 0; dr < PER; dr++) {
        const row = (r * PER + dr) * SUB_COLS;
        for (let dc = 0; dc < PER; dc++) {
          const v = raw[row + c * PER + dc];
          if (isValid(v)) { sum += v; n++; }
        }
      }
      if (n) out[r * COLS + c] = (sum / n) * scale + offset;
    }
  }
  return out;
}

const VARS = [
  { name: 'tmax', valid: (v) => v !== -32768, scale: 0.1, offset: -73 },
  { name: 'tmin', valid: (v) => v !== -32768, scale: 0.1, offset: -73 },
  { name: 'ppt', valid: (v) => v !== -2147483648 && v >= 0, scale: 0.1, offset: 0 },
  { name: 'vap', valid: (v) => v !== -32768 && v >= 0, scale: 0.1, offset: 0 },
  { name: 'swe', valid: (v) => v !== -2147483648 && v >= 0, scale: 0.1, offset: 0 },
];

console.log(`TerraClimate → ${OUT}\n(raw downloads cached in ${CACHE})`);

const demRaw = values(await fetchSlab('layers/terraclim_dem.nc', 'elevation', null), 'f32');
const elev = cellMeans(demRaw, (v) => v > -32000 && Number.isFinite(v), 0.1, 0);

const monthly = {};
for (const v of VARS) {
  monthly[v.name] = [];
  // Three at a time: a public university server, and each answer is 16 MB.
  for (let m = 0; m < 12; m += 3) {
    const slabs = await Promise.all(
      [m, m + 1, m + 2].map((mm) => fetchSlab(`climatology/TerraClimate_19912020_${v.name}.nc`, v.name, mm))
    );
    for (const s of slabs) monthly[v.name].push(cellMeans(values(s, 'i32'), v.valid, v.scale, v.offset));
  }
}

// ── Land cells, their countries, and packing ────────────────────────────────

const land = [];
for (let i = 0; i < ROWS * COLS; i++) {
  if (Number.isFinite(monthly.tmax[0][i]) && Number.isFinite(monthly.tmin[0][i])) land.push(i);
}
const n = land.length;

const countries = [''];
const countryIdx = new Map([['', 0]]);
const cellCountry = new Uint8Array(n);
for (let k = 0; k < n; k++) {
  const i = land[k];
  const r = Math.floor(i / COLS), c = i % COLS;
  const lat = 90 - (r + 0.5) * RES, lon = -180 + (c + 0.5) * RES;
  // The centre first; a coastal cell whose centre is at sea is tried at its
  // corners' insides too.
  let code = iso1A2Code([lon, lat]);
  for (const [dy, dx] of [[0.06, 0.06], [-0.06, 0.06], [0.06, -0.06], [-0.06, -0.06]]) {
    if (code) break;
    code = iso1A2Code([lon + dx, lat + dy]);
  }
  code = code ?? '';
  if (!countryIdx.has(code)) {
    countryIdx.set(code, countries.length);
    countries.push(code);
  }
  cellCountry[k] = countryIdx.get(code);
}
if (countries.length > 256) throw new Error(`too many countries: ${countries.length}`);

const rowStart = new Uint32Array(ROWS + 1);
const mask = new Uint8Array(Math.ceil((ROWS * COLS) / 8));
for (let k = 0; k < n; k++) {
  const i = land[k];
  mask[i >> 3] |= 1 << (i & 7);
  rowStart[Math.floor(i / COLS) + 1]++;
}
for (let r = 0; r < ROWS; r++) rowStart[r + 1] += rowStart[r];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const elevArr = new Int16Array(n);
for (let k = 0; k < n; k++) {
  const e = elev[land[k]];
  elevArr[k] = Number.isFinite(e) ? clamp(e, -500, 8800) : 0;
}

// Packed one byte a value, month after month (12 × n each):
//   tmax, tmin   int8, half degrees      (−64 … 63.5 °C)
//   ppt          uint8, √mm × 8          (to about 1,000 mm)
//   vap          uint8, kPa × 50
//   swe          uint8, √mm × 4
const pack = {
  tmax: (v) => clamp(v * 2, -128, 127),
  tmin: (v) => clamp(v * 2, -128, 127),
  ppt: (v) => clamp(Math.sqrt(Math.max(0, v || 0)) * 8, 0, 255),
  vap: (v) => clamp((v || 0) * 50, 0, 255),
  swe: (v) => clamp(Math.sqrt(Math.max(0, v || 0)) * 4, 0, 255),
};
const blocks = {};
for (const v of VARS) {
  const arr = v.name.startsWith('t') ? new Int8Array(12 * n) : new Uint8Array(12 * n);
  for (let m = 0; m < 12; m++) {
    const src = monthly[v.name][m];
    for (let k = 0; k < n; k++) arr[m * n + k] = pack[v.name](src[land[k]]);
  }
  blocks[v.name] = arr;
}

const header = Buffer.from(JSON.stringify({
  format: 1, rows: ROWS, cols: COLS, lat0: 90, lon0: -180, res: RES, n, countries,
  source: 'TerraClimate 1991-2020 monthly normals (Abatzoglou et al. 2018, CC0)',
}));
const pad4 = (len) => Buffer.alloc((4 - (len % 4)) % 4);
const head = Buffer.alloc(8);
head.write('CLIM', 0);
head.writeUInt32LE(header.length, 4);
const parts = [head, header, pad4(header.length)];
const add = (typed) => {
  const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  parts.push(b, pad4(b.length));
};
add(rowStart);
add(mask);
add(elevArr);
add(cellCountry);
for (const v of VARS) add(blocks[v.name]);

const raw = Buffer.concat(parts);
const gz = gzipSync(raw, { level: 9 });
writeFileSync(OUT, gz);
console.log(`${n.toLocaleString()} land cells, ${countries.length - 1} countries — ${(raw.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(1)} MB gzipped`);
