import type { Coordinate3D } from '../../utils/trailUtils';
import type { RecPoint, Recording } from './types';

// A recording written out as GPX 1.1 — one <trkseg> for each stretch between
// pauses, with the height and the time of every point. This is the file that
// is shared, the copy kept in the account, and what another app (Komoot,
// Strava, Google Earth) opens.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function recordingToGpx(rec: Pick<Recording, 'name' | 'segments' | 'startedAt'>): string {
  const segs = rec.segments
    .filter((s) => s.length > 0)
    .map((s) => `<trkseg>${s.map((p) =>
      `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`
    ).join('')}</trkseg>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Navi" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${esc(rec.name)}</name><time>${new Date(rec.startedAt).toISOString()}</time></metadata><trk><name>${esc(rec.name)}</name>${segs}</trk></gpx>`;
}

// Back from GPX — for a recording that reached this device only through the
// account (it was made on another phone).
export function gpxToSegments(gpx: string): RecPoint[][] | null {
  try {
    const doc = new DOMParser().parseFromString(gpx, 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    const segs: RecPoint[][] = [];
    for (const seg of Array.from(doc.getElementsByTagName('trkseg'))) {
      const pts: RecPoint[] = [];
      for (const pt of Array.from(seg.getElementsByTagName('trkpt'))) {
        const lat = parseFloat(pt.getAttribute('lat') ?? '');
        const lon = parseFloat(pt.getAttribute('lon') ?? '');
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const eleText = pt.getElementsByTagName('ele')[0]?.textContent;
        const timeText = pt.getElementsByTagName('time')[0]?.textContent;
        const ele = eleText ? parseFloat(eleText) : NaN;
        const t = timeText ? Date.parse(timeText) : NaN;
        pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, t: Number.isFinite(t) ? t : 0, acc: null });
      }
      if (pts.length) segs.push(pts);
    }
    return segs.length ? segs : null;
  } catch {
    return null;
  }
}

// The points as one line, for opening the recording on the map like any
// other trail.
export function recordingCoords(rec: Pick<Recording, 'segments'>): Coordinate3D[] {
  return rec.segments.flat().map((p) => [p.lat, p.lon, p.ele ?? 0] as Coordinate3D);
}

// The file name for a download or a share: the walk's name, made safe.
export function gpxFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Navi';
  return `${base}.gpx`;
}
