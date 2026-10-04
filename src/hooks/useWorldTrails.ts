import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Coordinate3D } from '../utils/trailUtils';
import { computeElevationGain } from '../utils/trailUtils';
import {
  lonLatToMercator,
  mercatorToLonLat,
  wmtParents,
  wmtRouteToCoords,
  wmtStages,
  type WmtElevation,
  type WmtStage,
  type WmtRouteDetails,
  type WmtRouteSummary,
} from '../lib/waymarked';
import type { TrailSource, WmtParent } from './useTrailData';
import { needsEnglish } from '../lib/trailNames';
import { translateWorldTrails } from '../lib/worldTrailSearch';
import { seedWmtStages } from './useWmtStages';
import { LEADERS_DOT } from './useTrailLeaders';
import { placeLabelAt } from './usePlacePhotos';

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
  // A long trail's stages, in order; empty for a trail that has none.
  stages: WmtStage[];
  // The long trail this one is a stage of: the one its card was opened from,
  // else the first OSM names.
  parent: WmtParent | null;
  // Set when the card was opened from that long trail's list of stages.
  cameFrom: WmtParent | null;
}

interface Options {
  onLoadTrail: (coords: Coordinate3D[], name: string, source: TrailSource) => void;
  // A trail is open on the map. The other routes then fade to grey, so the
  // one in orange is the only coloured line on the screen.
  focused?: boolean;
}

// Waymarked Trails draws every route in its own strong colour (red, blue,
// purple, yellow…). That is a fine overview, and a mess as soon as one route
// is the point: the open trail, or the one tapped and waiting on its card,
// is lost among a dozen others just as loud. Picked out, the rest go grey
// and faint — still there to see what else is around, no longer competing.
const PAINT_NORMAL = { 'raster-opacity': 0.9, 'raster-saturation': 0, 'raster-brightness-max': 1 } as const;
const PAINT_MUTED = { 'raster-opacity': 0.45, 'raster-saturation': -1, 'raster-brightness-max': 0.8 } as const;

// The tapped route itself, drawn over the faded tiles in the open trail's
// orange — exactly the part "טען מסלול" would load.
const SEL_SOURCE = 'wmt-selection';
const SEL_CASING = 'wmt-selection-casing';
const SEL_LINE = 'wmt-selection-line';

// Everything these layers must sit under, if present: the current route, and
// the trail-list markers on the home screen.
const ABOVE_US = ['route-casing', 'route-line', SEL_CASING, 'clusters'];

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

// The last few routes' details and elevation, so going from a stage back to
// its long trail — megabytes, for a national one — is instant.
const recent = new Map<number, { details: WmtRouteDetails; elevation: WmtElevation | null }>();
const RECENT_MAX = 4;
function remember(id: number, entry: { details: WmtRouteDetails; elevation: WmtElevation | null }) {
  recent.delete(id);
  recent.set(id, entry);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
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
  // This runs inside a state update, where a throw takes down the whole page.
  // A route shape we have not met yet should cost one card, not the app.
  let result: ReturnType<typeof wmtRouteToCoords>;
  try {
    result = wmtRouteToCoords(sel.details, sel.elevation);
  } catch (e) {
    console.error('World trail geometry failed:', sel.id, e);
    return { ...sel, details: null, status: 'unavailable' };
  }
  const { coords, partial, segmentCount, hasElevation } = result;
  const eles = coords.map((c) => c[2]);
  const { gain, loss } = hasElevation ? computeElevationGain(eles) : { gain: null, loss: null };
  let stages: WmtStage[] = [];
  try { stages = wmtStages(sel.details, sel.elevation); } catch (e) { console.error('World trail stages failed:', sel.id, e); }
  const parents = wmtParents(sel.details);
  return {
    ...sel,
    stages,
    parent: sel.cameFrom ?? parents[0] ?? null,
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

export function useWorldTrails(map: mapboxgl.Map | null, styleRev: number, { onLoadTrail, focused = false }: Options) {
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => false);
  const [selection, setSelection] = useState<WorldTrailSelection | null>(null);
  const muted = focused || !!selection;
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupRef = useRef<mapboxgl.Popup | null>(null);
  const selectSeq = useRef(0);

  const toggle = useCallback(() => { writeEnabled(!readEnabled()); }, []);
  const enable = useCallback(() => { if (!readEnabled()) writeEnabled(true); }, []);

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
          { id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { ...(mutedRef.current ? PAINT_MUTED : PAINT_NORMAL) } },
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

  // Fade the other routes while one is picked out, and back when it is not.
  useEffect(() => {
    if (!map || !enabled) return;
    try {
      if (!map.getLayer(LAYER_ID)) return;
      for (const [k, v] of Object.entries(muted ? PAINT_MUTED : PAINT_NORMAL)) {
        map.setPaintProperty(LAYER_ID, k as 'raster-opacity', v);
      }
    } catch {}
  }, [map, enabled, muted, styleRev]);

  // A long trail's stages, handed on, so the stage opened from its card finds
  // its neighbours without asking the server.
  useEffect(() => {
    if (!selection?.details) return;
    seedWmtStages(selection.id, {
      stages: selection.stages,
      parents: wmtParents(selection.details),
      climb: selection.elevationStatus !== 'loading',
    });
  }, [selection]);

  // The tapped route, in orange over the faded tiles.
  const selCoords = selection?.coords;
  useEffect(() => {
    if (!map) return;
    const remove = () => {
      try {
        if (map.getLayer(SEL_LINE)) map.removeLayer(SEL_LINE);
        if (map.getLayer(SEL_CASING)) map.removeLayer(SEL_CASING);
        if (map.getSource(SEL_SOURCE)) map.removeSource(SEL_SOURCE);
      } catch {}
    };
    if (!selCoords || selCoords.length < 2) { remove(); return; }
    const draw = () => {
      if (!map.getStyle()) return;
      remove();
      map.addSource(SEL_SOURCE, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: selCoords.map((c) => [c[1], c[0]]) } },
      });
      const beforeId = map.getLayer('clusters') ? 'clusters' : undefined;
      map.addLayer({ id: SEL_CASING, type: 'line', source: SEL_SOURCE, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#18181b', 'line-width': 10, 'line-opacity': 0.85 } }, beforeId);
      map.addLayer({ id: SEL_LINE, type: 'line', source: SEL_SOURCE, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f97316', 'line-width': 5 } }, beforeId);
    };
    try { draw(); } catch {}
    map.on('style.load', draw);
    return () => { map.off('style.load', draw); remove(); };
  }, [map, selCoords, styleRev]);

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
  // `fit`: the route was picked from a search, not tapped where it lies, so
  // the map goes to it once its extent is known.
  // `cameFrom`: the long trail whose list of stages this one was picked from.
  const select = useCallback(async (
    id: number,
    summary: WmtRouteSummary | null,
    opts?: { fit?: boolean; cameFrom?: WmtParent },
  ) => {
    const seq = ++selectSeq.current;
    popupRef.current?.remove();
    const cameFrom = opts?.cameFrom ?? null;
    const base: WorldTrailSelection = {
      id, summary, details: null, elevation: null, status: 'loading', elevationStatus: 'loading',
      coords: [], partial: false, segmentCount: 0, lengthKm: null, gain: null, loss: null, minEle: null, maxEle: null,
      stages: [], parent: cameFrom, cameFrom,
    };

    const kept = recent.get(id);
    if (kept) {
      remember(id, kept);
      setSelection(deriveSelection({
        ...base, details: kept.details, elevation: kept.elevation, status: 'ok',
        elevationStatus: kept.elevation ? 'ok' : 'unavailable',
      }));
      if (opts?.fit && map) fitToRoute(map, kept.details.bbox);
      return;
    }
    setSelection(base);

    const details = await getJson<{ data: WmtRouteDetails }>(`/api/world-trails?id=${id}`);
    if (seq !== selectSeq.current) return;
    if (!details.body) {
      setSelection((s) => (s && s.id === id ? { ...s, status: details.status } : s));
      return;
    }
    setSelection((s) =>
      s && s.id === id ? deriveSelection({ ...s, details: details.body!.data, status: 'ok' }) : s
    );
    if (opts?.fit && map) fitToRoute(map, details.body.data.bbox);

    const elevation = await getJson<{ data: WmtElevation }>(`/api/world-trails?id=${id}&elevation=1`);
    if (seq !== selectSeq.current) return;
    // A route whose elevation could not be had is not kept: next time it
    // gets another chance at it.
    if (elevation.body) remember(id, { details: details.body.data, elevation: elevation.body.data });
    setSelection((s) => {
      if (!s || s.id !== id) return s;
      if (!elevation.body) return { ...s, elevationStatus: elevation.status };
      return deriveSelection({ ...s, elevation: elevation.body.data, elevationStatus: 'ok' });
    });
  }, [map]);

  const clearSelection = useCallback(() => {
    selectSeq.current++;
    setSelection(null);
  }, []);

  const loadSelected = useCallback(() => {
    if (!selection?.details || selection.coords.length < 2) return;
    onLoadTrail(selection.coords, selection.details.name ?? `מסלול ${selection.id}`, {
      kind: 'wmt', id: selection.id, ...(selection.cameFrom ? { parent: selection.cameFrom } : {}),
    });
    clearSelection();
  }, [selection, onLoadTrail, clearSelection]);

  // For saved trails and share links, and a stage picked on the open trail's
  // card: straight from id to an open trail, no card.
  const loadById = useCallback(async (id: number, parent?: WmtParent): Promise<boolean> => {
    let entry = recent.get(id);
    if (!entry) {
      const details = await getJson<{ data: WmtRouteDetails }>(`/api/world-trails?id=${id}`);
      if (!details.body) return false;
      const elevation = await getJson<{ data: WmtElevation }>(`/api/world-trails?id=${id}&elevation=1`);
      entry = { details: details.body.data, elevation: elevation.body?.data ?? null };
      if (entry.elevation) remember(id, entry);
    }
    const { coords } = wmtRouteToCoords(entry.details, entry.elevation);
    if (coords.length < 2) return false;
    onLoadTrail(coords, entry.details.name ?? `מסלול ${id}`, { kind: 'wmt', id, ...(parent ? { parent } : {}) });
    return true;
  }, [onLoadTrail]);

  // ── Tapping the map ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled) return;

    const onClick = async (e: mapboxgl.MapMouseEvent) => {
      // A tap on a trail-list marker, or on a leading trail's star, is that
      // marker's business.
      const markerLayers = ['unclustered-point', 'clusters', LEADERS_DOT].filter((id) => map.getLayer(id));
      if (markerLayers.length && map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;
      // So is a tap on a place name the map writes: it opens that place's photos.
      if (placeLabelAt(map, e.point)) return;

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
          <div class="text-xs text-white font-bold px-2 pt-1">מסלולים בנקודה זו</div>
          ${results
            .map(
              (r) =>
                `<button type="button" data-id="${r.id}" class="text-right px-3 py-2 rounded-xl text-sm font-bold text-orange-400 hover:bg-white/10 transition-colors flex flex-col">${
                  escapeHtml(r.name ?? `מסלול ${r.id}`)
                }<span data-en="${r.id}" dir="ltr" class="text-xs font-semibold text-sky-200 text-right empty:hidden"></span></button>`
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

      // English names for the ones in a script the reader may not read, filled
      // in when they arrive rather than holding the list back for them.
      const foreign = results.filter((r) => needsEnglish(r.name)).map((r) => r.id);
      if (foreign.length) {
        translateWorldTrails(foreign).then((names) => {
          const el = popup.getElement();
          if (!el || popupRef.current !== popup) return;
          for (const [id, en] of names) {
            const span = el.querySelector<HTMLSpanElement>(`span[data-en="${id}"]`);
            if (span) span.textContent = en;
          }
        });
      }
    };

    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
      popupRef.current?.remove();
      popupRef.current = null;
    };
  }, [map, enabled, select, showHint]);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  return { enabled, toggle, enable, selection, select, clearSelection, loadSelected, loadById, hint };
}

// The route's extent comes in Web Mercator metres, like everything else from
// Waymarked Trails. Room is left at the bottom for the card that opens over
// the map on a phone.
function fitToRoute(map: mapboxgl.Map, bbox: [number, number, number, number] | undefined) {
  if (!bbox || bbox.some((n) => !Number.isFinite(n))) return;
  const [west, south] = mercatorToLonLat(bbox[0], bbox[1]);
  const [east, north] = mercatorToLonLat(bbox[2], bbox[3]);
  const narrow = map.getContainer().clientWidth < 768;
  try {
    map.fitBounds([[west, south], [east, north]], {
      padding: narrow ? { top: 120, bottom: 300, left: 40, right: 40 } : { top: 80, bottom: 80, left: 80, right: 440 },
      maxZoom: 15,
      duration: 1200,
    });
  } catch {}
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
