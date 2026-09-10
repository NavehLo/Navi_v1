// The one check that catches the dangerous mistake before a walker does.
//
// The summer feature puts water on the map as "somewhere to cool off". Get the
// filter wrong and it recommends a sewage-treatment pond. Two halves:
//
//   1. Fixed cases — reservoirs, wastewater, fishponds and נחל קדרון must be
//      refused; ponds, springs and נחל כזיב must pass. Run with no arguments.
//   2. The whole country — every natural=water polygon, spring and named
//      waterway in Israel through the real filter, printing what survives so a
//      person can read it. This is the check §9 of the plan calls the most
//      important one in the whole feature, and no amount of unit tests replaces
//      reading the list. Run with --audit (needs network; ~15s of Overpass).
//
//   node scripts/checkWaterFilter.mjs
//   node scripts/checkWaterFilter.mjs --audit

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { classifyWater } = await import('../src/lib/waterSources.ts');
const { isPerennialStream, perennialStreamNames } = await import('../src/lib/perennialStreams.ts');

let failed = 0;
function check(what, tags, expected) {
  const got = classifyWater(tags)?.category ?? null;
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what.padEnd(46)} → ${String(got).padEnd(17)} ${ok ? '' : `(expected ${expected})`}`);
}

console.log('blocked — must never reach a map');
check('מאגר קולחין',            { natural: 'water', water: 'wastewater' }, null);
check('מאגר מים',               { natural: 'water', water: 'reservoir' }, null);
check('בריכת אגירה',            { natural: 'water', water: 'basin' }, null);
check('בריכת דגים',             { natural: 'water', water: 'fishpond' }, null);
check('תעלת ניקוז',             { natural: 'water', water: 'drain' }, null);
check('landuse=reservoir',      { natural: 'water', landuse: 'reservoir', water: 'pond' }, null);
check('מכון טיהור',             { natural: 'water', man_made: 'wastewater_plant', water: 'pond' }, null);
check('reservoir_type=sewage',  { natural: 'water', water: 'pond', reservoir_type: 'sewage' }, null);
check('בריכה עונתית',           { natural: 'water', water: 'pond', intermittent: 'yes' }, null);
check('בריכה בשטח פרטי',        { natural: 'water', water: 'pond', access: 'private' }, null);
check('בריכה עם swimming=no',   { natural: 'water', water: 'pond', swimming: 'no' }, null);
check('natural=water בלי שם',   { natural: 'water' }, null);
check('מעיין עונתי',            { natural: 'spring', intermittent: 'yes' }, null);

console.log('\nblocked by name — the whole-country audit found every one of these');
check('מאגר בזלת',              { natural: 'water', name: 'מאגר בזלת' }, null);
check('מאגר הגל הגואה',         { natural: 'water', water: 'pond', name: 'מאגר הגל הגואה', intermittent: 'no' }, null);
check('בריכת דגים - עין הנצי״ב', { natural: 'water', name: 'בריכת דגים - קיבוץ עין הנצי"ב', landuse: 'aquaculture' }, null);
check('Fish Farming',           { natural: 'water', name: 'Fish Farming' }, null);
check('בריכת הדגים',            { natural: 'water', water: 'pond', name: 'בריכת הדגים', 'name:en': 'Fish Pond' }, null);
check('סכר נחל ירקון',          { natural: 'water', name: 'סכר נחל ירקון' }, null);
check('מזרקת המזלות',           { natural: 'water', name: 'מזרקת המזלות', amenity: 'fountain' }, null);
check('בריכת החורף כרכור',      { natural: 'water', name: 'בריכת החורף כרכור' }, null);
check('בריכת נוי',              { natural: 'water', water: 'pond', name: 'בריכת נוי' }, null);
check('טיוב מי באר',            { natural: 'water', name: 'טיוב מי באר' }, null);
check('בריכת צבים (אקווריום)',  { natural: 'water', water: 'pond', name: 'בריכת צבים וחתולי ים', tourism: 'zoo', zoo: 'enclosure' }, null);
check('בור מים בגולף',          { natural: 'water', name: 'Ayla Golf Club', golf: 'lateral_water_hazard' }, null);
check('בריכות אידוי אשלג',      { natural: 'water', landuse: 'salt_pond', 'name:en': 'Arab Potash Solar Evaporation Pan' }, null);
check('מלחת סדום',              { natural: 'water', water: 'lake', name: 'מלחת סדום', salt: 'yes' }, null);
check('בריכת שחייה',            { natural: 'water', water: 'pond', leisure: 'swimming_pool', name: 'בריכה' }, null);

console.log('\nblocked streams — flow all year, carry sewage');
check('נחל קדרון',              { waterway: 'stream', name: 'נחל קדרון' }, null);
check('נחל חברון',              { waterway: 'stream', name: 'נחל חברון', intermittent: 'yes' }, null);
check('נחל חדרה',               { waterway: 'stream', name: 'נחל חדרה' }, null);
check('נחל בלי שם',             { waterway: 'stream' }, null);
check('נחל כידוד (דומה ל־דוד)', { waterway: 'stream', name: 'נחל כידוד' }, null);
check('נחל דודאים',             { waterway: 'stream', name: 'נחל דודאים' }, null);

console.log('\naccepted');
check('בריכה',                  { natural: 'water', water: 'pond', name: 'בריכת הנקיק' }, 'pool');
check('אגם',                    { natural: 'water', water: 'lake', name: 'אגם' }, 'pool');
check('גב מים בנחל',            { natural: 'water', water: 'stream_pool' }, 'pool');
check('natural=water עם שם',    { natural: 'water', name: 'עין שנץ' }, 'pool_unverified');
check('מעיין',                  { natural: 'spring', name: 'עין חלב' }, 'spring');
check('ים',                     { natural: 'coastline' }, 'sea');

console.log('\nperennial list overrides intermittent (OSM marks these seasonal, they are not)');
check('נחל כזיב + intermittent', { waterway: 'stream', name: 'נחל כזיב', intermittent: 'yes' }, 'perennial_stream');
check('נחל דוד + intermittent',  { waterway: 'stream', name: 'נחל דוד', intermittent: 'yes' }, 'perennial_stream');
check('נחל ערוגות',              { waterway: 'stream', name: 'נחל ערוגות', intermittent: 'yes' }, 'perennial_stream');
check('נחל פרת',                 { waterway: 'stream', name: 'נחל פרת', intermittent: 'yes' }, 'perennial_stream');
check('נחל שניר (חצבני)',        { waterway: 'river', name: 'נחל שניר (חצבני)' }, 'perennial_stream');
check('נחל עמל (האסי)',          { waterway: 'stream', name: 'נחל עמל (האסי)' }, 'perennial_stream');
check('נחל דן (מחולק)',          { waterway: 'stream', name: 'נחל דן (מחולק)' }, 'perennial_stream');
check('נחל חרמון = הבניאס',      { waterway: 'stream', name: 'נחל חרמון' }, 'perennial_stream');
check('בניאס בכתיב עממי',        { waterway: 'stream', name: 'הבניאס' }, 'perennial_stream');
check('נחל זוויתן (שני ו)',      { waterway: 'stream', name: 'נחל זוויתן' }, 'perennial_stream');
check('ואדי קלט = נחל פרת',      { waterway: 'stream', name: 'ואדי קלט' }, 'perennial_stream');
check('נחל אל־על עם מקף',        { waterway: 'stream', name: 'נחל אל־על' }, 'perennial_stream');

console.log(`\n${failed === 0 ? 'all cases passed' : failed + ' CASES FAILED'} · ${perennialStreamNames().length} streams on the list`);

if (process.argv.includes('--audit')) await audit();
process.exit(failed === 0 ? 0 : 1);

// ── whole-country audit ──────────────────────────────────────────────────────

async function overpass(query) {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
}

async function audit() {
  const BOX = '29.4,34.2,33.4,35.95';
  console.log('\nquerying Overpass for every water feature in the country…');
  const data = await overpass(`[out:json][timeout:180];
(
  way["natural"="water"](${BOX});
  node["natural"="spring"](${BOX});
  way["waterway"~"^(stream|river)$"]["name"](${BOX});
);
out tags;`);

  const elements = data.elements ?? [];
  const kept = [];
  for (const el of elements) {
    const props = classifyWater(el.tags ?? {});
    if (props) kept.push({ ...props, name: el.tags['name:he'] || el.tags.name || '(ללא שם)', tags: el.tags });
  }

  const byCat = {};
  for (const k of kept) byCat[k.category] = (byCat[k.category] ?? 0) + 1;
  console.log(`\nexamined ${elements.length} · kept ${kept.length} · dropped ${elements.length - kept.length}`);
  console.log(byCat);

  // A crude keyword net over what survived. It is not the filter — it is a
  // second opinion, so that a word like "קולחין" in a name gets a human's
  // attention even when the tags looked innocent.
  const SUSPECT = /קולחין|שפכים|ביוב|מאגר|דגים|טיהור|מתקן|בריכת שחייה|reservoir|wastewater|sewage|fishpond|treatment|swimming_pool/i;
  const flagged = kept.filter((k) => SUSPECT.test(JSON.stringify(k.tags)));
  console.log(`\n=== survived the filter but reads suspicious (${flagged.length}) ===`);
  for (const f of flagged) console.log('  !!', f.category, '|', f.name, '|', JSON.stringify(f.tags).slice(0, 200));
  if (!flagged.length) console.log('  none');

  for (const cat of ['perennial_stream', 'pool', 'pool_unverified']) {
    const names = [...new Set(kept.filter((k) => k.category === cat).map((k) => k.name))];
    console.log(`\n=== ${cat} — ${names.length} distinct names ===`);
    console.log(names.slice(0, 60).join(' · ') + (names.length > 60 ? ` … +${names.length - 60}` : ''));
  }
}
