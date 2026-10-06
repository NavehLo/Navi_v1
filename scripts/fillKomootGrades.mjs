// Adds Komoot's difficulty grade ("רמת קושי", lib/difficulty.ts) to the
// trails already collected for "מה אומרים מטיילים", without collecting again.
//
// A collection keeps, for each trail, the Komoot page its numbers were read
// from and the route's name there. This reads those pages again — straight
// from Komoot, free, no search — finds the same route by name, and stores its
// grade where the route covers most of the trail (gradeCovers in match.ts).
// Nothing else in the row changes. A route no longer on its page stays
// without a grade until the country is collected again.
//
//   node scripts/fillKomootGrades.mjs              # every collected country
//   node scripts/fillKomootGrades.mjs GR ES        # these countries
//   node scripts/fillKomootGrades.mjs GR --dry     # print, write nothing
//
// Needs in .env.local: SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL.

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const wanted = args.filter((a) => /^[A-Za-z]{2}$/.test(a)).map((a) => a.toUpperCase());

const { readGuides } = await import('../src/lib/trailCrowd/komoot.ts');
const { gradeCovers, routeKm } = await import('../src/lib/trailCrowd/match.ts');
const { collectedCountryLists } = await import('../src/lib/trailCrowd/leaders.ts');
const { crowdRows, writeCrowdRows } = await import('../src/lib/trailCrowd/store.ts');
const { countryTrails } = await import('../src/lib/countryTrails.ts');

const countries = wanted.length ? wanted : (await collectedCountryLists()).map((c) => c.country);
console.log(`${countries.length} countries: ${countries.join(' ')}${dry ? ' (dry run)' : ''}`);

const totals = { sources: 0, graded: 0, missing: 0, short: 0 };
for (const country of countries) {
  const list = await countryTrails(country);
  if (!list) { console.log(`${country}: no trail list — skipped`); continue; }
  const trailKm = new Map(list.trails.map((t) => [t.id, t.km]));
  const rows = await crowdRows(country, { fresh: true });
  const pending = rows.filter((r) => r.sources.some((s) => s.site === 'Komoot' && !s.grade && s.route));
  if (!pending.length) { console.log(`${country}: nothing to fill`); continue; }

  const urls = [...new Set(pending.flatMap((r) => r.sources.filter((s) => s.site === 'Komoot').map((s) => s.url)))];
  const routes = await readGuides(urls);
  const byPage = new Map();
  for (const r of routes) {
    const key = `${r.guide}|${r.name}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(r);
  }

  const changed = [];
  const counts = { sources: 0, graded: 0, missing: 0, short: 0 };
  for (const row of pending) {
    let touched = false;
    for (const s of row.sources) {
      if (s.site !== 'Komoot' || s.grade || !s.route) continue;
      counts.sources++;
      const same = byPage.get(`${s.url}|${s.route}`) ?? [];
      // The same name twice on a page: the one with the stored number of hikers.
      const r = same.find((x) => x.hikers === s.hikers) ?? same[0];
      if (!r?.grade) { counts.missing++; continue; }
      if (!gradeCovers(routeKm(r), trailKm.get(row.id) ?? Infinity)) { counts.short++; continue; }
      s.grade = r.grade;
      counts.graded++;
      touched = true;
    }
    if (touched) changed.push(row);
  }
  for (const k of Object.keys(totals)) totals[k] += counts[k];
  console.log(
    `${country}: ${urls.length} pages, ${routes.length} routes read · ${counts.sources} trails to grade: ` +
    `${counts.graded} graded, ${counts.short} route too short a part of the trail, ${counts.missing} route not found`
  );
  if (!changed.length || dry) continue;
  if (!(await writeCrowdRows(country, changed))) {
    console.error(`${country}: could not write`);
    process.exitCode = 1;
  }
}
console.log(`total: ${totals.graded} of ${totals.sources} graded (${totals.short} too short, ${totals.missing} not found)`);
