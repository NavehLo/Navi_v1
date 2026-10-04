// Reading a trail's rating and review count off review-site pages found by a
// web search. AllTrails, Wikiloc and the rest have no public API, but their
// pages state the numbers ("4.7 · 1,240 reviews"), and a small model can read
// them — and, more importantly, tell whether the page is about *this* trail
// or another one with a similar name.
//
// The free Gemini tier first, then gpt-4.1-mini; well under a cent a trail.

import { generateTextWithFallback, textProviderChain, type TextEngine } from '../narration';
import type { WebResult } from '../trailInfo/sources';
import type { CrowdSource } from './score';

export interface TrailIdentity {
  name: string;
  nameEn: string | null;
  country: string;          // English
  km: number;
  regions: string[];        // Latin names where known
  multiDay: boolean;
}

const SITES: Array<[RegExp, string]> = [
  [/alltrails\./, 'AllTrails'],
  [/wikiloc\./, 'Wikiloc'],
  [/komoot\./, 'Komoot'],
  [/outdooractive\./, 'Outdooractive'],
  [/tripadvisor\./, 'Tripadvisor'],
];

export const REVIEW_DOMAINS = ['alltrails.com', 'wikiloc.com', 'komoot.com', 'outdooractive.com', 'tripadvisor.com'];

function siteOf(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return SITES.find(([re]) => re.test(host))?.[1] ?? null;
}

const SYSTEM_PROMPT = [
  'You read search results from hiking review sites and report the user rating and number of reviews of ONE specific trail.',
  '',
  'For each numbered result decide first whether the page is about the same trail:',
  '- "yes": clearly this trail (same name or a known alternative name, same area, length roughly matching — a page about one section/stage of a long trail is NOT the same trail unless the trail itself is that section).',
  '- "unsure": could be, but the name, place or length does not clearly match.',
  '- "no": a different trail, a list of many trails, a region page, or a page with no rating.',
  '',
  'Then copy the numbers exactly as written on the page — never estimate or invent:',
  '- rating: the average user rating as a number (e.g. 4.7), or null if none is shown.',
  '- scale: the maximum of that rating scale (5 for stars/bubbles, 10 if out of 10).',
  '- reviews: the number of reviews/ratings the average is based on (e.g. "1,240 reviews" -> 1240). For Komoot, the number of people who recommend it. null if not shown.',
  '',
  'Judge every result on its own — several results may be about the same trail (e.g. on different sites), and each of them gets "yes".',
  '',
  'Return JSON only, with exactly one entry per result, in order (n = 1, 2, 3 …), including the "no" ones:',
  '{"results": [{"n": 1, "same": "yes|unsure|no", "rating": 4.7, "scale": 5, "reviews": 1240}]}',
].join('\n');

function userPrompt(t: TrailIdentity, results: WebResult[]): string {
  const head = [
    `Trail: ${t.nameEn && t.nameEn !== t.name ? `${t.nameEn} (local name: ${t.name})` : t.name}`,
    `Country: ${t.country}`,
    t.regions.length ? `Area: ${t.regions.join(', ')}` : null,
    `Length: about ${Math.round(t.km)} km${t.multiDay ? ', a multi-day trail' : ''}`,
  ].filter(Boolean);
  const body = results.map((r, i) => `=== Result ${i + 1} | ${r.url} | ${r.title} ===\n${r.content}`);
  return [...head, '', ...body].join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- model output, checked field by field
function parseJson(text: string): any | null {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(body);
  } catch {
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
  }
}

function engines(): TextEngine[] {
  const cheap = textProviderChain('gemini-free').filter((e) => e === 'gemini-free' || e === 'openai');
  return cheap.length ? cheap : textProviderChain();
}

// The head of a page is where the rating sits; the rest is other trails,
// photos and comments.
const PAGE_CHARS = 2500;

// Null when the model could not be asked (no key, every engine failed) —
// distinct from [] (asked, nothing found), so a failure is retried later
// rather than stored as "no reviews".
export async function extractRatings(t: TrailIdentity, results: WebResult[]): Promise<CrowdSource[] | null> {
  const usable = results
    .filter((r) => siteOf(r.url))
    .map((r) => ({
      ...r,
      content: r.snippet && !r.content.startsWith(r.snippet)
        ? `${r.snippet}\n…\n${r.content.slice(0, PAGE_CHARS)}`
        : r.content.slice(0, PAGE_CHARS),
    }));
  if (usable.length === 0) return [];

  let text: string;
  try {
    ({ text } = await generateTextWithFallback(engines(), SYSTEM_PROMPT, userPrompt(t, usable), {
      json: true,
      maxTokens: 800,
      timeoutMs: 25_000,
      openaiModel: process.env.TRAIL_INFO_OPENAI_MODEL || 'gpt-4.1-mini',
    }));
  } catch (e) {
    console.error('Trail crowd extraction failed:', e);
    return null;
  }
  const data = parseJson(text);
  if (!Array.isArray(data?.results)) return null;

  // One entry per site: a site's several pages about the same trail are the
  // same hikers, so the largest is kept rather than the sum.
  const bySite = new Map<string, CrowdSource>();
  for (const r of data.results) {
    const page = usable[Number(r?.n) - 1];
    if (!page || r?.same !== 'yes') continue;
    const site = siteOf(page.url)!;
    const count = Math.round(Number(r.reviews));
    if (!Number.isFinite(count) || count < 1) continue;
    const scale = Number(r.scale) > 0 ? Number(r.scale) : 5;
    const raw = r.rating == null ? null : Number(r.rating);
    const rating = raw != null && Number.isFinite(raw) && raw > 0 && raw <= scale
      ? Math.round((raw / scale) * 5 * 100) / 100
      : null;
    const prev = bySite.get(site);
    if (!prev || count > prev.count) bySite.set(site, { site, url: page.url, rating, count });
  }
  return [...bySite.values()];
}
