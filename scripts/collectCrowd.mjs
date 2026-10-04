// Collects "מה אומרים מטיילים" for one country from this Mac, without the
// time limit of a request — the same steps as the admin's button in
// settings → מתקדם (src/lib/trailCrowd/country.ts), straight through.
//
//   node scripts/collectCrowd.mjs GR
//
// Needs in .env.local: TAVILY_API_KEY, SUPABASE_SERVICE_ROLE_KEY and
// NEXT_PUBLIC_SUPABASE_URL (or pass it on the command line). Costs Tavily
// credits: about two searches per area of the country, and one credit per
// five pages read. Logged in ai_usage under "מדדי מטיילים".

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

const country = (process.argv[2] ?? '').toUpperCase();
if (!/^[A-Z]{2}$/.test(country)) {
  console.error('usage: node scripts/collectCrowd.mjs <ISO country code>');
  process.exit(1);
}

import { readFileSync, writeFileSync } from 'node:fs';

const { withAiArea } = await import('../src/lib/aiUsage.ts');
const { readGuides } = await import('../src/lib/trailCrowd/komoot.ts');
const { matchRoutes, trailLines } = await import('../src/lib/trailCrowd/match.ts');
const { countryTrails } = await import('../src/lib/countryTrails.ts');
const c = await import('../src/lib/trailCrowd/country.ts');
const { crowdRows } = await import('../src/lib/trailCrowd/store.ts');
const { crowdSummaries, trafficSignal, TRAFFIC_ORDER } = await import('../src/lib/trailCrowd/score.ts');

await withAiArea('trail_crowd', async () => {
  const list = await countryTrails(country);
  if (!list) throw new Error(`no trail list for ${country}`);
  console.log(`${country}: ${list.trails.length} trails, ${list.regions.length} areas`);

  // CROWD_ROUTES=<file>: the pages read on an earlier run (written by
  // CROWD_DUMP=<file>), so the matching can be tuned without paying again.
  let guides, routes;
  if (process.env.CROWD_ROUTES) {
    ({ guides, routes } = JSON.parse(readFileSync(process.env.CROWD_ROUTES, 'utf8')));
    console.log(`from ${process.env.CROWD_ROUTES}: ${guides.length} pages, ${routes.length} routes`);
  } else {
    // CROWD_GUIDES=<file>: the pages found on an earlier run, without searching again.
    guides = process.env.CROWD_GUIDES
      ? JSON.parse(readFileSync(process.env.CROWD_GUIDES, 'utf8')).guides
      : await c.findCountryGuides(list);
    if (!guides) throw new Error('no search could be made (key? credit?)');
    console.log(`${process.env.CROWD_GUIDES ? 'loaded' : 'found'} ${guides.length} Komoot pages`);
    routes = [];
    for (let i = 0; i < guides.length; i += 15) {
      routes.push(...(await readGuides(guides.slice(i, i + 15))));
      console.log(`read ${Math.min(i + 15, guides.length)}/${guides.length} pages: ${routes.length} routes`);
    }
    if (process.env.CROWD_DUMP) writeFileSync(process.env.CROWD_DUMP, JSON.stringify({ guides, routes }));
  }
  // A page lists ten routes. Far fewer means the pages were not read, and
  // saving would replace good numbers with none.
  if (routes.length < guides.length * 3) throw new Error(`only ${routes.length} routes from ${guides.length} pages — not saving`);
  const matches = Object.fromEntries(matchRoutes(routes, await trailLines(list.trails)));
  console.log(`${Object.keys(matches).length} of our trails matched`);

  const ask = c.wikiCandidates(list, matches);
  const views = await c.pageviewsOf(ask);
  console.log(`Wikipedia: ${Object.values(views).filter((v) => v > 0).length} of ${ask.length} asked have reads`);

  if (!(await c.saveCountry(list, matches, views))) throw new Error('could not save (table? key?)');

  const rows = await crowdRows(country, { fresh: true });
  const s = crowdSummaries(rows);
  const byId = new Map(list.trails.map((t) => [t.id, t]));
  const tiers = Object.fromEntries(TRAFFIC_ORDER.map((t) => [t, [...s.values()].filter((x) => x.traffic === t).length]));
  console.log('\nsaved', rows.length, 'rows. traffic tiers:', tiers, 'unknown:', [...s.values()].filter((x) => x.traffic === 'unknown').length);
  console.log('with a rating:', [...s.values()].filter((x) => x.rating != null).length);
  console.log('\nbusiest:');
  for (const r of [...rows].sort((a, b) => trafficSignal(b.sources) - trafficSignal(a.sources)).slice(0, 25)) {
    const src = r.sources[0];
    console.log(` ${s.get(r.id).traffic.padEnd(9)} ${String(src?.hikers ?? '').padStart(6)} hikers ★${src?.rating ?? '-'} (${src?.count ?? 0})  ${byId.get(r.id)?.name?.slice(0, 40)}  ⇐ ${src?.route?.slice(0, 50) ?? ''}`);
  }
});
process.exit(0);
