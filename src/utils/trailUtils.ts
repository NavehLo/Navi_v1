export type Coordinate3D = [number, number, number]; // [lat, lon, elevation]

export function getBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180)
          - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function parseKML(xmlDoc: Document): Coordinate3D[] {
  const coords: Coordinate3D[] = [];
  const lineStrings = xmlDoc.getElementsByTagName("LineString");
  if (lineStrings.length > 0) {
    const coordStr = lineStrings[0].getElementsByTagName("coordinates")[0];
    if (coordStr && coordStr.textContent) {
      const points = coordStr.textContent.trim().split(/\s+/);
      for (let i = 0; i < points.length; i++) {
        const parts = points[i].split(',');
        if (parts.length >= 2) {
          const lon = parseFloat(parts[0]);
          const lat = parseFloat(parts[1]);
          const ele = parts.length >= 3 ? parseFloat(parts[2]) : 0;
          coords.push([lat, lon, ele]);
        }
      }
    }
  }
  return coords;
}

export function parseGPX(xmlDoc: Document): Coordinate3D[] {
  // Try track points first (trkpt), then route points (rtept), then waypoints (wpt)
  let points = xmlDoc.getElementsByTagName("trkpt");
  if (points.length === 0) points = xmlDoc.getElementsByTagName("rtept");
  if (points.length === 0) points = xmlDoc.getElementsByTagName("wpt");

  const coords: Coordinate3D[] = [];
  for (let i = 0; i < points.length; i++) {
    const lat = parseFloat(points[i].getAttribute("lat") || "0");
    const lon = parseFloat(points[i].getAttribute("lon") || "0");
    const eleTag = points[i].getElementsByTagName("ele")[0];
    const ele = eleTag && eleTag.textContent ? parseFloat(eleTag.textContent) : 0;
    if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon, ele]);
  }
  return coords;
}

// Haversine formula
export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

// ── Along-trail geometry ─────────────────────────────────────────────────────
// The tour camera advances by *distance* along the route, not by point index —
// GPX points are unevenly spaced, so the two disagree badly on real tracks.
// Everything that needs to know "where is the traveler" must use these.

// Index of the last trail point at or before `km`, via binary search.
function segmentIndexAt(acc: number[], km: number): number {
  let low = 0, high = acc.length - 1, lo = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (acc[mid] <= km) { lo = mid; low = mid + 1; } else { high = mid - 1; }
  }
  return lo;
}

// The point sitting `km` along the trail, interpolated inside its segment.
export function pointAtDistance(coords: Coordinate3D[], acc: number[], km: number): Coordinate3D {
  if (coords.length === 0) return [0, 0, 0];
  if (km <= 0) return coords[0];
  const last = acc[acc.length - 1] ?? 0;
  if (km >= last) return coords[coords.length - 1];

  const lo = segmentIndexAt(acc, km);
  const hi = Math.min(lo + 1, coords.length - 1);
  const distLo = acc[lo], distHi = acc[hi];
  if (hi === lo || distHi === distLo) return coords[lo];

  const frac = (km - distLo) / (distHi - distLo);
  const c1 = coords[lo], c2 = coords[hi];
  return [
    c1[0] + (c2[0] - c1[0]) * frac,
    c1[1] + (c2[1] - c1[1]) * frac,
    (c1[2] || 0) + ((c2[2] || 0) - (c1[2] || 0)) * frac,
  ];
}

export interface TrailProjection {
  index: number;      // nearest trail point
  km: number;         // how far along the trail that point is
  offTrailKm: number; // how far the position is from the trail itself
}

// Snaps a real GPS fix onto the route so field mode can reason about progress
// the same way the virtual tour does. `preferKm` breaks ties on out-and-back
// routes, where one coordinate belongs to two very different points of the walk.
export function projectOntoTrail(
  coords: Coordinate3D[],
  acc: number[],
  lat: number,
  lon: number,
  preferKm?: number | null
): TrailProjection | null {
  if (coords.length === 0) return null;

  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = getDistance(lat, lon, coords[i][0], coords[i][1]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  // Among the points that are essentially equally close (within 50 m of the
  // best), prefer the one nearest to where the walker already was.
  if (preferKm != null) {
    const tolerance = bestDist + 0.05;
    let tieIdx = bestIdx, tieGap = Math.abs((acc[bestIdx] ?? 0) - preferKm);
    for (let i = 0; i < coords.length; i++) {
      if (getDistance(lat, lon, coords[i][0], coords[i][1]) > tolerance) continue;
      const gap = Math.abs((acc[i] ?? 0) - preferKm);
      if (gap < tieGap) { tieGap = gap; tieIdx = i; }
    }
    bestIdx = tieIdx;
  }

  return { index: bestIdx, km: acc[bestIdx] ?? 0, offTrailKm: bestDist };
}
