// Collecting the raw numbers behind "מה אומרים מטיילים" for one world trail:
//
//   1. Wikipedia: how often its articles were read in the last 24 months, in
//      every language it has one (the article from the route's `wikidata` or
//      `wikipedia` tag). Free, and a fair measure of how well known it is —
//      but only famous trails have an article.
//   2. Review sites: one web search (Tavily) limited to AllTrails, Wikiloc,
//      Komoot, Outdooractive and Tripadvisor, and a small model that reads the
//      rating and the review count off the pages that are about this trail.
//
// Google's ratings were ruled out: its terms forbid storing them, and without
// storing them no list could be filtered by them. See README, "מה אומרים
// מטיילים".

import { fetchWmt } from '../wmtServer';
import type { WmtRouteDetails } from '../waymarked';
import { englishFromTags } from '../trailNames';
import { countryEnglish, tavilySearch, wikiByName } from '../trailInfo/sources';
import { extractRatings, REVIEW_DOMAINS, type TrailIdentity } from './extract';
import type { CrowdData } from './score';
import type { CountryTrail } from '../countryTrails';
import type { RegionInfo } from '../regions';

const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
// The articles read for pageviews, most-read languages first. A trail with
// articles in thirty languages is famous either way.
const MAX_ARTICLES = 12;
const PREFERRED_LANGS = ['en', 'de', 'fr', 'it', 'es', 'el', 'nl', 'pl', 'he', 'ru', 'pt', 'cs'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- third-party JSON, read defensively
async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

interface Article { lang: string; title: string }

// The Wikidata item behind a `wikipedia=lang:Title` tag.
async function qidFromArticle(lang: string, title: string): Promise<string | null> {
  const params = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', titles: title });
  const data = await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  return data?.query?.pages?.[0]?.pageprops?.wikibase_item ?? null;
}

async function articlesOf(qid: string): Promise<Article[]> {
  const params = new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: qid, props: 'sitelinks' });
  const data = await getJson(`https://www.wikidata.org/w/api.php?${params}`);
  const links: Record<string, { site: string; title: string }> = data?.entities?.[qid]?.sitelinks ?? {};
  const out: Article[] = [];
  for (const { site, title } of Object.values(links)) {
    const m = /^([a-z_-]+)wiki$/.exec(site);
    // "commonswiki", "specieswiki" and the like are not language editions.
    if (!m || ['commons', 'species', 'meta', 'simple', 'wikidata'].includes(m[1])) continue;
    out.push({ lang: m[1].replace(/_/g, '-'), title });
  }
  const rank = (l: string) => (PREFERRED_LANGS.indexOf(l) + 1 || 99);
  return out.sort((a, b) => rank(a.lang) - rank(b.lang)).slice(0, MAX_ARTICLES);
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function pageviews(a: Article): Promise<number> {
  const end = new Date();
  end.setUTCDate(1);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 24);
  const title = encodeURIComponent(a.title.replace(/ /g, '_'));
  const data = await getJson(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${a.lang}.wikipedia/all-access/user/${title}/monthly/${yyyymmdd(start)}00/${yyyymmdd(end)}00`
  );
  return (data?.items ?? []).reduce((n: number, it: { views?: number }) => n + (it.views ?? 0), 0);
}

// The articles come from the route's tags; failing those, from an English
// article whose title *is* the trail's name (as "על המסלול" finds them) —
// most routes in OSM carry no Wikipedia tag, even famous ones.
export async function wikipediaViews(details: WmtRouteDetails | null, nameEn: string | null): Promise<number> {
  const tags = details?.tags ?? {};
  let qid = /^Q\d+$/.test(tags.wikidata ?? '') ? tags.wikidata! : null;
  const wpTag = details?.wikipedia ?? tags.wikipedia;
  let wp: { lang: string; title: string } | null = null;
  // A tag ("en:Title"), or Waymarked Trails' own form: { en: "Title", … }.
  const first = typeof wpTag === 'string' ? wpTag : wpTag ? Object.entries(wpTag).map(([l, t]) => `${l}:${t}`)[0] : undefined;
  const m = first ? /^([a-z-]{2,12}):(.+)$/i.exec(first.trim()) : null;
  if (m) wp = { lang: m[1].toLowerCase(), title: m[2] };
  if (!qid && !wp && nameEn) wp = await wikiByName('en', nameEn);
  if (!qid && wp) qid = await qidFromArticle(wp.lang, wp.title);
  const articles = qid ? await articlesOf(qid) : wp ? [wp] : [];
  const views = await Promise.all(articles.map(pageviews));
  return views.reduce((a, b) => a + b, 0);
}

function searchQuery(t: TrailIdentity): string {
  const name = t.nameEn ?? t.name;
  const where = t.regions[0] ? `${t.regions[0]} ${t.country}` : t.country;
  return /trail|path|way|route|weg|sentiero|μονοπάτι/i.test(name)
    ? `${name} ${where} reviews`
    : `${name} hiking trail ${where} reviews`;
}

// Null when a paid step failed (search refused, every model failed) — the
// trail is then tried again on the next run rather than stored as unknown.
export async function collectCrowd(
  country: string,
  trail: CountryTrail,
  regions: Map<string, RegionInfo>
): Promise<CrowdData | null> {
  const details = (await fetchWmt(`/details/relation/${trail.id}`)) as WmtRouteDetails | null;
  const identity: TrailIdentity = {
    name: trail.name,
    nameEn: trail.name_en ?? englishFromTags(details?.tags) ?? null,
    country: countryEnglish(country),
    km: trail.km,
    regions: trail.regions.map((id) => regions.get(id)).filter(Boolean).map((r) => r!.latin ?? r!.name),
    multiDay: trail.multiDay,
  };

  const [views, results] = await Promise.all([
    wikipediaViews(details, identity.nameEn),
    tavilySearch(searchQuery(identity), { domains: REVIEW_DOMAINS, max: 6 }),
  ]);
  if (!results) return null;
  const sources = await extractRatings(identity, results);
  if (!sources) return null;

  return { id: trail.id, pageviews: views, sources, fetchedAt: new Date().toISOString() };
}
