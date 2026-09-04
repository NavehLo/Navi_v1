// The identity of a narrated point, shared by the server cache and the
// browser's offline store so both name the same clip. No imports on purpose:
// this runs on both sides.

// Bumping this invalidates every cached narration on purpose: it is the
// mechanism for rolling out a better prompt without deleting rows by hand.
// Audio keyed to superseded text simply stops being referenced.
export const PROMPT_VERSION = 2;

export interface PoiIdentity {
  lat: number;
  lon: number;
  type: string;
  osmType?: string | null; // 'node' | 'way' | 'relation'
  osmId?: number | string | null;
  trailSlug?: string | null; // only for the synthetic start/midway/end points
}

const SYNTHETIC_TYPES = new Set(['start', 'midway', 'end']);

// Identifies the *point*, not the trail it was found on, so a spring that
// appears in two different trails is paid for once. Four decimal places is
// about 11 m — close enough that two readings of the same node collapse onto
// one key, far enough apart that neighbouring points don't collide.
export function poiKeyFor(p: PoiIdentity): string {
  const v = `v${PROMPT_VERSION}`;
  if (p.osmType && p.osmId != null && p.osmId !== '') {
    return `osm:${p.osmType}/${p.osmId}:${v}`;
  }
  if (p.trailSlug && SYNTHETIC_TYPES.has(p.type)) {
    return `trail:${p.trailSlug}:${p.type}:${v}`;
  }
  return `geo:${p.lat.toFixed(4)}:${p.lon.toFixed(4)}:${p.type}:${v}`;
}
