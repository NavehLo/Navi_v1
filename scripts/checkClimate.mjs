// Checks "מתי כדאי ללכת" against places whose seasons anybody who walks knows:
// the Dead Sea in July, the Hermon in January, the Alps, Iceland, Patagonia.
// Runs the real grid (src/data/climate-grid.bin.gz) through the real rules
// (src/lib/climate.ts) and prints each place's year, so a change to a
// threshold can be seen for what it does everywhere at once.
//
//   node scripts/checkClimate.mjs

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

const { climateAt } = await import('../src/lib/climateGrid.ts');
const { rateMonths, monthRuns, MONTH_SHORT } = await import('../src/lib/climate.ts');

// [name, lat, lon, lowest m, highest m, hours, { month index: expected }, gorge?]
//
// Beside the places anyone knows, popular trails whose season is widely
// published (visitgreece, park authorities): Kritsa and Samaria gorges in
// Crete (Samaria is closed November–April for floods), the Lycian Way, the
// Cinque Terre. The first version called Crete's rainy January perfect.
const PLACES = [
  ['עין גדי, נחל דוד', 31.46, 35.385, -380, -150, 2, { 0: 'good', 1: 'good', 6: 'bad', 7: 'bad' }],
  ['הרי ירושלים', 31.77, 35.13, 550, 800, 4, { 3: 'good', 7: 'fair' }],
  ['מירון', 33.0, 35.41, 650, 1150, 5, { 3: 'good', 10: 'good' }],
  ['החרמון', 33.31, 35.78, 1600, 2200, 5, { 0: 'bad', 8: 'good' }],
  ['הרי אילת', 29.56, 34.92, 150, 750, 5, { 0: 'good', 6: 'bad' }],
  ['שאמוני, Lac Blanc', 45.95, 6.88, 1050, 2350, 6, { 0: 'bad', 7: 'good' }],
  ['צרמט', 46.0, 7.75, 1600, 2600, 6, { 1: 'bad', 7: 'good' }],
  ['הדרך הליקית, כאש', 36.2, 29.6, 0, 400, 6, { 3: 'good', 6: 'bad' }],
  ['איסלנד, Laugavegur', 63.98, -19.06, 500, 1100, 7, { 0: 'bad', 7: 'good' }],
  ['טורס דל פיינה', -50.95, -72.95, 100, 900, 7, { 0: 'good', 6: 'bad' }],
  ['מונאר, קרלה', 10.08, 77.06, 1500, 2000, 4, { 6: 'bad', 1: 'good' }],
  ['Kritsa Gorge, כרתים', 35.16, 25.63, 240, 610, 1.8, { 0: 'bad', 11: 'bad', 3: 'good', 4: 'good', 9: 'good' }, true],
  ['Samaria Gorge, כרתים', 35.27, 23.96, 0, 1230, 6.5, { 0: 'bad', 4: 'good', 9: 'good' }, true],
  ['הדרך הליקית בחורף', 36.2, 29.6, 0, 400, 6, { 0: 'fair', 11: 'fair', 2: 'good', 3: 'good', 10: 'good' }],
  ['צ׳ינקווה טרה', 44.12, 9.71, 0, 500, 5, { 3: 'good', 4: 'good', 10: 'fair' }],
];

const DOT = { good: '🟢', fair: '🟡', bad: '🔴' };
let failed = 0;

for (const [name, lat, lon, lowEle, highEle, hours, expect, gorge = false] of PLACES) {
  const low = climateAt(lat, lon, lowEle);
  const high = climateAt(lat, lon, highEle);
  if (!low || !high) {
    failed++;
    console.log(`FAIL  ${name}: no climate`);
    continue;
  }
  const months = rateMonths({ low: low.months, high: high.months, lat, hours, gorge });
  const ratings = months.map((m) => m.rating);
  console.log(`\n${name}  (grid ${low.gridEle} m, walk ${lowEle}–${highEle} m, ${hours} h)`);
  console.log('  ' + ratings.map((r, i) => `${MONTH_SHORT[i]}${DOT[r]}`).join(' '));
  console.log(`  עונה מומלצת: ${monthRuns(ratings) || '—'}`);
  for (const [m, want] of Object.entries(expect)) {
    const got = ratings[m];
    const ok = got === want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${MONTH_SHORT[m]}: ${want}${ok ? '' : ` (got ${got} — ${months[m].reasons.map((r) => r.text).join('; ')})`}`);
  }
  for (const i of [0, 6]) {
    const v = months[i];
    console.log(`  ${MONTH_SHORT[i]}: ${v.tmax}°/${v.tmin}°, ${v.ppt} mm, ${v.daylight} h — ${v.reasons.map((r) => r.text).join('; ')}`);
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
