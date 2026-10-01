// Reading a trail's own website.
//
// An official trail site is the best source there is — sections, how to get
// there, where to sleep — but its facts are spread over a dozen pages and
// wrapped in menus, footers and cookie banners. This reads the home page, the
// pages most likely to hold the facts a walker needs, and only their text.
//
// No HTML parser: the pages are read once per trail and handed to a language
// model, which copes with a stray menu line far better than a parser copes
// with the HTML of an arbitrary small-town tourism site.

const USER_AGENT = 'Mozilla/5.0 (compatible; Navi-Trail-App/1.0; +mailto:naveh@hamarag.com)';
const PAGE_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_PAGE_CHARS = 5000;

export interface PageText {
  url: string;
  title: string;
  text: string;
}

interface FetchedPage {
  url: string;
  html: string;
}

export async function fetchHtml(url: string, timeoutMs = PAGE_TIMEOUT_MS): Promise<FetchedPage | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'he,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    if (!/html/i.test(res.headers.get('content-type') ?? 'text/html')) return null;
    const html = await res.text();
    return { url: res.url || url, html: html.slice(0, MAX_HTML_BYTES) };
  } catch {
    return null;
  }
}

// ── robots.txt ────────────────────────────────────────────────────────────────
// Only the `User-agent: *` group, and only Disallow prefixes: enough to stay
// out of what a site has asked crawlers to stay out of.
const robotsCache = new Map<string, string[]>();

async function disallowedPrefixes(origin: string): Promise<string[]> {
  const known = robotsCache.get(origin);
  if (known) return known;
  const rules: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
        if (!m) continue;
        const field = m[1].toLowerCase();
        if (field === 'user-agent') applies = m[2].trim() === '*';
        else if (applies && field === 'disallow' && m[2].trim()) rules.push(m[2].trim());
      }
    }
  } catch { /* no robots.txt is permission */ }
  if (robotsCache.size > 200) robotsCache.delete(robotsCache.keys().next().value!);
  robotsCache.set(origin, rules);
  return rules;
}

export async function robotsAllows(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const rules = await disallowedPrefixes(u.origin);
    const path = u.pathname + u.search;
    // "*" matches anything and a trailing "$" (left unescaped) anchors the end.
    return !rules.some((r) => {
      const pattern = r.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${pattern}`).test(path);
    });
  } catch {
    return false;
  }
}

// ── HTML → text ───────────────────────────────────────────────────────────────
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function siteName(html: string): string {
  return decodeEntities(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? '').trim();
}

function pageTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html);
  const t = decodeEntities(og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  // "Section 1: Stemnitsa-Dimitsana - Menalon Trail" — the site's name on
  // every page says nothing in a list of that site's pages.
  const site = siteName(html);
  if (!site) return t;
  const stripped = t.replace(new RegExp(`\\s*[-–|·:]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').trim();
  return stripped || t;
}

export function htmlToText(html: string): string {
  const body = /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|select|button|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|dd|dt|blockquote)>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n## ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => l.replace(/^(##|•)\s*/, '').length > 2)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = cut.lastIndexOf('\n');
  return (stop > max * 0.6 ? cut.slice(0, stop) : cut) + '\n…';
}

// ── Links ─────────────────────────────────────────────────────────────────────
interface Link {
  url: string;
  text: string;
  order: number;
}

const SKIP_PATH = /\/(wp-json|feed|comments|author|tag|privacy|cookie|login|register|cart|checkout|account|search|wp-login|xmlrpc)(\/|$)|\.(pdf|jpe?g|png|gif|webp|zip|gpx|kml|kmz|mp4|mp3|docx?|xlsx?)$/i;

function sameSite(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
}

function internalLinks(html: string, base: string): Link[] {
  const baseUrl = new URL(base);
  const seen = new Set<string>();
  const out: Link[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let u: URL;
    try { u = new URL(decodeEntities(m[1]), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u, baseUrl)) continue;
    u.hash = '';
    // Filter parameters (?portfolioCats=21) make the same page twice.
    u.search = '';
    const key = u.href.replace(/\/$/, '');
    if (seen.has(key) || key === baseUrl.href.replace(/[?#].*$/, '').replace(/\/$/, '') || SKIP_PATH.test(u.pathname)) continue;
    seen.add(key);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    out.push({ url: u.href, text, order: out.length });
  }
  return out;
}

// What a walker needs to know, in the languages trail sites are written in.
// The anchor text and the URL path are both searched: a Greek site's English
// version still has English paths, and a Hebrew site often has English slugs.
const KEYWORDS: Array<[RegExp, number]> = [
  [/section|stage|etap|étape|tappa|etapa|leg\b|קטע|מקטע|שלב/i, 5],
  [/route|trail|itinerar|path|weg|sentier|sendero|percorso|מסלול|שביל/i, 3],
  [/how[-_ ]?to[-_ ]?get|getting[-_ ]?there|access|arriv|transport|bus|taxi|transfer|anreise|הגעה|תחבורה/i, 5],
  [/general[-_ ]?info|about|information|overview|faq|practical|info\b|מידע|אודות|שאלות/i, 4],
  [/accommodat|lodging|hotel|hostel|refuge|hut|camp|sleep|guesthouse|unterkunft|hébergement|לינה|חניון|אכסני/i, 4],
  [/water|spring|מים|מעיין/i, 3],
  [/map|gps|gpx|download|מפה|מפות/i, 2],
  [/geograph|nature|natural|flora|fauna|environment|history|culture|village|region|טבע|היסטוריה|כפר|אזור/i, 2],
  [/safety|season|weather|when|equipment|gear|difficult|בטיחות|עונה|ציוד|קושי/i, 4],
];

const NOISE = /press|news|blog|shop|store|gallery|video|event|offer|volunteer|contact|partner|sponsor|donat|newsletter|library|מבצע|חנות|גלריה|צור[-_ ]?קשר/i;

// A link's score, and the topic it most likely covers (index into KEYWORDS).
function scoreLink(l: Link): { score: number; topic: number } {
  let path = new URL(l.url).pathname;
  try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
  const hay = `${l.text} ${path.replace(/[-_/]/g, ' ')}`;
  let score = 0;
  let topic = -1;
  KEYWORDS.forEach(([re, w], i) => {
    if (!re.test(hay)) return;
    score += w;
    if (topic < 0 || w > KEYWORDS[topic][1]) topic = i;
  });
  if (NOISE.test(hay)) score -= 4;
  return { score, topic };
}

// The best page on each topic first, then the rest by score — otherwise a
// site with eight "Section n" pages fills every slot with sections and the
// pages on getting there and where to sleep are never read.
function pickLinks(links: Link[], max: number): Link[] {
  const scored = links.map((l) => ({ l, ...scoreLink(l) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.l.order - b.l.order);
  const picked: Link[] = [];
  for (let topic = 0; topic < KEYWORDS.length; topic++) {
    const best = scored.find((x) => x.topic === topic && !picked.includes(x.l));
    if (best) picked.push(best.l);
  }
  for (const x of scored) if (!picked.includes(x.l)) picked.push(x.l);
  return picked.slice(0, max);
}

// The version of the site in the language the reader is most likely to get
// the most out of: Hebrew if there is one, else English. menalontrail.eu
// opens in Greek and says where its English pages are.
function preferredLanguageUrl(html: string, url: string): string | null {
  const alternates = new Map<string, string>();
  const re = /<link\b[^>]*rel=["']alternate["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const lang = /hreflang=["']([^"']+)/i.exec(m[0])?.[1]?.toLowerCase();
    const href = /href=["']([^"']+)/i.exec(m[0])?.[1];
    if (lang && href) alternates.set(lang.split('-')[0], decodeEntities(href));
  }
  const pageLang = /<html[^>]*\blang=["']([a-z]{2})/i.exec(html)?.[1]?.toLowerCase();
  for (const want of ['he', 'iw', 'en']) {
    if (pageLang === want) return null;
    const href = alternates.get(want);
    if (href) {
      try { return new URL(href, url).href; } catch { return null; }
    }
  }
  // No hreflang tags — but a language switcher pointing at "/en/" says the
  // same thing.
  const base = new URL(url);
  for (const want of ['he', 'en']) {
    const re = new RegExp(`href=["']((?:https?://${base.hostname.replace(/\./g, '\\.')})?/${want}/?)["']`, 'i');
    const m = re.exec(html);
    if (m) {
      try { return new URL(m[1], url).href; } catch { /* next */ }
    }
  }
  return null;
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

// Lines that appear on more than one page are the site's furniture — menus,
// footers, cookie notices — and are dropped everywhere but the first page.
function dropRepeatedLines(pages: PageText[]): PageText[] {
  const count = new Map<string, number>();
  for (const p of pages) for (const l of new Set(p.text.split('\n'))) count.set(l, (count.get(l) ?? 0) + 1);
  return pages.map((p, i) =>
    i === 0 ? p : { ...p, text: p.text.split('\n').filter((l) => (count.get(l) ?? 0) < 2 || l.startsWith('## ')).join('\n') }
  );
}

export interface CrawlOptions {
  maxPages?: number;
  maxChars?: number;
  // Set when the site belongs to an organisation rather than to the trail —
  // a nature park, a national trails body — given as the trail's names. Only
  // pages that mention the trail are read then: the Turkish routes society's
  // pages on the Sufi Trail are not a source about the Lycian Way.
  topic?: string[];
}

function squash(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

function linkPath(url: string): string {
  const path = new URL(url).pathname;
  try { return decodeURIComponent(path); } catch { return path; }
}

function mentions(text: string, topic: string[]): boolean {
  const hay = squash(text);
  return topic.some((name) => {
    const n = squash(name);
    return n.length >= 4 && hay.includes(n);
  });
}

interface FetchedText extends PageText {
  html: string;
}

async function fetchTexts(links: Link[]): Promise<FetchedText[]> {
  const allowed = await Promise.all(links.map((l) => robotsAllows(l.url)));
  const pages = await inBatches(links.filter((_, i) => allowed[i]), 4, async (l) => {
    const page = await fetchHtml(l.url);
    return page ? { url: page.url, html: page.html, title: pageTitle(page.html) || l.text, text: htmlToText(page.html) } : null;
  });
  return pages.filter((p): p is FetchedText => !!p && p.text.length > 200);
}

export async function crawlSite(startUrl: string, { maxPages = 12, maxChars = 50_000, topic }: CrawlOptions = {}): Promise<PageText[]> {
  if (!(await robotsAllows(startUrl))) return [];
  let home = await fetchHtml(startUrl);
  if (!home) return [];

  const better = preferredLanguageUrl(home.html, home.url);
  if (better && better !== home.url && (await robotsAllows(better))) {
    home = (await fetchHtml(better)) ?? home;
  }

  // The home page is titled "Main" or "Home"; the site's name says more.
  const homePage: PageText = { url: home.url, title: siteName(home.html) || pageTitle(home.html), text: htmlToText(home.html) };
  const links = internalLinks(home.html, home.url);
  let pages: PageText[];

  if (topic?.length) {
    const relevant = (l: Link) => {
      const hay = `${l.text} ${linkPath(l.url)}`;
      return mentions(hay, topic) && !NOISE.test(hay);
    };
    const first = await fetchTexts(links.filter(relevant).slice(0, 4));
    // The trail's own pages lead on to its sections, maps and practical
    // pages — beneath it on the site, or named after it.
    const seen = new Set([home.url, ...first.map((p) => p.url)]);
    const deeper = first.flatMap((p) =>
      internalLinks(p.html, p.url).filter((l) => {
        if (seen.has(l.url) || !(relevant(l) || l.url.startsWith(p.url.replace(/\/?$/, '/')))) return false;
        seen.add(l.url);
        return true;
      })
    );
    const room = Math.max(0, maxPages - first.length);
    const ranked = pickLinks(deeper, room);
    const more = await fetchTexts(ranked.length ? ranked : deeper.slice(0, room));
    pages = [
      ...(mentions(homePage.text, topic) ? [homePage] : []),
      ...first,
      ...more.filter((p) => mentions(p.text, topic)),
    ].map(({ url, title, text }) => ({ url, title, text }));
  } else {
    let picked = pickLinks(links, maxPages);
    // A site whose links say nothing in the languages above — its menu, in
    // order, is still the best guess at what it considers important.
    if (picked.length < 3) picked = [...picked, ...links.filter((l) => !picked.includes(l) && !NOISE.test(l.text))];
    const subpages = await fetchTexts(picked.slice(0, maxPages));
    pages = [homePage, ...subpages.map(({ url, title, text }) => ({ url, title, text }))];
  }

  let budget = maxChars;
  const out: PageText[] = [];
  for (const p of dropRepeatedLines(pages)) {
    if (budget < 500) break;
    const text = capText(p.text, Math.min(MAX_PAGE_CHARS, budget));
    if (text.length < 80) continue;
    out.push({ ...p, text });
    budget -= text.length;
  }
  return out;
}
