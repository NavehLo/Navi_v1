// Collects "מה אומרים מטיילים" for one country from this Mac, without the
// time limit of a request — the same steps as the admin's button in
// settings → מתקדם (src/lib/trailCrowd/country.ts), straight through.
//
//   node scripts/collectCrowd.mjs GR                     # pages found by Tavily
//   node scripts/collectCrowd.mjs AL BA --find codex      # several countries, one after another
//
// How the country's Komoot pages are found (--find; src/lib/trailCrowd/findGuides.ts):
//   tavily        Tavily search (the default): about two searches per area,
//                 from the 1,000 free a month. Logged in ai_usage under "מדדי מטיילים".
//   codex         Codex searches for them, on the owner's ChatGPT plan — no
//                 per-call cost, only the plan's allowance. Then the free crawl
//                 below continues from what it found.
//   crawl         Komoot's own links only, from the country's page. Free.
//   codex-only    Codex's pages alone, without the crawl.
// --pages N: how many pages the crawl reads at most (default 200).
//
// Needs in .env.local: SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL,
// and TAVILY_API_KEY for --find tavily; Codex installed and signed in for
// --find codex (see src/lib/countryGuide/subscription.ts).

import { register } from 'node:module';
register('./tsResolve.mjs', import.meta.url);
try { process.loadEnvFile('.env.local'); } catch { /* the environment may already hold the keys */ }

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const FIND = flag('--find', 'tavily');
const PAGES = Number(flag('--pages', '200'));
const countries = args.filter((a, i) => /^[A-Za-z]{2}$/.test(a) && !['--find', '--pages'].includes(args[i - 1])).map((a) => a.toUpperCase());
if (!countries.length || !['tavily', 'codex', 'crawl', 'codex-only'].includes(FIND) || !(PAGES > 0)) {
  console.error('usage: node scripts/collectCrowd.mjs <ISO code>… [--find tavily|codex|crawl|codex-only] [--pages 200]');
  process.exit(1);
}

import { readFileSync, writeFileSync } from 'node:fs';

const { withAiArea } = await import('../src/lib/aiUsage.ts');
const { readGuides } = await import('../src/lib/trailCrowd/komoot.ts');
const { countryTrails, rebuildCountryTrails } = await import('../src/lib/countryTrails.ts');
const c = await import('../src/lib/trailCrowd/country.ts');
const { crowdRows } = await import('../src/lib/trailCrowd/store.ts');
const { crowdSummaries, trafficSignal, TRAFFIC_ORDER } = await import('../src/lib/trailCrowd/score.ts');
const { findGuidesWithCodex, countryGuidePage, crawlGuides } = await import('../src/lib/trailCrowd/findGuides.ts');
const { countryEnglish } = await import('../src/lib/trailInfo/sources.ts');

// The country's pages and their routes, the way --find says.
async function findAndRead(list) {
  if (FIND === 'tavily') {
    const guides = await c.findCountryGuides(list);
    if (!guides) throw new Error('no search could be made (key? credit?)');
    console.log(`found ${guides.length} Komoot pages`);
    const routes = [];
    for (let i = 0; i < guides.length; i += 15) {
      routes.push(...(await readGuides(guides.slice(i, i + 15))));
      console.log(`read ${Math.min(i + 15, guides.length)}/${guides.length} pages: ${routes.length} routes`);
    }
    return { guides, routes };
  }
  const name = countryEnglish(list.country);
  let seeds = [];
  if (FIND !== 'crawl') {
    const areas = [...new Set(list.regions.map((r) => r.latin ?? r.name).filter((n) => /[a-z]/i.test(n)))];
    console.log(`asking Codex for ${name}'s Komoot pages (${areas.length} areas)…`);
    const r = await findGuidesWithCodex(name, areas);
    console.log(`Codex: ${r.urls.length} pages, ${r.searches} searches, ${Math.round(r.seconds / 60)} min`);
    seeds = r.urls;
  }
  if (FIND !== 'codex-only') {
    const home = await countryGuidePage(list.country, name);
    console.log(home ? `the country's page: ${home}` : `no "hiking-in-${name}" page in Komoot's sitemap`);
    if (home) seeds = [home, ...seeds];
  }
  if (!seeds.length) throw new Error('no Komoot page to start from');
  // codex-only reads just Codex's pages; otherwise the crawl goes on from them.
  const max = FIND === 'codex-only' ? seeds.length : Math.max(PAGES, seeds.length);
  const r = await crawlGuides(list.country, seeds, { maxPages: max, log: console.log });
  console.log(`read ${r.read} pages: ${r.guides.length} in ${name}, ${r.routes.length} routes${r.queued ? ` (${r.queued} more pages linked, not read)` : ''}`);
  return { guides: r.guides, routes: r.routes };
}

for (const country of countries) {
  try {
    await collect(country);
  } catch (e) {
    console.error(`${country}: ${e.message} — nothing saved`);
  }
}
process.exit(0);

async function collect(country) {
await withAiArea('trail_crowd', async () => {
  // CROWD_REBUILD=1: the country's list built afresh first (it then brings
  // back the trails earlier runs added, under their names).
  let list = process.env.CROWD_REBUILD ? await rebuildCountryTrails(country) : await countryTrails(country);
  if (!list) throw new Error(`no trail list for ${country}`);
  console.log(`${country}: ${list.trails.length} trails, ${list.regions.length} areas`);

  // CROWD_ROUTES=<file>: the pages read on an earlier run (written by
  // CROWD_DUMP=<file>), so the matching can be tuned without paying again.
  let guides, routes;
  if (process.env.CROWD_ROUTES) {
    ({ guides, routes } = JSON.parse(readFileSync(process.env.CROWD_ROUTES, 'utf8')));
    console.log(`from ${process.env.CROWD_ROUTES}: ${guides.length} pages, ${routes.length} routes`);
  } else if (process.env.CROWD_GUIDES) {
    // CROWD_GUIDES=<file>: the pages found on an earlier run, without searching again.
    guides = JSON.parse(readFileSync(process.env.CROWD_GUIDES, 'utf8')).guides;
    console.log(`loaded ${guides.length} Komoot pages`);
    routes = await readGuides(guides);
  } else {
    ({ guides, routes } = await findAndRead(list));
  }
  if (process.env.CROWD_DUMP) writeFileSync(process.env.CROWD_DUMP, JSON.stringify({ guides, routes }));
  // A page lists ten routes. Far fewer means the pages were not read, and
  // saving would replace good numbers with none.
  if (routes.length < guides.length * 3) throw new Error(`only ${routes.length} routes from ${guides.length} pages — not saving`);
  const matches = await c.matchAll(list, routes);
  const before = list.trails.length;
  list = await c.withAddedTrails(list, matches);
  const inList = list.trails.filter((t) => matches[t.id]).length;
  console.log(`${inList} of the list's trails matched, ${list.trails.length - before} of them just added (${list.trails.length} trails now)`);

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
}
