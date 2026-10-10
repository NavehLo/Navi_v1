// What "מה אומרים מטיילים" has collected so far, and what is left — for the
// owner, in the terminal. Reads only.
//
//   node scripts/crowdStatus.mjs
//   node scripts/crowdStatus.mjs --collected    # only the codes collected (for crowdRound.sh)
//
//   1. the countries collected: trails, how many with Komoot's numbers, with
//      a rating, and when — and what a round (crowdRound.sh) is collecting now
//   2. still to collect: where Komoot covers the country well, fairly or
//      weakly — something is better than nothing
//   3. not worth collecting: where Komoot is almost absent
//
// How well Komoot covers a country comes from scripts/komootCoverage.json
// (scripts/measureKomootCoverage.mjs): the hikers of the ten routes on the
// country's own page on Komoot. Order within each part: the owner's
// (scripts/countryGroups.mjs).
//
// Needs in .env.local: SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL.

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

import { existsSync, readFileSync, readdirSync } from 'node:fs';

const { serviceClient } = await import('../src/lib/supabaseService.ts');
const { CROWD_VERSION, komootOf } = await import('../src/lib/trailCrowd/score.ts');
const { countryEnglish } = await import('../src/lib/trailInfo/sources.ts');
const { GROUPS } = await import('./countryGroups.mjs');

const CONTINENT = {
  europe: 'Europe', latam: 'Latin America', asia: 'Asia', 'north-america': 'North America',
  africa: 'Africa', oceania: 'Oceania',
};
const continentOf = new Map(Object.entries(GROUPS).flatMap(([g, codes]) => codes.map((cc) => [cc, CONTINENT[g] ?? g])));
const order = Object.values(GROUPS).flat();

// Komoot's coverage: hikers of the ten routes on the country's page.
const COVERAGE_FILE = new URL('./komootCoverage.json', import.meta.url);
const coverage = existsSync(COVERAGE_FILE) ? JSON.parse(readFileSync(COVERAGE_FILE, 'utf8')) : null;
const TIERS = [[30_000, 'good'], [8_000, 'fair'], [2_000, 'weak'], [0, 'almost none']];
function tierOf(cc) {
  const c = coverage?.countries[cc];
  if (!c) return null;
  if (!c.page) return 'almost none';
  return TIERS.find(([min]) => c.hikers >= min)[1];
}

const db = serviceClient();
if (!db) { console.error('no database key in .env.local'); process.exit(1); }
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('trail_crowd').select('country, sources, fetched_at')
    .eq('crowd_version', CROWD_VERSION).order('country').order('trail_id').range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...data);
  if (data.length < 1000) break;
}
const by = new Map();
for (const r of rows) {
  const c = by.get(r.country) ?? { trails: 0, komoot: 0, rated: 0, at: '' };
  c.trails++;
  const k = komootOf(r.sources ?? []);
  if (k) c.komoot++;
  if (k?.rating != null) c.rated++;
  if (r.fetched_at > c.at) c.at = r.fetched_at;
  by.set(r.country, c);
}

if (process.argv.includes('--collected')) {
  console.log([...by.keys()].join(' '));
  process.exit(0);
}

// What the rounds running now are collecting (crowdRound.sh writes
// logs/running-<pid>.txt, and removes it when it ends).
const running = new Set();
const LOGS = new URL('../logs/', import.meta.url);
for (const f of existsSync(LOGS) ? readdirSync(LOGS) : []) {
  const pid = /^running-(\d+)\.txt$/.exec(f)?.[1];
  if (!pid) continue;
  try { process.kill(Number(pid), 0); } catch { continue; } // a round that died without cleaning up
  for (const cc of readFileSync(new URL(f, LOGS), 'utf8').split(/\s+/).filter(Boolean)) running.add(cc);
}

const rank = (cc) => (order.indexOf(cc) + 1) || 999;
const name = (cc) => countryEnglish(cc).slice(0, 22).padEnd(22);
const cont = (cc) => (continentOf.get(cc) ?? '').padEnd(14);
const num = (n, w) => String(n).padStart(w);

// ── 1. Collected ─────────────────────────────────────────────────────────────
const done = [...by.keys()].sort((a, b) => rank(a) - rank(b));
console.log(`\n1. COLLECTED — ${done.length} countries\n`);
console.log(`   ${'country'.padEnd(25)} ${'continent'.padEnd(14)} trails  Komoot  rated  collected`);
for (const cc of done) {
  const c = by.get(cc);
  console.log(`   ${cc} ${name(cc)} ${cont(cc)} ${num(c.trails, 6)} ${num(c.komoot, 7)} ${num(c.rated, 6)}  ${c.at.slice(0, 10)}`);
}
const total = (k) => [...by.values()].reduce((n, c) => n + c[k], 0);
console.log(`\n   ${total('komoot')} trails with Komoot's numbers (${total('rated')} rated), ${total('trails')} trails in all`);
const runningNow = [...running].filter((cc) => !by.has(cc));
if (runningNow.length) console.log(`   being collected now: ${runningNow.map((cc) => `${cc} ${countryEnglish(cc)}`).join(', ')}`);

// ── 2 and 3. Still to collect ────────────────────────────────────────────────
const left = order.filter((cc) => !by.has(cc) && !running.has(cc));
const line = (cc) => {
  const c = coverage?.countries[cc];
  const t = tierOf(cc);
  return `   ${cc} ${name(cc)} ${cont(cc)} ${(t ?? 'not measured').padEnd(12)} ${c ? num(c.hikers.toLocaleString('en'), 8) : ''}`;
};
const header = `   ${'country'.padEnd(25)} ${'continent'.padEnd(14)} ${'Komoot'.padEnd(12)} hikers*`;
const worth = left.filter((cc) => tierOf(cc) !== 'almost none');
const thin = left.filter((cc) => tierOf(cc) === 'almost none');

console.log(`\n2. TO COLLECT — Komoot covers them well, fairly or weakly (${worth.length}), in order:\n`);
console.log(header);
for (const cc of worth) console.log(line(cc));
if (worth.length) console.log(`\n   next round: scripts/crowdRound.sh ${worth.slice(0, 4).join(' ')}`);

console.log(`\n3. NOT WORTH COLLECTING — Komoot is almost absent (${thin.length}); Wikipedia's reads still rate the famous treks:\n`);
console.log(header);
for (const cc of thin) console.log(line(cc));

console.log(`\n* hikers of the ten routes on the country's own Komoot page — good ≥ 30,000, fair ≥ 8,000, weak ≥ 2,000.`);
console.log(coverage
  ? `  Measured ${coverage.measuredAt} (node scripts/measureKomootCoverage.mjs). For scale: Italy 118,000, Austria 79,000, Albania 27,000.`
  : '  Not measured yet: node scripts/measureKomootCoverage.mjs');
process.exit(0);
