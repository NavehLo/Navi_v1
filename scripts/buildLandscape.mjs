// Builds src/data/landscape.json.gz: what each country and each of its areas
// looks like — how mountainous and how dramatic, how much forest and of what
// kind, and how many rivers that flow all year or for a season. Read by
// src/lib/landscape.ts, which is the one place the words for it are decided.
//
// Everything is computed on one global grid of 30 arc-seconds (about 1 km),
// from four open sources:
//
//   Relief   GMTED2010 (USGS, public domain), its 30" grids of the highest and
//            the lowest point in every cell. "Dramatic" is not height — a high
//            plateau is flat — but how far the ground falls around you: the
//            highest minus the lowest point within ~2.5 km (RADIUS_KM). The
//            Dolomites come out at 1,500 m and more, the Tibetan plateau at a
//            few hundred.
//   Forest   Copernicus Global Land Cover 100 m, 2019 (CC BY 4.0). Every 100 m
//            pixel is closed forest (>70% canopy) or open forest (15–70%), of
//            one type: evergreen needle-leaf (pine, fir, spruce), evergreen
//            broad-leaf, deciduous needle-leaf (larch), deciduous broad-leaf
//            (beech, oak, chestnut), mixed. Averaged to the 1 km cells.
//   Rivers   Messager et al. 2021, "Global prevalence of non-perennial rivers
//            and streams" (Nature; CC BY 4.0): every river and stream with a
//            catchment of 10 km² or more, with the predicted chance that it
//            stops flowing at least one day a year, and at least thirty.
//            See RIVER_* below for how that becomes "all year" and "seasonal".
//   Ranges   GMBA Mountain Inventory v2 (CC BY 4.0), the named mountain ranges,
//            with Hebrew names from Wikidata where it has them.
//
// Land is what lies inside an area of src/data/regions.json.gz (GMTED has no
// sea mask), so the regions file must be built first.
//
// The output holds no grid, only summaries — a histogram of relief, shares of
// forest and rivers — so the thresholds that turn them into words live in
// landscape.ts and can change without rebuilding. The 1 km layers are left in
// the cache folder for anything that later wants to sample a trail.
//
// Run once. Downloads about 3.7 GB into the cache folder the first time, then
// a few minutes of GDAL and about one of Node. Needs GDAL on PATH (or
// Postgres.app's copy, found by itself).
//
//   node scripts/buildLandscape.mjs [cacheDir]

import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/data/landscape.json.gz');
const REGIONS = join(ROOT, 'src/data/regions.json.gz');
const CACHE = process.argv[2] ?? join(homedir(), '.cache/navi-landscape');
mkdirSync(CACHE, { recursive: true });

// Bumped when what is stored changes; landscape.ts checks it.
const LANDSCAPE_FORMAT = 1;

const POSTGRES_GDAL = '/Applications/Postgres.app/Contents/Versions/latest/bin';
const env = { ...process.env, PATH: `${process.env.PATH}:${POSTGRES_GDAL}`, GDAL_CACHEMAX: '4096' };
const gdal = (cmd, args) => execFileSync(cmd, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
const gdalOut = (cmd, args) => execFileSync(cmd, args, { env, maxBuffer: 1 << 30 }).toString();
const gdalAsync = (cmd, args) => new Promise((resolve, reject) => {
  spawn(cmd, args, { env, stdio: ['ignore', 'inherit', 'inherit'] })
    .on('error', reject)
    .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

// The grid is GMTED's own: 43200 × 16800 cells of 1/120°, 84°N to 56°S.
const RES = 1 / 120;
const COLS = 43200;
const ROWS = 16800;
const WEST = -180.000138888888927;
const NORTH = 83.999861111111684;
const EXTENT = [WEST, NORTH - ROWS * RES, WEST + COLS * RES, NORTH].map(String);
const onGrid = ['-te', ...EXTENT, '-ts', String(COLS), String(ROWS)];

const RADIUS_KM = 2.5;
const KM_PER_DEG = 111.32;

// Relief bins (m), the lower edge of each: what the histogram is kept in.
const RELIEF_BINS = [0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 1800, 2000, 2500, 3000];

// Rivers. Messager's model says, per reach, whether it is expected to stop
// flowing at least a day a year (predcat1) and at least thirty (predcat30).
//   all year:  predcat1 = 0 — or a real river by any measure (lowest month of
//              the natural flow 5 m³/s or more). The model trained on gauges
//              that sit below dams and abstraction, and calls the Jordan,
//              with 8 m³/s in its driest month, intermittent.
//   seasonal:  stops, but flows for a season: dry less than thirty days, or
//              dry longer outside the arid zone (aridity index 0.2 and above;
//              the file keeps it ×10,000). In a desert a reach dry for more
//              than a month is a wadi that runs a few days a year — not what
//              anybody means by a river, and left out.
const RIVER_PERENNIAL = 'predcat1 = 0 OR dis_m3_pmn >= 5';
const RIVER_SEASONAL = 'predcat1 = 1 AND dis_m3_pmn < 5 AND (predcat30 = 0 OR ari_ix_uav >= 2000)';

// ── Downloads ───────────────────────────────────────────────────────────────

const SOURCES = {
  'mx30_grd.zip': 'https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/topo/downloads/GMTED/Grid_ZipFiles/mx30_grd.zip',
  'mi30_grd.zip': 'https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/topo/downloads/GMTED/Grid_ZipFiles/mi30_grd.zip',
  'lc100_2019_discrete.tif': 'https://zenodo.org/records/3939050/files/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif?download=1',
  'GIRES_v10_shp.zip': 'https://ndownloader.figshare.com/files/28254582',
  'GMBA_basic.zip': 'https://data.earthenv.org/mountains/standard/GMBA_Inventory_v2.0_standard_basic.zip',
};

function fetchAll() {
  for (const [name, url] of Object.entries(SOURCES)) {
    const path = join(CACHE, name);
    if (existsSync(path) && statSync(path).size > 1e6) continue;
    console.log(`downloading ${name}…`);
    execFileSync('curl', ['-sSfL', '-C', '-', '--retry', '4', '-o', path, url], { stdio: 'inherit' });
  }
  const unzip = (zip, marker, dest = CACHE) => {
    if (!existsSync(join(CACHE, marker))) execFileSync('unzip', ['-o', '-q', join(CACHE, zip), '-d', dest], { stdio: 'inherit' });
  };
  unzip('mx30_grd.zip', 'gmted/mx30_grd', join(CACHE, 'gmted'));
  unzip('mi30_grd.zip', 'gmted/mi30_grd', join(CACHE, 'gmted'));
  unzip('GIRES_v10_shp.zip', 'GIRES_v10_shp');
  unzip('GMBA_basic.zip', 'gmba_basic/GMBA_Inventory_v2.0_standard_basic.shp', join(CACHE, 'gmba_basic'));
}

// ── The 1 km layers ─────────────────────────────────────────────────────────
// Each a raw file (ENVI), row after row from the north, so Node can read rows
// straight out of it.

// The ENVI driver writes the header beside the data with its extension
// replaced, so "x.bin.tmp" gets "x.bin.hdr" — already the final name.
async function layer(name, make) {
  const path = join(CACHE, name);
  if (existsSync(path)) return path;
  console.log(`building ${name}…`);
  const t = Date.now();
  await make(path + '.tmp');
  for (const ext of ['', '.hdr']) {
    if (existsSync(path + '.tmp' + ext)) execFileSync('mv', [path + '.tmp' + ext, path + ext]);
  }
  console.log(`  ${((Date.now() - t) / 1000).toFixed(0)} s`);
  return path;
}

async function elevationLayers() {
  const max = await layer('relief-max.bin', (out) => gdal('gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Int16', join(CACHE, 'gmted/mx30_grd'), out]));
  const min = await layer('relief-min.bin', (out) => gdal('gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Int16', join(CACHE, 'gmted/mi30_grd'), out]));
  return { max, min };
}

// Seven bands, pixel-interleaved: the share (0–100) of the cell that is
// forest of each type, then the share that is closed forest of any type.
const FOREST_TYPES = ['needleEvergreen', 'broadEvergreen', 'needleDeciduous', 'broadDeciduous', 'mixed', 'unknown'];
const FOREST_BANDS = [
  [111, 121], [112, 122], [113, 123], [114, 124], [115, 125], [116, 126],
  [111, 112, 113, 114, 115, 116],
];

// The 100 m map is 51 GB once decompressed, and a warp reads it on one core:
// about two hours. Cut into vertical strips warped side by side, it is a
// fraction of that.
const STRIPS = 10;

function forestLayer() {
  return layer('forest.bin', async (out) => {
    const src = join(CACHE, 'lc100_2019_discrete.tif');
    const info = gdalOut('gdalinfo', [src]);
    const [, w, h] = info.match(/Size is (\d+), (\d+)/);
    const [, ox, oy] = info.match(/Origin = \(([-\d.]+),([-\d.]+)\)/);
    const [, px] = info.match(/Pixel Size = \(([-\d.]+),/);
    // A LUT is interpolated between its points, so every byte gets one.
    const lut = (classes) => Array.from({ length: 256 }, (_, v) => `${v}:${classes.includes(v) ? 100 : 0}`).join(',');
    const bands = FOREST_BANDS.map((classes, i) => `
  <VRTRasterBand dataType="Byte" band="${i + 1}">
    <ComplexSource>
      <SourceFilename relativeToVRT="0">${src}</SourceFilename>
      <SourceBand>1</SourceBand>
      <SrcRect xOff="0" yOff="0" xSize="${w}" ySize="${h}" />
      <DstRect xOff="0" yOff="0" xSize="${w}" ySize="${h}" />
      <LUT>${lut(classes)}</LUT>
    </ComplexSource>
  </VRTRasterBand>`).join('');
    const vrt = join(CACHE, 'forest.vrt');
    writeFileSync(vrt, `<VRTDataset rasterXSize="${w}" rasterYSize="${h}">
  <SRS>EPSG:4326</SRS>
  <GeoTransform>${ox}, ${px}, 0, ${oy}, 0, ${-Number(px)}</GeoTransform>${bands}
</VRTDataset>
`);
    const width = COLS / STRIPS;
    const strips = Array.from({ length: STRIPS }, (_, i) => join(CACHE, `forest-strip-${i}.tif`));
    await Promise.all(strips.map((strip, i) => {
      if (existsSync(strip)) return null;
      // GMTED's grid starts half a second west of -180°. Asked for that, the
      // warper takes the strip to cross the date line and reads the whole
      // world for every piece of it — hours. Starting at -180 moves the first
      // strip's cells by 15 m.
      const west = Math.max(-180, WEST + i * width * RES);
      const east = WEST + (i + 1) * width * RES;
      return gdalAsync('gdalwarp', [
        '-q', '-overwrite', '-r', 'average', '-te', String(west), EXTENT[1], String(east), EXTENT[3],
        '-ts', String(width), String(ROWS), '-ot', 'Byte', '-dstnodata', 'None', '-wm', '512', vrt, strip + '.tmp.tif',
      ]).then(() => execFileSync('mv', [strip + '.tmp.tif', strip]));
    }));
    const mosaic = join(CACHE, 'forest-strips.vrt');
    gdal('gdalbuildvrt', ['-q', '-overwrite', mosaic, ...strips]);
    gdal('gdal_translate', ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BIP', mosaic, out]);
  });
}

// 0 none, 1 seasonal, 2 all year. Seasonal is burned first, so a cell that
// has both is "all year".
function riverLayer() {
  return layer('rivers.bin', async (out) => {
    const parts = ['af', 'ar', 'as', 'au', 'eu', 'gr', 'na', 'sa', 'si']
      .map((p) => join(CACHE, `GIRES_v10_shp/GIRES_v10_rivers_${p}.shp`))
      .filter(existsSync);
    gdal('gdal_create', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-outsize', String(COLS), String(ROWS), '-bands', '1', '-burn', '0',
      '-a_srs', 'EPSG:4326', '-a_ullr', EXTENT[0], EXTENT[3], EXTENT[2], EXTENT[1], out]);
    for (const [value, where] of [[1, RIVER_SEASONAL], [2, RIVER_PERENNIAL]]) {
      for (const shp of parts) {
        console.log(`  ${value === 2 ? 'all year' : 'seasonal'}: ${shp.split('_').pop()}`);
        gdal('gdal_rasterize', ['-q', '-at', '-burn', String(value), '-where', where, shp, out]);
      }
    }
  });
}

// Each cell's area, by index into the list returned (0: none).
async function regionLayer() {
  const regions = JSON.parse(gunzipSync(readFileSync(REGIONS)).toString('utf8')).countries;
  const units = [];
  for (const [country, { units: us }] of Object.entries(regions)) {
    for (const u of us) units.push({ country, id: u.id, polys: u.polys, size: (u.bbox[2] - u.bbox[0]) * (u.bbox[3] - u.bbox[1]) });
  }
  // Largest first, so an enclave (Lesotho, San Marino) is burned over the
  // country round it — the rings are drawn filled, holes and all.
  units.sort((a, b) => b.size - a.size);
  const path = await layer('regions.bin', async (out) => {
    const features = units.map((u, i) => ({
      type: 'Feature',
      properties: { rid: i + 1 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: u.polys.map((flat) => {
          const ring = [];
          for (let k = 0; k < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]);
          if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ring.push(ring[0]);
          return [ring];
        }),
      },
    }));
    const geojson = join(CACHE, 'regions.geojson');
    writeFileSync(geojson, JSON.stringify({ type: 'FeatureCollection', features }));
    gdal('gdal_create', ['-q', '-of', 'ENVI', '-ot', 'UInt16', '-outsize', String(COLS), String(ROWS), '-bands', '1', '-burn', '0',
      '-a_srs', 'EPSG:4326', '-a_ullr', EXTENT[0], EXTENT[3], EXTENT[2], EXTENT[1], out]);
    gdal('gdal_rasterize', ['-q', '-a', 'rid', geojson, out]);
  });
  return { path, units };
}

async function rangeLayer() {
  const shp = join(CACHE, 'gmba_basic/GMBA_Inventory_v2.0_standard_basic.shp');
  const path = await layer('ranges.bin', async (out) => {
    gdal('gdal_create', ['-q', '-of', 'ENVI', '-ot', 'UInt32', '-outsize', String(COLS), String(ROWS), '-bands', '1', '-burn', '0',
      '-a_srs', 'EPSG:4326', '-a_ullr', EXTENT[0], EXTENT[3], EXTENT[2], EXTENT[1], out]);
    gdal('gdal_rasterize', ['-q', '-a', 'GMBA_V2_ID', shp, out]);
  });
  // id → names, from the attribute table.
  const csv = gdalOut('ogr2ogr', ['-f', 'CSV', '/vsistdout/', shp, '-select', 'GMBA_V2_ID,MapName,Name_EN,WikiDataUR']);
  const names = new Map();
  for (const row of parseCsv(csv).slice(1)) {
    const [id, mapName, en, wiki] = row;
    names.set(Number(id), { en: en || mapName, wiki: wiki?.match(/Q\d+$/)?.[0] ?? null });
  }
  return { path, names };
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Hebrew names of the ranges, from Wikidata (free, no key), kept in the cache
// batch by batch. Wikidata answers a fast client with 429, so the batches are
// spaced and a refusal waits as long as it asks; names it never gave stay
// English (and are asked again on the next run).
async function hebrewNames(qids) {
  const file = join(CACHE, 'wikidata-he.json');
  const known = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const missing = [...new Set(qids)].filter((q) => !(q in known));
  console.log(`Hebrew names: ${missing.length} to ask Wikidata for`);
  for (let i = 0; i < missing.length; i += 50) {
    const ids = missing.slice(i, i + 50);
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=he&ids=${ids.join('|')}`;
    let done = false;
    for (let attempt = 1; attempt <= 5 && !done; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'navi-trails/1.0 (https://navi-v1.vercel.app; landscape build)' }, signal: AbortSignal.timeout(30_000) });
        if (res.status === 429 || res.status >= 500) {
          const wait = Number(res.headers.get('retry-after')) || 10 * attempt;
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        for (const q of ids) known[q] = body.entities?.[q]?.labels?.he?.value ?? null;
        writeFileSync(file, JSON.stringify(known));
        done = true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        if (attempt === 5) console.log(`  Wikidata: ${e.message}`);
      }
    }
    if (!done) {
      console.log('  Wikidata keeps refusing — the rest stay in English this time');
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return known;
}

// ── The pass over the grid ──────────────────────────────────────────────────

function rowReader(path, bytesPerCell) {
  const fd = openSync(path, 'r');
  const rowBytes = COLS * bytesPerCell;
  return {
    read(row, buf) { readSync(fd, buf, 0, rowBytes, row * rowBytes); },
    close() { closeSync(fd); },
  };
}

function binOf(relief) {
  let b = 0;
  while (b + 1 < RELIEF_BINS.length && relief >= RELIEF_BINS[b + 1]) b++;
  return b;
}

function newAcc() {
  return {
    area: 0,                                  // km²
    relief: new Float64Array(RELIEF_BINS.length),
    forest: new Float64Array(FOREST_BANDS.length), // km² of each band
    perennial: 0,                             // km² of cells with a river that flows all year
    seasonal: 0,
    ranges: new Map(),                        // GMBA id → km² of land 300 m+ of relief
  };
}

function aggregate({ max, min }, forest, rivers, regions, ranges) {
  const R_ROWS = Math.max(1, Math.round(RADIUS_KM / (KM_PER_DEG * RES)));
  const WIN = 2 * R_ROWS + 1;
  const acc = new Map(); // unit index → accumulator
  const maxR = rowReader(max, 2), minR = rowReader(min, 2);
  const forR = rowReader(forest, FOREST_BANDS.length);
  const rivR = rowReader(rivers, 1);
  const regR = rowReader(regions.path, 2);
  const rngR = rowReader(ranges.path, 4);

  // A ring of the last WIN rows, each already reduced across its columns.
  const rowMax = Array.from({ length: WIN }, () => new Int16Array(COLS));
  const rowMin = Array.from({ length: WIN }, () => new Int16Array(COLS));
  const bufMax = Buffer.alloc(COLS * 2), bufMin = Buffer.alloc(COLS * 2);
  const vMax = new Int16Array(bufMax.buffer, bufMax.byteOffset, COLS);
  const vMin = new Int16Array(bufMin.buffer, bufMin.byteOffset, COLS);
  const bufFor = Buffer.alloc(COLS * FOREST_BANDS.length), bufRiv = Buffer.alloc(COLS);
  const bufReg = Buffer.alloc(COLS * 2), bufRng = Buffer.alloc(COLS * 4);
  const vReg = new Uint16Array(bufReg.buffer, bufReg.byteOffset, COLS);
  const vRng = new Uint32Array(bufRng.buffer, bufRng.byteOffset, COLS);
  const reliefOut = Buffer.alloc(COLS * 2);
  const vReliefOut = new Uint16Array(reliefOut.buffer, reliefOut.byteOffset, COLS);
  const reliefFile = join(CACHE, 'relief.bin');
  const reliefFd = openSync(reliefFile, 'w');

  const latOf = (r) => NORTH - (r + 0.5) * RES;
  const reduceRow = (r, slot) => {
    maxR.read(r, bufMax);
    minR.read(r, bufMin);
    // Across the columns: a window as wide in kilometres as it is tall.
    const cos = Math.max(0.05, Math.cos((latOf(r) * Math.PI) / 180));
    const rc = Math.min(40, Math.max(1, Math.round(R_ROWS / cos)));
    const outMax = rowMax[slot], outMin = rowMin[slot];
    for (let c = 0; c < COLS; c++) {
      let hi = -32768, lo = 32767;
      const a = Math.max(0, c - rc), b = Math.min(COLS - 1, c + rc);
      for (let k = a; k <= b; k++) {
        if (vMax[k] > hi) hi = vMax[k];
        if (vMin[k] < lo) lo = vMin[k];
      }
      outMax[c] = hi;
      outMin[c] = lo;
    }
  };

  for (let r = 0; r < Math.min(R_ROWS, ROWS); r++) reduceRow(r, r % WIN);
  const t0 = Date.now();
  for (let r = 0; r < ROWS; r++) {
    const ahead = r + R_ROWS;
    if (ahead < ROWS) reduceRow(ahead, ahead % WIN);
    regR.read(r, bufReg);
    vReliefOut.fill(0);
    let anyLand = false;
    for (let c = 0; c < COLS; c++) if (vReg[c]) { anyLand = true; break; }
    if (anyLand) {
      forR.read(r, bufFor);
      rivR.read(r, bufRiv);
      rngR.read(r, bufRng);
      const lat = latOf(r);
      const cellKm2 = (KM_PER_DEG * RES) ** 2 * Math.cos((lat * Math.PI) / 180);
      const top = Math.max(0, r - R_ROWS), bottom = Math.min(ROWS - 1, r + R_ROWS);
      for (let c = 0; c < COLS; c++) {
        const unit = vReg[c];
        if (!unit) continue;
        let hi = -32768, lo = 32767;
        for (let rr = top; rr <= bottom; rr++) {
          const s = rr % WIN;
          if (rowMax[s][c] > hi) hi = rowMax[s][c];
          if (rowMin[s][c] < lo) lo = rowMin[s][c];
        }
        const relief = Math.max(0, hi - lo);
        vReliefOut[c] = Math.min(65535, relief);
        let a = acc.get(unit);
        if (!a) acc.set(unit, (a = newAcc()));
        a.area += cellKm2;
        a.relief[binOf(relief)] += cellKm2;
        const f = c * FOREST_BANDS.length;
        for (let b = 0; b < FOREST_BANDS.length; b++) a.forest[b] += (bufFor[f + b] / 100) * cellKm2;
        if (bufRiv[c] === 2) a.perennial += cellKm2;
        else if (bufRiv[c] === 1) a.seasonal += cellKm2;
        if (relief >= 300 && vRng[c]) a.ranges.set(vRng[c], (a.ranges.get(vRng[c]) ?? 0) + cellKm2);
      }
    }
    writeFileSync(reliefFd, reliefOut);
    if (r % 1200 === 0) console.log(`  row ${r} / ${ROWS}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  for (const x of [maxR, minR, forR, rivR, regR, rngR]) x.close();
  closeSync(reliefFd);
  writeFileSync(reliefFile + '.hdr', `ENVI\nsamples = ${COLS}\nlines = ${ROWS}\nbands = 1\nheader offset = 0\nfile type = ENVI Standard\ndata type = 12\ninterleave = bsq\nbyte order = 0\nmap info = {Geographic Lat/Lon, 1, 1, ${WEST}, ${NORTH}, ${RES}, ${RES}, WGS-84}\n`);
  return acc;
}

// ── Output ──────────────────────────────────────────────────────────────────

// Shares in thousandths, which is precise enough and keeps the file small.
const permille = (x, of) => (of > 0 ? Math.round((1000 * x) / of) : 0);

function summary(a, rangeIds) {
  const forestAll = a.forest.slice(0, FOREST_TYPES.length).reduce((s, v) => s + v, 0);
  const ranges = [...a.ranges.entries()]
    .filter(([, km2]) => km2 >= Math.max(25, a.area * 0.02))
    .sort((x, y) => y[1] - x[1])
    .slice(0, 5)
    .map(([id]) => { rangeIds.add(id); return id; });
  return {
    area: Math.round(a.area),
    relief: Array.from(a.relief, (v) => permille(v, a.area)),
    forest: permille(forestAll, a.area),
    closed: permille(a.forest[FOREST_TYPES.length], a.area),
    types: Array.from(a.forest.slice(0, FOREST_TYPES.length), (v) => permille(v, forestAll)),
    perennial: permille(a.perennial, a.area),
    seasonal: permille(a.seasonal, a.area),
    ranges,
  };
}

function merge(into, a) {
  into.area += a.area;
  for (let i = 0; i < into.relief.length; i++) into.relief[i] += a.relief[i];
  for (let i = 0; i < into.forest.length; i++) into.forest[i] += a.forest[i];
  into.perennial += a.perennial;
  into.seasonal += a.seasonal;
  for (const [id, km2] of a.ranges) into.ranges.set(id, (into.ranges.get(id) ?? 0) + km2);
}

console.log(`landscape → ${OUT}\n(downloads and 1 km layers in ${CACHE})`);
fetchAll();
const elevation = await elevationLayers();
// The rivers and the rest are single-core too: they run beside the forest.
const [forest, rivers, regions, ranges] = await Promise.all([
  forestLayer(),
  riverLayer(),
  regionLayer(),
  rangeLayer(),
]);

console.log('reading the grid…');
const acc = aggregate(elevation, forest, rivers, regions, ranges);

const rangeIds = new Set();
const countries = {};
const regionsOut = {};
const byCountry = new Map();
for (const [unit, a] of acc) {
  const u = regions.units[unit - 1];
  if (!byCountry.has(u.country)) byCountry.set(u.country, newAcc());
  merge(byCountry.get(u.country), a);
  (regionsOut[u.country] ??= {})[u.id] = summary(a, rangeIds);
}
for (const [country, a] of byCountry) countries[country] = summary(a, rangeIds);

const qids = [...rangeIds].map((id) => ranges.names.get(id)?.wiki).filter(Boolean);
const he = await hebrewNames(qids);
const rangeNames = {};
for (const id of rangeIds) {
  const n = ranges.names.get(id);
  if (n) rangeNames[id] = { en: n.en, he: (n.wiki && he[n.wiki]) || null };
}

const out = {
  version: LANDSCAPE_FORMAT,
  builtAt: new Date().toISOString().slice(0, 10),
  sources: 'GMTED2010 (USGS); Copernicus Global Land Service LC100 2019 (CC BY 4.0); Messager et al. 2021, Nature (CC BY 4.0); GMBA Mountain Inventory v2 (CC BY 4.0); Wikidata',
  reliefBins: RELIEF_BINS,
  forestTypes: FOREST_TYPES,
  ranges: rangeNames,
  countries,
  regions: regionsOut,
};
const raw = Buffer.from(JSON.stringify(out));
const gz = gzipSync(raw, { level: 9 });
writeFileSync(OUT, gz);
console.log(`${Object.keys(countries).length} countries, ${acc.size} areas, ${Object.keys(rangeNames).length} ranges — ${(raw.length / 1e3).toFixed(0)} KB raw, ${(gz.length / 1e3).toFixed(0)} KB gzipped`);
