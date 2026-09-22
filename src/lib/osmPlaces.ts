import type { PlaceCategory, PlaceSuggestion } from './mapboxSearch';

// Places and nature from OpenStreetMap, through Photon (komoot's geocoder,
// free for fair use).
//
// Mapbox is the better geocoder for addresses, and the only one that finds a
// foreign city typed in Hebrew — "פריז" is Paris there and nothing at all
// here. What it does not have is the country's own names: "אילת" finds four
// streets and a supermarket because the city is stored as "Eilat" even with
// language=he, and a wadi, a spring or a nature reserve is not in its index in
// any language. OSM has all of them, in Hebrew and in English, so the two
// geocoders are asked together and their answers merged.
//
// Docs: https://photon.komoot.io/

const BASE = 'https://photon.komoot.io/api/';

// Towns and the things that contain them.
export const SETTLEMENT_TAGS = [
  'place:country', 'place:state', 'place:region', 'place:county',
  'place:city', 'place:town', 'place:village', 'place:island',
] as const;

// The outdoors: what someone looking for a trail would type. Photon takes
// these as an OR over includes, and without them the answers are kindergartens
// and furniture shops — unfiltered, "ישראל" returns seven of those above the
// country itself.
export const NATURE_TAGS = [
  'boundary:protected_area', 'boundary:national_park',
  'leisure:nature_reserve', 'leisure:park',
  'natural:peak', 'natural:volcano', 'natural:valley', 'natural:mountain_range',
  'natural:water', 'natural:spring', 'natural:beach', 'natural:cave_entrance',
  'natural:glacier', 'natural:wood',
  'waterway:river', 'waterway:stream', 'waterway:waterfall',
  'tourism:viewpoint', 'tourism:attraction',
  'historic:archaeological_site', 'historic:ruins', 'historic:castle',
  'landuse:forest',
] as const;

interface Feature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string> & { extent?: number[] };
}

export interface OsmSearchOptions {
  tags: readonly string[];
  limit?: number;
  // Keep only names that begin with what was typed. Used where a loose match
  // is worse than no match at all — a drive's origin and destination.
  prefixOnly?: boolean;
  // How many of the matches to keep, after ranking.
  max?: number;
  proximity?: [number, number] | null;
  signal?: AbortSignal;
}

// OSM's key/value pair, reduced to the handful of kinds worth their own icon.
function categorize(key: string, value: string): PlaceCategory {
  if (key === 'place') {
    return value === 'country' || value === 'state' || value === 'region' || value === 'county'
      ? 'region'
      : 'settlement';
  }
  if (key === 'waterway' || value === 'water' || value === 'spring' || value === 'beach') return 'water';
  if (value === 'peak' || value === 'volcano' || value === 'valley' || value === 'mountain_range') return 'summit';
  if (key === 'historic') return 'heritage';
  if (value === 'viewpoint') return 'viewpoint';
  if (key === 'boundary' || key === 'leisure' || key === 'landuse' || key === 'natural') return 'park';
  return 'other';
}

// Names are compared with the dashes, quotes and double spaces taken out, so
// that "תל אביב–יפו" and "תל אביב-יפו" are the same place and "עין-גדי" finds
// it either way.
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[־–—\-_'"’״׳().,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Photon matches loosely enough that "פריז" comes back as "פריד" and "פרי".
// A suggestion is only worth showing if what was typed is really in the name:
// either as a run of characters, or as the beginnings of its words.
export function nameMatches(name: string, query: string): boolean {
  const n = normalizeName(name);
  const q = normalizeName(query);
  if (!q) return false;
  if (n.includes(q)) return true;
  const words = n.split(' ');
  return q.split(' ').every((t) => words.some((w) => w.startsWith(t)));
}

// "שמורת טבע עין גדי" on its own is not enough to tell two of them
// apart; the council and the country underneath it are.
function contextOf(p: Record<string, string>): string {
  const local = p.city || p.county || p.district || p.state;
  return [local, p.country].filter((x) => !!x && x !== p.name).join(', ');
}

// Photon's extent is [west, north, east, south]; a bounding box everywhere
// else in the app is [west, south, east, north].
function bboxOf(extent: number[] | undefined): [number, number, number, number] | undefined {
  if (!extent || extent.length !== 4 || extent.some((n) => !Number.isFinite(n))) return undefined;
  const [west, north, east, south] = extent;
  return [west, south, east, north];
}

const HEBREW = /[֐-׿]/;

export async function searchOsmPlaces(query: string, opts: OsmSearchOptions): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const params = new URLSearchParams({
      q,
      limit: String(opts.limit ?? 10),
      // Hebrew is not one of the languages Photon can translate into, but
      // "default" is the name as written locally — which in Israel is the
      // Hebrew one. An English search gets English names where OSM has them.
      lang: HEBREW.test(q) ? 'default' : 'en',
    });
    if (opts.proximity) {
      params.set('lon', String(opts.proximity[0]));
      params.set('lat', String(opts.proximity[1]));
    }
    for (const tag of opts.tags) params.append('osm_tag', tag);

    const res = await fetch(`${BASE}?${params}`, { signal: opts.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { features?: Feature[] };

    const out: PlaceSuggestion[] = [];
    const seen = new Set<string>();
    for (const f of data.features ?? []) {
      const p = f.properties;
      const name = p.name;
      if (!name) continue;
      if (opts.prefixOnly ? !normalizeName(name).startsWith(normalizeName(q)) : !nameMatches(name, q)) continue;
      const category = categorize(p.osm_key ?? '', p.osm_value ?? '');
      const placeFormatted = contextOf(p);
      const key = `${normalizeName(name)}|${normalizeName(placeFormatted)}|${category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [lon, lat] = f.geometry.coordinates;
      out.push({
        mapboxId: `osm:${p.osm_type ?? ''}${p.osm_id ?? name}`,
        name,
        placeFormatted,
        featureType: category === 'settlement' || category === 'region' ? 'place' : 'poi',
        category,
        place: { name, lon, lat, bbox: bboxOf(p.extent) },
      });
      if (opts.max && out.length >= opts.max) break;
    }
    return out;
  } catch {
    // A geocoder that is only half of the answer never fails the search.
    return [];
  }
}
