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
// --dry: match and find the popular parts of long trails, print them, and
//   save nothing (with CROWD_ROUTES=<file>, a free rehearsal).
// --dump-only: read the pages and keep their routes on this Mac
//   (~/.cache/navi-komoot/dumps/crowd-<CC>.json, for crowdGap.mjs and for
//   matching again with CROWD_ROUTES) — nothing is written to the database.
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
const DUMP_ONLY = args.includes('--dump-only');
const DRY = args.includes('--dry');
const countries = args.filter((a, i) => /^[A-Za-z]{2}$/.test(a) && !['--find', '--pages'].includes(args[i - 1])).map((a) => a.toUpperCase());
if (!countries.length || !['tavily', 'codex', 'crawl', 'codex-only'].includes(FIND) || !(PAGES > 0)) {
  console.error('usage: node scripts/collectCrowd.mjs <ISO code>… [--find tavily|codex|crawl|codex-only] [--pages 200]');
  process.exit(1);
}

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { withAiArea } = await import('../src/lib/aiUsage.ts');
const { readGuides } = await import('../src/lib/trailCrowd/komoot.ts');
const { countryTrails, rebuildCountryTrails } = await import('../src/lib/countryTrails.ts');
const c = await import('../src/lib/trailCrowd/country.ts');
const { crowdRows } = await import('../src/lib/trailCrowd/store.ts');
const { storedCountryTrails, addSections } = await import('../src/lib/countryTrails.ts');
const { findSections, sectionsOfCountry, writeSections, isSectionsTableMissing } = await import('../src/lib/trailCrowd/sections.ts');
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
  // --dump-only never builds a list: building one writes it to the table.
  let list = DUMP_ONLY || DRY ? await storedCountryTrails(country)
    : process.env.CROWD_REBUILD ? await rebuildCountryTrails(country) : await countryTrails(country);
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
  if (DUMP_ONLY) {
    // Komoot's lines stay on this Mac: never in the repository or the database.
    const dir = join(homedir(), '.cache/navi-komoot/dumps');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `crowd-${country}.json`), JSON.stringify({ guides, routes }));
    console.log(`kept ${routes.length} routes from ${guides.length} pages in ${dir} — nothing saved to the database`);
    return;
  }
  // A page lists ten routes. Far fewer means the pages were not read, and
  // saving would replace good numbers with none.
  if (routes.length < guides.length * 3) throw new Error(`only ${routes.length} routes from ${guides.length} pages — not saving`);
  const { matches, onLong } = await c.matchAllDetailed(list, routes);
  const have = new Set(list.trails.map((t) => t.id));
  const hikers = (ids) => ids.reduce((n, id) => n + (matches[id].hikers ?? 0), 0);
  const fresh = Object.keys(matches).map(Number).filter((id) => !have.has(id));
  console.log(`${Object.keys(matches).length} trails matched (${hikers(Object.keys(matches).map(Number))} hikers), ${fresh.length} of them new to the list`);

  // The popular parts of long trails (src/lib/trailCrowd/sections.ts).
  console.log(`${onLong.size} routes run only along a far longer trail — looking for the part they walk…`);
  const sections = await findSections(country, onLong, await sectionsOfCountry(country), { log: console.log });
  console.log(`${sections.length} sections (${sections.filter((s) => s.isNew).length} new), ${sections.reduce((n, s) => n + (s.source.hikers ?? 0), 0)} hikers`);
  if (DRY) {
    console.log('--dry: nothing saved');
    return;
  }

  const before = list.trails.length;
  list = await c.withAddedTrails(list, matches);
  if (sections.length) {
    if (await writeSections(sections.filter((s) => s.isNew).map((s) => s.section))) {
      list = (await addSections(country, sections.map((s) => s.section))) ?? list;
      for (const s of sections) matches[s.section.id] = s.source;
    } else {
      console.log(isSectionsTableMissing() ? 'sections not saved: run supabase/schema.sql (trail_sections)' : 'sections not saved');
    }
  }
  const inList = list.trails.filter((t) => matches[t.id]).length;
  console.log(`${inList} of the list's trails matched, ${list.trails.length - before} of them just added (${list.trails.length} trails now)`);

  const ask = c.wikiCandidates(list, matches);
  const views = await c.pageviewsOf(ask);
  console.log(`Wikipedia: ${Object.values(views).filter((v) => v > 0).length} of ${ask.length} asked have reads`);

  // From an earlier run's pages, the numbers are as old as the pages.
  const at = process.env.CROWD_ROUTES ? statSync(process.env.CROWD_ROUTES).mtime.toISOString() : undefined;
  if (!(await c.saveCountry(list, matches, views, at))) throw new Error('could not save (table? key?)');

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
