// Burns shade and water figures for the bundled trails into public/trails.json.
//
// Kept apart from generateTrailIndex.js on purpose. That script is instant and
// offline; this one asks Overpass once per trail and takes minutes, and tying
// the two together would mean you could not re-index the trails without also
// hammering a free public service 83 times.
//
// Why precompute at all: without it, every trail a user opens costs an Overpass
// round-trip before it can say anything about water, and the search filters
// could not offer "shaded" or "near water" at all — those need the answer for
// every trail at once, before any of them is opened.
//
//   node scripts/buildSummerIndex.mjs                 # all trails, writes trails.json
//   node scripts/buildSummerIndex.mjs --only כזיב     # one trail, prints, writes nothing
//   node scripts/buildSummerIndex.mjs --shade-only    # no network at all
//   node scripts/buildSummerIndex.mjs --refetch       # ignore the resume cache
//
// Overpass fails often enough that it has to be planned for. A partial run
// would leave some trails with figures and others silently without, which in
// the UI is indistinguishable from "this trail has no water" — so trails.json
// is only rewritten when every trail succeeded. A single failure aborts the
// write and says which trail broke.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { readGreyscalePng } from './readCanopyPng.mjs';

register('./tsResolve.mjs', import.meta.url);
const { computeShade, computeWater, packBar } = await import('../src/lib/summerConditions.ts');
const { classifyWater } = await import('../src/lib/waterSources.ts');
const { getDistance } = await import('../src/utils/trailUtils.ts');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = argValue('--only');
const shadeOnly = process.argv.includes('--shade-only');
const DELAY_MS = 2500;          // courtesy gap between Overpass queries
// Overpass is a free service and a heavy `around` query over a 120-point
// polyline genuinely can take a minute. The first run of this script lost a
// trail to a 60s abort, so the client waits longer than the server is allowed
// to take, rather than cutting off a query that was about to answer.
const SERVER_TIMEOUT_S = 90;
const CLIENT_TIMEOUT_MS = 120_000;
const SEARCH_RADIUS_M = 250;    // must match src/app/api/water/route.ts
const GEOMETRY_SPACING_KM = 0.05;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

// ── canopy grid, same contract as src/lib/canopy.ts ──────────────────────────

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/canopy-il-100m.json'), 'utf8'));
const png = readGreyscalePng(fs.readFileSync(path.join(ROOT, 'public/data/canopy-il-100m.png')));
if (png.width !== meta.cols || png.height !== meta.rows) {
  throw new Error(`raster is ${png.width}x${png.height}, metadata says ${meta.cols}x${meta.rows}`);
}
const grid = {
  attribution: meta.attribution,
  sample(lat, lon) {
    const col = Math.floor((lon - meta.west) / meta.cellSize);
    const row = Math.floor((meta.north - lat) / meta.cellSize);
    if (col < 0 || col >= meta.cols || row < 0 || row >= meta.rows) return null;
    return png.data[row * meta.cols + col] / 255;
  },
};

// ── trail geometry ───────────────────────────────────────────────────────────

function readTrail(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const coords = [];
  for (const m of xml.matchAll(/<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/g)) {
    coords.push([parseFloat(m[1]), parseFloat(m[2]), 0]);
  }
  const acc = [0];
  for (let i = 1; i < coords.length; i++) {
    acc.push(acc[i - 1] + getDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  }
  return { coords, acc };
}

// ── water, via the same query the API route sends ────────────────────────────

async function overpass(query) {
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let lastError = null;
  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)',
          },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
        });
        if (res.ok) return res.json();
        lastError = new Error(`${endpoint} → HTTP ${res.status}`);
        // 429 and 504 are the two this actually hits; both are worth waiting out.
        if (res.status === 429 || res.status === 504) await sleep(15_000);
      } catch (e) {
        lastError = e;
      }
    }
  }
  throw lastError ?? new Error('Overpass unreachable');
}

function thin(geometry) {
  const out = [];
  let last = null;
  for (const g of geometry) {
    if (last && getDistance(last.lat, last.lon, g.lat, g.lon) < GEOMETRY_SPACING_KM) continue;
    out.push([g.lat, g.lon]);
    last = g;
  }
  const tail = geometry[geometry.length - 1];
  if (tail && (!out.length || out[out.length - 1][0] !== tail.lat)) out.push([tail.lat, tail.lon]);
  return out;
}

async function fetchWater(coords) {
  const step = Math.max(1, Math.ceil(coords.length / 120));
  const sampled = coords.filter((_, i) => i % step === 0).slice(0, 120);
  const poly = sampled.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(',');
  const around = `(around:${SEARCH_RADIUS_M},${poly})`;
  const data = await overpass(`[out:json][timeout:${SERVER_TIMEOUT_S}];
(
  way${around}[natural=water];
  node${around}[natural=spring];
  way${around}[natural=coastline];
)->.places;
way${around}[waterway~"^(stream|river)$"][name]->.lines;
.places out center 180;
.lines out geom 60;`);

  const sources = [];
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const props = classifyWater(tags);
    if (!props) continue;
    const geometry = Array.isArray(el.geometry) && el.geometry.length > 1 ? thin(el.geometry) : undefined;
    const lat = el.lat ?? el.center?.lat ?? geometry?.[0]?.[0];
    const lon = el.lon ?? el.center?.lon ?? geometry?.[0]?.[1];
    if (lat == null || lon == null) continue;
    sources.push({
      lat, lon,
      category: props.category,
      label: props.label,
      confident: props.confident,
      name: tags['name:he'] || tags.name || null,
      ...(geometry ? { geometry } : {}),
    });
  }
  return sources;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── run ──────────────────────────────────────────────────────────────────────

// A run over 83 trails takes minutes and Overpass fails part-way often enough
// that it has to be assumed. Successful answers are kept here so a re-run picks
// up where the last one stopped instead of asking for all 83 again. It is a
// build artifact, not data — delete it to force a fresh fetch.
const CACHE_FILE = path.join(ROOT, 'scripts/.summer-cache.json');
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
const refetch = process.argv.includes('--refetch');

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/trails.json'), 'utf8'));
const targets = only ? index.filter((t) => t.name.includes(only)) : index;
if (!targets.length) {
  console.error(only ? `No trail matches "${only}".` : 'trails.json is empty — run generateTrailIndex.js first.');
  process.exit(1);
}

console.log(`${targets.length} trail(s)${shadeOnly ? ', shade only' : ''}\n`);
const failures = [];
const rows = [];

for (const [i, trail] of targets.entries()) {
  const file = path.join(ROOT, 'public', trail.path);
  if (!fs.existsSync(file)) { failures.push(`${trail.name}: GPX missing at ${trail.path}`); continue; }

  const { coords, acc } = readTrail(file);
  const shade = computeShade(coords, acc, grid);

  let water = null;
  let fromCache = false;
  if (!shadeOnly) {
    // The cache key includes the point count so an edited GPX is re-fetched
    // rather than answered from a stale entry.
    const cacheKey = `${trail.id}|${coords.length}|r${SEARCH_RADIUS_M}`;
    try {
      let sources;
      if (!refetch && cache[cacheKey]) {
        sources = cache[cacheKey];
        fromCache = true;
      } else {
        sources = await fetchWater(coords);
        cache[cacheKey] = sources;
        saveCache();
      }
      water = computeWater(coords, acc, sources);
    } catch (e) {
      failures.push(`${trail.name}: ${e.message}`);
      console.log(`${String(i + 1).padStart(3)}/${targets.length}  ${trail.name}  — נכשל: ${e.message}`);
      await sleep(DELAY_MS);
      continue;
    }
  }

  // Only the summary figures and the points go into the index. The per-point
  // shade profile is thousands of numbers per trail and is recomputed from the
  // raster in a blink when the trail is actually opened.
  trail.summer = {
    shadePct: shade ? round(shade.shadePct, 1) : null,
    bands: shade ? { sun: round(shade.bands.sun, 1), partial: round(shade.bands.partial, 1), shade: round(shade.bands.shade, 1) } : null,
    ...(water ? {
      longestDryKm: round(water.longestDryKm, 2),
      nearWaterPct: round(water.nearWaterPct, 1),
      // 120 characters saying where along the trail the water is, so the app
      // can draw the strip without going near Overpass.
      waterBar: packBar(water.bar),
      waterPoints: water.points.map((p) => ({
        lat: round(p.lat, 5), lon: round(p.lon, 5),
        km: round(p.km, 2), offTrailM: p.offTrailM,
        category: p.category, label: p.label, confident: p.confident, counted: p.counted, name: p.name,
      })),
    } : {}),
  };

  rows.push({ name: trail.name, shade: trail.summer.shadePct, dry: trail.summer.longestDryKm, near: trail.summer.nearWaterPct, points: water?.points ?? [] });
  console.log(
    `${String(i + 1).padStart(3)}/${targets.length}  ${trail.name.slice(0, 34).padEnd(35)}` +
    `צל ${String(trail.summer.shadePct ?? '—').padStart(5)}%` +
    (water ? `   יבש ${String(trail.summer.longestDryKm).padStart(5)} ק״מ   ליד מים ${String(trail.summer.nearWaterPct).padStart(5)}%   ${water.points.length} מקורות${fromCache ? '  (cache)' : ''}` : '')
  );

  // Only a real fetch owes Overpass a pause.
  if (!shadeOnly && !fromCache && i < targets.length - 1) await sleep(DELAY_MS);
}

// Every water source that survived the filter, for the review-by-eye pass.
if (!shadeOnly) {
  const seen = new Map();
  for (const r of rows) for (const p of r.points) {
    const key = `${p.category}|${p.name ?? '—'}`;
    if (!seen.has(key)) seen.set(key, { ...p, trails: [] });
    seen.get(key).trails.push(r.name);
  }
  console.log(`\n=== כל מקורות המים שעברו את הסינון (${seen.size} ייחודיים) — לעבור בעין ===`);
  for (const s of [...seen.values()].sort((a, b) => a.category.localeCompare(b.category))) {
    console.log(`  ${s.category.padEnd(17)} ${(s.name ?? '(ללא שם)').padEnd(26)} ${s.confident ? '   ' : '(?)'} ← ${s.trails.slice(0, 3).join(', ')}`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} מסלולים נכשלו — trails.json לא נכתב:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}

if (only || shadeOnly) {
  console.log(`\n${only ? '--only' : '--shade-only'}: trails.json לא נכתב.`);
} else {
  fs.writeFileSync(path.join(ROOT, 'public/trails.json'), JSON.stringify(index, null, 2));
  console.log(`\nנכתבו נתוני קיץ ל-${rows.length} מסלולים ב-public/trails.json`);
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
