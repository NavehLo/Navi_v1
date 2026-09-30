import type { DrivePlace } from '../hooks/useTrailData';

// A saved or shared drive is its places; the road is asked for again when it
// is opened (unless the saved copy carries the road itself — see page.tsx).
//
//   drive:lon,lat;lon,lat;…|from name|stop name|…|to name|@durationSec
//
// The first and last points are the ends, any in between are the stops, in
// order. The duration is optional. The two-point form without it is what
// every drive was saved as before stops existed, and still reads.

export interface DriveLink {
  from: DrivePlace;
  to: DrivePlace;
  vias: DrivePlace[];
  durationSec?: number;
}

const clean = (name: string) => name.replace(/\|/g, '/');

export function encodeDrive(d: DriveLink): string {
  const places = [d.from, ...d.vias, d.to];
  const pts = places.map((p) => `${p.lon},${p.lat}`).join(';');
  const names = places.map((p) => clean(p.name)).join('|');
  const dur = d.durationSec != null ? `|@${Math.round(d.durationSec)}` : '';
  return `drive:${pts}|${names}${dur}`;
}

export function decodeDrive(raw: string | null | undefined): DriveLink | null {
  if (!raw?.startsWith('drive:')) return null;
  const parts = raw.slice('drive:'.length).split('|');
  const pts = parts.shift()!.split(';').map((pair) => pair.split(',').map(Number));
  if (pts.length < 2 || pts.some((p) => p.length !== 2 || !p.every(Number.isFinite))) return null;

  let durationSec: number | undefined;
  const last = parts[parts.length - 1];
  if (last && /^@\d+$/.test(last)) {
    durationSec = Number(last.slice(1));
    parts.pop();
  }

  const places: DrivePlace[] = pts.map(([lon, lat], i) => ({
    lon, lat,
    name: parts[i] || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
  }));
  return {
    from: places[0],
    to: places[places.length - 1],
    vias: places.slice(1, -1),
    durationSec,
  };
}
