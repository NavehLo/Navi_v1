// Finding what is known about a trail, best source first.
//
//   1. official  the trail's own website (OSM `website`, Wikidata P856) — or,
//                for the Israeli trails, the Nakeb page they were taken from
//   2. wikipedia Hebrew, English and the local language; Wikivoyage
//   3. osm       the route's own tags: description, operator, marking
//   4. web       a web search (Tavily), only when 1–2 found too little
//
// Every source carries a tier so the model can prefer the better one when two
// disagree, and so the reader can see where each fact came from.

import type { SourceTier, TrailInfoRequest } from './types';
import { crawlSite, fetchHtml, htmlToText, decodeEntities } from './crawl';
import { fetchWmt } from '../wmtServer';
import type { WmtRouteDetails } from '../waymarked';
import { englishFromTags } from '../trailNames';
import { countriesFor } from '../trailCountry';

const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
const TIMEOUT_MS = 8000;
const MAX_ARTICLE_CHARS = 8000;
// Below this many characters from tiers 1–2 a web search is worth its credit.
const ENOUGH_CHARS = 1500;

export interface CollectedSource {
  id: number;
  tier: SourceTier;
  title: string;
  url?: string;
  text: string;
}

export interface CollectedTrail {
  name: string;
  nameEn: string | null;
  countries: string[];
  // What is known for certain from the map itself: length, marking, operator.
  facts: string[];
  sources: CollectedSource[];
}

class SourceList {
  private items: CollectedSource[] = [];
  private urls = new Set<string>();
  add(tier: SourceTier, title: string, text: string, url?: string): void {
    const clean = text.trim();
    if (clean.length < 40) return;
    const key = url?.replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '');
    if (key && this.urls.has(key)) return;
    if (key) this.urls.add(key);
    this.items.push({ id: this.items.length + 1, tier, title, url, text: clean });
  }
  get chars(): number {
    return this.items.filter((s) => s.tier !== 'osm').reduce((n, s) => n + s.text.length, 0);
  }
  hasOfficial(): boolean {
    return this.items.some((s) => s.tier === 'official');
  }
  list(): CollectedSource[] {
    return this.items;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely shaped third-party JSON, read defensively
async function getJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function withinTime<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

function trim(text: string, max: number): string {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

// ── Wikipedia / Wikidata ──────────────────────────────────────────────────────
interface WikiRef {
  lang: string;
  title: string;
  project: 'wikipedia' | 'wikivoyage';
}

function wikiUrl(ref: WikiRef): string {
  return `https://${ref.lang}.${ref.project}.org/wiki/${encodeURIComponent(ref.title.replace(/ /g, '_'))}`;
}

async function wikiArticle(ref: WikiRef): Promise<{ title: string; text: string } | null> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', prop: 'extracts', explaintext: '1',
    redirects: '1', titles: ref.title,
  });
  const data = await getJson(`https://${ref.lang}.${ref.project}.org/w/api.php?${params}`);
  const page = data?.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;
  // The tail of an article is references and links, not facts.
  const text = String(page.extract).split(/\n==\s*(References|Notes|External links|See also|הערות שוליים|קישורים חיצוניים|ראו גם|לקריאה נוספת)\s*==/i)[0];
  return { title: page.title, text: trim(text, MAX_ARTICLE_CHARS) };
}

function parseWikipediaTag(value: string | Record<string, string> | undefined): WikiRef[] {
  if (!value) return [];
  const entries = typeof value === 'string' ? [value] : Object.entries(value).map(([l, t]) => `${l}:${t}`);
  return entries.flatMap((v) => {
    const m = /^([a-z-]{2,12}):(.+)$/i.exec(v.trim());
    return m ? [{ lang: m[1].toLowerCase(), title: m[2].trim(), project: 'wikipedia' as const }] : [];
  });
}

interface WikidataFacts {
  officialSites: string[];
  articles: WikiRef[];
}

async function wikidataFacts(qid: string, localLang: string | null): Promise<WikidataFacts> {
  const params = new URLSearchParams({ action: 'wbgetentities', format: 'json', ids: qid, props: 'claims|sitelinks' });
  const data = await getJson(`https://www.wikidata.org/w/api.php?${params}`);
  const entity = data?.entities?.[qid];
  const out: WikidataFacts = { officialSites: [], articles: [] };
  if (!entity) return out;
  for (const c of entity.claims?.P856 ?? []) {
    const v = c?.mainsnak?.datavalue?.value;
    if (typeof v === 'string') out.officialSites.push(v);
  }
  const langs = ['he', 'en', ...(localLang && !['he', 'en'].includes(localLang) ? [localLang] : [])];
  for (const lang of langs) {
    const wp = entity.sitelinks?.[`${lang}wiki`]?.title;
    if (wp) out.articles.push({ lang, title: wp, project: 'wikipedia' });
  }
  for (const lang of ['he', 'en']) {
    const wv = entity.sitelinks?.[`${lang}wikivoyage`]?.title;
    if (wv) out.articles.push({ lang, title: wv, project: 'wikivoyage' });
  }
  return out;
}

// An article found by searching is accepted only if its title *is* the
// trail's name — a search for "Menalon Trail" otherwise returns the article
// about a village that mentions it once.
async function wikiByName(lang: string, name: string): Promise<WikiRef | null> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', list: 'search', srsearch: name, srlimit: '5',
  });
  const data = await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const want = norm(name);
  const hit = (data?.query?.search ?? []).find((r: { title: string }) => norm(r.title.replace(/\s*\(.*\)$/, '')) === want);
  return hit ? { lang, title: hit.title, project: 'wikipedia' } : null;
}

// ── Countries ────────────────────────────────────────────────────────────────
// The ISO code of the country holding most of the route, to the language its
// Wikipedia is likely written in. Only for countries where that is clear.
const COUNTRY_LANG: Record<string, string> = {
  GR: 'el', IT: 'it', FR: 'fr', ES: 'es', PT: 'pt', DE: 'de', AT: 'de', CH: 'de', NL: 'nl', PL: 'pl',
  CZ: 'cs', SK: 'sk', SI: 'sl', HR: 'hr', RO: 'ro', BG: 'bg', TR: 'tr', NO: 'no', SE: 'sv', FI: 'fi',
  DK: 'da', JP: 'ja', GE: 'ka', AM: 'hy', HU: 'hu', RS: 'sr', CY: 'el', IL: 'he', JO: 'ar', MA: 'ar',
};

function countryEnglish(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ── Web search (Tavily) ───────────────────────────────────────────────────────
// 1,000 free searches a month. Unlike Google's grounding, results may be kept,
// so each trail is searched once and the answer serves everyone after.
interface WebResult {
  url: string;
  title: string;
  content: string;
}

async function webSearch(query: string): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const data = await getJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 6, include_raw_content: 'text' }),
  });
  return (data?.results ?? [])
    .map((r: { url?: string; title?: string; raw_content?: string; content?: string }) => ({
      url: r.url ?? '',
      title: r.title ?? '',
      content: (r.raw_content || r.content || '').trim(),
    }))
    .filter((r: WebResult) => r.url && r.content);
}

// A result whose domain carries the trail's name is very likely its own site
// ("menalontrail.eu" for "Menalon Trail").
function looksOfficial(url: string, names: string[]): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  const squash = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const domain = squash(host.split('.').slice(0, -1).join(''));
  return names.some((n) => {
    const words = n.toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['trail', 'path', 'route', 'way', 'the'].includes(w));
    return words.length > 0 && words.every((w) => domain.includes(squash(w)));
  });
}

const SKIP_WEB = /(facebook|instagram|tiktok|youtube|pinterest|twitter|x)\.com|tripadvisor\.|booking\.com|wikipedia\.org|wikivoyage\.org/i;

async function addWebResults(list: SourceList, query: string, names: string[]): Promise<void> {
  const results = (await webSearch(query)).filter((r) => !SKIP_WEB.test(r.url));
  const official = results.find((r) => looksOfficial(r.url, names));
  if (official && !list.hasOfficial()) await addOfficialSite(list, official.url, names);
  for (const r of results.slice(0, 5)) {
    if (r === official && list.hasOfficial()) continue;
    list.add('web', r.title || new URL(r.url).hostname, trim(r.content, 4000), r.url);
  }
}

// ── Official site ─────────────────────────────────────────────────────────────
// A site named after the trail is read broadly; any other — the operator's,
// a park's — only where it talks about this trail.
async function addOfficialSite(list: SourceList, url: string, names: string[]): Promise<void> {
  const topic = looksOfficial(url, names) ? undefined : names;
  const pages = await withinTime(crawlSite(url, { topic }), 18_000, []);
  for (const p of pages) list.add('official', p.title || new URL(p.url).hostname, p.text, p.url);
}

// ── World trails ─────────────────────────────────────────────────────────────
async function collectWmt(id: number): Promise<CollectedTrail | null> {
  const [details, countriesById] = await Promise.all([
    fetchWmt(`/details/relation/${id}?locale=he`) as Promise<WmtRouteDetails | null>,
    withinTime(countriesFor([id]), 4000, new Map<number, string[]>()),
  ]);
  if (!details) return null;
  const tags = details.tags ?? {};
  const name = details.name ?? tags.name ?? `מסלול ${id}`;
  const nameEn = englishFromTags(tags);
  const countries = countriesById.get(id) ?? [];
  const localLang = countries[0] ? COUNTRY_LANG[countries[0]] ?? null : null;

  const facts: string[] = [];
  if (details.route?.length) facts.push(`אורך לפי המפה: ${(details.route.length / 1000).toFixed(1)} ק"מ`);
  if (countries.length) {
    const he = new Intl.DisplayNames(['he'], { type: 'region' });
    facts.push(`מדינה: ${countries.map((c) => he.of(c) ?? c).join(', ')}`);
  }
  if (details.operator) facts.push(`מפעיל: ${details.operator}`);
  if (details.symbol_description) facts.push(`סימון: ${details.symbol_description}`);
  if (tags.network) facts.push(`רמת רשת (OSM network): ${tags.network}`);
  if (tags.ref) facts.push(`מספר שביל: ${tags.ref}`);
  if (tags.roundtrip) facts.push(`מעגלי: ${tags.roundtrip === 'yes' ? 'כן' : 'לא'}`);
  if (tags.from || tags.to) facts.push(`מ: ${tags.from ?? '?'} אל: ${tags.to ?? '?'}`);

  const list = new SourceList();

  // Tier 1: the trail's own website.
  const wikidata = tags.wikidata && /^Q\d+$/.test(tags.wikidata)
    ? await wikidataFacts(tags.wikidata, localLang)
    : { officialSites: [], articles: [] };
  const sites = [tags.website, tags['contact:website'], tags.url, details.url, ...wikidata.officialSites]
    .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
  const names = [nameEn, name, tags.ref].filter((n): n is string => !!n);
  if (sites[0]) await addOfficialSite(list, sites[0], names);

  // Tier 2: encyclopedias.
  let articles = [...parseWikipediaTag(details.wikipedia ?? tags.wikipedia), ...wikidata.articles];
  if (!articles.some((a) => a.project === 'wikipedia')) {
    const byName = await Promise.all([
      nameEn ? wikiByName('en', nameEn) : wikiByName('en', name),
      localLang && localLang !== 'en' ? wikiByName(localLang, name) : Promise.resolve(null),
    ]);
    articles = [...articles, ...byName.filter((a): a is WikiRef => !!a)];
  }
  const seen = new Set<string>();
  articles = articles.filter((a) => {
    const k = `${a.project}:${a.lang}:${a.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 4);
  const texts = await Promise.all(articles.map(wikiArticle));
  articles.forEach((a, i) => {
    const t = texts[i];
    // The URL of the article reached, not the one asked for, so two titles
    // that redirect to the same article are read once.
    if (t) list.add(a.project, `${t.title} (${a.project === 'wikipedia' ? 'ויקיפדיה' : 'ויקימסע'}, ${a.lang})`, t.text, wikiUrl({ ...a, title: t.title }));
  });

  // Tier 3: the route's own description in OSM.
  const descriptions = [tags['description:he'], tags['description:en'], details.description, tags.description, tags.note]
    .filter((d, i, all): d is string => !!d && all.indexOf(d) === i);
  if (descriptions.length) list.add('osm', 'OpenStreetMap', descriptions.join('\n'), `https://www.openstreetmap.org/relation/${id}`);

  // Tier 4: the web, when the above said too little.
  if (list.chars < ENOUGH_CHARS) {
    const where = countries[0] ? ` ${countryEnglish(countries[0])}` : '';
    const searchName = nameEn ?? name;
    const query = /trail|path|way|route|weg|sentiero|μονοπάτι/i.test(searchName)
      ? `${searchName}${where} hiking`
      : `${searchName} hiking trail${where}`;
    await addWebResults(list, query, [nameEn, name].filter((n): n is string => !!n));
  }

  return { name, nameEn, countries, facts, sources: list.list() };
}

// ── Israeli trails (Nakeb) ────────────────────────────────────────────────────
// The page has the trail's details, the walk described step by step and
// readers' comments; the rest is the site's menus and "similar trails".
function nakebText(html: string): string {
  const start = html.search(/<h1\b/i);
  const endMarkers = ['מסלולי הליכה דומים', 'class="bg_gray'];
  const end = Math.min(...endMarkers.map((m) => html.indexOf(m, start)).filter((i) => i > 0), html.length);
  const segment = html.slice(Math.max(0, start), end)
    .replace(/<a\b[^>]*>\s*מכירים קישור[\s\S]*?<\/a>/i, '')
    .replace(/הוסף לרשימה|הוספת דירוג|הוספת תגובה|מפת המסלול|הדמיה תלת מימדית/g, '');
  return htmlToText(`<body>${segment}</body>`);
}

// Links readers attached to the trail: blog posts and articles about it.
function nakebExternalLinks(html: string): string[] {
  const start = html.search(/<h1\b/i);
  const end = html.indexOf('מסלולי הליכה דומים', start);
  html = html.slice(Math.max(0, start), end > 0 ? end : html.length);
  const out: string[] = [];
  const re = /<a\b[^>]*href=["']?(https?:\/\/[^"'\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = decodeEntities(m[1]);
    if (/nakeb\.co\.il|google\.|facebook\.|whatsapp|twitter|instagram|waze|moovit|apple\.com|bootstrap|fonts\.|browsehappy|israelhiking|amudanan|govmap|off-road/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, 3);
}

// Hebrew Wikipedia articles about the places a trail is named after: "נחל
// כזיב", "מבצר יחיעם". Taken only when the article sits near the trail, so a
// namesake elsewhere is not mistaken for it.
const PLACE_WORDS = new Set([
  'נחל', 'הר', 'עין', 'מעיין', 'חרבת', 'חורבת', 'תל', 'יער', 'מבצר', 'מערת', 'מצפה', 'גבעת', 'ואדי', 'מעלה',
  'קניון', 'בריכת', 'מנזר', 'רכס', 'בקעת', 'עמק', 'הרי', 'מכתש', 'גב', 'גבי', 'שמורת', 'פארק', 'אגם', 'מצד',
]);

function placeCandidates(text: string, includeWhole: boolean): string[] {
  // "למנזר", "ומצפה", "ממצפה" → the place word without its prefix letter.
  const words = text.replace(/[,.:;!?()\-–"]/g, ' ').split(/\s+/).filter(Boolean).map((w) => {
    const bare = w.replace(/^[ולמהב]/, '');
    return !PLACE_WORDS.has(w) && PLACE_WORDS.has(bare) ? bare : w;
  });
  const out = includeWhole ? [text.trim()] : [];
  words.forEach((w, i) => {
    if (!PLACE_WORDS.has(w)) return;
    for (const len of [2, 3]) {
      const span = words.slice(i, i + len);
      if (span.length === len && !span.slice(1).some((x) => /^ו/.test(x) || x === 'אל')) out.push(span.join(' '));
    }
  });
  return [...new Set(out)];
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return Math.hypot((lat2 - lat1) * 111, (lon2 - lon1) * 111 * Math.cos((lat1 * Math.PI) / 180));
}

// Two kinds of candidate. A place the trail is *named* after ("נחל סער") is
// taken even when its article has no coordinates — many stream articles have
// none, and the trail's name already ties it to the place. A place merely
// mentioned in the description ("הר רם") must have coordinates within 10 km
// of the trail's start, or it could be a namesake anywhere in the country.
async function hebrewPlaceArticles(name: string, description: string, lat?: number, lon?: number): Promise<WikiRef[]> {
  const fromName = placeCandidates(name, true);
  const fromText = description
    .split('\n')
    .flatMap((line) => placeCandidates(line, false))
    .filter((c) => !fromName.includes(c));
  const titles = [...new Set([...fromName, ...fromText])].slice(0, 45);
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1', prop: 'coordinates|pageprops',
    ppprop: 'disambiguation', titles: titles.join('|'),
  });
  const data = await getJson(`https://he.wikipedia.org/w/api.php?${params}`);

  // What each returned title was asked as, through normalisation and redirects.
  const askedAs = new Map<string, string>();
  for (const n of [...(data?.query?.normalized ?? []), ...(data?.query?.redirects ?? [])]) {
    askedAs.set(n.to, askedAs.get(n.from) ?? n.from);
  }
  const named: WikiRef[] = [];
  const mentioned: WikiRef[] = [];
  for (const page of data?.query?.pages ?? []) {
    if (page.missing || page.pageprops?.disambiguation !== undefined) continue;
    const asked = askedAs.get(page.title) ?? page.title;
    const c = page.coordinates?.[0];
    const near = c && lat != null && lon != null ? distanceKm(lat, lon, c.lat, c.lon) <= 10 : null;
    const ref = { lang: 'he', title: page.title, project: 'wikipedia' as const };
    if (fromName.includes(asked)) {
      if (near !== false) named.push(ref);
    } else if (near === true) {
      mentioned.push(ref);
    }
  }
  return [...named, ...mentioned].slice(0, 4);
}

async function collectNakeb(req: Extract<TrailInfoRequest, { kind: 'nakeb' }>): Promise<CollectedTrail> {
  const list = new SourceList();
  const pageUrl = `https://www.nakeb.co.il/hike/${req.id}`;
  const page = await fetchHtml(pageUrl);
  if (page) list.add('nakeb', `${req.name} — נאקב`, trim(nakebText(page.html), 8000), pageUrl);

  const description = page ? nakebText(page.html) : '';
  const refs = await hebrewPlaceArticles(req.name, description, req.lat, req.lon);
  const texts = await Promise.all(refs.map(wikiArticle));
  refs.forEach((r, i) => {
    const t = texts[i];
    if (t) list.add('wikipedia', `${t.title} (ויקיפדיה)`, trim(t.text, 5000), wikiUrl(r));
  });

  // Reader-added links on Nakeb, read like any web result.
  for (const link of page ? nakebExternalLinks(page.html) : []) {
    const linked = await fetchHtml(link, 6000);
    if (linked) list.add('web', new URL(linked.url).hostname, trim(htmlToText(linked.html), 4000), linked.url);
  }

  if (list.chars < ENOUGH_CHARS) await addWebResults(list, `${req.name} מסלול טיול`, []);

  return { name: req.name, nameEn: null, countries: ['IL'], facts: [], sources: list.list() };
}

export async function collectSources(req: TrailInfoRequest): Promise<CollectedTrail | null> {
  return req.kind === 'wmt' ? collectWmt(req.id) : collectNakeb(req);
}
