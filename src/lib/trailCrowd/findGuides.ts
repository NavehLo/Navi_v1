// Finding a country's Komoot "best hikes" pages without Tavily — for
// scripts/collectCrowd.mjs only (it starts programs and downloads Komoot's
// sitemap on this Mac). Two ways, either or both:
//
//   codex  Codex (`codex exec --search`, the owner's ChatGPT plan) searches the
//          web for the pages. No per-call cost, only the plan's allowance. A
//          page it names is used only if it is a Komoot walking guide that
//          answers and whose routes lie in the country — an invented one is a
//          404 and drops out on reading.
//   crawl  Komoot's own links: a country's page links to its areas' pages,
//          and those to more. Followed breadth first from the country's
//          "hiking-in-…" page (found in Komoot's public sitemap) and from any
//          page Codex found, keeping the pages whose routes lie in the
//          country and not following the others. Free. In a test (2026-10-10)
//          it found all of the 30 most walked routes Tavily had found in
//          Montenegro, and 100 Austrian pages to Tavily's 60.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { iso1A2Code } from '@rapideditor/country-coder';
import { guideUrl, own, parseGuide, type KomootRoute } from './komoot';
import { writeWithCodex } from '../countryGuide/subscription';

const GUIDE_ANY = /https?:\/\/(?:www\.)?komoot\.com\/(?:[a-z]{2}-[a-z]{2}\/)?guide\/\d+\/[a-z0-9-]+/gi;

// ── Codex ────────────────────────────────────────────────────────────────────

export const CODEX_MODEL = 'gpt-5.6-terra';

export async function findGuidesWithCodex(
  country: string,
  areas: string[],
  opts: { model?: string; effort?: string } = {},
): Promise<{ urls: string[]; searches: number; seconds: number }> {
  const system = [
    'You find web pages. Answer with JSON only, no prose.',
    'Use web search; list only URLs that the search actually returned — never make one up or guess an id.',
  ].join(' ');
  const user = [
    `Find Komoot guide pages about hiking and walking in ${country}.`,
    'They look like https://www.komoot.com/guide/<number>/<slug>, where the slug says what and where:',
    `"hiking-in-…", "easy-hikes-in-…", "mountain-hikes-in-…", "hiking-around-…", "waterfall-hikes-in-…", "family-friendly-hikes-in-…".`,
    `Search for the whole country, and for each of its areas: ${areas.join('; ')}.`,
    'Also the best-known hiking places of the country (national parks, mountain ranges, lakes, gorges, towns that walkers start from).',
    'Search with site:komoot.com/guide. Aim for 3–6 pages per area, and 60–150 pages in all.',
    'Only walking pages: no cycling, running, castles, attractions.',
    'Answer exactly: {"urls": ["https://www.komoot.com/guide/…", …]}',
  ].join('\n');
  const r = await writeWithCodex(system, user, opts.model ?? CODEX_MODEL, opts.effort ?? 'low');
  const urls = new Set<string>();
  for (const m of r.text.matchAll(GUIDE_ANY)) {
    const u = guideUrl(m[0]);
    if (u) urls.add(u);
  }
  return { urls: [...urls], searches: r.searches, seconds: r.seconds };
}

// ── Komoot's sitemap: the country's own page ─────────────────────────────────

const CACHE = join(homedir(), '.cache/navi-komoot');
const UA = 'Mozilla/5.0 (compatible; Navi-Trail-App/1.0; naveh@hamarag.com)';

// The walking guides' addresses from Komoot's public sitemap (about 70
// files), fetched once and kept on this Mac; refreshed after a month.
async function sitemapGuides(): Promise<string[]> {
  const file = join(CACHE, 'walking-guides.txt');
  const MONTH = 30 * 24 * 3600_000;
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < MONTH) {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean);
  }
  mkdirSync(CACHE, { recursive: true });
  const index = await (await fetch('https://www.komoot.com/_sitemaps/sitemap-index.xml', { headers: { 'User-Agent': UA } })).text();
  const parts = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const out: string[] = [];
  for (const part of parts) {
    const res = await fetch(part, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const buf = Buffer.from(await res.arrayBuffer());
    const xml = part.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = guideUrl(m[1]);
      if (u) out.push(u);
    }
  }
  writeFileSync(file, out.join('\n'));
  return out;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Where Komoot's name for the country is not the usual English one.
const KOMOOT_NAMES: Record<string, string> = {
  MK: 'macedonia', CZ: 'czech-republic', LU: 'luxemburg', US: 'united-states-of-america',
};

// The country's "hiking-in-<country>" page, or null.
export async function countryGuidePage(cc: string, countryName: string): Promise<string | null> {
  const name = KOMOOT_NAMES[cc] ?? slug(countryName);
  const want = new Set([`hiking-in-${name}`, `hiking-in-the-${name}`]);
  return (await sitemapGuides()).find((u) => want.has(u.split('/').pop()!)) ?? null;
}

// ── Crawl ────────────────────────────────────────────────────────────────────

const LINK = /guide\/(\d+)\/([a-z0-9-]+)/g;
const WALKING = /hik|walk/i;

// A page belongs to the country when most of its routes pass through it.
function inCountry(routes: KomootRoute[], cc: string): boolean {
  const inside = routes.filter((r) => r.points.some(([lat, lon], i) => i % 10 === 0 && iso1A2Code([lon, lat]) === cc)).length;
  return inside / routes.length >= 0.5;
}

export async function crawlGuides(
  cc: string,
  seeds: string[],
  opts: { maxPages?: number; log?: (s: string) => void } = {},
): Promise<{ guides: string[]; routes: KomootRoute[]; read: number; queued: number }> {
  const maxPages = opts.maxPages ?? 200;
  const queue = [...new Set(seeds)];
  const seen = new Set(queue.map((u) => u.match(/guide\/(\d+)/)![1]));
  const guides: string[] = [];
  const routes: KomootRoute[] = [];
  let read = 0;
  while (queue.length && read < maxPages) {
    const url = queue.shift()!;
    read++;
    let html: string;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }
    const found = parseGuide(url, html);
    // Another country's page (a neighbour, a namesake): neither kept nor followed.
    if (found.length && !inCountry(found, cc)) continue;
    if (found.length) {
      guides.push(url);
      routes.push(...found);
    }
    for (const m of html.matchAll(LINK)) {
      if (!WALKING.test(m[2]) || seen.has(m[1])) continue;
      // Copies (own): a piece of the page kept in the queue keeps the page.
      seen.add(own(m[1]));
      queue.push(own(`https://www.komoot.com/guide/${m[1]}/${m[2]}`));
    }
    if (read % 25 === 0) opts.log?.(`crawl: ${read} pages read, ${guides.length} in the country, ${routes.length} routes, ${queue.length} waiting`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return { guides, routes, read, queued: queue.length };
}
