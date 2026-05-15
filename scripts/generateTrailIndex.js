const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');
const trailsDir = path.join(publicDir, 'trails');

const regions = {
  north: 'צפון',
  center: 'מרכז',
  jerusalem: 'אזור ירושלים',
  south: 'דרום'
};

const types = {
  circular: 'מעגליים',
  multiday: 'מספר ימי הליכה'
};

function determineRegion(lat, lon) {
  if (lat > 32.4) return regions.north;
  if (lat < 31.6) return regions.south;
  if (lat >= 31.7 && lat <= 31.9 && lon >= 34.9 && lon <= 35.4) return regions.jerusalem;
  return regions.center;
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180; 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  return R * c; 
}

function processGPX(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = [...content.matchAll(/<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"/g)];
  if (matches.length > 0) {
    const startLat = parseFloat(matches[0][1]);
    const startLon = parseFloat(matches[0][2]);
    let distance = 0;
    for (let i = 1; i < matches.length; i++) {
      distance += getDistance(
        parseFloat(matches[i-1][1]), parseFloat(matches[i-1][2]),
        parseFloat(matches[i][1]), parseFloat(matches[i][2])
      );
    }
    return { lat: startLat, lon: startLon, distance: distance };
  }
  return null;
}

const allTrails = [];

// Process circular
const circularDir = path.join(trailsDir, 'circular');
if (fs.existsSync(circularDir)) {
  const files = fs.readdirSync(circularDir).filter(f => f.endsWith('.gpx') || f.endsWith('.GPX'));
  files.forEach(file => {
    const filePath = path.join(circularDir, file);
    const coords = processGPX(filePath);
    if (coords) {
      allTrails.push({
        id: `circular-${file}`,
        name: file.replace(/_?\d*\.gpx$/i, '').replace(/_/g, ' '),
        path: `/trails/circular/${file}`,
        type: types.circular,
        region: determineRegion(coords.lat, coords.lon),
        length: coords.distance,
        startCoord: [coords.lon, coords.lat] // Mapbox uses [lon, lat]
      });
    }
  });
}

// Process multi-day
const multidayDir = path.join(trailsDir, 'multi-day');
if (fs.existsSync(multidayDir)) {
  const files = fs.readdirSync(multidayDir).filter(f => f.endsWith('.gpx') || f.endsWith('.GPX'));
  files.forEach(file => {
    const filePath = path.join(multidayDir, file);
    const coords = processGPX(filePath);
    if (coords) {
      allTrails.push({
        id: `multiday-${file}`,
        name: file.replace(/_?\d*\.gpx$/i, '').replace(/_/g, ' '),
        path: `/trails/multi-day/${file}`,
        type: types.multiday,
        region: determineRegion(coords.lat, coords.lon),
        length: coords.distance,
        startCoord: [coords.lon, coords.lat]
      });
    }
  });
}

fs.writeFileSync(path.join(publicDir, 'trails.json'), JSON.stringify(allTrails, null, 2));
console.log(`Successfully generated index for ${allTrails.length} trails.`);
