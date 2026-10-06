import { useEffect } from 'react';
import type mapboxgl from 'mapbox-gl';
import { regionBounds } from '../lib/countryGuide/client';
import type { CountryGuide } from '../lib/countryGuide/types';

// "אזורי טיול" on the map: the region being read about, outlined, with the
// places that define it, where its trails start and the real lines of those
// that are marked routes — or every region of the country at once, numbered
// as in the text, with their routes. The map is framed on it, leaving
// room for the panel (beside it on a wide screen, folded below it on a phone).

export interface GuideMapView {
  guide: CountryGuide;
  // A region's place in guide.regions, or -1 for all of them.
  index: number;
}

const SOURCE = 'country-guide';
const FILL = 'country-guide-fill';
const LINE = 'country-guide-line';
const DOTS = 'country-guide-dots';
const ROUTES = 'country-guide-routes';
const LABELS = 'country-guide-labels';

function features(view: GuideMapView) {
  const all = view.index < 0;
  const regions = all ? view.guide.regions.map((r, i) => ({ r, i })) : [{ r: view.guide.regions[view.index], i: view.index }];
  return regions.filter(({ r }) => r).flatMap(({ r, i }) => {
    const out: GeoJSON.Feature[] = [];
    if (r.shape) {
      out.push({
        type: 'Feature',
        properties: { kind: 'area' },
        geometry: { type: 'MultiPolygon', coordinates: r.shape.polygons },
      });
    }
    for (const t of r.trails) {
      if (t.line?.length) {
        out.push({ type: 'Feature', properties: { kind: 'route', label: t.name }, geometry: { type: 'MultiLineString', coordinates: t.line } });
      }
    }
    const box = regionBounds(r);
    if (box && all) {
      out.push({
        type: 'Feature',
        properties: { kind: 'name', label: `${i + 1}. ${r.name}` },
        geometry: { type: 'Point', coordinates: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] },
      });
    }
    if (!all) {
      for (const p of r.places) {
        out.push({ type: 'Feature', properties: { kind: 'place', label: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
      }
      for (const t of r.trails) {
        if (t.start) out.push({ type: 'Feature', properties: { kind: 'trail', label: t.name }, geometry: { type: 'Point', coordinates: t.start } });
      }
    }
    return out;
  });
}

function bounds(view: GuideMapView): [number, number, number, number] | null {
  const regions = view.index < 0 ? view.guide.regions : [view.guide.regions[view.index]];
  const boxes = regions.flatMap((r) => { const b = r ? regionBounds(r) : null; return b ? [b] : []; });
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])),
  ];
}

export function useCountryGuideMap(map: mapboxgl.Map | null, styleRev: number, view: GuideMapView | null) {
  // Drawn whenever what is shown changes, or the map's style is replaced.
  useEffect(() => {
    if (!map || !view) return;
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: features(view) };
    const remove = () => {
      try {
        for (const id of [LABELS, DOTS, ROUTES, LINE, FILL]) if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      } catch {}
    };
    const draw = () => {
      if (!map.getStyle()) return;
      remove();
      map.addSource(SOURCE, { type: 'geojson', data });
      const beforeId = ['route-casing', 'wmt-selection-casing', 'clusters'].find((id) => map.getLayer(id));
      map.addLayer({
        id: FILL, type: 'fill', source: SOURCE, filter: ['==', ['get', 'kind'], 'area'],
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.14 },
      }, beforeId);
      map.addLayer({
        id: LINE, type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'area'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#7dd3fc', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      }, beforeId);
      map.addLayer({
        id: ROUTES, type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'route'],
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f97316', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 11, 4], 'line-opacity': 0.9 },
      }, beforeId);
      map.addLayer({
        id: DOTS, type: 'circle', source: SOURCE, filter: ['in', ['get', 'kind'], ['literal', ['place', 'trail']]],
        paint: {
          'circle-color': ['match', ['get', 'kind'], 'trail', '#fbbf24', '#ffffff'],
          'circle-radius': ['match', ['get', 'kind'], 'trail', 6, 4],
          'circle-stroke-color': '#18181b',
          'circle-stroke-width': 2,
        },
      }, beforeId);
      map.addLayer({
        id: LABELS, type: 'symbol', source: SOURCE, filter: ['in', ['get', 'kind'], ['literal', ['place', 'trail', 'name']]],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': ['match', ['get', 'kind'], 'name', 15, 13],
          'text-offset': ['match', ['get', 'kind'], 'name', ['literal', [0, 0]], ['literal', [0, 1]]],
          'text-anchor': ['match', ['get', 'kind'], 'name', 'center', 'top'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': ['match', ['get', 'kind'], 'trail', '#fde68a', 'name', '#e0f2fe', '#ffffff'],
          'text-halo-color': '#18181b',
          'text-halo-width': 1.8,
        },
      });
    };
    try { draw(); } catch {}
    map.on('style.load', draw);
    return () => {
      map.off('style.load', draw);
      remove();
    };
  }, [map, view, styleRev]);

  // Framed only when the region changes, not when the style does.
  useEffect(() => {
    if (!map || !view) return;
    const box = bounds(view);
    if (!box) return;
    const wide = window.innerWidth >= 768;
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {
      // Clear of the place search and the control rail as well as the panel.
      padding: wide ? { top: 100, bottom: 50, left: 120, right: 440 } : { top: 130, bottom: 210, left: 110, right: 20 },
      maxZoom: 10,
      duration: 1400,
      pitch: 0,
    });
  }, [map, view]);
}
