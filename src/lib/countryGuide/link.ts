// Tying the trails of "אזורי טיול" to the marked routes the app can open.
//
// Each trail is looked up by name in Waymarked Trails (OpenStreetMap's marked
// routes, the same source as the world trails in the app), and a result is
// taken only if its name carries the trail's words — and its numbers: Alta
// Via 1 is not Alta Via 2 — and it lies in the trail's region. The route's
// line is kept, simplified, so the region on the map shows the real path.
//
// Free, but a community service: one request at a time, a pause between
// them, and only when a guide is written (or relinked with --link).

import { fetchWmt } from '../wmtServer';
import { mercatorToLonLat, type WmtRouteDetails, type WmtRouteSummary, type WmtSegment } from '../waymarked';
import type { GuideRegion, GuideTrail } from './types';
import { regionBounds } from './client';

const PAUSE_MS = 400;
// How close a route must come to the region (degrees, about 30 km).
const NEAR_DEG = 0.3;
// Simplification, in Web Mercator metres (roughly 70–100 m on the ground in
// Europe): plenty for a line drawn over a whole region.
const TOLERANCE_M = 120;
const MAX_POINTS = 1500;
// Most of the trail's words, not two of three: "Agia Roumeli–Loutro" is not
// "Western forts of Agia Roumeli".
const MIN_SCORE = 0.75;

let last = 0;
async function wmt(path: string): Promise<unknown | null> {
  const wait = last + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return fetchWmt(path, 30_000, false);
}

const STOP = new Set([
  'di', 'del', 'della', 'delle', 'dei', 'degli', 'de', 'la', 'le', 'il', 'lo', 'the', 'of', 'and', 'des', 'du', 'von', 'der',
  'die', 'das', 'el', 'los', 'las', 'trail', 'path', 'route', 'trek', 'trekking', 'tour', 'sentiero', 'loop', 'circuit',
  'giro', 'anello', 'hike', 'walk', 'via', 'nr', 'n', 'no', 'weg', 'camino', 'chemin', 'sentier', 'grande', 'grand', 'dell',
]);

function tokens(s: string): string[] {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    // "AV1", "E4", "GR20": the letters and the number apart.
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && (/^\d+$/.test(w) || (w.length >= 3 && !STOP.has(w))));
}

// How well a route's name answers one of the trail's: the share of the
// trail's words it holds, and nothing if a number differs.
export function nameScore(trailNames: string[], route: WmtRouteSummary): number {
  const routeTokens = new Set([...tokens(route.name ?? ''), ...tokens(route.ref ?? '')]);
  const routeNumbers = [...routeTokens].filter((w) => /^\d+$/.test(w));
  let best = 0;
  for (const n of trailNames) {
    const t = [...new Set(tokens(n))];
    const words = t.filter((w) => !/^\d+$/.test(w));
    const numbers = t.filter((w) => /^\d+$/.test(w));
    if (!words.length) continue;
    if (numbers.some((x) => !routeTokens.has(x))) continue;
    if (numbers.length && routeNumbers.some((x) => !numbers.includes(x))) continue;
    // A numbered route for an unnumbered trail ("Andros Route C2" for the
    // Andros Route) is likely one part of it: kept, but behind an unnumbered one.
    const hit = words.filter((w) => routeTokens.has(w)).length / words.length - (!numbers.length && routeNumbers.length ? 0.1 : 0);
    if (hit > best) best = hit;
  }
  return best;
}

function boxOf(details: WmtRouteDetails): [number, number, number, number] {
  const [w, s] = mercatorToLonLat(details.bbox[0], details.bbox[1]);
  const [e, n] = mercatorToLonLat(details.bbox[2], details.bbox[3]);
  return [w, s, e, n];
}

function overlaps(a: [number, number, number, number], b: [number, number, number, number], pad: number): boolean {
  return a[0] <= b[2] + pad && a[2] >= b[0] - pad && a[1] <= b[3] + pad && a[3] >= b[1] - pad;
}

function leafWays(segments: WmtSegment[]): [number, number][][] {
  return segments.flatMap((s) => (s.ways ? s.ways.map((w) => w.geometry?.coordinates ?? []) : leafWays(s.main ?? [])));
}

function perpendicular(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function simplify(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let far = -1, dist = 0;
    for (let k = i + 1; k < j; k++) {
      const d = perpendicular(pts[k], pts[i], pts[j]);
      if (d > dist) { dist = d; far = k; }
    }
    if (far > 0 && dist > tol) { keep[far] = 1; stack.push([i, far], [far, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

// The route as lines of [lon, lat]: its ways joined where they meet, then
// simplified until it is small enough to ship inside the guide.
export function routeLines(details: WmtRouteDetails): number[][][] {
  const ways = leafWays(details.route?.main ?? []).filter((w) => w.length >= 2);
  const runs: [number, number][][] = [];
  for (const w of ways) {
    const prev = runs[runs.length - 1];
    const end = prev?.[prev.length - 1];
    if (end && Math.hypot(end[0] - w[0][0], end[1] - w[0][1]) < 50) prev.push(...w.slice(1));
    else runs.push([...w]);
  }
  for (let tol = TOLERANCE_M; ; tol *= 2) {
    const lines = runs.map((r) => simplify(r, tol)).filter((r) => r.length >= 2);
    if (lines.reduce((n, l) => n + l.length, 0) <= MAX_POINTS || tol > 5000) {
      return lines.map((l) => l.map(([x, y]) => mercatorToLonLat(x, y).map((v) => Math.round(v * 1e4) / 1e4)));
    }
  }
}

export interface LinkResult {
  wmt: GuideTrail['wmt'];
  line: number[][][] | null;
  tried: string[];
}

export async function linkTrail(t: GuideTrail, aliases: string[], region: GuideRegion): Promise<LinkResult> {
  const names = [...new Set([t.nameLatin, ...aliases, t.name].filter((n) => n && /[A-Za-z]/.test(n)))];
  const box = regionBounds(region) ?? (t.start ? [t.start[0], t.start[1], t.start[0], t.start[1]] as [number, number, number, number] : null);
  if (!box || !names.length) return { wmt: null, line: null, tried: names };

  // The search ranks loosely ("Alta Via 2" alone brings other Alte Vie); the
  // region's name beside the trail's brings the right one up. (Asking for
  // more than 10 results returns fewer, not more.)
  const queries = [...new Set([`${t.nameLatin} ${region.nameLatin}`, ...names])].slice(0, 4);
  const candidates = new Map<number, { route: WmtRouteSummary; score: number }>();
  for (const q of queries) {
    const found = (await wmt(`/list/search?query=${encodeURIComponent(q)}&limit=10`)) as { results?: WmtRouteSummary[] } | null;
    for (const r of found?.results ?? []) {
      const score = nameScore(names, r);
      if (score >= MIN_SCORE && (candidates.get(r.id)?.score ?? 0) < score) candidates.set(r.id, { route: r, score });
    }
  }
  // The best name first; among equals, the trail of wider standing.
  const rank = (g: string) => ['IWN', 'NAT', 'REG', 'LOC'].indexOf(g);
  const ordered = [...candidates.values()].sort((a, b) => b.score - a.score || rank(a.route.group) - rank(b.route.group));
  for (const { route } of ordered.slice(0, 4)) {
    const details = (await wmt(`/details/relation/${route.id}`)) as WmtRouteDetails | null;
    if (!details?.bbox || !overlaps(boxOf(details), box, NEAR_DEG)) continue;
    return {
      wmt: { type: 'relation', id: route.id, name: route.name ?? t.nameLatin, group: route.group, linear: route.linear },
      line: routeLines(details),
      tried: names,
    };
  }
  return { wmt: null, line: null, tried: names };
}
