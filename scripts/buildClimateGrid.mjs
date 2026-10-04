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
// Thirty-year normals describe the climate of about 2005, and the world has
// warmed since: comparing 2016–2025 with 1991–2020 in TerraClimate's own
// monthly series gives +0.7° in Israel and +1.25° in the Alps. So the normals
// are moved to the last decade (see "The last decade" below) — the
// temperatures, humidity and snow, by how much the decade differed from the
// normal, smoothed so that one odd winter does not become a rule. Rain is left
// on the thirty years: ten years of rain are too noisy to say anything, and
// the decade shows no clear change in it.
//
// What comes out is a few megabytes, land only, south to 60°S (nothing below
// is walked). Each cell also carries the country it lies in, from the borders
// that ship with country-coder, so "which countries are in season in May" is a
// pass over the grid and not a question to anyone.
//
// Run once; the raw downloads (about a gigabyte and a half) are kept in a cache folder so
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
function values(buf, kind, expected = SUB_ROWS * SUB_COLS) {
  const at = buf.indexOf('\nData:\n') + 7;
  const n = buf.readUInt32BE(at);
  if (n !== expected) throw new Error(`expected ${expected} values, got ${n}`);
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

// ── The last decade ─────────────────────────────────────────────────────────
// How 2016–2025 differed from 1991–2020, month by month, on a coarse 0.5°
// grid: warming is a large-scale signal, and every twelfth pixel is plenty to
// see it (a megabyte a month rather than sixteen). The difference is then
// smoothed over the 3×3 neighbouring coarse cells and the month either side —
// ten years are few, and a single run of warm Februaries would otherwise
// read as February itself having warmed by three degrees — and added to the
// fine normals above. Snow goes by ratio rather than difference, so it can
// shrink but never go below nothing.

const RECENT_FROM = 2016, RECENT_TO = 2025;
const CSTRIDE = 12;                                  // every twelfth pixel: 0.5°
const C_ROWS = SRC_ROWS / CSTRIDE, C_COLS = SRC_COLS / CSTRIDE;
const C_PER_YEAR = 12 * C_ROWS * C_COLS;
const AGG = 'http://thredds.northwestknowledge.net:8080/thredds/dodsC';

async function fetchCoarse(url, name) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
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

const space = `[${CSTRIDE / 2}:${CSTRIDE}:${SRC_ROWS - 1}][${CSTRIDE / 2}:${CSTRIDE}:${SRC_COLS - 1}]`;
// The series is packed differently from the normals file.
const SERIES = {
  tmax: { valid: (v) => v !== -32768, scale: 0.01, offset: -99 },
  tmin: { valid: (v) => v !== -32768, scale: 0.01, offset: -99 },
  vap: { valid: (v) => v !== -32768 && v >= 0, scale: 0.001, offset: 0 },
  swe: { valid: (v) => v !== -2147483648 && v >= 0, scale: 0.1, offset: 0 },
};

async function coarseRecent(name) {
  const { valid, scale, offset } = SERIES[name];
  const sum = new Float64Array(C_PER_YEAR), cnt = new Uint16Array(C_PER_YEAR);
  const years = Array.from({ length: RECENT_TO - RECENT_FROM + 1 }, (_, i) => RECENT_FROM + i);
  for (let y = 0; y < years.length; y += 3) {
    const bufs = await Promise.all(years.slice(y, y + 3).map((year) => {
      const t0 = (year - 1950) * 12;
      const url = `${AGG}/agg_terraclimate_${name}_1950_CurrentYear_GLOBE.nc.dods?${enc(`${name}.${name}[${t0}:1:${t0 + 11}]${space}`)}`;
      return fetchCoarse(url, `recent-${name}-${year}.bin`);
    }));
    for (const b of bufs) {
      const v = values(b, 'i32', C_PER_YEAR);
      for (let i = 0; i < C_PER_YEAR; i++) if (valid(v[i])) { sum[i] += v[i] * scale + offset; cnt[i]++; }
    }
  }
  return Float32Array.from(sum, (s, i) => (cnt[i] >= 5 ? s / cnt[i] : NaN));
}

async function coarseNormal(v) {
  const url = `${BASE}/climatology/TerraClimate_19912020_${v.name}.nc.dods?${enc(`${v.name}.${v.name}[0:1:11]${space}`)}`;
  const raw = values(await fetchCoarse(url, `normal-${v.name}.bin`), 'i32', C_PER_YEAR);
  return Float32Array.from(raw, (x) => (v.valid(x) ? x * v.scale + v.offset : NaN));
}

// Smoothed over the neighbouring cells and the month either side.
// `ratio`: the sums' ratio (snow), else the mean difference.
function smoothedChange(recent, normal, ratio) {
  const out = new Float32Array(C_PER_YEAR);
  for (let m = 0; m < 12; m++) {
    for (let r = 0; r < C_ROWS; r++) {
      for (let c = 0; c < C_COLS; c++) {
        let a = 0, b = 0, n = 0;
        for (const mm of [(m + 11) % 12, m, (m + 1) % 12]) {
          for (let dr = -1; dr <= 1; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= C_ROWS) continue;
            for (let dc = -1; dc <= 1; dc++) {
              const i = mm * C_ROWS * C_COLS + rr * C_COLS + ((c + dc + C_COLS) % C_COLS);
              if (!Number.isFinite(recent[i]) || !Number.isFinite(normal[i])) continue;
              a += recent[i]; b += normal[i]; n++;
            }
          }
        }
        const k = m * C_ROWS * C_COLS + r * C_COLS + c;
        if (ratio) out[k] = n && b >= 3 * n ? Math.max(0.3, Math.min(1.5, a / b)) : 1;
        else out[k] = n ? (a - b) / n : 0;
      }
    }
  }
  return out;
}

console.log(`adjusting to ${RECENT_FROM}–${RECENT_TO}…`);
const report = [];
for (const v of VARS.filter((x) => x.name !== 'ppt')) {
  const change = smoothedChange(await coarseRecent(v.name), await coarseNormal(v), v.name === 'swe');
  let total = 0, counted = 0;
  for (let m = 0; m < 12; m++) {
    const fine = monthly[v.name][m];
    for (let r = 0; r < ROWS; r++) {
      // A fine 0.25° cell lies in coarse cell (r/2, c/2).
      const cr = r >> 1;
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        if (!Number.isFinite(fine[i])) continue;
        const d = change[m * C_ROWS * C_COLS + cr * C_COLS + (c >> 1)];
        fine[i] = v.name === 'swe' ? fine[i] * d : v.name === 'vap' ? Math.max(0, fine[i] + d) : fine[i] + d;
        total += d; counted++;
      }
    }
  }
  report.push(`${v.name} ${v.name === 'swe' ? '×' : '+'}${(total / counted).toFixed(2)} on average`);
}
console.log('  ' + report.join(', '));

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
  adjusted: `temperature, vapour pressure and snow moved to ${RECENT_FROM}-${RECENT_TO}`,
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
