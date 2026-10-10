// How well Komoot covers each of the owner's countries (scripts/countryGroups.mjs),
// for crowdStatus.mjs: the hikers of the ten routes on the country's own
// "hiking-in-<country>" page on Komoot. Free — one Komoot page per country.
// Writes scripts/komootCoverage.json; run it again now and then (a year on,
// or when Komoot changes).
//
//   node scripts/measureKomootCoverage.mjs          # every country in GROUPS
//   node scripts/measureKomootCoverage.mjs PE NP    # these, added to the file

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const { countryGuidePage } = await import('../src/lib/trailCrowd/findGuides.ts');
const { parseGuide } = await import('../src/lib/trailCrowd/komoot.ts');
const { countryEnglish } = await import('../src/lib/trailInfo/sources.ts');
const { GROUPS } = await import('./countryGroups.mjs');

const OUT = new URL('./komootCoverage.json', import.meta.url);
const wanted = process.argv.slice(2).map((a) => a.toUpperCase());
const codes = wanted.length ? wanted : Object.values(GROUPS).flat();
const file = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { countries: {} };

for (const cc of codes) {
  const page = await countryGuidePage(cc, countryEnglish(cc));
  let hikers = 0, ratings = 0, routes = 0;
  if (page) {
    try {
      const res = await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Navi-Trail-App/1.0; naveh@hamarag.com)', 'Accept-Language': 'en' } });
      const rs = res.ok ? parseGuide(page, await res.text()) : [];
      routes = rs.length;
      hikers = rs.reduce((n, r) => n + r.hikers, 0);
      ratings = rs.reduce((n, r) => n + r.ratings, 0);
    } catch { /* counted as nothing */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  file.countries[cc] = { page, routes, hikers, ratings };
  console.log(`${cc} ${countryEnglish(cc).padEnd(24)} ${String(hikers).padStart(7)} hikers on the country's page${page ? '' : ' (no page)'}`);
}
file.measuredAt = new Date().toISOString().slice(0, 10);
writeFileSync(OUT, JSON.stringify(file, null, 1) + '\n');
console.log(`→ ${OUT.pathname}`);
process.exit(0);
