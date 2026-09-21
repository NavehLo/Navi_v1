import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Coordinate3D } from '../utils/trailUtils';
import { computeElevationGain } from '../utils/trailUtils';
import {
  lonLatToMercator,
  wmtRouteToCoords,
  type WmtElevation,
  type WmtRouteDetails,
  type WmtRouteSummary,
} from '../lib/waymarked';
import type { TrailSource } from './useTrailData';

// The world trails overlay: every marked hiking route in OpenStreetMap, drawn
// from Waymarked Trails' tiles, with a tap on a route opening its card.
//
// The tiles are pictures, so a tap cannot ask them what it hit. Instead the
// tap becomes a small box around the finger, the API says which routes cross
// that box, and one result opens straight away while several become a list.

export const WORLD_TRAILS_KEY = 'navi:worldTrails';
const SOURCE_ID = 'wmt-hiking';
const LAYER_ID = 'wmt-hiking';
const TILES = ['https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png'];
const ATTRIBUTION =
  '© <a href="https://hiking.waymarkedtrails.org" target="_blank" rel="noopener">Waymarked Trails</a> (CC BY-SA)';

// Below this the tiles only draw national trails and a finger covers a whole
// district; asking the API there returns a region's worth of routes.
const MIN_CLICK_ZOOM = 9;
const CLICK_BOX_PX = 12;

export type WorldTrailStatus = 'loading' | 'ok' | 'unavailable' | 'rate-limited';

export interface WorldTrailSelection {
  id: number;
  summary: WmtRouteSummary | null;
  details: WmtRouteDetails | null;
  elevation: WmtElevation | null;
  status: WorldTrailStatus;
  elevationStatus: WorldTrailStatus;
  // Derived once details (and, when it arrives, elevation) are in.
  coords: Coordinate3D[];
  partial: boolean;
  segmentCount: number;
  lengthKm: number | null;
  gain: number | null;
  loss: number | null;
  minEle: number | null;
  maxEle: number | null;
}

interface Options {
  onLoadTrail: (coords: Coordinate3D[], name: string, source: TrailSource) => void;
}

// Everything these layers must sit under, if present: the current route, and
// the trail-list markers on the home screen.
const ABOVE_US = ['route-line', 'clusters'];

// The on/off choice lives in localStorage and is read through an external
// store, so the server render (always off) and the first client render agree
// and the switch still flips every subscriber at once.
const listeners = new Set<() => void>();
function readEnabled(): boolean {
  try { return localStorage.getItem(WORLD_TRAILS_KEY) === '1'; } catch { return false; }
}
function writeEnabled(next: boolean) {
  try { localStorage.setItem(WORLD_TRAILS_KEY, next ? '1' : '0'); } catch {}
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

async function getJson<T>(url: string): Promise<{ status: WorldTrailStatus; body: T | null }> {
  try {
    const res = await fetch(url);
    const body = await res.json();
    const status: WorldTrailStatus = body.status ?? (res.ok ? 'ok' : 'unavailable');
    return { status, body: status === 'ok' ? (body as T) : null };
  } catch {
    return { status: 'unavailable', body: null };
  }
}

function deriveSelection(sel: WorldTrailSelection): WorldTrailSelection {
  if (!sel.details) return sel;
  const { coords, partial, segmentCount, hasElevation } = wmtRouteToCoords(sel.details, sel.elevation);
  const eles = coords.map((c) => c[2]);
  const { gain, loss } = hasElevation ? computeElevationGain(eles) : { gain: null, loss: null };
  return {
    ...sel,
    coords,
    partial,
    segmentCount,
    lengthKm: sel.details.route?.length != null ? sel.details.route.length / 1000 : null,
    gain,
    loss,
    minEle: sel.elevation?.min_elevation ?? null,
    maxEle: sel.elevation?.max_elevation ?? null,
  };
}

export function useWorldTrails(map: mapboxgl.Map | null, styleRev: number, { onLoadTrail }: Options) {
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => false);
  const [selection, setSelection] = useState<WorldTrailSelection | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const selectSeq = useRef(0);

  const toggle = useCallback(() => { writeEnabled(!readEnabled()); }, []);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2500);
  }, []);

  // ── The tile layer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled) return;

    const addLayer = () => {
      if (!map.getStyle()) return;
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'raster',
          tiles: TILES,
          tileSize: 256,
          maxzoom: 18,
          attribution: ATTRIBUTION,
        });
      }
      if (!map.getLayer(LAYER_ID)) {
        const beforeId = ABOVE_US.find((id) => map.getLayer(id));
        map.addLayer(
          { id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.9 } },
          beforeId
        );
      }
    };

    try { addLayer(); } catch {}
    map.on('style.load', addLayer);
    return () => {
      map.off('style.load', addLayer);
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {}
    };
  }, [map, enabled, styleRev]);

  // The route line is added after us when a trail opens; it lands on top by
  // itself. The other way round — the overlay switched on over an open trail —
  // is handled by `beforeId` above. This covers the trail-list markers, which
  // are re-created on every filter change and would otherwise end up beneath.
  useEffect(() => {
    if (!map || !enabled) return;
    const lift = () => {
      try {
        const order = map.getStyle()?.layers?.map((l) => l.id) ?? [];
        const ours = order.indexOf(LAYER_ID), theirs = order.indexOf('clusters');
        if (ours >= 0 && theirs >= 0 && ours > theirs) map.moveLayer(LAYER_ID, 'clusters');
      } catch {}
    };
    map.on('sourcedata', lift);
    return () => { map.off('sourcedata', lift); };
  }, [map, enabled, styleRev]);

  // ── Selecting a route ─────────────────────────────────────────────────────
  const select = useCallback(async (id: number, summary: WmtRouteSummary | null) => {
    const seq = ++selectSeq.current;
    popupRef.current?.remove();
    setSelection({
      id, summary, details: null, elevation: null, status: 'loading', elevationStatus: 'loading',
      coords: [], partial: false, segmentCount: 0, lengthKm: null, gain: null, loss: null, minEle: null, maxEle: null,
    });

    const details = await getJson<{ data: WmtRouteDetails }>(`/api/world-trails?id=${id}`);
    if (seq !== selectSeq.current) return;
    if (!details.body) {
      setSelection((s) => (s && s.id === id ? { ...s, status: details.status } : s));
      return;
    }
    setSelection((s) =>
      s && s.id === id ? deriveSelection({ ...s, details: details.body!.data, status: 'ok' }) : s
    );

    const elevation = await getJson<{ data: WmtElevation }>(`/api/world-trails?id=${id}&elevation=1`);
    if (seq !== selectSeq.current) return;
    setSelection((s) => {
      if (!s || s.id !== id) return s;
      if (!elevation.body) return { ...s, elevationStatus: elevation.status };
      return deriveSelection({ ...s, elevation: elevation.body.data, elevationStatus: 'ok' });
    });
  }, []);

  const clearSelection = useCallback(() => {
    selectSeq.current++;
    setSelection(null);
  }, []);

  const loadSelected = useCallback(() => {
    if (!selection?.details || selection.coords.length < 2) return;
    onLoadTrail(selection.coords, selection.details.name ?? `מסלול ${selection.id}`, { kind: 'wmt', id: selection.id });
    clearSelection();
  }, [selection, onLoadTrail, clearSelection]);

  // For saved trails and share links: straight from id to an open trail, no card.
  const loadById = useCallback(async (id: number): Promise<boolean> => {
    const details = await getJson<{ data: WmtRouteDetails }>(`/api/world-trails?id=${id}`);
    if (!details.body) return false;
    const elevation = await getJson<{ data: WmtElevation }>(`/api/world-trails?id=${id}&elevation=1`);
    const { coords } = wmtRouteToCoords(details.body.data, elevation.body?.data ?? null);
    if (coords.length < 2) return false;
    onLoadTrail(coords, details.body.data.name ?? `מסלול ${id}`, { kind: 'wmt', id });
    return true;
  }, [onLoadTrail]);

  // ── Tapping the map ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled) return;

    const onClick = async (e: mapboxgl.MapMouseEvent) => {
      // A tap on a trail-list marker is that marker's business.
      const markerLayers = ['unclustered-point', 'clusters'].filter((id) => map.getLayer(id));
      if (markerLayers.length && map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;

      if (map.getZoom() < MIN_CLICK_ZOOM) {
        showHint('התקרב כדי לבחור מסלול');
        return;
      }

      const sw = map.unproject([e.point.x - CLICK_BOX_PX, e.point.y + CLICK_BOX_PX]);
      const ne = map.unproject([e.point.x + CLICK_BOX_PX, e.point.y - CLICK_BOX_PX]);
      const [minx, miny] = lonLatToMercator(sw.lng, sw.lat);
      const [maxx, maxy] = lonLatToMercator(ne.lng, ne.lat);

      const res = await getJson<{ results: WmtRouteSummary[] }>(
        `/api/world-trails?bbox=${[minx, miny, maxx, maxy].map((n) => n.toFixed(1)).join(',')}`
      );
      if (!res.body) {
        if (res.status === 'rate-limited') showHint('יותר מדי לחיצות — רגע אחד');
        else showHint('שכבת המסלולים לא זמינה כרגע');
        return;
      }
      const results = res.body.results ?? [];
      if (results.length === 0) return;
      if (results.length === 1) {
        select(results[0].id, results[0]);
        return;
      }

      // Several routes under the finger — let the person pick.
      popupRef.current?.remove();
      const html = `
        <div class="p-2 flex flex-col gap-1 bg-zinc-900/95 backdrop-blur-md text-white rounded-2xl shadow-xl border border-white/10" dir="rtl" style="min-width: 180px;">
          <div class="text-[10px] text-zinc-500 font-bold px-2 pt-1">מסלולים בנקודה זו</div>
          ${results
            .map(
              (r) =>
                `<button type="button" data-id="${r.id}" class="text-right px-3 py-2 rounded-xl text-sm font-bold text-orange-400 hover:bg-white/10 transition-colors">${
                  escapeHtml(r.name ?? `מסלול ${r.id}`)
                }</button>`
            )
            .join('')}
        </div>`;
      const popup = new mapboxgl.Popup({ closeButton: false, className: 'trail-popup', maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
      popup.getElement()?.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.id);
          select(id, results.find((r) => r.id === id) ?? null);
        });
      });
      popupRef.current = popup;
    };

    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
      popupRef.current?.remove();
      popupRef.current = null;
    };
  }, [map, enabled, select, showHint]);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  return { enabled, toggle, selection, select, clearSelection, loadSelected, loadById, hint };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
