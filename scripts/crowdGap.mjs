// How much of "מה אומרים מטיילים" never reaches a country's list, and why.
// Reads only: nothing is written to the database, and no paid search is made.
//
//   node scripts/crowdGap.mjs                 # every country with a saved dump
//   node scripts/crowdGap.mjs AL ME           # some
//   node scripts/crowdGap.mjs AL --overpass-all
//   node scripts/crowdGap.mjs --no-overpass   # leave group 3 unchecked (Overpass busy)
//
// The routes come from the pages saved by collectCrowd.mjs (CROWD_DUMP, or
// --dump-only) in ~/.cache/navi-komoot/dumps/crowd-<CC>.json — Komoot's lines
// are kept on this Mac only, never in the repository or the database. The
// list is the country's stored one (never rebuilt here).
//
// Every distinct Komoot route in the country goes into one group:
//   matched        on a trail of the list, and its most walked route
//   shadowed       on a trail of the list that a busier route took
//   1a discover    a marked trail not in the list, found by discover.ts today
//   1b probes      one that only more probes along the route find
//   1c int         only an international path fits (left out of every list)
//   1d stage       on a trail too long for it, but one of its stages fits
//   2  long        on a marked trail far longer than itself, no stage fits
//   2  partial     40–60% of it on a trail of the list
//   3  osm         no marked trail; ≥90% of it on OSM's ways (Overpass)
//   3  off         no marked trail; less of it on OSM's ways
//   3  unchecked   no marked trail; not asked of Overpass (beyond --top)
//
// Free services, gently: Waymarked as the collection does; Overpass one
// request at a time, two seconds apart, backing off on 429/504, every answer
// kept in ~/.cache/navi-komoot/overpass so a second run asks nothing.

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const { iso1A2Code } = await import('@rapideditor/country-coder');
const { storedCountryTrails } = await import('../src/lib/countryTrails.ts');
const { trailLines, trailLinesOf, trailsOf, routeKm } = await import('../src/lib/trailCrowd/match.ts');
const { discoverTrails } = await import('../src/lib/trailCrowd/discover.ts');
const { fetchWmt } = await import('../src/lib/wmtServer.ts');
const { lonLatToMercator } = await import('../src/lib/waymarked.ts');
const { sectionsOfCountry } = await import('../src/lib/trailCrowd/sections.ts');

const DUMPS = join(homedir(), '.cache/navi-komoot/dumps');
const OVERPASS_CACHE = join(homedir(), '.cache/navi-komoot/overpass');
mkdirSync(OVERPASS_CACHE, { recursive: true });
mkdirSync('logs', { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const TOP = Number(flag('--top', '40'));
const OVERPASS_ALL = args.includes('--overpass-all');
const NO_OVERPASS = args.includes('--no-overpass');
let countries = args.filter((a, i) => /^[A-Za-z]{2}$/.test(a) && args[i - 1] !== '--top').map((a) => a.toUpperCase());
if (!countries.length) countries = readdirSync(DUMPS).map((f) => /^crowd-([A-Z]{2})\.json$/.exec(f)?.[1]).filter(Boolean);

const LOG = `logs/crowd-gap-${new Date().toISOString().slice(0, 10)}.log`;
const log = (...a) => { const s = a.join(' '); console.log(s); appendFileSync(LOG, s + '\n'); };

// The rules of match.ts, spelled out so each can be told apart.
const NEAR_M = 150, MIN_SHARE = 0.6, LONGER_FACTOR = 5;
const PROBE = 0.01, PROBES = 8, OUTLINE_PAD = 0.3;
const OSM_NEAR_M = 40;

function distanceTo(lat, lon, lines) {
  const ky = 111_320, kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - lon) * kx, ay = (line[i - 1][1] - lat) * ky;
      const bx = (line[i][0] - lon) * kx, by = (line[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function bboxOf(points, pad) {
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  return [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
}

// Share of the route's points within NEAR_M of a trail.
function shareOn(r, t) {
  const [w, s, e, n] = bboxOf(r.points, 0.003);
  if (t.bbox[0] > e || t.bbox[2] < w || t.bbox[1] > n || t.bbox[3] < s) return 0;
  let on = 0;
  for (const [lat, lon] of r.points) if (distanceTo(lat, lon, t.lines) <= NEAR_M) on++;
  return on / r.points.length;
}

function mbox(w, s, e, n) {
  const [x0, y0] = lonLatToMercator(w, Math.max(-85, s));
  const [x1, y1] = lonLatToMercator(e, Math.min(85, n));
  return [x0, y0, x1, y1].map((v) => v.toFixed(0)).join(',');
}

// The marked trails near a route — every group, the list's or not — from
// PROBES small squares along it and its farthest point from the start.
const probeMemo = new Map();
async function probeAround(r) {
  const pts = r.points;
  const at = Array.from({ length: PROBES }, (_, i) => pts[Math.floor(((i + 0.5) * pts.length) / PROBES)]);
  const far = pts.reduce((a, p) => (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > Math.hypot(a[0] - pts[0][0], a[1] - pts[0][1]) ? p : a));
  at.push(far);
  const summaries = new Map();
  for (const [lat, lon] of at) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    let found = probeMemo.get(key);
    if (!found) {
      const res = await fetchWmt(`/list/by_area?bbox=${mbox(lon - PROBE, lat - PROBE, lon + PROBE, lat + PROBE)}&limit=100`, 15_000, false);
      found = res?.results ?? [];
      probeMemo.set(key, found);
    }
    for (const s of found) summaries.set(s.id, s);
  }
  return summaries;
}

async function outlines(ids, points) {
  const out = [];
  const list = [...ids];
  const [w, s, e, n] = bboxOf(points, OUTLINE_PAD);
  for (let i = 0; i < list.length; i += 40) {
    const res = await fetchWmt(`/list/segments?bbox=${mbox(w, s, e, n)}&relations=${list.slice(i, i + 40).join(',')}`, 30_000, false);
    for (const f of res?.features ?? []) {
      const t = f.geometry && trailLinesOf(Number(f.id), f.geometry, null);
      if (t) out.push(t);
    }
  }
  return out;
}

// A stage of a long trail that the route fits, by the rules of match.ts.
async function fittingStage(r, longTrail) {
  const d = await fetchWmt(`/details/relation/${longTrail.id}`, 30_000, false);
  const ids = Object.keys(d?.subroutes ?? {}).map(Number);
  if (!ids.length) return null;
  const stages = await outlines(ids, r.points);
  const fits = trailsOf(r, stages);
  return fits.length ? stages.find((t) => t.id === fits[0]) : null;
}

// ── Overpass ────────────────────────────────────────────────────────────────

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.openstreetmap.fr/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let lastOverpass = 0;

// One Overpass request at a time, whatever the number of workers.
let overpassQueue = Promise.resolve();
function osmWays(r) {
  const run = overpassQueue.then(() => osmWaysNow(r));
  overpassQueue = run.catch(() => null);
  return run;
}

// Overpass refusing three routes in a row is down: the rest of the run does
// not wait on it (group 3 stays unchecked).
let overpassFailures = 0;

async function osmWaysNow(r) {
  if (overpassFailures >= 3) return null;
  const [w, s, e, n] = bboxOf(r.points, 0.001);
  const q = `[out:json][timeout:90];way[highway](${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)});out geom qt;`;
  const file = join(OVERPASS_CACHE, createHash('sha1').update(q).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastOverpass + 2000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastOverpass = Date.now();
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        headers: { 'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)' },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status === 504 || res.status >= 500) {
        await sleep(Math.min(60_000, 10_000 * 2 ** attempt));
        continue;
      }
      // A mirror that refuses us (403) is not asked again this time.
      if (!res.ok) continue;
      const body = await res.json();
      const lines = (body.elements ?? []).filter((x) => x.geometry).map((x) => x.geometry.map((g) => [g.lon, g.lat]));
      writeFileSync(file, JSON.stringify(lines));
      overpassFailures = 0;
      return lines;
    } catch {
      await sleep(Math.min(60_000, 10_000 * 2 ** attempt));
    }
  }
  if (++overpassFailures === 3) console.log('  Overpass is not answering — the rest of the run goes without it');
  return null;
}

// ── One country ─────────────────────────────────────────────────────────────

const GROUPS = ['matched', 'shadowed', '1a discover', '1b probes', '1c int', '1d stage', '2 long', '2 partial', '3 osm', '3 off', '3 unchecked'];
const total = Object.fromEntries(GROUPS.map((g) => [g, { routes: 0, hikers: 0 }]));
let totalHikers = 0;

for (const cc of countries) {
  const file = join(DUMPS, `crowd-${cc}.json`);
  if (!existsSync(file)) { log(`${cc}: no dump in ${DUMPS}`); continue; }
  const list = await storedCountryTrails(cc);
  if (!list) { log(`${cc}: no stored list (out of date?) — skipped`); continue; }
  const { routes: all } = JSON.parse(readFileSync(file, 'utf8'));
  const seen = new Set();
  const routes = [];
  for (const r of all) {
    const key = r.points.map((p) => p.join(',')).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.points.some(([lat, lon], i) => i % 10 === 0 && iso1A2Code([lon, lat]) === cc)) routes.push(r);
  }
  routes.sort((a, b) => b.hikers - a.hikers);
  log(`\n${cc}: ${routes.length} routes in the country, ${list.trails.length} trails in the list`);
  // The popular parts of long trails (sections.ts) are trails of the list too:
  // a route along one counts as matched. Their line is the points kept along it.
  const lines = [
    ...(await trailLines(list.trails.filter((t) => t.id > 0))),
    ...(await sectionsOfCountry(cc)).map((s) => trailLinesOf(s.id, { type: 'LineString', coordinates: s.samples.map(([lon, lat]) => lonLatToMercator(lon, lat)) }, s.km)).filter(Boolean),
  ];
  const known = new Set(list.trails.map((t) => t.id));

  // matched / shadowed: each trail keeps its most walked route.
  const best = new Map();
  const onList = new Map();
  for (const r of routes) {
    const on = trailsOf(r, lines);
    onList.set(r, on);
    for (const id of on) if ((best.get(id)?.hikers ?? -1) < r.hikers) best.set(id, r);
  }

  const rows = [];
  let overpassAsked = 0;
  // Routes four at a time; the most walked first, so --top is the busiest.
  let next = 0;
  const worker = async () => {
  while (next < routes.length) {
    const r = routes[next++];
    let group, why = '';
    const on = onList.get(r);
    if (on.length) {
      group = on.some((id) => best.get(id) === r) ? 'matched' : 'shadowed';
    } else {
      // What discover.ts finds today.
      const today = await discoverTrails([r], known);
      if (today.length && trailsOf(r, today).length) {
        group = '1a discover';
        why = today.map((t) => t.id).join(',');
      } else {
        const near = await probeAround(r);
        const candidates = await outlines([...near.keys()].filter((id) => !known.has(id)), r.points);
        const groupOf = new Map([...near.values()].map((s) => [s.id, s.group]));
        const fit = trailsOf(r, candidates);
        const local = fit.filter((id) => groupOf.get(id) !== 'INT');
        const length = routeKm(r);
        // Every marked trail it runs along (≥60%), the list's and the others.
        const along = [...lines, ...candidates].map((t) => ({ t, share: shareOn(r, t) })).filter((x) => x.share >= MIN_SHARE);
        const tooLong = along.filter((x) => x.t.km > length * LONGER_FACTOR).sort((a, b) => a.t.km - b.t.km);
        if (local.length) {
          group = '1b probes';
          why = local.join(',');
        } else {
          let stage = null;
          for (const x of tooLong.slice(0, 3)) if ((stage = await fittingStage(r, x.t))) break;
          if (stage) {
            group = '1d stage';
            why = `stage ${stage.id} of ${tooLong[0].t.id}`;
          } else if (tooLong.length) {
            group = '2 long';
            why = `${tooLong[0].t.id}${known.has(tooLong[0].t.id) ? ' (in list)' : ''} ${Math.round(tooLong[0].t.km)} km vs ${Math.round(length)} km`;
          } else if (fit.length) {
            group = '1c int';
            why = fit.join(',');
          } else {
            const partial = lines.map((t) => ({ t, share: shareOn(r, t) })).sort((a, b) => b.share - a.share)[0];
            if (partial && partial.share >= 0.4) {
              group = '2 partial';
              why = `${partial.t.id} ${Math.round(partial.share * 100)}%`;
            } else if (!NO_OVERPASS && (OVERPASS_ALL || overpassAsked < TOP)) {
              overpassAsked++;
              const ways = await osmWays(r);
              if (!ways) { group = '3 unchecked'; why = 'Overpass did not answer'; }
              else {
                const onOsm = r.points.filter(([lat, lon]) => distanceTo(lat, lon, ways) <= OSM_NEAR_M).length / r.points.length;
                group = onOsm >= 0.9 ? '3 osm' : '3 off';
                why = `${Math.round(onOsm * 100)}% on OSM ways`;
              }
            } else {
              group = '3 unchecked';
            }
          }
        }
      }
    }
    rows.push({ r, group, why });
    if (rows.length % 25 === 0) console.log(`  ${cc}: ${rows.length}/${routes.length}`);
  }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  rows.sort((a, b) => b.r.hikers - a.r.hikers);
  process.stdout.write('\n');

  const sum = routes.reduce((n, r) => n + r.hikers, 0);
  totalHikers += sum;
  log(`${cc}: ${sum.toLocaleString('en')} hikers in all`);
  for (const g of GROUPS) {
    const these = rows.filter((x) => x.group === g);
    if (!these.length) continue;
    const h = these.reduce((n, x) => n + x.r.hikers, 0);
    total[g].routes += these.length;
    total[g].hikers += h;
    log(`  ${g.padEnd(12)} ${String(these.length).padStart(4)} routes ${String(h).padStart(8)} hikers ${String(Math.round((100 * h) / sum)).padStart(3)}%`);
  }
  for (const g of GROUPS.filter((g) => g !== 'matched')) {
    const these = rows.filter((x) => x.group === g).slice(0, 10);
    if (!these.length) continue;
    log(`  — ${g}:`);
    for (const x of these) log(`     ${String(x.r.hikers).padStart(6)}  ${x.r.name.slice(0, 70)}  ${x.why}`);
  }
}

log(`\nALL (${countries.join(' ')}): ${totalHikers.toLocaleString('en')} hikers`);
for (const g of GROUPS) {
  const t = total[g];
  if (!t.routes) continue;
  log(`  ${g.padEnd(12)} ${String(t.routes).padStart(5)} routes ${String(t.hikers).padStart(9)} hikers ${String(Math.round((100 * t.hikers) / totalHikers)).padStart(3)}%`);
}
process.exit(0);
