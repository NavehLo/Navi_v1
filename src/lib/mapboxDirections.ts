import mapboxgl from 'mapbox-gl';
import type { Coordinate3D } from '../utils/trailUtils';
import { getDistance } from '../utils/trailUtils';
import { SearchError } from './mapboxSearch';

// Mapbox Directions API, driving profile. Docs:
// https://docs.mapbox.com/api/navigation/directions/

export interface DriveRoute {
  coords: Coordinate3D[]; // [lat, lon, 0] — the API carries no elevation
  distanceKm: number;
  durationSec: number;
}

export type DirectionsFailure = 'no-token' | 'unauthorized' | 'no-route' | 'unavailable';

export class DirectionsError extends Error {
  constructor(public readonly kind: DirectionsFailure) {
    super(kind);
  }
}

// `overview=full` on a long drive returns tens of thousands of points, many a
// metre or two apart on gentle curves. The tour interpolates by distance, so
// anything closer than this to the previous kept point adds nothing but weight.
const MIN_POINT_SPACING_KM = 0.005;

export function thinCoords(coords: Coordinate3D[], minSpacingKm = MIN_POINT_SPACING_KM): Coordinate3D[] {
  if (coords.length < 3) return coords;
  const out: Coordinate3D[] = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const last = out[out.length - 1];
    if (getDistance(last[0], last[1], coords[i][0], coords[i][1]) >= minSpacingKm) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export async function driveRoute(from: [number, number], to: [number, number]): Promise<DriveRoute> {
  const token = mapboxgl.accessToken;
  if (!token) throw new DirectionsError('no-token');

  const path = `${from[0]},${from[1]};${to[0]},${to[1]}`;
  const params = new URLSearchParams({
    geometries: 'geojson',
    overview: 'full',
    language: 'he',
    access_token: token,
  });

  let res: Response;
  try {
    res = await fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`);
  } catch {
    throw new DirectionsError('unavailable');
  }
  if (res.status === 401 || res.status === 403) throw new DirectionsError('unauthorized');

  const data = await res.json().catch(() => null) as
    | { code?: string; routes?: Array<{ distance: number; duration: number; geometry: { coordinates: [number, number][] } }> }
    | null;
  if (!data) throw new DirectionsError('unavailable');
  if (data.code === 'NoRoute' || data.code === 'NoSegment') throw new DirectionsError('no-route');
  if (data.code !== 'Ok' || !data.routes?.length) throw new DirectionsError('unavailable');

  const route = data.routes[0];
  const coords = thinCoords(route.geometry.coordinates.map(([lon, lat]) => [lat, lon, 0] as Coordinate3D));
  return { coords, distanceKm: route.distance / 1000, durationSec: route.duration };
}

export function describeSearchOrDirectionsError(e: unknown): string {
  const kind = e instanceof SearchError || e instanceof DirectionsError ? e.kind : 'unavailable';
  switch (kind) {
    case 'no-token': return 'המפה עוד לא מוכנה — נסה שוב בעוד רגע.';
    case 'unauthorized': return 'הטוקן של Mapbox לא מאפשר חיפוש וניווט. בחשבון Mapbox יש להוסיף לטוקן את ההרשאות Search ו-Directions.';
    case 'no-route': return 'לא נמצא מסלול נסיעה בין שתי הנקודות.';
    default: return 'השירות לא ענה. בדוק את החיבור ונסה שוב.';
  }
}
