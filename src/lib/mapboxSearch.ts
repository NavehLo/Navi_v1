import mapboxgl from 'mapbox-gl';
import { NATURE_TAGS, SETTLEMENT_TAGS, nameMatches, normalizeName, searchOsmPlaces } from './osmPlaces';

// Mapbox Search Box API, called from the browser with the same public token
// the map uses. Suggest + retrieve inside one session bill as a single search,
// so the session token is minted when a field gains focus and reused until a
// suggestion is picked.
//
// Docs: https://docs.mapbox.com/api/search/search-box/

const BASE = 'https://api.mapbox.com/search/searchbox/v1';

// Enough of a kind to pick an icon by, and to know what a search is offering
// before reading the name.
export type PlaceCategory =
  | 'settlement' | 'region' | 'park' | 'water' | 'summit'
  | 'heritage' | 'viewpoint' | 'address' | 'other';

export interface PlaceSuggestion {
  mapboxId: string;
  name: string;
  placeFormatted: string; // "תל אביב-יפו, ישראל"
  featureType: string;    // poi | address | place | …
  category: PlaceCategory;
  // Set when the suggestion did not come from Mapbox and already carries its
  // coordinates — nothing to retrieve.
  place?: Place;
}

export interface Place {
  name: string;
  lon: number;
  lat: number;
  // Present for the things that are an area rather than a point — a country, a
  // nature reserve, the length of a river — so the map can frame the whole of
  // it instead of dropping onto its centre at some arbitrary zoom.
  bbox?: [number, number, number, number]; // [west, south, east, north]
}

export type SearchFailure = 'no-token' | 'unauthorized' | 'unavailable';

export class SearchError extends Error {
  constructor(public readonly kind: SearchFailure) {
    super(kind);
  }
}

function token(): string {
  const t = mapboxgl.accessToken;
  if (!t) throw new SearchError('no-token');
  return t;
}

export function newSessionToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function call<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new SearchError('unavailable');
  }
  if (res.status === 401 || res.status === 403) throw new SearchError('unauthorized');
  if (!res.ok) throw new SearchError('unavailable');
  return res.json();
}

// Mapbox's own feature types, mapped onto the kinds this app draws icons for.
const MAPBOX_CATEGORIES: Record<string, PlaceCategory> = {
  country: 'region', region: 'region', district: 'region', postcode: 'region',
  place: 'settlement', locality: 'settlement', neighborhood: 'settlement',
  address: 'address', street: 'address',
};

function fromMapbox(s: Record<string, string>): PlaceSuggestion {
  const featureType = s.feature_type ?? '';
  return {
    mapboxId: s.mapbox_id,
    name: s.name,
    placeFormatted: s.place_formatted ?? '',
    featureType,
    category: MAPBOX_CATEGORIES[featureType] ?? 'other',
  };
}

// The two ends of a drive. Mapbox answers, with Israel's own settlement names
// filled in from OSM where Mapbox only knows the transliteration.
export async function suggestPlaces(
  query: string,
  sessionToken: string,
  proximity: [number, number] | null,
  signal?: AbortSignal
): Promise<PlaceSuggestion[]> {
  const [mapbox, settlements] = await Promise.all([
    mapboxSuggest(query, sessionToken, proximity, signal),
    // Only for Hebrew: a foreign city typed in Hebrew ("פריז") is Mapbox's to
    // answer, and OSM's local names cannot help with it.
    HEBREW.test(query)
      ? searchOsmPlaces(query, { tags: SETTLEMENT_TAGS, prefixOnly: true, limit: 4, max: 2, signal })
      : Promise.resolve([]),
  ]);
  return rankSuggestions(merge(settlements, mapbox), query);
}

// Everywhere a walk could start — countries, cities and villages — and the
// places worth walking to. Each geocoder is asked only for what it is good at,
// which is also what keeps the answers clean: Mapbox is asked for
// administrative places alone, because the moment it is allowed to return
// shops and streets it returns nothing else. "פריז" from Tel Aviv is a
// hairdresser, an ice cream kiosk and four branches of a burger chain, and
// Paris is not on the list at all — ask for places and Paris comes first.
// The outdoors, which Mapbox does not index and OSM does, is OSM's half.
const MAPBOX_PLACE_TYPES = 'country,region,district,place,locality';

export async function suggestPlacesAndPois(
  query: string,
  sessionToken: string,
  proximity: [number, number] | null,
  signal?: AbortSignal
): Promise<PlaceSuggestion[]> {
  const [mapbox, osm] = await Promise.all([
    mapboxSuggest(query, sessionToken, proximity, signal, MAPBOX_PLACE_TYPES),
    searchOsmPlaces(query, {
      tags: [...SETTLEMENT_TAGS, ...NATURE_TAGS],
      limit: 10,
      max: 6,
      proximity,
      signal,
    }),
  ]);
  // Mapbox answers a query it cannot match with whatever lies near the map —
  // "תל אב" comes back with three villages near Hebron whose names share not
  // one word with it. A suggestion has to have been asked for.
  const relevant = mapbox.filter((s) => nameMatches(s.name, query));
  return rankSuggestions(merge(osm, relevant), query).slice(0, 8);
}

async function mapboxSuggest(
  query: string,
  sessionToken: string,
  proximity: [number, number] | null,
  signal?: AbortSignal,
  types?: string
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    q: query,
    session_token: sessionToken,
    // Answer in the language the question was asked in. Two geocoders that
    // both name a country cannot be told they mean the same one when one says
    // "Switzerland" and the other "שווייץ", and a name in a script the reader
    // did not type cannot be checked against what they typed either.
    language: HEBREW.test(query) ? 'he' : 'en',
    limit: '6',
    access_token: token(),
  });
  if (types) params.set('types', types);
  if (proximity) params.set('proximity', `${proximity[0]},${proximity[1]}`);
  const data = await call<{ suggestions?: Array<Record<string, string>> }>(
    `${BASE}/suggest?${params}`, signal
  );
  return (data.suggestions ?? []).map(fromMapbox);
}

const HEBREW = /[\u0590-\u05FF]/;

// OSM first, so that where both geocoders know a place it is OSM's copy that
// survives the de-duplication: it is the one with the local name, with the
// area's bounds, and with coordinates already attached — picking it costs no
// billed retrieve.
function merge(osm: PlaceSuggestion[], mapbox: PlaceSuggestion[]): PlaceSuggestion[] {
  return [...osm, ...mapbox];
}

// Proximity is what makes "תל" offer Tel Aviv before Tel Aviv, Texas — and
// also what puts four streets called אילת above the city of Eilat when
// searching from Tel Aviv. A place whose name is exactly what was typed is
// almost always the one meant, and a settlement beats a footpath sign named
// after it. The APIs also tend to return a city twice (place + locality);
// one is enough.
const SETTLEMENT_TYPES = new Set(['country', 'region', 'district', 'place', 'locality', 'neighborhood']);

function isSettlement(s: PlaceSuggestion): boolean {
  return s.category === 'settlement' || s.category === 'region' || SETTLEMENT_TYPES.has(s.featureType);
}

function rankSuggestions(list: PlaceSuggestion[], query: string): PlaceSuggestion[] {
  const q = normalizeName(query);
  const seen = new Set<string>();
  const unique = list.filter((s) => {
    const name = normalizeName(s.name);
    // A city is its name; anything smaller needs its surroundings to be
    // told apart from the next one along with the same name.
    const key = isSettlement(s) ? name : `${name}|${normalizeName(s.placeFormatted)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Within a tier the order is the order the answers arrived in, which puts
  // OSM's ahead of Mapbox's. Ranking an exact name above a longer one that
  // starts with it looks right until "תל אביב" turns up a locality of that
  // exact name near Nes Ziona and stands it in front of Tel Aviv itself.
  const rank = (s: PlaceSuggestion) => {
    const name = normalizeName(s.name);
    if (name.startsWith(q)) return isSettlement(s) ? 0 : 1;
    return s.category === 'address' ? 3 : 2;
  };
  return unique
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

export async function retrievePlace(suggestion: PlaceSuggestion, sessionToken: string): Promise<Place> {
  if (suggestion.place) return suggestion.place;
  const params = new URLSearchParams({ session_token: sessionToken, language: 'he', access_token: token() });
  const data = await call<{ features?: Array<{ geometry: { coordinates: [number, number] }; properties: { name?: string; bbox?: number[] } }> }>(
    `${BASE}/retrieve/${encodeURIComponent(suggestion.mapboxId)}?${params}`
  );
  const f = data.features?.[0];
  if (!f) throw new SearchError('unavailable');
  const bbox = f.properties.bbox;
  return {
    name: f.properties.name || suggestion.name,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    bbox: bbox?.length === 4 && bbox.every(Number.isFinite)
      ? (bbox as [number, number, number, number])
      : undefined,
  };
}

// A name for a dropped pin. Falls back to the coordinates when nothing is
// there to be named — the middle of a desert is a fine place to start from.
export async function reversePlace(lon: number, lat: number): Promise<Place> {
  const fallback = { name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lon, lat };
  try {
    const params = new URLSearchParams({
      longitude: String(lon), latitude: String(lat), language: 'he', limit: '1', access_token: token(),
    });
    const data = await call<{ features?: Array<{ properties: { name?: string; place_formatted?: string } }> }>(
      `${BASE}/reverse?${params}`
    );
    const p = data.features?.[0]?.properties;
    const name = p?.name ? (p.place_formatted ? `${p.name}, ${p.place_formatted}` : p.name) : null;
    return name ? { name, lon, lat } : fallback;
  } catch {
    return fallback;
  }
}
