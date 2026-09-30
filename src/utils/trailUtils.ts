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

// ── Elevation gain / loss ────────────────────────────────────────────────────
// Summed with hysteresis: a climb or descent only counts once it has run past
// `threshold` metres in one direction. Without it, the metre-scale jitter of
// a GPS track or a 30 m DEM adds up to hundreds of metres of "climbing" that
// nobody walked. 5 m is the usual figure (it is what most trail sites use).
export function computeElevationGain(elevations: number[], threshold = 5): { gain: number; loss: number } {
  let gain = 0, loss = 0;
  if (elevations.length < 2) return { gain, loss };

  let anchor = elevations[0];
  let extreme = elevations[0];
  let dir: 1 | -1 | 0 = 0; // which way the current run is going

  for (let i = 1; i < elevations.length; i++) {
    const e = elevations[i];
    if (dir === 0) {
      if (e - anchor >= threshold) { dir = 1; extreme = e; }
      else if (anchor - e >= threshold) { dir = -1; extreme = e; }
      continue;
    }
    if (dir === 1) {
      if (e > extreme) extreme = e;
      else if (extreme - e >= threshold) { gain += extreme - anchor; anchor = extreme; extreme = e; dir = -1; }
    } else {
      if (e < extreme) extreme = e;
      else if (e - extreme >= threshold) { loss += anchor - extreme; anchor = extreme; extreme = e; dir = 1; }
    }
  }
  // Close the run that was still going at the end.
  if (dir === 1) gain += extreme - anchor;
  else if (dir === -1) loss += anchor - extreme;
  return { gain: Math.round(gain), loss: Math.round(loss) };
}

// ── Snapping onto the line itself ────────────────────────────────────────────
// projectOntoTrail above measures to the nearest *point*, which is fine for
// dense GPS tracks but not for a route whose points are hundreds of metres
// apart: standing on the path halfway between two of them reads as "far off
// the trail". This measures to the nearest *segment*, so the distance off the
// route is the real one and the position along it is interpolated.

export interface TrailSnap {
  km: number;         // how far along the trail the snapped point is
  offTrailKm: number; // straight-line distance from the position to the trail
  lat: number;
  lon: number;
  ele: number;
}

export function snapToTrail(
  coords: Coordinate3D[],
  acc: number[],
  lat: number,
  lon: number,
  preferKm?: number | null
): TrailSnap | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    const [la, lo, e] = coords[0];
    return { km: 0, offTrailKm: getDistance(lat, lon, la, lo), lat: la, lon: lo, ele: e || 0 };
  }

  // A local flat projection around the position: at trail scale the error is
  // far below GPS noise, and it keeps each segment test to a few multiplies.
  const kx = 111.32 * Math.cos(lat * Math.PI / 180);
  const ky = 110.574;

  type Hit = { i: number; t: number; d: number };
  const hits: Hit[] = [];
  let best: Hit = { i: 0, t: 0, d: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = (coords[i][1] - lon) * kx, ay = (coords[i][0] - lat) * ky;
    const bx = (coords[i + 1][1] - lon) * kx, by = (coords[i + 1][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.sqrt(px * px + py * py);
    const hit = { i, t, d };
    if (preferKm != null) hits.push(hit);
    if (d < best.d) best = hit;
  }

  const kmOf = (h: Hit) => acc[h.i] + (acc[h.i + 1] - acc[h.i]) * h.t;

  // Out-and-back routes pass the same spot twice. Among the segments that are
  // essentially as close as the best (within 30 m), take the one nearest to
  // where the walker already was.
  if (preferKm != null) {
    const tolerance = best.d + 0.03;
    let gap = Math.abs(kmOf(best) - preferKm);
    for (const h of hits) {
      if (h.d > tolerance) continue;
      const g = Math.abs(kmOf(h) - preferKm);
      if (g < gap) { gap = g; best = h; }
    }
  }

  const a = coords[best.i], b = coords[best.i + 1];
  return {
    km: kmOf(best),
    offTrailKm: best.d,
    lat: a[0] + (b[0] - a[0]) * best.t,
    lon: a[1] + (b[1] - a[1]) * best.t,
    ele: (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * best.t,
  };
}

// The stretch of trail between two along-trail distances, in the order it
// will be walked: from `fromKm` to `toKm`, backwards along the file if `toKm`
// comes first. The ends are interpolated, not rounded to the nearest point.
export function sliceTrail(coords: Coordinate3D[], acc: number[], fromKm: number, toKm: number): Coordinate3D[] {
  const lo = Math.min(fromKm, toKm), hi = Math.max(fromKm, toKm);
  const out: Coordinate3D[] = [pointAtDistance(coords, acc, lo)];
  for (let i = 0; i < coords.length; i++) {
    if (acc[i] > lo && acc[i] < hi) out.push(coords[i]);
  }
  out.push(pointAtDistance(coords, acc, hi));
  return fromKm <= toKm ? out : out.reverse();
}

// A minimal GPX track, so a measured stretch can be kept in the personal area
// the same way an uploaded file is.
export function coordsToGpx(coords: Coordinate3D[], name: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pts = coords
    .map(([lat, lon, ele]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${Math.round(ele || 0)}</ele></trkpt>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Navi" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name)}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}
