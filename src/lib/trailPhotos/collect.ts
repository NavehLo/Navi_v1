import { fetchWmt } from '../wmtServer';
import type { WmtRouteDetails } from '../waymarked';
import {
  CORRIDOR_M, excludedWhy, makeLine, placeAll, preselect, searchBoxes, shortlist, choose,
  type Candidate, type Placed, type Verdict,
} from './select';
import { commonsCandidate, commonsInfo, commonsSpots, heroTitle, panoramaxCandidates } from './sources';
import { lookAtPhotos } from './vision';
import { MAX_PHOTOS, segmentCount, type TrailPhoto, type TrailPhotos } from './types';

// Gathers a trail's candidates from every source, has the model look at the
// best of them, and makes the choice (select.ts). Finishes inside the route's
// minute: the searches stop at the deadline with what they have.

const BUDGET_MS = 40_000;

function toPhoto(p: Placed<Candidate>): TrailPhoto {
  const c = p.c;
  return {
    id: c.id, source: c.source, lat: c.lat, lon: c.lon, km: Math.round(p.km * 100) / 100,
    thumb: c.thumb, full: c.full, width: c.width, height: c.height,
    author: c.author, license: c.license, pageUrl: c.pageUrl, takenAt: c.takenAt,
  };
}

export interface CollectDebug {
  spots: number;
  inCorridor: number;
  asked: number;
  panoramax: number;
  shortlisted: number;
  verdicts: Record<string, Verdict> | null;
}

export async function collectTrailPhotos(
  coords: [number, number][],
  wmtId: number | null,
  debug?: CollectDebug,
): Promise<TrailPhotos | null> {
  const deadline = Date.now() + BUDGET_MS;
  const line = makeLine(coords);
  if (line.pts.length < 2 || line.lengthKm <= 0) return null;
  const segments = segmentCount(line.lengthKm);

  const [{ spots, complete }, panoramax, hero] = await Promise.all([
    commonsSpots(searchBoxes(line, CORRIDOR_M.commons), deadline),
    panoramaxCandidates(searchBoxes(line, CORRIDOR_M.panoramax), deadline),
    wmtId
      ? fetchWmt(`/details/relation/${wmtId}`).then((d) => heroTitle((d as WmtRouteDetails | null)?.tags, deadline))
      : Promise.resolve(null),
  ]);

  const placedSpots = placeAll(line, spots, segments);
  const asked = preselect(placedSpots);
  const titles = asked.map((p) => p.c.title!).filter(Boolean);
  if (hero && !titles.includes(hero)) titles.push(hero);
  const info = await commonsInfo(titles, deadline + 10_000);

  const placed: Placed<Candidate>[] = [];
  const addFound = (list: Placed[]) => {
    for (const p of list) {
      const i = info.get(p.c.title!);
      if (i) placed.push({ ...p, c: commonsCandidate(p.c, i) });
    }
  };
  addFound(asked);

  // A part whose first few were all close-ups of flowers or signposts gets a
  // second look, at the ones not asked about yet.
  const usableSegs = new Set(placed.filter((p) => !excludedWhy(p.c)).map((p) => p.seg));
  const askedIds = new Set(asked.map((p) => p.c.id));
  const second = preselect(placedSpots.filter((p) => !usableSegs.has(p.seg) && !askedIds.has(p.c.id)));
  if (second.length) {
    for (const [k, v] of await commonsInfo(second.map((p) => p.c.title!), deadline + 10_000)) info.set(k, v);
    addFound(second);
  }

  // Street-level frames only where Commons has nothing for that part.
  const covered = new Set(placed.map((p) => p.seg));
  const frames = placeAll(line, panoramax, segments).filter((p) => !covered.has(p.seg));
  placed.push(...preselect(frames, 4));

  const short = shortlist(placed);
  const verdicts = await lookAtPhotos(short);
  const chosen = choose(verdicts ? short : placed, segments, verdicts ?? undefined);

  const photos = chosen.map(toPhoto);
  const heroInfo = hero ? info.get(hero) : undefined;
  if (heroInfo && !photos.some((p) => p.id === `commons:${hero}`)) {
    // Still no more than the most a trail shows.
    if (photos.length >= MAX_PHOTOS) photos.pop();
    photos.unshift({
      id: `commons:${hero}`, source: 'commons', lat: null, lon: null, km: null,
      thumb: heroInfo.thumb, full: heroInfo.full, width: heroInfo.width, height: heroInfo.height,
      author: heroInfo.author, license: heroInfo.license, pageUrl: heroInfo.pageUrl, takenAt: heroInfo.takenAt,
      hero: true,
    });
  }

  if (debug) {
    Object.assign(debug, {
      spots: spots.length, inCorridor: placedSpots.length, asked: asked.length + second.length,
      panoramax: frames.length, shortlisted: short.length,
      verdicts: verdicts ? Object.fromEntries(verdicts) : null,
    });
  }

  // Commons could not be searched at all: that is a failure, not a trail
  // without photos, and nothing is stored.
  if (!complete && photos.length === 0) return null;

  return {
    photos,
    segments,
    lengthKm: Math.round(line.lengthKm * 100) / 100,
    // A part of the trail that could not be searched is searched again soon,
    // like a choice the model did not look at.
    checked: verdicts != null && complete,
    generatedAt: new Date().toISOString(),
  };
}
