import { useState } from 'react';
import { Coordinate3D, parseGPX, parseKML, getDistance } from '../utils/trailUtils';

export interface TrailData {
  name: string;
  coords: Coordinate3D[];
  elevations: number[];
  minEle: number;
  maxEle: number;
  centerLat: number;
  centerLatMid: number;
  centerLon: number;
  totalDistance: number;
  accumulatedDistances: number[];
  start: Coordinate3D | null;
  end: Coordinate3D | null;
  geoJson: any;
  pois: { index: number, coord: Coordinate3D, type: string }[];
}

export function useTrailData() {
  const [trail, setTrail] = useState<TrailData | null>(null);
  const [trailError, setTrailError] = useState<string | null>(null);
  const [trailLoading, setTrailLoading] = useState(false);

  const loadTrailFile = (file: File) => {
    setTrailError(null);
    setTrailLoading(true);

    const reader = new FileReader();

    reader.onerror = () => {
      setTrailLoading(false);
      setTrailError('שגיאה בקריאת הקובץ. נסה שוב.');
    };

    reader.onload = function (e) {
      setTrailLoading(false);
      try {
        if (!e.target?.result) {
          setTrailError('הקובץ ריק או לא ניתן לקריאה.');
          return;
        }
        const text = e.target.result as string;

        // Check for XML parse errors
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        const parseError = xmlDoc.querySelector('parsererror');
        if (parseError) {
          setTrailError('הקובץ אינו XML תקני. בדוק שהקובץ תקין ונסה שוב.');
          return;
        }

        let parsedCoords: Coordinate3D[] = [];
        let trailName = file.name.replace(/\.(gpx|kml)$/i, '');

        if (file.name.toLowerCase().endsWith('.kml')) {
          const nameNode = xmlDoc.getElementsByTagName('name')[0];
          if (nameNode?.textContent) trailName = nameNode.textContent.trim();
          parsedCoords = parseKML(xmlDoc);
        } else {
          const nameNode = xmlDoc.getElementsByTagName('name')[0];
          if (nameNode?.textContent) trailName = nameNode.textContent.trim();
          parsedCoords = parseGPX(xmlDoc);
        }

        if (parsedCoords.length === 0) {
          setTrailError(
            `לא נמצאו נקודות מסלול בקובץ "${file.name}". ` +
            'ודא שהקובץ מכיל track (<trkpt>), route (<rtept>) או waypoints (<wpt>).'
          );
          return;
        }

        processCoordinates(parsedCoords, trailName);
      } catch (err: any) {
        setTrailError('שגיאה בעיבוד הקובץ: ' + (err?.message || String(err)));
      }
    };

    reader.readAsText(file, 'UTF-8');
  };

  const loadTrailFromUrl = async (url: string, defaultName?: string) => {
    setTrailError(null);
    setTrailLoading(true);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
      }
      const text = await res.text();

      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      const parseError = xmlDoc.querySelector('parsererror');
      if (parseError) {
        setTrailError('הקובץ אינו XML תקני. בדוק שהקובץ תקין ונסה שוב.');
        setTrailLoading(false);
        return;
      }

      let parsedCoords: Coordinate3D[] = [];
      let trailName = defaultName || url.split('/').pop()?.replace(/\.(gpx|kml)$/i, '') || 'מסלול';

      if (url.toLowerCase().endsWith('.kml')) {
        const nameNode = xmlDoc.getElementsByTagName('name')[0];
        if (nameNode?.textContent) trailName = nameNode.textContent.trim();
        parsedCoords = parseKML(xmlDoc);
      } else {
        const nameNode = xmlDoc.getElementsByTagName('name')[0];
        if (nameNode?.textContent) trailName = nameNode.textContent.trim();
        parsedCoords = parseGPX(xmlDoc);
      }

      if (parsedCoords.length === 0) {
        setTrailError('לא נמצאו נקודות מסלול בקובץ.');
        setTrailLoading(false);
        return;
      }

      processCoordinates(parsedCoords, trailName);
      setTrailLoading(false);
    } catch (err: any) {
      setTrailError('שגיאה בטעינת המסלול: ' + (err?.message || String(err)));
      setTrailLoading(false);
    }
  };

  const processCoordinates = (coordsArr: Coordinate3D[], name: string) => {
    let tDist = 0;
    const accDists = [0];
    let minE = Infinity, maxE = -Infinity;
    let sumLat = 0, sumLon = 0;
    const eles: number[] = [];

    for (let i = 0; i < coordsArr.length; i++) {
      const p = coordsArr[i];
      eles.push(p[2]);
      if (p[2] < minE) minE = p[2];
      if (p[2] > maxE) maxE = p[2];
      sumLat += p[0];
      sumLon += p[1];

      if (i > 0) {
        const prev = coordsArr[i - 1];
        const dist = getDistance(prev[0], prev[1], p[0], p[1]);
        tDist += dist;
        accDists.push(tDist);
      }
    }

    const startPt = coordsArr[0];
    const endPt = coordsArr[coordsArr.length - 1];

    const pois = [
      { index: 0, coord: startPt, type: 'start' },
      { index: Math.floor(coordsArr.length / 2), coord: coordsArr[Math.floor(coordsArr.length / 2)], type: 'midway' },
      { index: coordsArr.length - 1, coord: endPt, type: 'end' }
    ];

    const geoJson = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: coordsArr.map(c => [c[1], c[0], c[2]])
      }
    };

    setTrailError(null);
    setTrail({
      name,
      coords: coordsArr,
      elevations: eles,
      minEle: minE === Infinity ? 0 : minE,
      maxEle: maxE === -Infinity ? 0 : maxE,
      centerLat: sumLat / coordsArr.length,
      centerLon: sumLon / coordsArr.length,
      centerLatMid: coordsArr[Math.floor(coordsArr.length / 2)][0],
      totalDistance: tDist,
      accumulatedDistances: accDists,
      start: startPt,
      end: endPt,
      geoJson,
      pois
    });
  };

  return { trail, setTrail, trailError, trailLoading, loadTrailFile, loadTrailFromUrl, processCoordinates };
}
