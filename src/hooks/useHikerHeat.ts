import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type mapboxgl from 'mapbox-gl';
import { HEAT_STOPS } from '../lib/trailHeat';
import type { HeatData } from '../lib/trailCrowd/heat';
import { latinName } from '../lib/trailNames';
import type { WmtRouteSummary } from '../lib/waymarked';

// "מפת חום של מטיילים": where people walk, at a glance, over the light map.
// Each trail Komoot counts hikers on is a point weighted by heatWeight; the
// heat thins out as the map comes close, where the same trails take over as
// dots — the busier, the bigger and darker — named, with their hikers, and a
// tap opens the trail's card.

export const HIKER_HEAT_KEY = 'navi:hikerHeat';
const SOURCE = 'hiker-heat';
const LAYER = 'hiker-heat';
export const HEAT_TRAIL_DOT = 'hiker-heat-trail';
const HEAT_TRAIL_LABEL = 'hiker-heat-trail-label';
// Where the heat starts to fade, the trails appear; names a little closer.
const DOT_ZOOM = 7.5;
const LABEL_ZOOM = 9;

// On/off in localStorage, read through an external store like the world
// trails switch (useWorldTrails): the server render is always off.
const listeners = new Set<() => void>();
export function readHikerHeat(): boolean {
  try { return localStorage.getItem(HIKER_HEAT_KEY) === '1'; } catch { return false; }
}
function write(next: boolean) {
  try { localStorage.setItem(HIKER_HEAT_KEY, next ? '1' : '0'); } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// Fetched once a session.
let memo: HeatData | null = null;
let pending: Promise<HeatData | null> | null = null;
function fetchHeat(): Promise<HeatData | null> {
  if (memo) return Promise.resolve(memo);
  pending ??= fetch('/api/world-trails/heat')
    .then((r) => r.json())
    .then((d) => {
      if (d.status !== 'ok' || !Array.isArray(d.trails)) throw new Error(d.status);
      memo = { trails: d.trails, countries: d.countries ?? [] };
      return memo;
    })
    .catch(() => {
      pending = null; // another try next time
      return null;
    });
  return pending;
}

export function useHikerHeat(
  map: mapboxgl.Map | null,
  styleRev: number,
  { muted, onPick }: { muted: boolean; onPick: (summary: WmtRouteSummary) => void }
) {
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);
  const enabled = useSyncExternalStore(subscribe, readHikerHeat, () => false);
  const setEnabled = useCallback((next: boolean) => { if (readHikerHeat() !== next) write(next); }, []);
  const [data, setData] = useState<HeatData | null>(memo);

  useEffect(() => {
    if (!enabled || memo) return;
    let live = true;
    fetchHeat().then((d) => { if (live && d) setData(d); });
    return () => { live = false; };
  }, [enabled]);

  useEffect(() => {
    const heat = memo ?? data;
    if (!map || !enabled || !heat?.trails.length) return;
    const geojson = {
      type: 'FeatureCollection' as const,
      features: heat.trails.map((t) => ({
        type: 'Feature' as const,
        properties: {
          w: t.w, id: t.id, name: t.name, group: t.group, linear: t.linear,
          label: latinName(t.name, t.name_en, t.country) ?? t.name,
          // Hebrew alone: mixed with Latin, the map's text comes out scrambled.
          sub: `${t.hikers.toLocaleString('he-IL')} מטיילים`,
          // The busiest are drawn on top and named first.
          rank: -t.hikers,
        },
        geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
      })),
    };
    const fade = muted ? 0.5 : 1;
    const remove = () => {
      try {
        if (map.getLayer(HEAT_TRAIL_LABEL)) map.removeLayer(HEAT_TRAIL_LABEL);
        if (map.getLayer(HEAT_TRAIL_DOT)) map.removeLayer(HEAT_TRAIL_DOT);
        if (map.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      } catch {}
    };
    const draw = () => {
      if (!map.getStyle()) return;
      remove();
      map.addSource(SOURCE, { type: 'geojson', data: geojson });
      // Under the style's own names (places stay readable through the heat)
      // and so under everything the app draws on top.
      const beforeId = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
      map.addLayer({
        id: LAYER, type: 'heatmap', source: SOURCE, maxzoom: 13,
        paint: {
          'heatmap-weight': ['get', 'w'],
          // Wide enough that a valley's trails run together into one area.
          // Tuned to the square-root weights (half the trails weigh under 0.07).
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 6, 2.2, 9, 3.4],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 5, 22, 8, 36, 11, 50],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], ...HEAT_STOPS.flat()],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.85, 12, 0.3],
        },
      }, beforeId);
      // The trails themselves, over the style's names and under the app's own
      // layers (the leading trails' stars, the open route).
      const above = ['trail-leaders-dot', 'route-casing', 'wmt-selection-casing', 'clusters'].find((id) => map.getLayer(id));
      map.addLayer({
        id: HEAT_TRAIL_DOT, type: 'circle', source: SOURCE, minzoom: DOT_ZOOM,
        layout: { 'circle-sort-key': ['get', 'w'] },
        paint: {
          // About 500, 5,000 and 20,000 hikers.
          'circle-color': ['interpolate', ['linear'], ['get', 'w'], 0.1, '#fd8d3c', 0.3, '#e31a1c', 0.63, '#800026'],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], DOT_ZOOM, ['interpolate', ['linear'], ['get', 'w'], 0, 3, 0.6, 7], 12, ['interpolate', ['linear'], ['get', 'w'], 0, 6, 0.6, 12]],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], DOT_ZOOM, 0, DOT_ZOOM + 0.5, fade],
          'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], DOT_ZOOM, 0, DOT_ZOOM + 0.5, fade],
        },
      }, above);
      map.addLayer({
        id: HEAT_TRAIL_LABEL, type: 'symbol', source: SOURCE, minzoom: LABEL_ZOOM,
        layout: {
          'text-field': ['format', ['get', 'label'], {}, '\n', {}, ['get', 'sub'], { 'font-scale': 0.85 }],
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-size': 13,
          'text-offset': [0, 1],
          'text-anchor': 'top',
          'symbol-sort-key': ['get', 'rank'],
        },
        paint: {
          'text-color': '#18181b',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.8,
          'text-opacity': fade,
        },
      }, above);
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
    map.on('click', HEAT_TRAIL_DOT, click);
    map.on('mouseenter', HEAT_TRAIL_DOT, enter);
    map.on('mouseleave', HEAT_TRAIL_DOT, leave);
    return () => {
      map.off('style.load', draw);
      map.off('click', HEAT_TRAIL_DOT, click);
      map.off('mouseenter', HEAT_TRAIL_DOT, enter);
      map.off('mouseleave', HEAT_TRAIL_DOT, leave);
      remove();
    };
  }, [map, enabled, data, muted, styleRev]);

  return { enabled, setEnabled, countries: (memo ?? data)?.countries ?? null };
}
