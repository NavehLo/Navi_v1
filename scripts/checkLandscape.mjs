// Checks "הרים, יער ונהרות" against countries and areas whose landscape
// anybody who walks knows: the Alps, the Netherlands, Finland's forests,
// Epirus, Israel. Runs the real summaries (src/data/landscape.json.gz) through
// the real rules (src/lib/landscape.ts) and prints each one's line, so a
// change to a threshold can be seen for what it does everywhere at once.
//
//   node scripts/checkLandscape.mjs

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const L = await import('../src/lib/landscape.ts');
const data = JSON.parse(gunzipSync(readFileSync(new URL('../src/data/landscape.json.gz', import.meta.url))).toString('utf8'));
const bins = data.reliefBins;

let failed = 0;
const fail = (msg) => { failed++; console.log(`FAIL  ${msg}`); };

// Every relief threshold must be a stored bin edge, or shareAtLeast would
// silently count a different line.
for (const [level, m] of Object.entries(L.RELIEF_FROM)) {
  if (!bins.includes(m)) fail(`RELIEF_FROM.${level} = ${m} is not one of the stored bins ${bins.join(',')}`);
}
if (data.version !== L.LANDSCAPE_VERSION) fail(`file is format ${data.version}, landscape.ts expects ${L.LANDSCAPE_VERSION}`);

// [name, country, area id or null, expectations]
//   relief: [lowest, highest] level allowed
//   forested: true/false; types: forest types that must be named
//   perennial / any: [lowest, highest] water tier ('few' < 'some' < 'many')
const RELIEF = L.RELIEF_ORDER;
const WATER = ['few', 'some', 'many'];
const CASES = [
  ['שווייץ', 'CH', null, { relief: ['veryDramatic', 'veryDramatic'], forested: true, perennial: ['many', 'many'] }],
  ['אוסטריה', 'AT', null, { relief: ['veryDramatic', 'veryDramatic'], forested: true }],
  ['הולנד', 'NL', null, { relief: ['flat', 'flat'], forested: false }],
  ['פינלנד', 'FI', null, { relief: ['flat', 'hills'], forested: true, types: ['needleEvergreen'] }],
  ['גרמניה', 'DE', null, { relief: ['hills', 'gentle'], forested: true }],
  ['יוון', 'GR', null, { relief: ['dramatic', 'veryDramatic'] }],
  ['סלובניה', 'SI', null, { relief: ['dramatic', 'veryDramatic'], forested: true }],
  ['נורווגיה', 'NO', null, { relief: ['dramatic', 'veryDramatic'] }],
  ['ישראל', 'IL', null, { relief: ['hills', 'gentle'], forested: false, perennial: ['few', 'few'] }],
  ['קפריסין', 'CY', null, { perennial: ['few', 'few'] }],
  ['דנמרק', 'DK', null, { relief: ['flat', 'hills'] }],
  ['פרו', 'PE', null, { forested: true, types: ['broadEvergreen'] }],
  // Areas: what the second step of the list is chosen by.
  ["ואלה ד'אוסטה", 'IT', "IT:Valle d'Aosta", { relief: ['veryDramatic', 'veryDramatic'] }],
  ['טרנטינו', 'IT', 'IT:Trentino-Alto Adige', { relief: ['veryDramatic', 'veryDramatic'], forested: true, perennial: ['some', 'many'] }],
  // The Gargano rises to 1,000 m straight from the sea: a tenth of Apulia.
  ['פוליה', 'IT', 'IT:Apulia', { relief: ['flat', 'gentle'], perennial: ['few', 'few'] }],
  ['טוסקנה', 'IT', 'IT:Toscana', { relief: ['gentle', 'dramatic'], forested: true }],
  ['אפירוס', 'GR', 'GRC-2949', { relief: ['dramatic', 'veryDramatic'], forested: true, perennial: ['some', 'many'] }],
  ['הנגב', 'IL', 'ISR-3053', { forested: false, any: ['few', 'few'] }],
];

const fmt = (s) => `${L.reliefShort(s, bins)} · ${L.forestShort(s)} · ${L.waterShort(s)}`;

for (const [name, country, area, expect] of CASES) {
  const s = area ? data.regions[country]?.[area] : data.countries[country];
  if (!s) { fail(`${name}: no summary`); continue; }
  const problems = [];
  const relief = L.reliefLevel(s, bins);
  if (expect.relief) {
    const [lo, hi] = expect.relief.map((r) => RELIEF.indexOf(r));
    const at = RELIEF.indexOf(relief);
    if (at < lo || at > hi) problems.push(`relief ${relief}, expected ${expect.relief.join('–')}`);
  }
  if (expect.forested != null && (s.forest >= L.FORESTED) !== expect.forested) {
    problems.push(`forest ${s.forest / 10}%, expected ${expect.forested ? '' : 'not '}forested`);
  }
  for (const t of expect.types ?? []) {
    if (!L.mainForestTypes(s).includes(t)) problems.push(`forest type ${t} not named (${L.mainForestTypes(s).join(',') || 'none'})`);
  }
  for (const [key, tier] of [['perennial', L.perennialWater(s)], ['any', L.anyWater(s)]]) {
    if (!expect[key]) continue;
    const [lo, hi] = expect[key].map((w) => WATER.indexOf(w));
    if (WATER.indexOf(tier) < lo || WATER.indexOf(tier) > hi) problems.push(`${key} water ${tier}, expected ${expect[key].join('–')}`);
  }
  const line = `${name.padEnd(10)} ${fmt(s)}   [relief≥1000 ${L.shareAtLeast(s, bins, 1000) / 10}%, perennial ${s.perennial / 10}%, seasonal ${s.seasonal / 10}%]`;
  if (problems.length) fail(`${line}\n      ${problems.join('; ')}`);
  else console.log(`ok    ${line}`);
}

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
