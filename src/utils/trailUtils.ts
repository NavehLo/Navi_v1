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
