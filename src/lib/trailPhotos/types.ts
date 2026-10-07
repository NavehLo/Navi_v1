// Shared between /api/trail-photos and the section that shows its answer, so
// nothing here may touch the server environment.

export type PhotoSource = 'commons' | 'panoramax';

// One photo along the trail, as shown: a link to the file where it is kept,
// never the file itself. Every photo carries who took it and its licence —
// the licences (CC BY, CC BY-SA) require both beside the picture.
export interface TrailPhoto {
  id: string;
  source: PhotoSource;
  // Where it was taken, and how far along the trail. The trail's own photo
  // (its OSM `wikimedia_commons` / `image`) may have no place: null.
  lat: number | null;
  lon: number | null;
  km: number | null;
  thumb: string;   // ~500 px wide, for the strip
  full: string;    // ~1280 px wide, for the viewer
  width: number;
  height: number;
  author: string;
  license: string;
  pageUrl: string; // the photo's page at its source, for the credit
  takenAt: string | null;
  hero?: boolean;
}

export interface TrailPhotos {
  photos: TrailPhoto[];
  // How many parts the trail was cut into: at most one photo comes from each.
  segments: number;
  lengthKm: number;
  // Whether the free model looked at the pictures and every part of the trail
  // was searched. Otherwise the choice is kept for a week, then made again.
  checked: boolean;
  generatedAt: string;
}

export type TrailPhotosStatus = 'ok' | 'unavailable' | 'rate-limited';

// The most photos a trail ever shows, however long it is.
export const MAX_PHOTOS = 12;

// One part of the trail per ~1.5 km, between 4 and 12 parts.
export function segmentCount(lengthKm: number): number {
  return Math.max(4, Math.min(MAX_PHOTOS, Math.round(lengthKm / 1.5)));
}

// The points sent to the server: at most this many, taken evenly, so the same
// trail always sends the same points and lands on the same stored answer.
export const MAX_SENT_POINTS = 400;

export function thinForPhotos(coords: Array<[number, number] | [number, number, number]>): [number, number][] {
  const step = Math.max(1, Math.ceil(coords.length / MAX_SENT_POINTS));
  const out: [number, number][] = [];
  for (let i = 0; i < coords.length; i += step) out.push([round5(coords[i][0]), round5(coords[i][1])]);
  const last = coords[coords.length - 1];
  if (last && (out.length === 0 || out[out.length - 1][0] !== round5(last[0]) || out[out.length - 1][1] !== round5(last[1]))) {
    out.push([round5(last[0]), round5(last[1])]);
  }
  return out;
}

function round5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}
