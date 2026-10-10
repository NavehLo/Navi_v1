// "הרים, יער ונהרות" for every trail of a country's world list: how dramatic
// the ground around it is, how much forest and of what kind, and how much of
// it runs beside a river that flows all year or for a season. Written into
// src/data/trail-landscape.json.gz, which ships with the server
// (landscapeData.ts) — commit it and deploy.
//
// Runs on this Mac, because it reads the 1 km layers scripts/buildLandscape.mjs
// left in its cache folder (they are gigabytes; the server never sees them).
// Each trail's outline comes from Waymarked Trails, as the country list's own
// do; along it a point every SAMPLE_M, and each point reads its cell:
//
//   relief   the cell's relief (highest minus lowest within ~2.5 km) — the
//            mountains you see around you at that point of the walk
//   forest   the share of the cell under trees, and of what type
//   rivers   whether a river that flows all year (or for a season) crosses
//            the cell — within about a kilometre of the path
//   range    the GMBA mountain range the cell is in
//
// The summary has the same shape as a country's (landscape.ts), with shares
// of the trail's length instead of shares of land, so the same words, filters
// and order apply.
//
//   node scripts/collectLandscape.mjs GR ES MT     # these countries
//   node scripts/collectLandscape.mjs --all        # every country with a stored list
//   node scripts/collectLandscape.mjs --build CH   # build the country's list first if it has none,
//                                                  # or only part of one — with a longer time
//                                                  # budget than the app's, so it is read whole
//   node scripts/collectLandscape.mjs --rebuild FR # build its list again even if a whole one is stored
//   node scripts/collectLandscape.mjs --build --europe   # a whole group (GROUPS below):
//        --europe --latam --asia --north-america --africa --oceania, or --world for all of them
//
// Needs in .env.local: SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL,
// to read the stored country lists. Free: no paid service is called. Run it
// again for a country after its list changes (new trails have no landscape
// until then and show "אין מידע על הנוף").

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

import { existsSync, openSync, readSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { storedCountryTrails, rebuildCountryTrails, builtCountryCounts, readByIds } = await import('../src/lib/countryTrails.ts');
const { sectionsOfCountry } = await import('../src/lib/trailCrowd/sections.ts');
const { LANDSCAPE_VERSION } = await import('../src/lib/landscape.ts');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'src/data/trail-landscape.json.gz');
const AREAS = join(ROOT, 'src/data/landscape.json.gz');
const CACHE = process.env.LANDSCAPE_CACHE ?? join(homedir(), '.cache/navi-landscape');
const SAMPLE_M = 200;
const MAX_SAMPLES = 2000;    // a 400 km path is still read every 200 m; longer ones more sparsely

// The grid of the layers — buildLandscape.mjs's.
const RES = 1 / 120;
const COLS = 43200;
const ROWS = 16800;
const WEST = -180.000138888888927;
const NORTH = 83.999861111111684;
const FOREST_BANDS = 7;      // six types, then closed forest
const FOREST_TYPES = 6;

for (const f of ['relief.bin', 'forest.bin', 'rivers.bin', 'ranges.bin']) {
  if (!existsSync(join(CACHE, f))) {
    console.error(`${join(CACHE, f)} is missing — run node scripts/buildLandscape.mjs first.`);
    process.exit(1);
  }
}

// The countries collected, by the owner's order of priority (countryGroups.mjs).
import { GROUPS } from './countryGroups.mjs';

const args = process.argv.slice(2);
let countries = args.filter((a) => /^[A-Za-z]{2}$/.test(a)).map((a) => a.toUpperCase());
for (const [name, codes] of Object.entries(GROUPS)) {
  if (args.includes(`--${name}`) || args.includes('--world')) countries.push(...codes);
}
countries = [...new Set(countries)];
if (args.includes('--all')) countries = Object.keys(await builtCountryCounts()).sort();
if (!countries.length) {
  console.error(`usage: node scripts/collectLandscape.mjs [--build] <ISO code>… | --${Object.keys(GROUPS).join(' | --')} | --world | --all`);
  process.exit(1);
}

const areas = JSON.parse(gunzipSync(readFileSync(AREAS)).toString('utf8'));
const BINS = areas.reliefBins;

// ── Reading cells ───────────────────────────────────────────────────────────

const fds = Object.fromEntries(['relief', 'forest', 'rivers', 'ranges'].map((n) => [n, openSync(join(CACHE, `${n}.bin`), 'r')]));
const buf = Buffer.alloc(8);
function cell(lon, lat) {
  const r = Math.floor((NORTH - lat) / RES);
  const c = Math.floor((lon - WEST) / RES);
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
  const i = r * COLS + c;
  readSync(fds.relief, buf, 0, 2, i * 2);
  const relief = buf.readUInt16LE(0);
  readSync(fds.forest, buf, 0, FOREST_BANDS, i * FOREST_BANDS);
  const forest = [...buf.subarray(0, FOREST_BANDS)];
  readSync(fds.rivers, buf, 0, 1, i);
  const river = buf[0];
  readSync(fds.ranges, buf, 0, 4, i * 4);
  const range = buf.readUInt32LE(0);
  return { relief, forest, river, range };
}

// ── Along a trail ───────────────────────────────────────────────────────────

function haversineM(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(s));
}

// A point every `step` metres along each line, the first point included.
function samples(lines, step) {
  const out = [];
  for (const line of lines) {
    if (line.length === 1) out.push(line[0]);
    let walked = 0, next = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const d = haversineM(a, b);
      while (next <= walked + d) {
        const t = d ? (next - walked) / d : 0;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        next += step;
      }
      walked += d;
    }
  }
  return out;
}

const permille = (x, of) => (of > 0 ? Math.round((1000 * x) / of) : 0);

function summarize(lines) {
  const km = lines.reduce((s, l) => s + l.slice(1).reduce((t, p, i) => t + haversineM(l[i], p), 0), 0) / 1000;
  const step = Math.max(SAMPLE_M, (km * 1000) / MAX_SAMPLES);
  const cells = samples(lines, step).map(([lon, lat]) => cell(lon, lat)).filter(Boolean);
  if (!cells.length) return null;
  const n = cells.length;
  const relief = new Array(BINS.length).fill(0);
  const types = new Array(FOREST_TYPES).fill(0);
  let forest = 0, closed = 0, perennial = 0, seasonal = 0;
  const ranges = new Map();
  for (const c of cells) {
    let b = 0;
    while (b + 1 < BINS.length && c.relief >= BINS[b + 1]) b++;
    relief[b]++;
    for (let t = 0; t < FOREST_TYPES; t++) { types[t] += c.forest[t]; forest += c.forest[t]; }
    closed += c.forest[FOREST_TYPES];
    if (c.river === 2) perennial++;
    else if (c.river === 1) seasonal++;
    if (c.range) ranges.set(c.range, (ranges.get(c.range) ?? 0) + 1);
  }
  return {
    area: Math.round(km * 10) / 10,
    relief: relief.map((v) => permille(v, n)),
    forest: Math.round((forest / n) * 10),       // the cells hold 0–100
    closed: Math.round((closed / n) * 10),
    types: types.map((v) => permille(v, forest)),
    perennial: permille(perennial, n),
    seasonal: permille(seasonal, n),
    // Ranges it spends at least a tenth of its way in, the most first.
    ranges: [...ranges.entries()].filter(([, k]) => k >= n * 0.1).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id),
  };
}

// ── Range names ─────────────────────────────────────────────────────────────
// English from the GMBA table, Hebrew from the Wikidata names the build cached.

let gmbaCsv = null; // read once a run; save() asks after every country
function rangeNames(ids) {
  if (!ids.size) return {};
  gmbaCsv ??= readGmba();
  return namesFrom(gmbaCsv, ids);
}

function readGmba() {
  const shp = join(CACHE, 'gmba_basic/GMBA_Inventory_v2.0_standard_basic.shp');
  const env = { ...process.env, PATH: `${process.env.PATH}:/Applications/Postgres.app/Contents/Versions/latest/bin` };
  return execFileSync('ogr2ogr', ['-f', 'CSV', '/vsistdout/', shp, '-select', 'GMBA_V2_ID,MapName,Name_EN,WikiDataUR'], { env, maxBuffer: 1 << 28 }).toString();
}

function namesFrom(csv, ids) {
  const he = existsSync(join(CACHE, 'wikidata-he.json')) ? JSON.parse(readFileSync(join(CACHE, 'wikidata-he.json'), 'utf8')) : {};
  const out = {};
  for (const line of csv.split('\n').slice(1)) {
    const m = line.match(/^(\d+),("(?:[^"]|"")*"|[^,]*),("(?:[^"]|"")*"|[^,]*),(.*)$/);
    if (!m || !ids.has(Number(m[1]))) continue;
    const unq = (v) => v.replace(/^"|"$/g, '').replace(/""/g, '"');
    const q = m[4].match(/Q\d+/)?.[0];
    out[m[1]] = { en: unq(m[3]) || unq(m[2]), he: (q && he[q]) || null };
  }
  return out;
}

// ── Run ─────────────────────────────────────────────────────────────────────

const file = existsSync(OUT)
  ? JSON.parse(gunzipSync(readFileSync(OUT)).toString('utf8'))
  : { version: LANDSCAPE_VERSION, reliefBins: BINS, ranges: {}, countries: {} };
if (file.version !== LANDSCAPE_VERSION || String(file.reliefBins) !== String(BINS)) {
  console.log('stored trails were made with other bins or format — starting afresh');
  Object.assign(file, { version: LANDSCAPE_VERSION, reliefBins: BINS, ranges: {}, countries: {} });
}

// The file is written after every country, so a long run stopped halfway
// keeps what it did. It is read again just before, and only this country
// replaced: two runs at once (a round of the hiker metrics, and matching the
// saved pages again) would otherwise each write back their own countries over
// the other's.
function save(country) {
  // Without a country (the last write), what is on disk already holds this
  // run's countries, each saved as it was done.
  if (existsSync(OUT)) {
    const disk = JSON.parse(gunzipSync(readFileSync(OUT)).toString('utf8'));
    if (disk.version === file.version && String(disk.reliefBins) === String(file.reliefBins)) {
      file.countries = country ? { ...disk.countries, [country]: file.countries[country] } : disk.countries;
    }
  }
  const used = new Set(Object.values(file.countries).flatMap((c) => Object.values(c.trails).flatMap((t) => t.ranges)));
  file.ranges = rangeNames(used);
  const raw = Buffer.from(JSON.stringify(file));
  writeFileSync(`${OUT}.tmp`, gzipSync(raw, { level: 9 }));
  renameSync(`${OUT}.tmp`, OUT);
  return raw.length;
}

const BUILD_BUDGET_MS = 6 * 60_000;
const skip = args.includes('--skip-done');
for (const country of countries) {
  if (skip && file.countries[country]) { console.log(`${country}: done before — skipped`); continue; }
  let list = await storedCountryTrails(country);
  // A list the app built in its 40 seconds may be part of the country only
  // (Britain came out with 2 trails); from here there is time to read it whole.
  if (args.includes('--rebuild') || (args.includes('--build') && (!list || list.partial))) {
    console.log(`${country}: building its list${list ? ' again' : ''}…`);
    list = (await rebuildCountryTrails(country, BUILD_BUDGET_MS)) ?? list;
  }
  if (!list) { console.log(`${country}: no stored list — open the country in the app first, or pass --build`); continue; }
  const ids = list.trails.map((t) => t.id);
  console.log(`${country}: ${ids.length} trails, reading outlines…`);
  // A popular part of a long trail (negative id) is not a route of its own:
  // its line is the points kept along it (src/lib/trailCrowd/sections.ts).
  const found = await readByIds(country, ids.filter((id) => id > 0));
  if (ids.some((id) => id < 0)) {
    for (const s of await sectionsOfCountry(country)) found.set(s.id, { lines: [s.samples] });
  }
  const trails = {};
  let missing = 0;
  for (const id of ids) {
    const lines = found.get(id)?.lines;
    const s = lines?.length ? summarize(lines) : null;
    if (s) trails[id] = s;
    else missing++;
  }
  // A run that read too few outlines (Waymarked down) must not replace a good one.
  const had = Object.keys(file.countries[country]?.trails ?? {}).length;
  if (Object.keys(trails).length < Math.max(1, had * 0.8)) {
    console.log(`${country}: only ${Object.keys(trails).length} outlines read (had ${had}) — not saved`);
    continue;
  }
  file.countries[country] = { builtAt: new Date().toISOString().slice(0, 10), trails };
  console.log(`${country}: ${Object.keys(trails).length} trails${missing ? `, ${missing} without an outline` : ''}${list.partial ? ' (its list is still partial)' : ''}`);
  save(country);
}

const size = save();
const total = Object.values(file.countries).reduce((s, c) => s + Object.keys(c.trails).length, 0);
console.log(`→ ${OUT}: ${Object.keys(file.countries).length} countries, ${total} trails, ${(size / 1e3).toFixed(0)} KB raw`);
process.exit(0);
