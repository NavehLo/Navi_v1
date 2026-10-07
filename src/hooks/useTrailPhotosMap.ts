import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { TrailPhoto } from '../lib/trailPhotos/types';

// "תמונות מהמסלול" on the map: a camera where each photo was taken, once the
// trail card has loaded them (until the trail is closed). A tap on a camera
// opens its photo; the one last shown on the map ("הצג במפה") is drawn larger,
// in a ring.

const SOURCE = 'trail-photos';
const RING = 'trail-photos-ring';
// Exported for the place-name popup, which keeps out of taps on our marks.
export const PHOTOS_ICON_LAYER = 'trail-photos-icon';
const ICON = PHOTOS_ICON_LAYER;
const IMAGE = 'trail-photo-camera';

// A small camera in an amber badge, drawn once per style — round dots were
// taken for the guide's points, which are white circles too.
function cameraImage(): ImageData | null {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#f59e0b';
  g.strokeStyle = '#1c1917';
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(3, 3, size - 6, size - 6, 10);
  g.fill();
  g.stroke();
  g.fillStyle = '#1c1917';
  g.beginPath();
  g.roundRect(10, 15, 24, 17, 3);
  g.fill();
  g.fillRect(17, 11, 10, 5);
  g.fillStyle = '#f59e0b';
  g.beginPath();
  g.arc(22, 23.5, 5.5, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1c1917';
  g.beginPath();
  g.arc(22, 23.5, 3, 0, Math.PI * 2);
  g.fill();
  return g.getImageData(0, 0, size, size);
}

export function useTrailPhotosMap(
  map: mapboxgl.Map | null,
  styleRev: number,
  photos: TrailPhoto[] | null,
  focusId: string | null,
  onPick: (index: number) => void,
) {
  const pickRef = useRef(onPick);
  useEffect(() => { pickRef.current = onPick; });

  useEffect(() => {
    if (!map || !photos?.length) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: photos.flatMap((p, i): GeoJSON.Feature[] => p.lat == null || p.lon == null ? [] : [{
        type: 'Feature',
        properties: { index: i, focus: p.id === focusId ? 1 : 0 },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      }]),
    };
    const remove = () => {
      try {
        for (const id of [ICON, RING]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      } catch {}
    };
    const draw = () => {
      if (!map.getStyle()) return;
      remove();
      map.addSource(SOURCE, { type: 'geojson', data });
      if (!map.hasImage(IMAGE)) {
        const img = cameraImage();
        if (img) map.addImage(IMAGE, img, { pixelRatio: 2 });
      }
      // The ring marks the one last shown on the map ("הצג במפה").
      map.addLayer({
        id: RING, type: 'circle', source: SOURCE, filter: ['==', ['get', 'focus'], 1],
        paint: { 'circle-radius': 20, 'circle-color': '#f59e0b', 'circle-opacity': 0.35, 'circle-stroke-color': '#fbbf24', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: ICON, type: 'symbol', source: SOURCE,
        layout: {
          'icon-image': IMAGE,
          'icon-size': ['case', ['==', ['get', 'focus'], 1], 1.25, 1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    };
    const click = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.GeoJSONFeature[] }) => {
      const index = Number(e.features?.[0]?.properties?.index);
      if (Number.isInteger(index)) pickRef.current(index);
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    try { draw(); } catch {}
    map.on('style.load', draw);
    map.on('click', ICON, click);
    map.on('mouseenter', ICON, enter);
    map.on('mouseleave', ICON, leave);
    return () => {
      map.off('style.load', draw);
      map.off('click', ICON, click);
      map.off('mouseenter', ICON, enter);
      map.off('mouseleave', ICON, leave);
      remove();
    };
  }, [map, photos, focusId, styleRev]);
}
