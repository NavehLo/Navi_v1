import type { TrailData, TrailSource } from '../hooks/useTrailData';
import type { Coordinate3D } from '../utils/trailUtils';

// The trail on screen, kept on the device so it comes back when the page does.
//
// Android is free to throw a page out of memory while another app is in front
// — and a 3D map is a lot of memory — so switching to WhatsApp mid-walk and
// back could land on the home screen with the trail gone, and with no
// reception there was no getting it back. The trail's points themselves are
// kept, not just where it came from: reopening it must not need the network.
//
// Only a recent trail is brought back. Opening the app the next morning should
// start at the home screen, not in yesterday's walk.

const KEY = 'navi:openTrail.v1';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
// localStorage holds about 5 MB for the whole site, shared with the personal
// area's copy. A trail bigger than this is not worth crowding that out for.
const MAX_BYTES = 2_500_000;

export interface RememberedTrail {
  name: string;
  kind: TrailData['kind'];
  driveDurationSec?: number;
  coords: Coordinate3D[];
  // A file's text is dropped — it is the same points again, and can be
  // written back out from them (see page.tsx).
  source: TrailSource | null;
  tracking: boolean;
  savedAt: number;
}

export function rememberOpenTrail(trail: TrailData, source: TrailSource | null, tracking: boolean): void {
  try {
    const entry: RememberedTrail = {
      name: trail.name,
      kind: trail.kind,
      driveDurationSec: trail.driveDurationSec,
      // Five decimals is about a metre — all a GPS can tell apart anyway.
      coords: trail.coords.map(([lat, lon, ele]) => [
        Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5, Math.round(ele || 0),
      ]),
      source: source?.kind === 'file' ? { kind: 'file', content: '' } : source,
      tracking,
      savedAt: Date.now(),
    };
    const json = JSON.stringify(entry);
    if (json.length > MAX_BYTES) { forgetOpenTrail(); return; }
    localStorage.setItem(KEY, json);
  } catch {
    // Private mode, or storage full: the trail simply will not come back.
  }
}

export function recallOpenTrail(): RememberedTrail | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as RememberedTrail;
    if (!Array.isArray(entry.coords) || entry.coords.length < 2) return null;
    if (!(Date.now() - entry.savedAt < MAX_AGE_MS)) { forgetOpenTrail(); return null; }
    return entry;
  } catch {
    return null;
  }
}

export function forgetOpenTrail(): void {
  try { localStorage.removeItem(KEY); } catch {}
}
