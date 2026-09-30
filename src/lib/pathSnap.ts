import type mapboxgl from 'mapbox-gl';

// The spot on the nearest walkable way — a path, a dirt track, a street — to a
// point on the screen, read off the roads the map itself is drawing there.
// A pin dropped in a field or on a rooftop moves to where a walk could start.
//
// Only what is rendered can be found: paths appear from about zoom 13, so
// zoomed further out this finds nothing and the routing service does the
// snapping instead (it always starts a route on the nearest walkable way).

// Road classes (Mapbox Streets v8) that are not somewhere to walk.
const NOT_WALKABLE = new Set([
  'motorway', 'motorway_link', 'ferry', 'major_rail', 'minor_rail', 'service_rail',
  'aerialway', 'golf', 'construction',
]);

export function snapToRenderedPath(
  map: mapboxgl.Map,
  px: number,
  py: number,
  radiusPx = 40
): { lat: number; lon: number } | null {
  let features: mapboxgl.MapboxGeoJSONFeature[];
  try {
    features = map.queryRenderedFeatures([[px - radiusPx, py - radiusPx], [px + radiusPx, py + radiusPx]]);
  } catch {
    return null;
  }
  const target = map.unproject([px, py]);
  const kx = 111.32 * Math.cos(target.lat * Math.PI / 180), ky = 110.574;

  const lines: number[][][] = [];
  for (const f of features) {
    if (f.sourceLayer !== 'road') continue;
    if (NOT_WALKABLE.has(String(f.properties?.class ?? ''))) continue;
    const g = f.geometry;
    if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
  }

  let best: { lat: number; lon: number; d: number } | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const ax = (line[i][0] - target.lng) * kx, ay = (line[i][1] - target.lat) * ky;
      const bx = (line[i + 1][0] - target.lng) * kx, by = (line[i + 1][1] - target.lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
      const x = ax + dx * t, y = ay + dy * t;
      const d = Math.hypot(x, y);
      if (!best || d < best.d) best = { lon: target.lng + x / kx, lat: target.lat + y / ky, d };
    }
  }
  return best ? { lat: best.lat, lon: best.lon } : null;
}
