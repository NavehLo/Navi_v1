import mapboxgl from 'mapbox-gl';

// Mapbox Search Box API, called from the browser with the same public token
// the map uses. Suggest + retrieve inside one session bill as a single search,
// so the session token is minted when a field gains focus and reused until a
// suggestion is picked.
//
// Docs: https://docs.mapbox.com/api/search/search-box/

const BASE = 'https://api.mapbox.com/search/searchbox/v1';

export interface PlaceSuggestion {
  mapboxId: string;
  name: string;
  placeFormatted: string; // "תל אביב-יפו, ישראל"
  featureType: string;    // poi | address | place | …
  // Set when the suggestion did not come from Mapbox and already carries its
  // coordinates — nothing to retrieve.
  place?: Place;
}

export interface Place {
  name: string;
  lon: number;
  lat: number;
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

export async function suggestPlaces(
  query: string,
  sessionToken: string,
  proximity: [number, number] | null,
  signal?: AbortSignal
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    q: query,
    session_token: sessionToken,
    language: 'he',
    limit: '6',
    access_token: token(),
  });
  if (proximity) params.set('proximity', `${proximity[0]},${proximity[1]}`);
  const [data, settlements] = await Promise.all([
    call<{ suggestions?: Array<Record<string, string>> }>(`${BASE}/suggest?${params}`, signal),
    hebrewSettlements(query, signal),
  ]);
  const list = (data.suggestions ?? []).map((s) => ({
    mapboxId: s.mapbox_id,
    name: s.name,
    placeFormatted: s.place_formatted ?? '',
    featureType: s.feature_type ?? '',
  }));
  return rankSuggestions(mergeSettlements(list, settlements), query);
}

// Mapbox has no Hebrew name for some Israeli cities — "אילת" finds four
// streets and a supermarket, never Eilat, because the city is stored as
// "Eilat" even with language=he. OpenStreetMap does have the Hebrew names,
// and Photon (komoot's OSM geocoder, free for fair use) searches them. It is
// asked only for settlements, only for Hebrew queries, and its answers go in
// front of Mapbox's. Foreign cities typed in Hebrew ("פריז") stay Mapbox's.
const HEBREW = /[\u0590-\u05FF]/;

async function hebrewSettlements(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  if (!HEBREW.test(query)) return [];
  try {
    // lang=default: the name as written locally, not the browser's language
    const params = new URLSearchParams({ q: query, limit: '4', lang: 'default' });
    const url = `https://photon.komoot.io/api/?${params}&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village`;
    const res = await fetch(url, { signal });
    if (!res.ok) return [];
    const data = await res.json() as {
      features?: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }>;
    };
    const q = query.trim().toLowerCase();
    const out: PlaceSuggestion[] = [];
    const seen = new Set<string>();
    for (const f of data.features ?? []) {
      const name = f.properties.name;
      if (!name || !name.toLowerCase().startsWith(q) || seen.has(name)) continue;
      seen.add(name);
      const context = [f.properties.state, f.properties.country].filter(Boolean).join(', ');
      const place = { name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      out.push({ mapboxId: `osm:${f.properties.osm_id ?? name}`, name, placeFormatted: context, featureType: 'place', place });
      if (out.length >= 2) break;
    }
    return out;
  } catch {
    return [];
  }
}

function mergeSettlements(mapbox: PlaceSuggestion[], settlements: PlaceSuggestion[]): PlaceSuggestion[] {
  const known = new Set(
    mapbox.filter((s) => SETTLEMENT_TYPES.has(s.featureType)).map((s) => s.name.toLowerCase())
  );
  return [...settlements.filter((s) => !known.has(s.name.toLowerCase())), ...mapbox];
}

// Proximity is what makes "תל" offer Tel Aviv before Tel Aviv, Texas — and
// also what puts four streets called אילת above the city of Eilat when
// searching from Tel Aviv. A settlement whose name is what was typed is
// almost always what a road trip means, so it goes first. The API also
// tends to return a city twice (place + locality); one is enough.
const SETTLEMENT_TYPES = new Set(['country', 'region', 'district', 'place', 'locality', 'neighborhood']);

function rankSuggestions(list: PlaceSuggestion[], query: string): PlaceSuggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const unique = list.filter((s) => {
    const key = `${s.name}|${s.placeFormatted}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = (s: PlaceSuggestion) =>
    SETTLEMENT_TYPES.has(s.featureType) && s.name.toLowerCase().startsWith(q) ? 0 : 1;
  return unique
    .map((s, i) => ({ s, i, r: rank(s) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.s);
}

export async function retrievePlace(suggestion: PlaceSuggestion, sessionToken: string): Promise<Place> {
  if (suggestion.place) return suggestion.place;
  const params = new URLSearchParams({ session_token: sessionToken, language: 'he', access_token: token() });
  const data = await call<{ features?: Array<{ geometry: { coordinates: [number, number] }; properties: { name?: string } }> }>(
    `${BASE}/retrieve/${encodeURIComponent(suggestion.mapboxId)}?${params}`
  );
  const f = data.features?.[0];
  if (!f) throw new SearchError('unavailable');
  return { name: f.properties.name || suggestion.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
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
