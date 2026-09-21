// Real sources for the narration.
//
// A language model handed nothing but a latitude, a longitude and a POI type
// has no facts to offer, so it falls back on the only thing it can produce:
// scenery adjectives. This module gives it something to work from. In Israel
// almost every stream, ruin, spring and memorial has a Hebrew Wikipedia
// article with dates, names and events in it, and OpenStreetMap has often
// already told us which article that is.
//
// It also answers the question that decides whether a point is narrated at
// all: is there an article *about this point*? An article about the kibbutz
// two kilometres away is not. Sources found by proximity alone used to be fed
// to the model, which then narrated the neighbourhood as if it were the
// spring; now a point with no source of its own is simply not a guide point.
//
// Both APIs are free and need no key, and both are called from the server so
// CORS never enters into it. Every failure here is silent: no sources simply
// means there is nothing to narrate.

const WIKI_API = 'https://he.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

// Wikimedia's user-agent policy asks for a descriptive agent with contact info.
const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';

// An article found by the point's *name* is accepted only if it sits near the
// point. "עין גדי" the spring and "עין גדי" the kibbutz share a name; the
// coordinates are what tell them apart. Generous, because a ruin's article is
// often pinned to the tell as a whole and a stream's to somewhere along it.
const MAX_ARTICLE_DISTANCE_KM = 3;
const MAX_TOTAL_CHARS = 1500;
const MAX_EXTRACT_CHARS = 700;
const TIMEOUT_MS = 8000;
// The API accepts up to 50 titles or ids per query.
const BATCH = 50;

export interface GroundingSource {
  title: string;
  url: string;
  extract: string;
  via: 'wikipedia-tag' | 'wikidata' | 'name';
}

export interface Grounding {
  sources: GroundingSource[];
  osmFacts: string[];
}

async function wikiFetch(api: string, params: Record<string, string>): Promise<any | null> {
  try {
    const url = `${api}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('Wikipedia API error:', res.status, url);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('Wikipedia API request failed:', e);
    return null;
  }
}

function articleUrl(title: string): string {
  return `https://he.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function trimExtract(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_EXTRACT_CHARS) return clean;
  // Cut on a sentence boundary rather than mid-word, so the model isn't fed
  // a fact that stops halfway through.
  const cut = clean.slice(0, MAX_EXTRACT_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > MAX_EXTRACT_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut + '…';
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pulls the lead section of one or more Hebrew articles.
async function fetchExtracts(titles: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (titles.length === 0) return found;

  const data = await wikiFetch(WIKI_API, {
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    redirects: '1',
    titles: titles.join('|'),
  });

  for (const page of data?.query?.pages ?? []) {
    if (page.missing || !page.extract) continue;
    found.set(page.title, trimExtract(page.extract));
  }
  return found;
}

// The `wikipedia` tag is "he:כותרת" or, on some elements, a bare title or a
// title in another language. Only a Hebrew title can be read directly.
function hebrewTitleFromTag(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^([a-z-]{2,10}):(.+)$/i.exec(value.trim());
  if (!match) return value.trim();
  return match[1].toLowerCase() === 'he' ? match[2].trim() : null;
}

// A wikidata id resolves to the Hebrew article even when the wikipedia tag
// points at an article in another language — worth one free call per batch.
async function hebrewTitlesFromWikidata(ids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const batch of chunks(ids, BATCH)) {
    const data = await wikiFetch(WIKIDATA_API, {
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'sitelinks',
      sitefilter: 'hewiki',
    });
    for (const id of batch) {
      const title = data?.entities?.[id]?.sitelinks?.hewiki?.title;
      if (title) found.set(id, title);
    }
  }
  return found;
}

interface ArticlePage {
  title: string; // the canonical title, after redirects
  disambiguation: boolean;
  coord: { lat: number; lon: number } | null;
}

// Looks titles up, following redirects, and reports for each requested title
// the page it lands on — or nothing when there is no such article.
async function lookupPages(titles: string[]): Promise<Map<string, ArticlePage>> {
  const found = new Map<string, ArticlePage>();
  for (const batch of chunks(titles, BATCH)) {
    const data = await wikiFetch(WIKI_API, {
      action: 'query',
      prop: 'coordinates|pageprops',
      ppprop: 'disambiguation',
      redirects: '1',
      titles: batch.join('|'),
    });
    if (!data?.query) continue;

    const byCanonical = new Map<string, ArticlePage>();
    for (const page of data.query.pages ?? []) {
      if (page.missing || page.invalid) continue;
      const coords: Array<{ lat: number; lon: number; primary?: boolean }> = page.coordinates ?? [];
      const c = coords.find((x) => x.primary) ?? coords[0];
      byCanonical.set(page.title, {
        title: page.title,
        disambiguation: page.pageprops?.disambiguation !== undefined,
        coord: c ? { lat: c.lat, lon: c.lon } : null,
      });
    }
    // Map each requested spelling back through normalisation and redirects.
    const forward = new Map<string, string>();
    for (const n of data.query.normalized ?? []) forward.set(n.from, n.to);
    for (const r of data.query.redirects ?? []) forward.set(r.from, r.to);
    for (const requested of batch) {
      let title = requested;
      for (let hops = 0; hops < 3 && forward.has(title); hops++) title = forward.get(title)!;
      const page = byCanonical.get(title);
      if (page) found.set(requested, page);
    }
  }
  return found;
}

export interface ArticleCandidate {
  name?: string | null;
  lat: number;
  lon: number;
  tags?: Record<string, string> | null;
}

export interface ResolvedArticle {
  title: string;
  via: GroundingSource['via'];
}

// The Hebrew Wikipedia article about each candidate, or null when there is
// none. Batched, because POI discovery asks about a whole trail at once and
// each answer is one of at most three API calls for all of them together.
//
// Three ways in, most reliable first: the element names its article, the
// element names its Wikidata item, or the element's own name is an article
// title — the last accepted only when the article's coordinates put it at the
// point, so a namesake elsewhere in the country is not mistaken for it.
export async function resolveArticles(candidates: ArticleCandidate[]): Promise<(ResolvedArticle | null)[]> {
  const results: (ResolvedArticle | null)[] = candidates.map(() => null);
  if (candidates.length === 0) return results;

  try {
    const wanted = new Map<number, { title: string; via: GroundingSource['via']; checkDistance: boolean }>();

    // 1. Tagged Hebrew titles.
    const wikidataNeeded: number[] = [];
    candidates.forEach((c, i) => {
      const tags = c.tags ?? {};
      const tagged = hebrewTitleFromTag(tags.wikipedia);
      if (tagged) wanted.set(i, { title: tagged, via: 'wikipedia-tag', checkDistance: false });
      else if (tags.wikidata) wikidataNeeded.push(i);
    });

    // 2. Wikidata items, for elements tagged in another language or not at all.
    if (wikidataNeeded.length > 0) {
      const titles = await hebrewTitlesFromWikidata(
        [...new Set(wikidataNeeded.map((i) => candidates[i].tags!.wikidata))]
      );
      for (const i of wikidataNeeded) {
        const title = titles.get(candidates[i].tags!.wikidata);
        if (title) wanted.set(i, { title, via: 'wikidata', checkDistance: false });
      }
    }

    // 3. The name itself, for everything still unresolved.
    candidates.forEach((c, i) => {
      const name = c.name?.trim();
      if (!wanted.has(i) && name) wanted.set(i, { title: name, via: 'name', checkDistance: true });
    });

    if (wanted.size === 0) return results;

    // One lookup verifies all of them: tagged titles can point at deleted or
    // renamed pages, and a name can be a disambiguation page or an article
    // about somewhere else with the same name.
    const pages = await lookupPages([...new Set([...wanted.values()].map((w) => w.title))]);
    for (const [i, w] of wanted) {
      const page = pages.get(w.title);
      if (!page || page.disambiguation) continue;
      if (w.checkDistance) {
        const c = candidates[i];
        if (!page.coord || distanceKm(c.lat, c.lon, page.coord.lat, page.coord.lon) > MAX_ARTICLE_DISTANCE_KM) continue;
      }
      results[i] = { title: page.title, via: w.via };
    }
  } catch (e) {
    console.error('Article resolution failed:', e);
  }
  return results;
}

// OSM tags that are facts about the point in themselves, phrased for a Hebrew
// prompt. Elevation, operator and heritage grade are kept as colour but do not
// on their own make a point worth stopping for — see `hasOwnFacts`.
function osmFactsFrom(tags: Record<string, string>): string[] {
  const facts: string[] = [];
  const push = (label: string, value?: string) => {
    if (value) facts.push(`${label}: ${value}`);
  };
  push('תיאור', tags['description:he'] || tags.description);
  push('שנת הקמה', tags.start_date);
  push('גובה מעל פני הים (מטרים)', tags.ele);
  push('מעמד שימור', tags.heritage);
  push('כתובת החקוקה במקום', tags.inscription);
  push('תרבות/תקופה', tags['historic:civilization']);
  push('מפעיל האתר', tags.operator);
  return facts;
}

// A description has to be long enough to carry a fact or two. "מוצב על
// פסגת ההר" is a caption, and a model given only a caption pads it out with
// what a military post usually is — which is the generic narration this
// filter exists to keep out.
const MIN_DESCRIPTION_CHARS = 80;
const MIN_INSCRIPTION_CHARS = 60;

// Whether the element's own tags say something specific about it — a written
// description, or the text carved on a memorial. A height in metres is not a
// story.
export function hasOwnFacts(tags: Record<string, string> | null | undefined): boolean {
  if (!tags) return false;
  const description = (tags['description:he'] || tags.description || '').trim();
  const inscription = (tags.inscription || '').trim();
  return description.length >= MIN_DESCRIPTION_CHARS || inscription.length >= MIN_INSCRIPTION_CHARS;
}

export interface GroundingInput {
  lat: number;
  lon: number;
  name?: string | null;
  tags?: Record<string, string> | null;
}

// Never throws: an empty result is a valid one, and it means "do not narrate".
export async function gatherGrounding(input: GroundingInput): Promise<Grounding> {
  const tags = input.tags ?? {};
  const osmFacts = osmFactsFrom(tags);
  const sources: GroundingSource[] = [];

  try {
    const [article] = await resolveArticles([input]);
    if (article) {
      const extracts = await fetchExtracts([article.title]);
      for (const [title, extract] of extracts) {
        sources.push({ title, url: articleUrl(title), extract, via: article.via });
      }
    }
  } catch (e) {
    console.error('Grounding failed, continuing without sources:', e);
  }

  // Keep the prompt bounded.
  const bounded: GroundingSource[] = [];
  let total = 0;
  for (const source of sources) {
    if (total + source.extract.length > MAX_TOTAL_CHARS) break;
    bounded.push(source);
    total += source.extract.length;
  }

  return { sources: bounded, osmFacts };
}

// Is there anything specific to say about this point? An article about it, or
// a description of it in its own tags. Anything less and the model would have
// to fill the gap with "a place that invites you to feel the power of nature",
// which is the narration this exists to prevent.
export function isWorthNarrating(g: Grounding, tags?: Record<string, string> | null): boolean {
  return g.sources.length > 0 || hasOwnFacts(tags);
}

// The block handed to the model, and null when there is nothing to hand over.
export function groundingPromptBlock(g: Grounding): string | null {
  const parts: string[] = [];
  if (g.osmFacts.length > 0) {
    parts.push(
      'נתונים מ-OpenStreetMap על הנקודה. אלה כל העובדות הידועות — אל תרחיב מעבר להן ואל תסיק מהן מה "בדרך כלל" יש במקום כזה:\n' +
        g.osmFacts.map((f) => `- ${f}`).join('\n')
    );
  }
  if (g.sources.length > 0) {
    parts.push(
      'מקורות מוויקיפדיה העברית על הנקודה עצמה:\n' +
        g.sources.map((s) => `— מתוך הערך "${s.title}":\n${s.extract}`).join('\n\n')
    );
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// Stored alongside the narration so it can be checked after the fact against
// what the guide actually said. Extracts are left out — they are long, and the
// titles plus urls are enough to go back to the source.
export function sourcesForStorage(g: Grounding): unknown {
  return {
    wikipedia: g.sources.map((s) => ({ title: s.title, url: s.url, via: s.via })),
    osm: g.osmFacts,
  };
}
