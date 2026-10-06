// From the model's JSON to a checked draft.
//
// A source stays only if it is a page the search returned — a model will
// otherwise cite a plausible address it never read. And a page cited for a
// trail or a region has to mention it: the overview this feature was modelled
// on cited a page about Corno Grande for the Path of the Gods, and one about
// the Path of the Gods for Selvaggio Blu. A page that cannot be read is given
// the benefit of the doubt — unless it does not exist (404, no such site),
// which is what an invented address looks like when the tool does not say
// what its search returned (Codex).

import { hostOf } from './client';

export interface DraftTrail {
  name: string;
  nameLatin: string;
  aliases: string[];
  body: string;
  sources: number[];
  start: string | null;
}

export interface DraftRegion {
  name: string;
  nameLatin: string;
  aliases: string[];
  where: string;
  body: string;
  sources: number[];
  provinces: string[];
  anchors: string[];
  trails: DraftTrail[];
}

export interface Draft {
  intro: string;
  introSources: number[];
  regions: DraftRegion[];
  closing: string;
  closingSources: number[];
  sources: { id: number; url: string; title: string }[];
}

// What the checks removed, for the comparison between models.
export interface SourceReport {
  cited: number;          // distinct sources the model listed
  notSearched: string[];  // listed, but never returned by the search
  dead: string[];         // no such page
  unread: string[];       // could not be fetched to check (kept)
  mismatched: { item: string; url: string }[]; // cited for something the page never mentions
  uncited: string[];      // paragraphs or trails left with no source at all
}

const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;

function clean(v: unknown): string {
  return typeof v === 'string'
    ? v.replace(NIQQUD, '').replace(/\*\*/g, '').replace(/\[(\d+)\]/g, '').replace(/[ \t]{2,}/g, ' ').trim()
    : '';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(clean).filter(Boolean) : [];
}

function ids(v: unknown): number[] {
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- model output, validated field by field
export function parseJson(text: string): any | null {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try { return JSON.parse(body.slice(first, last + 1)); } catch { return null; }
  }
}

export function toDraft(text: string): Draft | null {
  const d = parseJson(text);
  if (!d || !Array.isArray(d.regions)) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  const regions: DraftRegion[] = d.regions.flatMap((r: any) => {
    const name = clean(r?.name);
    const body = clean(r?.body);
    if (!name || body.length < 40) return [];
    return [{
      name, body,
      nameLatin: clean(r.nameLatin) || name,
      aliases: strings(r.aliases),
      where: clean(r.where),
      sources: ids(r.sources),
      provinces: strings(r.provinces),
      anchors: strings(r.anchors).slice(0, 10),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
      trails: (Array.isArray(r.trails) ? r.trails : []).flatMap((t: any) => {
        const tName = clean(t?.name);
        const tBody = clean(t?.body);
        if (!tName || tBody.length < 20) return [];
        return [{
          name: tName, body: tBody,
          nameLatin: clean(t.nameLatin) || tName,
          aliases: strings(t.aliases),
          sources: ids(t.sources),
          start: clean(t.start) || null,
        }];
      }),
    }];
  });
  if (!regions.length) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  const sources = (Array.isArray(d.sources) ? d.sources : []).flatMap((s: any) => {
    const id = Number(s?.id);
    const url = typeof s?.url === 'string' ? s.url.trim() : '';
    return Number.isInteger(id) && /^https?:\/\//.test(url) ? [{ id, url, title: clean(s.title) || hostOf(url) }] : [];
  });
  return {
    intro: clean(d.intro), introSources: ids(d.introSources),
    regions,
    closing: clean(d.closing), closingSources: ids(d.closingSources),
    sources,
  };
}

// The same page, however it was written: scheme, www, trailing slash,
// tracking parameters (OpenAI adds ?utm_source=openai) and fragments aside.
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$/.test(k)) u.searchParams.delete(k);
    const q = u.searchParams.toString();
    return `${u.hostname.replace(/^www\./, '')}${decodeURIComponent(u.pathname).replace(/\/$/, '')}${q ? `?${q}` : ''}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// Lower case, accents off: "Gorroppu" in "Gola di Gorroppu", "Dolomiti" in "DOLOMITI".
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Words too common to say which trail a page is about.
const STOP = new Set([
  'della', 'delle', 'degli', 'trail', 'route', 'trek', 'trekking', 'hiking', 'walk', 'circuit', 'tour', 'sentiero',
  'monte', 'mount', 'mountain', 'mountains', 'valle', 'valley', 'parco', 'national', 'nazionale', 'grande', 'great',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'coast', 'coastal', 'island',
  'lakes', 'river', 'alpine', 'alpes', 'traverse', 'crossing', 'camino', 'chemin', 'sentier', 'grand', 'high',
]);

// A page mentions an item when it holds one of its names, or for a long name
// its distinctive words (Selvaggio Blu → "selvaggio").
function mentions(page: string, names: string[]): boolean {
  for (const n of names) {
    const f = fold(n).trim();
    if (f.length >= 3 && page.includes(f)) return true;
    const words = f.split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w));
    if (words.length && words.some((w) => page.includes(w))) return true;
  }
  return false;
}

async function readPage(url: string): Promise<{ text: string | null; dead: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Navi-Trail-App; naveh@hamarag.com)', Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow',
    });
    if (res.status === 404 || res.status === 410) return { text: null, dead: true };
    if (!res.ok) return { text: null, dead: false };
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return { text: text.length > 500 ? fold(text) : null, dead: false };
  } catch (e) {
    // No such host is an invented address; a timeout is only a slow site.
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    return { text: null, dead: code === 'ENOTFOUND' };
  }
}

// searchedUrls: what the search returned, or null when the tool does not say.
export async function checkSources(draft: Draft, searchedUrls: string[] | null): Promise<{ draft: Draft; report: SourceReport }> {
  const searched = searchedUrls ? new Set(searchedUrls.map(urlKey)) : null;
  const report: SourceReport = { cited: draft.sources.length, notSearched: [], dead: [], unread: [], mismatched: [], uncited: [] };

  const fromSearch = draft.sources.filter((s) => {
    if (!searched || searched.has(urlKey(s.url))) return true;
    report.notSearched.push(s.url);
    return false;
  });

  const pages = new Map<number, string | null>();
  const dead = new Set<number>();
  await Promise.all(fromSearch.map(async (s) => {
    const page = await readPage(s.url);
    pages.set(s.id, page.text);
    if (page.dead) { dead.add(s.id); report.dead.push(s.url); } else if (!page.text) report.unread.push(s.url);
  }));
  const kept = fromSearch.filter((s) => !dead.has(s.id));
  const keptIds = new Set(kept.map((s) => s.id));

  const byId = new Map(kept.map((s) => [s.id, s]));
  const check = (label: string, list: number[], names: string[] | null): number[] => {
    const out = list.filter((id) => {
      if (!keptIds.has(id)) return false;
      const page = pages.get(id);
      if (!names || !page || mentions(page, names)) return true;
      report.mismatched.push({ item: label, url: byId.get(id)!.url });
      return false;
    });
    if (!out.length) report.uncited.push(label);
    return out;
  };

  const regions = draft.regions.map((r) => ({
    ...r,
    sources: check(r.name, r.sources, [r.nameLatin, ...r.aliases]),
    trails: r.trails.map((t) => ({ ...t, sources: check(`${r.name} › ${t.name}`, t.sources, [t.nameLatin, t.name, ...t.aliases]) })),
  }));
  const introSources = check('פתיחה', draft.introSources, null);
  const closingSources = check('סיכום', draft.closingSources, null);

  // Only the sources still cited are kept, numbered afresh in reading order.
  const order: number[] = [];
  const note = (list: number[]) => { for (const id of list) if (!order.includes(id)) order.push(id); };
  note(introSources);
  for (const r of regions) { note(r.sources); for (const t of r.trails) note(t.sources); }
  note(closingSources);
  const renumber = new Map(order.map((id, i) => [id, i + 1]));
  const re = (list: number[]) => list.map((id) => renumber.get(id)!).filter(Boolean);

  return {
    report,
    draft: {
      intro: draft.intro, introSources: re(introSources),
      regions: regions.map((r) => ({ ...r, sources: re(r.sources), trails: r.trails.map((t) => ({ ...t, sources: re(t.sources) })) })),
      closing: draft.closing, closingSources: re(closingSources),
      sources: order.map((id, i) => ({ ...byId.get(id)!, id: i + 1 })),
    },
  };
}
