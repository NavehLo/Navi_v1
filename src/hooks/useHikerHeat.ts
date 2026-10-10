import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type mapboxgl from 'mapbox-gl';
import { HEAT_STOPS } from '../lib/trailHeat';
import type { HeatData } from '../lib/trailCrowd/heat';

// "מפת חום של מטיילים": where people walk, at a glance, over the light map.
// Each trail Komoot counts hikers on is a point weighted by heatWeight; the
// heat thins out as the map comes close, where single trails take over.

export const HIKER_HEAT_KEY = 'navi:hikerHeat';
const SOURCE = 'hiker-heat';
const LAYER = 'hiker-heat';

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
      if (d.status !== 'ok' || !Array.isArray(d.points)) throw new Error(d.status);
      memo = { points: d.points, countries: d.countries ?? [] };
      return memo;
    })
    .catch(() => {
      pending = null; // another try next time
      return null;
    });
  return pending;
}

export function useHikerHeat(map: mapboxgl.Map | null, styleRev: number) {
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
    if (!map || !enabled || !heat?.points.length) return;
    const geojson = {
      type: 'FeatureCollection' as const,
      features: heat.points.map(([lon, lat, w]) => ({
        type: 'Feature' as const,
        properties: { w },
        geometry: { type: 'Point' as const, coordinates: [lon, lat] },
      })),
    };
    const remove = () => {
      try {
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
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 6, 0.8, 9, 1.4],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 5, 22, 8, 36, 11, 50],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], ...HEAT_STOPS.flat()],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.85, 12, 0.3],
        },
      }, beforeId);
    };
    try { draw(); } catch {}
    map.on('style.load', draw);
    return () => {
      map.off('style.load', draw);
      remove();
    };
  }, [map, enabled, data, styleRev]);

  return { enabled, setEnabled, countries: (memo ?? data)?.countries ?? null };
}
