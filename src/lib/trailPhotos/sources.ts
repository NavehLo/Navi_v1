// Where the photos of a trail come from — free sources only, each with its
// licence and author:
//
//   Wikimedia Commons  photos placed where the camera stood. Includes most of
//                      Panoramio, and much of Flickr and Geograph, copied in
//                      under CC licences. The main source, in Israel and abroad.
//   Panoramax          open street-level imagery. Little off the road, and
//                      almost none in Israel, but now and then a frame of a
//                      village street or a track the trail follows in Europe.
//   The trail's own    a world trail's OSM `wikimedia_commons` / `image` tag,
//                      or its Wikidata image, shown first when there is one.
//
// Mapillary was tried and dropped: on the trails checked (Makhtesh Ramon,
// Nahal Amud, the Tre Cime) it covers the roads and nothing of the paths.
//
// Commons answers 429 to a burst of anonymous requests, so the searches go
// one after another, few per trail (see searchBoxes), with a descriptive agent.

import type { Candidate, Spot } from './select';
import type { PhotoSource } from './types';

const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const PANORAMAX_API = 'https://api.panoramax.xyz/api';
const TIMEOUT_MS = 12000;
// Wide enough for the strip; Commons serves only its standard widths.
const THUMB_W = 500;
const FULL_W = 1280;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One request to a MediaWiki API, waiting out a 429 once or twice — within
// the route's minute.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers' shapes differ by action
async function wiki(api: string, params: Record<string, string>, deadline: number): Promise<any | null> {
  const url = `${api}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) {
        const wait = (Number(res.headers.get('retry-after')) || 5) * 1000 + 500;
        if (Date.now() + wait > deadline) return null;
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        console.error('Commons API error:', res.status, url.slice(0, 200));
        return null;
      }
      return await res.json();
    } catch (e) {
      console.error('Commons API request failed:', e);
      return null;
    }
  }
  return null;
}

// ── Wikimedia Commons ───────────────────────────────────────────────────────

// Every geotagged file inside each box, as points — the cheap part. A box is
// [south, west, north, east].
// `complete` is false when a box could not be searched (Commons refused or
// the time ran out): what was found is real, but a part may look empty that
// is not.
export async function commonsSpots(boxes: Array<[number, number, number, number]>, deadline: number): Promise<{ spots: Spot[]; complete: boolean }> {
  const seen = new Map<string, Spot>();
  let complete = true;
  for (let i = 0; i < boxes.length; i++) {
    if (Date.now() > deadline) { complete = false; break; }
    if (i > 0) await sleep(700);
    const [s, w, n, e] = boxes[i];
    const data = await wiki(COMMONS_API, {
      action: 'query',
      list: 'geosearch',
      gsbbox: `${n}|${w}|${s}|${e}`,
      gsnamespace: '6',
      gslimit: '500',
    }, deadline);
    if (!data?.query) complete = false;
    for (const g of data?.query?.geosearch ?? []) {
      if (typeof g.title !== 'string' || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
      seen.set(g.title, { id: `commons:${g.title}`, source: 'commons', lat: g.lat, lon: g.lon, title: g.title });
    }
  }
  return { spots: [...seen.values()], complete };
}

function plain(html: unknown): string {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The tracking query Commons now appends to its links is not part of them.
function bare(url: string): string {
  return url.split('?')[0];
}

interface CommonsInfo {
  title: string;
  author: string;
  license: string;
  takenAt: string | null;
  width: number;
  height: number;
  mime: string;
  categories: string[];
  thumb: string;
  full: string;
  pageUrl: string;
}

// Author, licence, size and the picture's links for up to 50 files a request.
// A file with no licence named is left out: it cannot be shown with one.
export async function commonsInfo(titles: string[], deadline: number): Promise<Map<string, CommonsInfo>> {
  const out = new Map<string, CommonsInfo>();
  for (let i = 0; i < titles.length; i += 50) {
    if (Date.now() > deadline) break;
    if (i > 0) await sleep(500);
    const data = await wiki(COMMONS_API, {
      action: 'query',
      titles: titles.slice(i, i + 50).join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: String(THUMB_W),
      iiextmetadatafilter: 'Artist|LicenseShortName|DateTimeOriginal|Categories',
    }, deadline);
    for (const page of data?.query?.pages ?? []) {
      const ii = page?.imageinfo?.[0];
      const meta = ii?.extmetadata ?? {};
      const license = plain(meta.LicenseShortName?.value);
      if (!ii?.url || !license) continue;
      const thumb = bare(ii.thumburl ?? ii.url);
      const full = ii.width > FULL_W && ii.thumburl
        ? thumb.replace(`/${THUMB_W}px-`, `/${FULL_W}px-`)
        : bare(ii.url);
      const taken = plain(meta.DateTimeOriginal?.value);
      out.set(page.title, {
        title: page.title,
        author: plain(meta.Artist?.value).slice(0, 120) || 'לא ידוע',
        license,
        takenAt: /^\d{4}-\d{2}-\d{2}/.test(taken) ? taken.slice(0, 19) : null,
        width: ii.width,
        height: ii.height,
        mime: ii.mime ?? '',
        categories: plain(meta.Categories?.value).split('|').map((c) => c.trim()).filter(Boolean),
        thumb,
        full,
        pageUrl: bare(ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`),
      });
    }
  }
  return out;
}

export function commonsCandidate(spot: Spot, info: CommonsInfo): Candidate {
  return { ...spot, ...info, title: info.title };
}

// ── Panoramax ───────────────────────────────────────────────────────────────

interface PanoramaxFeature {
  id: string;
  collection?: string;
  geometry?: { coordinates?: [number, number] };
  assets?: Record<string, { href?: string }>;
  providers?: Array<{ name?: string }>;
  properties?: {
    datetime?: string;
    license?: string;
    'geovisio:producer'?: string;
    'pers:interior_orientation'?: { field_of_view?: number; sensor_array_dimensions?: [number, number] };
  };
}

// "CC-BY-SA-4.0" → "CC BY-SA 4.0", as Commons writes it.
function licenseName(id: string | undefined): string {
  if (!id) return '';
  const m = /^CC-(BY(?:-SA|-ND|-NC)*)-(\d\.\d)$/i.exec(id);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/^etalab/i.test(id)) return 'Licence Ouverte 2.0';
  return id;
}

// Street-level frames in each box. A 360° frame is left out: shown flat it is
// a warped strip, not a view.
export async function panoramaxCandidates(boxes: Array<[number, number, number, number]>, deadline: number): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();
  await Promise.all(boxes.map(async ([s, w, n, e]) => {
    if (Date.now() > deadline) return;
    try {
      const res = await fetch(`${PANORAMAX_API}/search?bbox=${w},${s},${e},${n}&limit=500`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json, application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { features?: PanoramaxFeature[] };
      for (const f of body.features ?? []) {
        const [lon, lat] = f.geometry?.coordinates ?? [NaN, NaN];
        const thumb = f.assets?.thumb?.href;
        const full = f.assets?.sd?.href ?? f.assets?.hd?.href;
        const license = licenseName(f.properties?.license);
        const orient = f.properties?.['pers:interior_orientation'];
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !thumb || !full || !license) continue;
        if ((orient?.field_of_view ?? 0) >= 180) continue;
        const [w0, h0] = orient?.sensor_array_dimensions ?? [2048, 1536];
        out.set(f.id, {
          id: `panoramax:${f.id}`,
          source: 'panoramax' as PhotoSource,
          lat, lon,
          group: f.collection,
          author: f.providers?.[0]?.name ?? f.properties?.['geovisio:producer'] ?? 'Panoramax',
          takenAt: f.properties?.datetime ?? null,
          width: w0,
          height: h0,
          license,
          pageUrl: `https://api.panoramax.xyz/#focus=pic&pic=${f.id}`,
          thumb,
          full,
          mime: 'image/jpeg',
        });
      }
    } catch (e) {
      console.error('Panoramax request failed:', e);
    }
  }));
  return [...out.values()];
}

// ── The trail's own photo ───────────────────────────────────────────────────

// A world trail's tags name a Commons file (`wikimedia_commons=File:…`, or an
// `image=` link to one), or a Wikidata item whose image (P18) is the trail's.
// Written as Commons writes its titles ("File:Foo bar.jpg"), so the answer
// about it can be found by title.
function fileTitle(name: string): string {
  const bareName = name.replace(/^File:/i, '').replace(/_/g, ' ').trim();
  return `File:${bareName.charAt(0).toUpperCase()}${bareName.slice(1)}`;
}

export async function heroTitle(tags: Record<string, string> | undefined, deadline: number): Promise<string | null> {
  const found = await heroName(tags, deadline);
  return found ? fileTitle(found) : null;
}

async function heroName(tags: Record<string, string> | undefined, deadline: number): Promise<string | null> {
  if (!tags) return null;
  const commons = tags.wikimedia_commons;
  if (commons && /^File:/i.test(commons)) return commons;
  const image = tags.image;
  const fromLink = image && /commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/i.exec(image)?.[1];
  if (fromLink) return decodeURIComponent(fromLink);
  const qid = tags.wikidata;
  if (qid && /^Q\d+$/.test(qid)) {
    const data = await wiki(WIKIDATA_API, { action: 'wbgetclaims', entity: qid, property: 'P18' }, deadline);
    const file = data?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof file === 'string' && file) return file;
  }
  return null;
}
