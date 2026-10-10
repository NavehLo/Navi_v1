import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import { useLeaders } from '../lib/trailLeadersClient';
import { TRAFFIC_LABELS, trailTitle } from '../lib/trailCrowd/score';
import { latinName } from '../lib/trailNames';
import type { WmtRouteSummary } from '../lib/waymarked';

// The leading trails of every collected country, as gold stars on the map
// while the world trails overlay is on: the most walked trails stand out from
// the hundreds of lines around them. A star sits at a point of its trail; a
// tap opens the trail's card, as a tap on the line would. The names appear
// once the map is close enough to read them without clutter.

export const LEADERS_SOURCE = 'trail-leaders';
export const LEADERS_DOT = 'trail-leaders-dot';
const LEADERS_LABEL = 'trail-leaders-label';
// Below this the stars of a whole country sit on top of each other.
const MIN_ZOOM = 5;
const LABEL_ZOOM = 7.5;

export function useTrailLeaders(
  map: mapboxgl.Map | null,
  styleRev: number,
  { enabled, muted, onPick, minZoom = MIN_ZOOM }: {
    enabled: boolean; muted: boolean; onPick: (summary: WmtRouteSummary) => void;
    // Over the hiker heat alone the stars wait a step closer, so a whole
    // country's heat reads clearly first.
    minZoom?: number;
  }
) {
  const leaders = useLeaders(enabled);
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  useEffect(() => {
    if (!map || !enabled) return;
    const features = Object.entries(leaders).flatMap(([code, l]) =>
      [...l.day, ...l.long].map((t, i) => ({
        type: 'Feature' as const,
        properties: {
          id: t.id, name: t.name, group: t.group, linear: t.linear,
          label: latinName(t.name, t.name_en, code) ?? trailTitle(t.name, t.crowd.komootName).title,
          sub: [t.crowd.traffic !== 'unknown' ? TRAFFIC_LABELS[t.crowd.traffic] : null, t.crowd.rating != null ? `★ ${t.crowd.rating.toFixed(1)}` : null]
            .filter(Boolean).join(' · '),
          // The busiest are drawn on top and named first.
          rank: i,
        },
        geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
      }))
    );
    if (!features.length) return;
    const data = { type: 'FeatureCollection' as const, features };

    const remove = () => {
      try {
        if (map.getLayer(LEADERS_LABEL)) map.removeLayer(LEADERS_LABEL);
        if (map.getLayer(LEADERS_DOT)) map.removeLayer(LEADERS_DOT);
        if (map.getSource(LEADERS_SOURCE)) map.removeSource(LEADERS_SOURCE);
      } catch {}
    };
    const draw = () => {
      if (!map.getStyle()) return;
      remove();
      map.addSource(LEADERS_SOURCE, { type: 'geojson', data });
      // Under the open trail and the selected route, over the overlay tiles.
      const beforeId = ['route-casing', 'wmt-selection-casing', 'clusters'].find((id) => map.getLayer(id));
      map.addLayer({
        id: LEADERS_DOT, type: 'circle', source: LEADERS_SOURCE, minzoom: minZoom,
        layout: { 'circle-sort-key': ['-', 100, ['get', 'rank']] },
        paint: {
          'circle-color': '#fbbf24',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], minZoom, 5, Math.max(10, minZoom + 1), 8],
          'circle-stroke-color': '#18181b',
          'circle-stroke-width': 2,
          'circle-opacity': muted ? 0.5 : 1,
          'circle-stroke-opacity': muted ? 0.5 : 1,
        },
      }, beforeId);
      map.addLayer({
        id: LEADERS_LABEL, type: 'symbol', source: LEADERS_SOURCE, minzoom: LABEL_ZOOM,
        layout: {
          'text-field': ['format', ['get', 'label'], {}, '\n', {}, ['get', 'sub'], { 'font-scale': 0.85 }],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 13,
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: {
          'text-color': '#fde68a',
          'text-halo-color': '#18181b',
          'text-halo-width': 1.6,
          'text-opacity': muted ? 0.5 : 1,
        },
      }, beforeId);
    };
    try { draw(); } catch {}
    map.on('style.load', draw);

    const click = (e: mapboxgl.MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      onPickRef.current({ type: 'relation', id: Number(p.id), name: p.name, group: p.group, linear: p.linear });
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', LEADERS_DOT, click);
    map.on('mouseenter', LEADERS_DOT, enter);
    map.on('mouseleave', LEADERS_DOT, leave);
    return () => {
      map.off('style.load', draw);
      map.off('click', LEADERS_DOT, click);
      map.off('mouseenter', LEADERS_DOT, enter);
      map.off('mouseleave', LEADERS_DOT, leave);
      remove();
    };
  }, [map, enabled, leaders, muted, minZoom, styleRev]);
}
