// "תמונות מהמסלול": which photos show a trail. Decided here only — the route
// gathers candidates and asks the free model about the pictures; every rule of
// what is kept, how many, and from where lives in this file. Pure functions:
// scripts/checkPhotos.mjs runs them on fixed trails after any change.
//
// The rule that matters most is spread. The trail is cut into equal parts by
// distance, and at most one photo is taken from each part — so 165 photos of
// one ruin become one photo, and an empty part stays empty (nothing is moved
// in from a richer part to fill it). Photos taken at the same spot and moment,
// or that the model says show the same view, count as one: only one of them
// can ever be chosen.

import { MAX_PHOTOS, segmentCount, type PhotoSource } from './types';

// ── The trail as a line ─────────────────────────────────────────────────────

export interface Line {
  pts: [number, number][]; // [lat, lon]
  acc: number[];           // km along the line at each point
  lengthKm: number;
}

const R_KM = 6371;

function havKm(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// A jump longer than this between two points is a gap in the line (a missing
// piece of a world trail), not walked distance.
const GAP_KM = 2;

export function makeLine(coords: [number, number][]): Line {
  const pts = coords.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = havKm(pts[i - 1], pts[i]);
    acc.push(acc[i - 1] + (d < GAP_KM ? d : 0));
  }
  return { pts, acc, lengthKm: acc[acc.length - 1] ?? 0 };
}

// Where a point falls on the line: the distance along it, and how far off it
// the point is (to the nearest segment, not the nearest vertex — the line the
// server gets is thinned to a few hundred points).
export function project(line: Line, lat: number, lon: number): { km: number; offM: number } {
  const kx = Math.cos(lat * Math.PI / 180) * 111.32; // km per degree of longitude here
  const ky = 110.57;                                 // km per degree of latitude
  let best = { km: 0, offM: Infinity };
  for (let i = 0; i < line.pts.length; i++) {
    const a = line.pts[i];
    const b = line.pts[i + 1] ?? a;
    const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky;
    const bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    const off = Math.sqrt(px * px + py * py) * 1000;
    if (off < best.offM) {
      const segKm = (line.acc[i + 1] ?? line.acc[i]) - line.acc[i];
      best = { km: line.acc[i] + t * segKm, offM: off };
    }
  }
  return best;
}

// The part of the trail a distance along it falls in.
export function segmentOf(km: number, lengthKm: number, segments: number): number {
  if (lengthKm <= 0) return 0;
  return Math.min(segments - 1, Math.max(0, Math.floor((km / lengthKm) * segments)));
}

// The trail split into stretches for the photo searches: one for a short
// trail, one per part for a long one (a single box over a long trail would be
// cut off at 500 results, all of them from its busiest place). Each is
// [south, west, north, east], padded by the corridor.
export const ONE_BOX_KM = 15;

export function searchBoxes(line: Line, padM: number): Array<[number, number, number, number]> {
  const segments = segmentCount(line.lengthKm);
  const groups: [number, number][][] = line.lengthKm < ONE_BOX_KM
    ? [line.pts]
    : Array.from({ length: segments }, (_, s) =>
        line.pts.filter((_, i) => {
          const at = segmentOf(line.acc[i], line.lengthKm, segments);
          // Each box reaches one point into its neighbours, so no stretch of
          // line between two parts is left out of both.
          const prev = i > 0 ? segmentOf(line.acc[i - 1], line.lengthKm, segments) : at;
          const next = i < line.pts.length - 1 ? segmentOf(line.acc[i + 1], line.lengthKm, segments) : at;
          return at === s || prev === s || next === s;
        }));
  const padLat = padM / 111_000;
  return groups.filter((g) => g.length).map((g) => {
    const lats = g.map((p) => p[0]);
    const lons = g.map((p) => p[1]);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const padLon = padM / (111_000 * Math.max(0.2, Math.cos(midLat * Math.PI / 180)));
    return [Math.min(...lats) - padLat, Math.min(...lons) - padLon, Math.max(...lats) + padLat, Math.max(...lons) + padLon];
  });
}

// ── Candidates ──────────────────────────────────────────────────────────────

// How far from the line a photo may have been taken. A photo on Commons is
// placed where its camera stood, often on a ridge or a lookout above the
// path, and still shows the trail's country; a street-level frame on
// Panoramax shows only what is in front of it, so it has to be on the path.
export const CORRIDOR_M: Record<PhotoSource, number> = { commons: 700, panoramax: 50 };

export interface Spot {
  id: string;
  source: PhotoSource;
  lat: number;
  lon: number;
  title?: string;     // the file's name, for Commons
  group?: string;     // the Panoramax sequence it belongs to
}

export interface Placed<T extends Spot = Spot> {
  c: T;
  km: number;
  offM: number;
  seg: number;
}

export function placeAll<T extends Spot>(line: Line, spots: T[], segments: number): Placed<T>[] {
  const out: Placed<T>[] = [];
  for (const c of spots) {
    const { km, offM } = project(line, c.lat, c.lon);
    if (offM > CORRIDOR_M[c.source]) continue;
    out.push({ c, km, offM, seg: segmentOf(km, line.lengthKm, segments) });
  }
  return out;
}

// A file's name without its counter: "Akbara ap 002.JPG" → "akbara ap",
// "Tre Cimes (145137477).jpeg" → "tre cimes". Two files with the same stem a
// few hundred metres apart are the same shoot. A camera's own name
// ("DSC_1234", "IMG_0042") says nothing, and joins nothing.
const GENERIC_STEM = /^(img|dsc|dscn|dscf|dcim|pict|pic|p|photo|image|file|foto|gopr|pano|panorama|mvimg|pxl|whatsapp image)$/;

export function titleStem(title: string | undefined): string | null {
  if (!title) return null;
  const s = title
    .replace(/^File:/i, '')
    .replace(/\.[a-z0-9]{3,4}$/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[_\-–—.,]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (s.length < 4 || GENERIC_STEM.test(s)) return null;
  return s;
}

// Before the files' details are asked for (one more request per 50 files),
// each part keeps a few candidates — the nearest to the line, but spread
// within the part and from different shoots, so the few asked about are not
// eight frames of one spot.
export function preselect<T extends Spot>(placed: Placed<T>[], perSegment = 8): Placed<T>[] {
  const bySeg = new Map<number, Placed<T>[]>();
  for (const p of placed) bySeg.set(p.seg, [...(bySeg.get(p.seg) ?? []), p]);
  const out: Placed<T>[] = [];
  for (const list of bySeg.values()) {
    list.sort((a, b) => a.offM - b.offM);
    const taken: Placed<T>[] = [];
    const stems = new Set<string>();
    // First pass: different shoots, at least 150 m apart. Second: whatever is left.
    for (const strict of [true, false]) {
      for (const p of list) {
        if (taken.length >= perSegment) break;
        if (taken.includes(p)) continue;
        const stem = titleStem(p.c.title) ?? p.c.group ?? null;
        if (strict) {
          if (stem && stems.has(stem)) continue;
          if (taken.some((q) => havKm([q.c.lat, q.c.lon], [p.c.lat, p.c.lon]) < 0.15)) continue;
        }
        taken.push(p);
        if (stem) stems.add(stem);
      }
    }
    out.push(...taken);
  }
  return out;
}

// ── The details of a candidate ──────────────────────────────────────────────

export interface Candidate extends Spot {
  author: string;
  takenAt: string | null;
  width: number;
  height: number;
  license: string;
  pageUrl: string;
  thumb: string;
  full: string;
  mime?: string;
  categories?: string[];
}

// What is not a picture of a place: maps, plans, logos, inscriptions, flags,
// insides of buildings, documents, signposts, and close-ups of one plant or
// animal (Commons is full of them along every trail, named by species).
// Judged from the file's type, name and categories; the model catches what
// these miss, and these are all there is when the model is not asked.
const NOT_A_VIEW = /\b(maps?|map of|locator|diagram|plan|plans|logo|logos|coat of arms|flag|flags|interior|interiors|document|documents|inscription|inscriptions|book|books|poster|stamp|stamps|coin|coins|chart|graph|screenshot|svg|drawing|drawings|painting|paintings|museum|museums|exhibit|exhibits|portrait|portraits|selfie|people of|wedding|food|meal|dish|signposts?|segnavia|waymarks?|wegweiser|trail signs?|road signs?|information signs?|flora of|fauna of|plants|flowers|birds|insects|butterflies|moths|beetles|reptiles|lizards|snakes|mammals|fish|fishes|animals|fungi|mushrooms|lichens|mosses|taxon|species|specimens?|macro)\b/i;
// "Capoeta damascina.jpg", "Verbascum caesareum 2.JPG": a species' Latin name.
// A capitalised genus, then a lower-case epithet with a Latin ending — places
// are written with capitals ("Nahal Kziv"), so they do not match.
const SPECIES_TITLE = /^File:[A-Z][a-z]+[ _][a-z]{2,}(us|um|a|is|ii|ae|ensis|oides|ix)([ _][a-z]{3,})?[ _(]*\d*\)?\.[A-Za-z]{3,4}$/;
// A category that is a species' name: "Capoeta damascina", "Pseudoturritis turrita".
const SPECIES_CATEGORY = /^[A-Z][a-z]+ [a-z]{2,}(us|um|a|is|ii|ae|ensis|oides|ix)$/;
// Names that only sound like a map. "Israel Hiking Map" is the app its users
// upload trail photos from — viewpoints, springs, caves along the way.
const NOT_A_MAP = /israel hiking map|\bon osm\b/gi;
const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

export function excludedWhy(c: Candidate): string | null {
  if (c.mime && !IMAGE_MIME.test(c.mime)) return 'not a photo';
  if (Math.max(c.width, c.height) < 640) return 'too small';
  if (c.width / Math.max(1, c.height) > 3.2) return 'panorama strip';
  const text = [c.title ?? '', ...(c.categories ?? [])].join(' | ').replace(NOT_A_MAP, ' ');
  if (NOT_A_VIEW.test(text)) return 'not a view';
  if (c.categories?.some((k) => SPECIES_CATEGORY.test(k))) return 'a species';
  if (c.title && SPECIES_TITLE.test(c.title)) return 'a species';
  return null;
}

const QUALITY_CATEGORY = /^(Quality images|Featured pictures|Valued images)\b/i;
// Words in the name or the categories that say the photo is of the country
// itself.
const VIEW_CATEGORY = /\b(landscapes?|views?|panoramas?|panoramic|valleys?|mountains?|hills?|peaks?|hiking|trails?|footpaths?|nature reserves?|national parks?|streams?|rivers?|wadis?|canyons?|gorges?|waterfalls?|springs?|deserts?|forests?|woods|lakes?|coasts?|cliffs?|ridges?|cr[aá]ters?|makhtesh|nahal|viewpoints?|lookouts?|caves?)\b/i;

// The model's view of one picture. `keep: false` is a photo of something
// other than the trail's country (indoors, a document, a person, a car);
// `sameAs` names an earlier candidate that shows the same view.
export interface Verdict {
  keep: boolean;
  quality: number; // 1–5
  sameAs?: string;
}

export function score(p: Placed<Candidate>, verdict?: Verdict): number {
  const c = p.c;
  let s = 2 * (1 - p.offM / CORRIDOR_M[c.source]);
  const long = Math.max(c.width, c.height);
  if (long >= 1200) s += 1;
  else if (long < 900) s -= 0.5;
  if (c.categories?.some((k) => QUALITY_CATEGORY.test(k))) s += 1.5;
  if ([c.title ?? '', ...(c.categories ?? [])].some((k) => VIEW_CATEGORY.test(k))) s += 0.75;
  // A frame from a street-level camera is a poorer picture than a photo
  // someone chose to take — used where nothing else is.
  if (c.source === 'panoramax') s -= 1;
  if (verdict) s += (verdict.quality - 3) * 0.8;
  return s;
}

// ── One shoot, one photo ────────────────────────────────────────────────────

const SAME_SHOOT_MINUTES = 30;
const SAME_SHOOT_KM = 0.2;
const SAME_STEM_KM = 0.3;

function minutesApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a.replace(' ', 'T'));
  const tb = Date.parse(b.replace(' ', 'T'));
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.abs(ta - tb) / 60000 : null;
}

// Which candidates are one shoot: the same photographer at the same place
// within half an hour, files named alike next to each other, frames of one
// street-level sequence, and whatever the model said shows the same view.
// Returns each candidate's group.
export function groupShoots(list: Placed<Candidate>[], verdicts?: Map<string, Verdict>): Map<string, string> {
  const parent = new Map<string, string>(list.map((p) => [p.c.id, p.c.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const join = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i].c;
    const stemA = titleStem(a.title);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j].c;
      const km = havKm([a.lat, a.lon], [b.lat, b.lon]);
      if (km > SAME_STEM_KM) continue;
      if (stemA && stemA === titleStem(b.title)) { join(a.id, b.id); continue; }
      if (a.group && a.group === b.group) { join(a.id, b.id); continue; }
      if (km <= SAME_SHOOT_KM && a.author && a.author === b.author) {
        const gap = minutesApart(a.takenAt, b.takenAt);
        if (gap == null || gap <= SAME_SHOOT_MINUTES) join(a.id, b.id);
      }
    }
  }
  for (const [id, v] of verdicts ?? []) if (v.sameAs) join(id, v.sameAs);
  return new Map(list.map((p) => [p.c.id, find(p.c.id)]));
}

// ── The choice ──────────────────────────────────────────────────────────────

// The pictures the model is asked about: the best two of each part, from
// different shoots, at most 24 in all.
export const MODEL_PER_SEGMENT = 2;
export const MODEL_MAX = 24;

export function shortlist(list: Placed<Candidate>[]): Placed<Candidate>[] {
  const usable = list.filter((p) => !excludedWhy(p.c));
  const groups = groupShoots(usable);
  const bySeg = new Map<number, Placed<Candidate>[]>();
  for (const p of usable) bySeg.set(p.seg, [...(bySeg.get(p.seg) ?? []), p]);
  const out: Placed<Candidate>[] = [];
  for (const segList of bySeg.values()) {
    segList.sort((a, b) => score(b) - score(a));
    const used = new Set<string>();
    for (const p of segList) {
      if (used.size >= MODEL_PER_SEGMENT) break;
      const g = groups.get(p.c.id)!;
      if (used.has(g)) continue;
      used.add(g);
      out.push(p);
    }
  }
  return out.sort((a, b) => score(b) - score(a)).slice(0, MODEL_MAX);
}

// No one photographer gives more than a third of the photos, when another's
// photo of the same part is there to take instead.
const AUTHOR_SHARE = 1 / 3;

// The photos shown: at most one per part and one per shoot, best first within
// each part, then in the order they come along the trail. When the model has
// looked, only what it kept is shown — the rest were not checked.
export function choose(list: Placed<Candidate>[], segments: number, verdicts?: Map<string, Verdict>): Placed<Candidate>[] {
  const usable = list.filter((p) => !excludedWhy(p.c) && (!verdicts || verdicts.get(p.c.id)?.keep === true));
  const groups = groupShoots(usable, verdicts);
  const scored = new Map(usable.map((p) => [p.c.id, score(p, verdicts?.get(p.c.id))]));
  const bySeg = new Map<number, Placed<Candidate>[]>();
  for (const p of usable) bySeg.set(p.seg, [...(bySeg.get(p.seg) ?? []), p]);
  for (const segList of bySeg.values()) segList.sort((a, b) => scored.get(b.c.id)! - scored.get(a.c.id)!);

  // The parts whose best photo is best choose first, so a view seen from two
  // parts goes to the part where it is seen best.
  const order = [...bySeg.keys()].sort((a, b) => scored.get(bySeg.get(b)![0].c.id)! - scored.get(bySeg.get(a)![0].c.id)!);
  const usedGroups = new Set<string>();
  const picked = new Map<number, Placed<Candidate>>();
  for (const seg of order) {
    const p = bySeg.get(seg)!.find((q) => !usedGroups.has(groups.get(q.c.id)!));
    if (!p) continue;
    picked.set(seg, p);
    usedGroups.add(groups.get(p.c.id)!);
  }

  // Too many from one photographer: their weakest picks give way to another
  // photographer's photo of the same part, where there is one.
  const cap = Math.max(1, Math.ceil(picked.size * AUTHOR_SHARE));
  const countOf = (author: string) => [...picked.values()].filter((p) => p.c.author === author).length;
  for (const author of new Set([...picked.values()].map((p) => p.c.author))) {
    if (!author) continue;
    const theirs = [...picked.entries()]
      .filter(([, p]) => p.c.author === author)
      .sort((a, b) => scored.get(a[1].c.id)! - scored.get(b[1].c.id)!);
    for (const [seg, p] of theirs) {
      if (countOf(author) <= cap) break;
      const alt = bySeg.get(seg)!.find((q) =>
        q !== p && q.c.author !== author && !usedGroups.has(groups.get(q.c.id)!) && (!q.c.author || countOf(q.c.author) < cap));
      if (!alt) continue;
      usedGroups.delete(groups.get(p.c.id)!);
      usedGroups.add(groups.get(alt.c.id)!);
      picked.set(seg, alt);
    }
  }

  return [...picked.values()].sort((a, b) => a.km - b.km).slice(0, Math.min(segments, MAX_PHOTOS));
}
