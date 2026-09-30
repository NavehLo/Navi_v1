import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  MapPin, X, Loader2, Navigation, RotateCcw, Ruler, Check, Plus, ChevronUp, ChevronDown, Trash2,
} from 'lucide-react';
import type { TrailData } from '../hooks/useTrailData';
import {
  snapToTrail, sliceTrail, computeElevationGain, getDistance, type Coordinate3D,
} from '../utils/trailUtils';
import { describeSearchOrDirectionsError, type WalkRoute } from '../lib/mapboxDirections';
import { findWalkRoutes } from '../lib/routeAlternatives';
import { withElevation } from '../lib/demElevation';
import { snapToRenderedPath } from '../lib/pathSnap';
import { formatDuration } from './DrivePlanner';

// Measuring a distance by walking, never as the crow flies — across as many
// points as the walk needs, with every leg and the whole shown separately.
// Points can be removed and moved up or down the list afterwards; the legs
// follow the order of the list.
//
// With a trail open, every point is on the trail: the floating pin snaps to
// the nearest spot on the line as the map moves under it, and each leg is the
// length of trail between two points.
//
// With no trail, the points can be anywhere. The pin snaps to the nearest
// path or road the map is drawing, and each leg is a walking route — up to
// three of them where there is more than one way round, shortest first, one of
// which is chosen for the total.
//
// Either way the result can be walked for real: "התחל ניווט" opens it as a
// trail of its own — with its points marked on it — and switches on the live
// location.
//
// The pin is a crosshair fixed to the middle of the screen, with the map
// moving under it; tapping to drop a marker fights with panning on a phone.
// The point taken is the ground under that exact pixel. (Not map.getCenter():
// on a tilted 3D map that is a different place from the one under the pin.)

interface PickedPoint { id: number; lat: number; lon: number; km: number | null; snapped?: boolean }
interface ScoredRoute extends WalkRoute { gain: number | null; loss: number | null }
interface FreeLeg { status: 'ok' | 'error'; routes: ScoredRoute[]; selected: number; error?: string }
interface LegSummary { km: number; gain: number | null; loss: number | null; durationSec: number | null; coords: Coordinate3D[] }

// A point of a measured walk, carried into navigation: where it is, and how
// far along the whole walk.
export interface MeasureWaypoint { label: string; km: number; lat: number; lon: number }

const LINE_SRC = 'measure-lines';
const PT_SRC = 'measure-points';
const LAYERS = ['measure-line-casing', 'measure-line', 'measure-pt', 'measure-pt-label'];
const ROUTE_COLORS = ['#facc15', '#a78bfa', '#34d399'];
const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
// A pin this close to the last point is the same point, not a new one.
const SAME_POINT_KM = 0.015;

export const pointLetter = (i: number) => LETTERS[i] ?? String(i + 1);

function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} מ׳` : `${km.toFixed(km < 10 ? 2 : 1)} ק״מ`;
}

function climbOf(coords: Coordinate3D[]): { gain: number; loss: number } | null {
  if (coords.length < 2) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of coords) { lo = Math.min(lo, c[2] || 0); hi = Math.max(hi, c[2] || 0); }
  if (hi - lo < 1) return null;
  return computeElevationGain(coords.map((c) => c[2] || 0));
}

const legKey = (a: PickedPoint, b: PickedPoint) => `${a.id}>${b.id}`;

export default function MeasureTool({
  map, trail, styleRev, onClose, onNavigate,
}: {
  map: mapboxgl.Map;
  trail: TrailData | null;
  styleRev: number;
  onClose: () => void;
  onNavigate: (coords: Coordinate3D[], name: string, waypoints: MeasureWaypoint[]) => void;
}) {
  const onTrail = !!trail;
  const [points, setPoints] = useState<PickedPoint[]>([]);
  const [picking, setPicking] = useState(true);
  const [liveSnap, setLive] = useState<Omit<PickedPoint, 'id'> | null>(null);
  const nextIdRef = useRef(1);

  // The panel: the bottom third of the screen by default, scrolling inside;
  // it can grow to half the screen or shrink to a strip with just the buttons.
  // The pin sits in the middle of the map that is left visible above it — so
  // the panel never covers it — and moves when the panel changes size.
  const [size, setSize] = useState<'min' | 'third' | 'half'>('third');
  const panelRef = useRef<HTMLDivElement>(null);
  const [pinY, setPinY] = useState<number | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const top = panel.getBoundingClientRect().top - map.getContainer().getBoundingClientRect().top;
      setPinY(Math.max(60, Math.round(top / 2)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  // The pixel under the pin's tip.
  const pinPixel = useCallback((): [number, number] => {
    const el = map.getContainer();
    return [el.clientWidth / 2, pinY ?? el.clientHeight / 2];
  }, [map, pinY]);

  // When the pin moves up or down the screen, the map moves with it, so the
  // same ground stays under it.
  const lastPinYRef = useRef<number | null>(null);
  useEffect(() => {
    if (pinY == null) return;
    const last = lastPinYRef.current;
    lastPinYRef.current = pinY;
    if (last != null && last !== pinY) map.panBy([0, last - pinY], { duration: 250 });
  }, [map, pinY]);

  // ── The ground under the pin, snapped to the trail or to a path ──
  const lastKmRef = useRef<number | null>(null);
  useEffect(() => {
    if (!picking) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const [px, py] = pinPixel();
      if (trail) {
        const c = map.unproject([px, py]);
        const snap = snapToTrail(trail.coords, trail.accumulatedDistances, c.lat, c.lng, lastKmRef.current);
        if (snap) lastKmRef.current = snap.km;
        setLive(snap ? { lat: snap.lat, lon: snap.lon, km: snap.km } : null);
      } else {
        const p = snapToRenderedPath(map, px, py);
        setLive(p ? { ...p, km: null } : null);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    map.on('move', schedule);
    map.on('idle', schedule); // paths finish drawing after the map stops
    return () => { map.off('move', schedule); map.off('idle', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [map, trail, picking, pinPixel]);
  const live = picking ? liveSnap : null;

  // ── Free mode: walking routes, one leg per pair of neighbouring points ──
  // Kept by the pair of points, not by position in the list, so moving a
  // point up or down asks only for the legs that are new, and taking a move
  // back finds its old answer still here.
  const [legCache, setLegCache] = useState<Record<string, FreeLeg>>({});
  const inflightRef = useRef(new Set<string>());

  const routeLeg = useCallback(async (key: string, from: PickedPoint, to: PickedPoint) => {
    try {
      const found = await findWalkRoutes([from.lon, from.lat], [to.lon, to.lat]);
      // One elevation pass for all of them — they share most of their tiles.
      const all = await withElevation(found.routes.flatMap((r) => r.coords));
      let at = 0;
      const routes = found.routes.map((r) => {
        const coords = all.slice(at, at + r.coords.length);
        at += r.coords.length;
        const climb = climbOf(coords);
        return { ...r, coords, gain: climb?.gain ?? null, loss: climb?.loss ?? null };
      });
      setLegCache((c) => ({ ...c, [key]: { status: 'ok', routes, selected: 0 } }));
      // The walk really starts and ends on the way the router found: move the
      // markers there, once — a point shared by two legs is not moved twice.
      setPoints((ps) => ps.map((p) => {
        if (p.snapped) return p;
        if (p.id === from.id && found.start) return { ...p, lon: found.start[0], lat: found.start[1], snapped: true };
        if (p.id === to.id && found.end) return { ...p, lon: found.end[0], lat: found.end[1], snapped: true };
        return p;
      }));
    } catch (e) {
      setLegCache((c) => ({ ...c, [key]: { status: 'error', routes: [], selected: 0, error: describeSearchOrDirectionsError(e) } }));
    } finally {
      inflightRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    if (trail) return;
    for (let i = 0; i < points.length - 1; i++) {
      const key = legKey(points[i], points[i + 1]);
      if (legCache[key] || inflightRef.current.has(key)) continue;
      inflightRef.current.add(key);
      void routeLeg(key, points[i], points[i + 1]);
    }
  }, [points, legCache, trail, routeLeg]);

  const selectRoute = useCallback((key: string, idx: number) =>
    setLegCache((c) => (c[key] ? { ...c, [key]: { ...c[key], selected: idx } } : c)), []);

  // ── Editing the list ──
  const pinPoint = (): Omit<PickedPoint, 'id'> => {
    if (live) return live;
    const c = map.unproject(pinPixel());
    return { lat: c.lat, lon: c.lng, km: null };
  };

  // Adds the point under the pin — unless it is where the last one already is.
  const addPoint = (): PickedPoint[] => {
    const p = pinPoint();
    const last = points[points.length - 1];
    if (last && getDistance(last.lat, last.lon, p.lat, p.lon) < SAME_POINT_KM) return points;
    const next = [...points, { ...p, id: nextIdRef.current++ }];
    setPoints(next);
    return next;
  };

  const removePoint = (i: number) => setPoints(points.filter((_, k) => k !== i));
  const movePoint = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= points.length) return;
    const next = points.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setPoints(next);
  };

  const reset = () => { setPoints([]); setPicking(true); };

  // ── Every leg as a number ──
  const legs = useMemo(() => {
    const out: { key: string; summary: LegSummary | null; free: FreeLeg | null; loading: boolean }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const key = legKey(a, b);
      if (trail) {
        if (a.km == null || b.km == null) { out.push({ key, summary: null, free: null, loading: false }); continue; }
        const coords = sliceTrail(trail.coords, trail.accumulatedDistances, a.km, b.km);
        const climb = climbOf(coords);
        out.push({ key, free: null, loading: false, summary: { km: Math.abs(b.km - a.km), gain: climb?.gain ?? null, loss: climb?.loss ?? null, durationSec: null, coords } });
      } else {
        const leg = legCache[key] ?? null;
        const r = leg?.status === 'ok' ? leg.routes[leg.selected] : null;
        out.push({
          key, free: leg, loading: !leg,
          summary: r ? { km: r.distanceKm, gain: r.gain, loss: r.loss, durationSec: r.durationSec, coords: r.coords } : null,
        });
      }
    }
    return out;
  }, [points, legCache, trail]);

  const complete = legs.length > 0 && legs.every((l) => l.summary);
  const total = useMemo(() => {
    if (!complete) return null;
    const s = legs.map((l) => l.summary!) ;
    const coords: Coordinate3D[] = [];
    s.forEach((l, i) => coords.push(...(i === 0 ? l.coords : l.coords.slice(1))));
    const hasClimb = s.some((l) => l.gain != null);
    return {
      km: s.reduce((a, l) => a + l.km, 0),
      gain: hasClimb ? s.reduce((a, l) => a + (l.gain ?? 0), 0) : null,
      loss: hasClimb ? s.reduce((a, l) => a + (l.loss ?? 0), 0) : null,
      durationSec: trail ? null : s.reduce((a, l) => a + (l.durationSec ?? 0), 0),
      coords,
    };
  }, [complete, legs, trail]);

  // ── What is drawn on the map ──
  const drawn = useMemo(() => {
    const lines: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    const line = (coords: Coordinate3D[], props: Record<string, unknown>) =>
      lines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });
    // Unchosen alternatives first, so the chosen routes are drawn on top.
    legs.forEach((l) => l.free?.routes.forEach((r, k) => {
      if (k !== l.free!.selected) line(r.coords, { key: l.key, idx: k, color: ROUTE_COLORS[k], sel: 0 });
    }));
    legs.forEach((l) => {
      if (l.summary) line(l.summary.coords, { key: l.key, idx: l.free?.selected ?? 0, color: ROUTE_COLORS[l.free?.selected ?? 0], sel: 1 });
    });
    const pts: GeoJSON.Feature<GeoJSON.Point>[] = points.map((p, i) => ({
      type: 'Feature', properties: { label: pointLetter(i), role: 'end' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    }));
    if (live) pts.push({ type: 'Feature', properties: { label: '', role: 'live' }, geometry: { type: 'Point', coordinates: [live.lon, live.lat] } });
    return {
      lines: { type: 'FeatureCollection', features: lines } as GeoJSON.FeatureCollection,
      pts: { type: 'FeatureCollection', features: pts } as GeoJSON.FeatureCollection,
    };
  }, [legs, points, live]);

  useEffect(() => {
    const sync = () => {
      if (!map.getStyle()) return;
      if (!map.getSource(LINE_SRC)) {
        map.addSource(LINE_SRC, { type: 'geojson', data: drawn.lines });
        map.addLayer({
          id: 'measure-line-casing', type: 'line', source: LINE_SRC,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': '#18181b', 'line-width': ['case', ['==', ['get', 'sel'], 1], 10, 6], 'line-opacity': 0.8 },
        });
        map.addLayer({
          id: 'measure-line', type: 'line', source: LINE_SRC,
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['case', ['==', ['get', 'sel'], 1], 6, 3],
            'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.75],
          },
        });
      } else {
        (map.getSource(LINE_SRC) as mapboxgl.GeoJSONSource).setData(drawn.lines);
      }
      if (!map.getSource(PT_SRC)) {
        map.addSource(PT_SRC, { type: 'geojson', data: drawn.pts });
        map.addLayer({
          id: 'measure-pt', type: 'circle', source: PT_SRC,
          paint: {
            'circle-radius': ['case', ['==', ['get', 'role'], 'live'], 6, 11],
            'circle-color': ['case', ['==', ['get', 'role'], 'live'], '#fb923c', '#18181b'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
        map.addLayer({
          id: 'measure-pt-label', type: 'symbol', source: PT_SRC,
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 13,
            'text-allow-overlap': true,
          },
          paint: { 'text-color': '#ffffff' },
        });
      } else {
        (map.getSource(PT_SRC) as mapboxgl.GeoJSONSource).setData(drawn.pts);
      }
      // Above the trail, the POIs and everything else.
      for (const id of LAYERS) if (map.getLayer(id)) map.moveLayer(id);
    };
    try { sync(); } catch {}
    map.on('style.load', sync);
    return () => { map.off('style.load', sync); };
  }, [map, drawn, styleRev]);

  // Taking the layers away when the tool closes.
  useEffect(() => () => {
    try {
      for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [LINE_SRC, PT_SRC]) if (map.getSource(id)) map.removeSource(id);
    } catch {}
  }, [map]);

  // A route can be chosen by tapping its line, too.
  useEffect(() => {
    const onClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
      const p = e.features?.[0]?.properties;
      if (typeof p?.key === 'string' && typeof p?.idx === 'number') selectRoute(p.key, p.idx);
    };
    map.on('click', 'measure-line', onClick);
    return () => { map.off('click', 'measure-line', onClick); };
  }, [map, selectRoute]);

  // Done picking: frame the whole walk. Never while picking — that would move
  // the map out from under the pin.
  const finish = (pts: PickedPoint[]) => {
    setPicking(false);
    const coords = legs.flatMap((l) => l.summary?.coords ?? []);
    const all = [...coords, ...pts.map((p) => [p.lat, p.lon, 0] as Coordinate3D)];
    if (all.length < 2) return;
    const bounds = new mapboxgl.LngLatBounds();
    all.forEach((c) => bounds.extend([c[1], c[0]]));
    // Framed in the part of the map the panel leaves open.
    const covered = map.getContainer().clientHeight - (pinY ?? 0) * 2;
    map.fitBounds(bounds, { padding: { top: 80, bottom: Math.max(80, covered + 30), left: 60, right: 60 }, duration: 900, maxZoom: 16 });
  };

  const startNavigation = () => {
    if (!total) return;
    let km = 0;
    const waypoints: MeasureWaypoint[] = points.map((p, i) => {
      if (i > 0) km += legs[i - 1].summary!.km;
      return { label: pointLetter(i), km, lat: p.lat, lon: p.lon };
    });
    onNavigate(total.coords, trail ? `קטע מתוך ${trail.name} · ${fmtKm(total.km)}` : `הליכה · ${fmtKm(total.km)}`, waypoints);
  };

  const n = points.length;
  const lastKm = n > 0 ? points[n - 1].km : null;
  const liveFromLast = trail && lastKm != null && live?.km != null ? Math.abs(live.km - lastKm) : null;
  const liveOffTrailFar = !!trail && !!live && (() => {
    const c = map.unproject(pinPixel());
    return c.distanceTo(new mapboxgl.LngLat(live.lon, live.lat)) > 500;
  })();
  const anyLoading = legs.some((l) => l.loading);

  const iconBtn = 'p-1.5 rounded-lg text-white hover:bg-white/15 disabled:opacity-25 disabled:hover:bg-transparent';

  return (
    <>
      {/* The floating pin */}
      {picking && pinY != null && (
        <div className="absolute left-1/2 z-[44] pointer-events-none w-0 h-0 transition-[top] duration-200" style={{ top: pinY }}>
          {/* The pin's tip is the point: the glyph is lifted so the tip sits on it */}
          <MapPin className="absolute w-10 h-10 -left-5 -top-10 text-orange-500 fill-orange-500/30 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]" />
          <div className="absolute w-2 h-2 -left-1 -top-1 rounded-full bg-orange-500 border border-white/80" />
        </div>
      )}

      {/* Three parts: a header, a middle that scrolls, and the buttons — which
          never scroll away, however long the list of points gets. */}
      <div
        ref={panelRef}
        className={`absolute inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[420px] z-[50] bg-zinc-900/95 border border-white/15 rounded-3xl shadow-2xl backdrop-blur-md px-4 pb-3 pt-1 flex flex-col gap-2 text-white ${
          size === 'half' ? 'h-[50dvh]' : size === 'third' ? 'h-[33dvh]' : ''
        }`}
        style={{ bottom: 'max(12px, env(safe-area-inset-bottom))' }}
        dir="rtl"
      >
        {/* The grab bar: a tap folds the panel down, or brings it back */}
        <button
          onClick={() => setSize(size === 'min' ? 'third' : 'min')}
          className="self-center py-1.5 px-6 shrink-0"
          aria-label={size === 'min' ? 'הרחב את הפאנל' : 'צמצם את הפאנל'}
        >
          <span className="block w-10 h-1.5 rounded-full bg-white/50" />
        </button>

        <div className="flex items-center justify-between gap-2 shrink-0">
          <div className="font-bold text-base flex items-center gap-2 min-w-0">
            <Ruler className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="truncate">{onTrail ? 'מדידה לאורך המסלול' : 'מדידת מרחק הליכה'}</span>
          </div>
          <div className="flex items-center shrink-0">
            {/* Folded down, the running total stays in sight */}
            {size === 'min' && n >= 2 && (
              <span className="text-sm ml-1">{n} נק׳{total && <> · <b className="text-yellow-300">{fmtKm(total.km)}</b></>}</span>
            )}
            <button
              onClick={() => setSize(size === 'half' ? 'third' : 'min')}
              disabled={size === 'min'}
              className={iconBtn}
              aria-label="צמצם את הפאנל"
              title="צמצם"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
            <button
              onClick={() => setSize(size === 'min' ? 'third' : 'half')}
              disabled={size === 'half'}
              className={iconBtn}
              aria-label="הרחב את הפאנל"
              title="הרחב"
            >
              <ChevronUp className="w-5 h-5" />
            </button>
            <button onClick={onClose} className="text-white hover:text-orange-300 p-1 mr-1" aria-label="סגור מדידה"><X size={20} /></button>
          </div>
        </div>

        <div className={`flex-col gap-2 overflow-y-auto overscroll-contain min-h-0 flex-1 ${size === 'min' ? 'hidden' : 'flex'}`}>
          {picking && (
            <>
              <p className="text-sm leading-relaxed">
                {n === 0
                  ? <>הזז את המפה כך שהנעץ יעמוד על <b>נקודת ההתחלה</b>.</>
                  : <>הזז את המפה אל <b>נקודה {pointLetter(n)}׳</b>.</>}
                {' '}{onTrail
                  ? 'הנקודה נצמדת לתוואי המסלול (העיגול הכתום).'
                  : live ? 'הנקודה נצמדת לדרך הקרובה (העיגול הכתום).' : ''}
              </p>
              {!onTrail && !live && (
                <p className="text-sm text-amber-200">אין דרך מסומנת ליד הנעץ בזום הזה — הנקודה תוצמד לדרך הקרובה ביותר כשהמסלול יחושב.</p>
              )}
              {onTrail && live?.km != null && (
                <div className="text-sm flex justify-between">
                  <span>{fmtKm(live.km)} מתחילת המסלול</span>
                  {liveFromLast != null && <span className="text-orange-300 font-bold">{fmtKm(liveFromLast)} מנקודה {pointLetter(n - 1)}׳</span>}
                </div>
              )}
              {liveOffTrailFar && (
                <div className="text-sm text-amber-200">הנעץ רחוק מהמסלול — הנקודה תוצמד למקום הקרוב ביותר עליו.</div>
              )}
            </>
          )}

          {/* The points, in walking order, each with the leg that reaches it */}
          {points.map((p, i) => {
            const leg = i > 0 ? legs[i - 1] : null;
            const s = leg?.summary;
            return (
              <div key={p.id} className="rounded-2xl bg-white/5 border border-white/10 px-2.5 py-2 flex items-start gap-2">
                <span className="w-7 h-7 shrink-0 rounded-full bg-zinc-950 border-2 border-white flex items-center justify-center text-sm font-bold">
                  {pointLetter(i)}
                </span>
                <div className="flex-1 min-w-0 pt-0.5">
                  {i === 0 ? (
                    <div className="text-sm font-bold">התחלה</div>
                  ) : s ? (
                    <div className="text-sm">
                      <b className="text-yellow-300">{fmtKm(s.km)}</b> מנקודה {pointLetter(i - 1)}׳
                      {s.durationSec != null && <> · {formatDuration(s.durationSec)}</>}
                      {s.gain != null && <> · ↑{s.gain} ↓{s.loss} מ׳</>}
                    </div>
                  ) : leg?.loading ? (
                    <div className="text-sm flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> מחפש דרכים…</div>
                  ) : null}
                  {leg?.free?.status === 'error' && <div className="text-sm text-amber-200">{leg.free.error}</div>}
                  {/* The ways round, when there is more than one */}
                  {leg?.free?.status === 'ok' && leg.free.routes.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {leg.free.routes.map((r, k) => (
                        <button
                          key={k}
                          onClick={() => selectRoute(leg.key, k)}
                          aria-pressed={leg.free!.selected === k}
                          className={`flex items-center gap-1.5 text-sm rounded-xl px-2.5 py-1 border transition-colors ${
                            leg.free!.selected === k ? 'bg-white/15 border-white' : 'bg-transparent border-white/25 hover:bg-white/10'
                          }`}
                        >
                          <span className="w-2.5 h-2.5 rounded-full" style={{ background: ROUTE_COLORS[k] }} />
                          {fmtKm(r.distanceKm)}
                          {k === 0 && <span className="text-emerald-300 text-xs font-bold">הקצרה</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {leg?.free?.status === 'ok' && leg.free.routes.length === 1 && (
                    <div className="text-xs text-white mt-1">דרך אחת בלבד — לא נמצאה כאן דרך הליכה שונה באמת.</div>
                  )}
                </div>
                <div className="flex shrink-0">
                  <button onClick={() => movePoint(i, -1)} disabled={i === 0} className={iconBtn} aria-label={`הקדם את נקודה ${pointLetter(i)}`} title="הקדם בסדר">
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button onClick={() => movePoint(i, 1)} disabled={i === n - 1} className={iconBtn} aria-label={`דחה את נקודה ${pointLetter(i)}`} title="דחה בסדר">
                    <ChevronDown className="w-4 h-4" />
                  </button>
                  <button onClick={() => removePoint(i)} className={iconBtn} aria-label={`הסר את נקודה ${pointLetter(i)}`} title="הסר נקודה">
                    <Trash2 className="w-4 h-4 text-red-300" />
                  </button>
                </div>
              </div>
            );
          })}

          {n >= 3 && total && (
            <div className="rounded-2xl bg-yellow-300/10 border border-yellow-300/40 px-3 py-2 flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold">סה״כ</span>
              <span className="text-sm">
                <b className="text-yellow-300 text-base">{fmtKm(total.km)}</b>
                {total.durationSec != null && <> · {formatDuration(total.durationSec)}</>}
                {total.gain != null && <> · ↑{total.gain} ↓{total.loss} מ׳</>}
              </span>
            </div>
          )}

          {!onTrail && n >= 2 && (
            <p className="text-xs text-white leading-relaxed">
              דרכי הליכה לפי Mapbox: שבילים, דרכי עפר ורחובות. הזמן הוא הערכה להליכה במישור. אפשר לבחור דרך גם בלחיצה על הקו במפה.
            </p>
          )}
          {onTrail && complete && total?.gain == null && (
            <p className="text-xs text-white">לקובץ המסלול אין נתוני גובה, לכן אין עלייה וירידה.</p>
          )}
        </div>

        {/* The buttons */}
        {picking ? (
          <div className="flex flex-col gap-2 shrink-0">
            <div className="flex gap-2">
              <button
                onClick={addPoint}
                className="flex-1 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold py-2.5 rounded-2xl transition-colors"
              >
                {n === 0 ? <MapPin className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {n === 0 ? 'קבע נקודה א׳' : `הוסף נקודה ${pointLetter(n)}׳`}
              </button>
              {n >= 1 && (
                <button
                  onClick={() => finish(addPoint())}
                  className="flex-1 flex items-center justify-center gap-2 bg-white text-zinc-900 text-sm font-bold py-2.5 rounded-2xl"
                >
                  <Check className="w-4 h-4" /> הוסף וסיים
                </button>
              )}
            </div>
            {n >= 2 && (
              <button onClick={() => finish(points)} className="text-sm text-white underline underline-offset-4">
                סיום בלי להוסיף את מיקום הנעץ
              </button>
            )}
          </div>
        ) : (
          <div className="flex gap-2 shrink-0">
            {total && (
              <button
                onClick={startNavigation}
                className="flex-1 flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-bold py-2.5 rounded-2xl transition-colors"
              >
                <Navigation className="w-4 h-4" /> התחל ניווט
              </button>
            )}
            {!total && anyLoading && (
              <div className="flex-1 flex items-center justify-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> מחשב…</div>
            )}
            <button onClick={() => setPicking(true)} className="flex items-center justify-center gap-1.5 px-3 bg-zinc-800 text-white text-sm font-bold py-2.5 rounded-2xl border border-white/15">
              <Plus className="w-4 h-4" /> נקודות
            </button>
            <button onClick={reset} className="flex items-center justify-center gap-1.5 px-3 bg-zinc-800 text-white text-sm font-bold py-2.5 rounded-2xl border border-white/15">
              <RotateCcw className="w-4 h-4" /> חדשה
            </button>
          </div>
        )}
      </div>
    </>
  );
}
