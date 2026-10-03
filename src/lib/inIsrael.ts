import type { Coordinate3D } from '../utils/trailUtils';

// Whether a trail is in Israel, for the parts of the trail card that only
// mean anything there: the summer water and shade (the shade grid covers
// Israel alone, and the rules for which water is safe to get into were
// written against Israeli streams and pools), and the reminder to check with
// רשות הטבע והגנים before setting out.
//
// "Israel" here is IL or PS in country-coder's borders (the iD editor's
// dataset): the Judean desert trails — נחל פרת, the north of the Dead Sea —
// are coded PS, and they are as much a part of this as Ein Gedi. Golan comes
// out IL. The dataset is large, so it is loaded only once a trail is opened,
// and the service worker keeps the chunk for use without reception.

const IN_REGION = new Set(['IL', 'PS']);
const SAMPLES = 12;

// Used only if the borders cannot be loaded (offline before the chunk was
// ever fetched): a box around the country. It takes in a strip of Jordan and
// Sinai, which is why it is the fallback and not the answer.
function inRoughBox(lat: number, lon: number): boolean {
  return lat >= 29.45 && lat <= 33.35 && lon >= 34.2 && lon <= 35.9;
}

export async function isTrailInIsrael(coords: Coordinate3D[]): Promise<boolean> {
  if (coords.length === 0) return false;
  const step = Math.max(1, (coords.length - 1) / (SAMPLES - 1));
  const points: [number, number][] = [];
  for (let i = 0; i < coords.length; i += step) {
    const c = coords[Math.round(i)];
    points.push([c[0], c[1]]); // [lat, lon]
  }

  let inside: (lat: number, lon: number) => boolean;
  try {
    const { iso1A2Code } = await import('@rapideditor/country-coder');
    inside = (lat, lon) => IN_REGION.has(iso1A2Code([lon, lat]) ?? '');
  } catch {
    inside = inRoughBox;
  }
  // Most of the trail, so one that only brushes the border is not counted.
  const n = points.filter(([lat, lon]) => inside(lat, lon)).length;
  return n / points.length >= 0.5;
}
