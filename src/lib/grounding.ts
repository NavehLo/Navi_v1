// Real sources for the narration.
//
// A language model handed nothing but a latitude, a longitude and a POI type
// has no facts to offer, so it falls back on the only thing it can produce:
// scenery adjectives. This module gives it something to work from. In Israel
// almost every stream, ruin, spring and memorial has a Hebrew Wikipedia
// article with dates, names and events in it, and OpenStreetMap has already
// told us which article that is.
//
// Both APIs are free and need no key, and both are called from the server so
// CORS never enters into it. Every failure here is silent: no sources simply
// means the prompt says so and forbids inventing any.

const WIKI_API = 'https://he.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

// Wikimedia's user-agent policy asks for a descriptive agent with contact info.
const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';

const GEOSEARCH_RADIUS_M = 2000;
const GEOSEARCH_LIMIT = 4;
const MAX_TOTAL_CHARS = 1500;
const MAX_EXTRACT_CHARS = 700;
const TIMEOUT_MS = 8000;

export interface GroundingSource {
  title: string;
  url: string;
  extract: string;
  via: 'wikipedia-tag' | 'wikidata' | 'geosearch';
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
// points at an article in another language — worth one extra free call.
async function hebrewTitleFromWikidata(id: string): Promise<string | null> {
  const data = await wikiFetch(WIKIDATA_API, {
    action: 'wbgetentities',
    ids: id,
    props: 'sitelinks',
    sitefilter: 'hewiki',
  });
  return data?.entities?.[id]?.sitelinks?.hewiki?.title ?? null;
}

async function geosearchTitles(lat: number, lon: number): Promise<string[]> {
  const data = await wikiFetch(WIKI_API, {
    action: 'query',
    list: 'geosearch',
    gscoord: `${lat}|${lon}`,
    gsradius: String(GEOSEARCH_RADIUS_M),
    gslimit: String(GEOSEARCH_LIMIT),
  });
  return (data?.query?.geosearch ?? []).map((r: any) => r.title as string);
}

// OSM tags that are facts in themselves, phrased for a Hebrew prompt.
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

export interface GroundingInput {
  lat: number;
  lon: number;
  tags?: Record<string, string> | null;
}

// Never throws and never blocks the narration: an empty result is a valid one.
export async function gatherGrounding(input: GroundingInput): Promise<Grounding> {
  const tags = input.tags ?? {};
  const osmFacts = osmFactsFrom(tags);
  const sources: GroundingSource[] = [];

  try {
    // 1. The element names its own article — by far the most reliable path.
    let taggedTitle = hebrewTitleFromTag(tags.wikipedia);
    let via: GroundingSource['via'] = 'wikipedia-tag';
    if (!taggedTitle && tags.wikidata) {
      taggedTitle = await hebrewTitleFromWikidata(tags.wikidata);
      via = 'wikidata';
    }

    if (taggedTitle) {
      const extracts = await fetchExtracts([taggedTitle]);
      for (const [title, extract] of extracts) {
        sources.push({ title, url: articleUrl(title), extract, via });
      }
    }

    // 2. Nothing tagged, or the tagged article turned out to be missing — ask
    //    Wikipedia what it knows about this patch of ground instead.
    if (sources.length === 0) {
      const titles = await geosearchTitles(input.lat, input.lon);
      const extracts = await fetchExtracts(titles);
      for (const title of titles) {
        const extract = extracts.get(title);
        if (extract) sources.push({ title, url: articleUrl(title), extract, via: 'geosearch' });
      }
    }
  } catch (e) {
    console.error('Grounding failed, continuing without sources:', e);
  }

  // Keep the prompt bounded — the first sources are the most relevant ones.
  const bounded: GroundingSource[] = [];
  let total = 0;
  for (const source of sources) {
    if (total + source.extract.length > MAX_TOTAL_CHARS) break;
    bounded.push(source);
    total += source.extract.length;
  }

  return { sources: bounded, osmFacts };
}

// The block handed to the model, and null when there is nothing to hand over.
export function groundingPromptBlock(g: Grounding): string | null {
  const parts: string[] = [];
  if (g.osmFacts.length > 0) {
    parts.push('נתונים מ-OpenStreetMap על הנקודה:\n' + g.osmFacts.map((f) => `- ${f}`).join('\n'));
  }
  if (g.sources.length > 0) {
    parts.push(
      'מקורות מוויקיפדיה העברית:\n' +
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
