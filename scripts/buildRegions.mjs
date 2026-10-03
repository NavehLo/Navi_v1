// Builds src/data/regions.json.gz: the areas inside each country that the
// world-trail lists are grouped by (src/lib/regions.ts reads it).
//
// Source: Natural Earth's states and provinces (1:10m, public domain), which
// carries Hebrew names (name_he) for almost every one. Where a country has
// more than MAX_UNITS of them — Italy's 110 provinces, France's 101
// departments, Britain's 232 districts — they are grouped by Natural Earth's
// own `region` (Italy's 20 regions, France's 18) when there are at least six
// of those — four for all of the United States says nothing, so its states
// stay. Grouped areas have no Hebrew name and
// is shown as written. Each area also gets a compass word (צפון, דרום-מערב,
// מרכז…) for where it lies in its country, which helps more than a name one
// has never heard of.
//
// The outlines are simplified to about a kilometre: they only decide which
// area a trail's few sample points fall in.
//
//   node scripts/buildRegions.mjs [path to ne_10m_admin_1_states_provinces.geojson]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/data/regions.json.gz');
const SRC_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';
const MAX_UNITS = 30;
const TOLERANCE = 0.01;      // degrees, ~1 km
const MIN_RING_AREA = 0.0004; // deg²; smaller islands go unless they are all there is

async function source() {
  const given = process.argv[2];
  if (given) return JSON.parse(readFileSync(given, 'utf8'));
  const cached = join(tmpdir(), 'ne_10m_admin_1.geojson');
  if (!existsSync(cached)) {
    console.log('downloading Natural Earth admin-1…');
    const res = await fetch(SRC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(cached, 'utf8'));
}

// ── Geometry ────────────────────────────────────────────────────────────────

function simplify(points, tol) {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worstD > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// A ring starts and ends on the same point, which leaves Douglas–Peucker no
// line to measure from; it is simplified as two halves instead.
function simplifyRing(ring, tol) {
  if (ring.length < 8) return ring;
  const mid = Math.floor(ring.length / 2);
  return [...simplify(ring.slice(0, mid + 1), tol).slice(0, -1), ...simplify(ring.slice(mid), tol)];
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(s / 2);
}

function rings(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.flat();
}

const round = (v) => Math.round(v * 1000) / 1000;

function packRings(all) {
  const simplified = all
    .map((r) => simplifyRing(r, TOLERANCE))
    .filter((r) => r.length >= 4)
    .map((r) => ({ r, a: ringArea(r) }));
  if (simplified.length === 0) return [];
  const big = simplified.filter((x) => x.a >= MIN_RING_AREA);
  const chosen = big.length ? big : [simplified.sort((a, b) => b.a - a.a)[0]];
  // Flat [lon, lat, lon, lat, …] — half the size of nested pairs.
  return chosen.map(({ r }) => r.flatMap(([x, y]) => [round(x), round(y)]));
}

function bboxOf(flatRings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of flatRings) for (let i = 0; i < r.length; i += 2) {
    if (r[i] < b[0]) b[0] = r[i];
    if (r[i + 1] < b[1]) b[1] = r[i + 1];
    if (r[i] > b[2]) b[2] = r[i];
    if (r[i + 1] > b[3]) b[3] = r[i + 1];
  }
  return b.map(round);
}

// ── Compass ─────────────────────────────────────────────────────────────────

// The middle of a country and its spread, from its areas' centres weighted by
// size — so a far-off island territory moves neither.
function weightedQuantile(items, key, q) {
  const sorted = [...items].sort((a, b) => a[key] - b[key]);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) { acc += x.w; if (acc >= q * total) return x[key]; }
  return sorted[sorted.length - 1][key];
}

function compass(units) {
  if (units.length < 2) return units.map(() => '');
  const all = units.map((u) => ({ lon: u.c[0], lat: u.c[1], w: Math.max(1, u.area) }));
  // Territories across an ocean (French Guiana, the Canaries) are left out of
  // the country's middle and spread, and get no compass word of their own.
  const mx = weightedQuantile(all, 'lon', 0.5), my = weightedQuantile(all, 'lat', 0.5);
  const spreadX = weightedQuantile(all, 'lon', 0.75) - weightedQuantile(all, 'lon', 0.25);
  const spreadY = weightedQuantile(all, 'lat', 0.75) - weightedQuantile(all, 'lat', 0.25);
  const far = (x) => Math.abs(x.lon - mx) > Math.max(12, 3 * spreadX) || Math.abs(x.lat - my) > Math.max(12, 3 * spreadY);
  const items = all.filter((x) => !far(x));
  const cx = weightedQuantile(items, 'lon', 0.5), cy = weightedQuantile(items, 'lat', 0.5);
  const halfW = Math.max(0.3, (weightedQuantile(items, 'lon', 0.95) - weightedQuantile(items, 'lon', 0.05)) / 2);
  const halfH = Math.max(0.3, (weightedQuantile(items, 'lat', 0.95) - weightedQuantile(items, 'lat', 0.05)) / 2);
  return units.map((u, i) => {
    if (far(all[i])) return '';
    const dx = (u.c[0] - cx) / halfW, dy = (u.c[1] - cy) / halfH;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) return ''; // overseas
    const ns = dy > 0.35 ? 'צפון' : dy < -0.35 ? 'דרום' : '';
    const ew = dx > 0.35 ? 'מזרח' : dx < -0.35 ? 'מערב' : '';
    return ns && ew ? `${ns}-${ew}` : ns || ew || 'מרכז';
  });
}

// ── Building ────────────────────────────────────────────────────────────────

const geo = await source();
const byCountry = new Map();
for (const f of geo.features) {
  const code = f.properties.iso_a2;
  if (!/^[A-Z]{2}$/.test(code ?? '')) continue;
  if (!byCountry.has(code)) byCountry.set(code, []);
  byCountry.get(code).push(f);
}

const out = { version: 1, source: 'Natural Earth 1:10m admin-1 (public domain)', countries: {} };
let unitCount = 0;
for (const [code, features] of byCountry) {
  const regions = features.map((f) => f.properties.region).filter(Boolean);
  const distinct = new Set(regions);
  const grouped = features.length > MAX_UNITS && distinct.size >= 6 && distinct.size <= MAX_UNITS && regions.length >= features.length * 0.9;

  const groups = new Map();
  for (const f of features) {
    const p = f.properties;
    const key = grouped ? (p.region || p.name) : p.adm1_code;
    if (!groups.has(key)) groups.set(key, { members: [], key });
    groups.get(key).members.push(f);
  }

  const units = [...groups.values()].map(({ members, key }) => {
    const p = members[0].properties;
    const polys = packRings(members.flatMap((m) => rings(m.geometry)));
    const area = members.reduce((s, m) => s + (m.properties.area_sqkm || 0), 0);
    const w = members.map((m) => Math.max(1, m.properties.area_sqkm || 1));
    const wsum = w.reduce((a, b) => a + b, 0);
    const c = [
      round(members.reduce((s, m, i) => s + (m.properties.longitude ?? 0) * w[i], 0) / wsum),
      round(members.reduce((s, m, i) => s + (m.properties.latitude ?? 0) * w[i], 0) / wsum),
    ];
    const name = grouped ? key : (p.name_he || p.name_en || p.name);
    const latin = grouped ? null : (p.name_en || p.name || null);
    return { id: grouped ? `${code}:${key}` : p.adm1_code, name, latin: latin && latin !== name ? latin : null, c, area, polys };
  }).filter((u) => u.polys.length > 0);

  const dirs = compass(units);
  out.countries[code] = {
    grouped,
    units: units.map((u, i) => ({ id: u.id, name: u.name, latin: u.latin, dir: dirs[i], c: u.c, bbox: bboxOf(u.polys), polys: u.polys })),
  };
  unitCount += units.length;
}

mkdirSync(dirname(OUT), { recursive: true });
const json = Buffer.from(JSON.stringify(out));
const gz = gzipSync(json, { level: 9 });
writeFileSync(OUT, gz);
console.log(`${Object.keys(out.countries).length} countries, ${unitCount} areas — ${(json.length / 1e6).toFixed(1)} MB raw, ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
for (const c of ['IT', 'CH', 'FR', 'GB', 'IL', 'US']) {
  const k = out.countries[c];
  console.log(c, k.grouped ? '(grouped)' : '', k.units.slice(0, 6).map((u) => `${u.name}${u.dir ? ` · ${u.dir}` : ''}`).join(' | '));
}
