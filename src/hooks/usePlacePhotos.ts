import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { LEADERS_DOT } from './useTrailLeaders';
import { HEAT_TRAIL_DOT } from './useHikerHeat';
import { PHOTOS_ICON_LAYER } from './useTrailPhotosMap';

// Tapping a name the map itself writes — a beach, a peak, a bay, a village —
// opens a small card with a button to Google Images for that place, so the
// reader can see what Cala Luna looks like before deciding to walk there.
// The query is built in searchQuery below.
//
// The names come from the Mapbox style, so the layers are found by what they
// draw (their source layer) rather than by id: the three map styles share the
// same vector tiles.

const LABEL_SOURCES = new Set(['poi_label', 'natural_label', 'place_label', 'airport_label']);
// Too big to mean "this spot".
const SKIP_LAYERS = new Set(['country-label', 'state-label', 'continent-label']);
// The app's own markers answer their own taps.
const OWN_LAYERS = ['trail-poi-dot', 'unclustered-point', 'clusters', LEADERS_DOT, HEAT_TRAIL_DOT, 'measure-line', 'drive-options-line', PHOTOS_ICON_LAYER];

export interface PlaceLabel {
  /** The name as the map shows it (English where it has one). */
  shown: string;
  /** The local name, under the English one when they differ. */
  local: string;
  /** What Google Images is asked for. */
  query: string;
}

// Settlement names are found within this many pixels of the tap.
const NEAR_PX = 200;
const countryNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// The local name alone is often a common word: a viewpoint in Zagori called
// Οξιά brought up pictures of beech trees. Mapbox's English name carries the
// kind of place ("Viewpoint Oxia"), and the nearest village and the country
// pin it to the right one — "Viewpoint Oxia Monodendri Greece".
function searchQuery(map: mapboxgl.Map, point: mapboxgl.Point, layers: string[], f: mapboxgl.MapboxGeoJSONFeature, name: string): string {
  const parts = [name];
  let iso = str(f.properties?.iso_3166_1);
  if (f.sourceLayer !== 'place_label') {
    const box: [mapboxgl.PointLike, mapboxgl.PointLike] = [[point.x - NEAR_PX, point.y - NEAR_PX], [point.x + NEAR_PX, point.y + NEAR_PX]];
    let best: { name: string; iso: string; d: number } | null = null;
    for (const s of map.queryRenderedFeatures(box, { layers })) {
      if (s.sourceLayer !== 'place_label' || s.properties?.class !== 'settlement' || s.geometry.type !== 'Point') continue;
      const sName = str(s.properties?.name_en) || str(s.properties?.name);
      if (!sName) continue;
      const at = map.project(s.geometry.coordinates as [number, number]);
      const d = Math.hypot(at.x - point.x, at.y - point.y);
      if (!best || d < best.d) best = { name: sName, iso: str(s.properties?.iso_3166_1), d };
    }
    if (best) {
      if (!name.toLowerCase().includes(best.name.toLowerCase())) parts.push(best.name);
      iso ||= best.iso;
    }
  }
  const country = iso && countryNames ? countryNames.of(iso.toUpperCase()) ?? '' : '';
  if (country && country !== iso.toUpperCase() && !parts.some((p) => p.toLowerCase().includes(country.toLowerCase()))) parts.push(country);
  return parts.join(' ');
}

function labelLayers(map: mapboxgl.Map): string[] {
  const layers = map.getStyle()?.layers ?? [];
  return layers
    .filter((l) => l.type === 'symbol' && LABEL_SOURCES.has((l as { 'source-layer'?: string })['source-layer'] ?? '') && !SKIP_LAYERS.has(l.id))
    .map((l) => l.id);
}

/** The map's own place name under a tap, if there is one and nothing of ours is on top of it. */
export function placeLabelAt(map: mapboxgl.Map, point: mapboxgl.Point): PlaceLabel | null {
  try {
    const own = OWN_LAYERS.filter((id) => map.getLayer(id));
    if (own.length && map.queryRenderedFeatures(point, { layers: own }).length) return null;
    const layers = labelLayers(map);
    if (!layers.length) return null;
    for (const f of map.queryRenderedFeatures(point, { layers })) {
      const local = str(f.properties?.name);
      if (!local) continue;
      const shown = str(f.properties?.name_en) || local;
      return { shown, local, query: searchQuery(map, point, layers, f, shown) };
    }
  } catch {}
  return null;
}

export function googleImagesUrl(query: string): string {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`;
}

export function usePlacePhotos(map: mapboxgl.Map | null) {
  const popupRef = useRef<mapboxgl.Popup | null>(null);

  useEffect(() => {
    if (!map) return;

    const onClick = (e: mapboxgl.MapMouseEvent) => {
      const place = placeLabelAt(map, e.point);
      if (!place) return;
      popupRef.current?.remove();

      const box = document.createElement('div');
      box.dir = 'rtl';
      box.className = 'p-3 flex flex-col gap-2 bg-zinc-900/95 backdrop-blur-md text-white rounded-2xl shadow-xl border border-white/10';
      box.style.minWidth = '180px';

      const title = document.createElement('div');
      title.dir = 'auto';
      title.className = 'text-sm font-bold text-white';
      title.textContent = place.shown;
      box.appendChild(title);
      if (place.local !== place.shown) {
        const local = document.createElement('div');
        local.dir = 'auto';
        local.className = 'text-xs text-white -mt-1';
        local.textContent = place.local;
        box.appendChild(local);
      }

      const link = document.createElement('a');
      link.href = googleImagesUrl(place.query);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'flex items-center justify-center gap-1.5 text-sm font-bold text-white bg-sky-600 hover:bg-sky-500 px-3 py-2 rounded-xl transition-colors';
      link.textContent = '📷 תמונות בגוגל';
      box.appendChild(link);

      const popup = new mapboxgl.Popup({ closeButton: false, className: 'trail-popup', maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setDOMContent(box)
        .addTo(map);
      link.addEventListener('click', () => popup.remove());
      popupRef.current = popup;
    };

    // A pointer over a name says it can be tapped.
    let pointing = false;
    const onMove = (e: mapboxgl.MapMouseEvent) => {
      const over = !!placeLabelAt(map, e.point);
      if (over === pointing) return;
      pointing = over;
      map.getCanvas().style.cursor = over ? 'pointer' : '';
    };

    map.on('click', onClick);
    map.on('mousemove', onMove);
    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
      popupRef.current?.remove();
      popupRef.current = null;
    };
  }, [map]);
}
