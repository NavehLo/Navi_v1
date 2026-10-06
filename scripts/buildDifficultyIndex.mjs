// Burns "רמת קושי" (lib/difficulty.ts) and the total climb of each bundled
// trail into public/trails.json, so the list can show and filter by it
// before any trail is opened.
//
// Offline and instant: every bundled GPX carries its heights. The figures are
// made exactly as the trail card makes them once the trail is open — the same
// points (parseGPX: track, else route, else waypoints; a missing height is
// 0), the same distance (getDistance), the same climb (computeElevationGain,
// with its 5 m hysteresis, and none at all for a flat file) and the same
// formula (difficultyFromClimb) — so the list and the card cannot disagree.
//
//   node scripts/buildDifficultyIndex.mjs
//
// Run it after generateTrailIndex.js, which rewrites trails.json from
// scratch. buildSummerIndex.mjs keeps these fields.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./tsResolve.mjs', import.meta.url);
const { getDistance, computeElevationGain } = await import('../src/utils/trailUtils.ts');
const { difficultyFromClimb, DIFFICULTY_LABELS } = await import('../src/lib/difficulty.ts');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'public/trails.json');

function points(xml) {
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
    const out = [];
    for (const m of xml.matchAll(re)) {
      const lat = parseFloat(/\blat="([^"]+)"/.exec(m[1])?.[1] ?? '0');
      const lon = parseFloat(/\blon="([^"]+)"/.exec(m[1])?.[1] ?? '0');
      const eleText = /<ele>([^<]*)<\/ele>/.exec(m[2] ?? '')?.[1];
      const ele = eleText ? parseFloat(eleText) : 0;
      if (!isNaN(lat) && !isNaN(lon)) out.push([lat, lon, ele]);
    }
    if (out.length) return out;
  }
  return [];
}

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const tally = {};
for (const t of index) {
  const coords = points(fs.readFileSync(path.join(ROOT, 'public', decodeURIComponent(t.path)), 'utf8'));
  if (coords.length < 2) throw new Error(`${t.name}: no points`);
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += getDistance(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  const eles = coords.map((c) => c[2]);
  const flat = Math.max(...eles) <= Math.min(...eles);
  const { gain, loss } = flat ? { gain: 0, loss: 0 } : computeElevationGain(eles);
  t.gain = Math.round(gain);
  t.difficulty = difficultyFromClimb(km, gain, loss);
  tally[t.difficulty] = (tally[t.difficulty] ?? 0) + 1;
}
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));
console.log(`רמת קושי ל-${index.length} מסלולים: ` + Object.entries(tally).map(([d, n]) => `${DIFFICULTY_LABELS[d]} ${n}`).join(', '));
