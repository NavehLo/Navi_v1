import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { MapPin, X, Loader2, Navigation, RotateCcw, Ruler, TrendingUp, TrendingDown, Footprints } from 'lucide-react';
import type { TrailData } from '../hooks/useTrailData';
import {
  snapToTrail, sliceTrail, computeElevationGain, type Coordinate3D, type TrailSnap,
} from '../utils/trailUtils';
import { walkRoutes, describeSearchOrDirectionsError, type WalkRoute } from '../lib/mapboxDirections';
import { withElevation } from '../lib/demElevation';
import { formatDuration } from './DrivePlanner';

// Measuring a distance by walking, never as the crow flies.
//
// With a trail open, both points are on the trail: the floating pin snaps to
// the nearest spot on the line as the map moves under it, and the distance is
// the length of trail between the two — the walk, not the gap.
//
// With no trail, the two points can be anywhere, and the answer is the walking
// routes between them: up to three, shortest first, along paths and streets
// that can be walked.
//
// Either way, the result can be walked for real: "התחל ניווט" opens it as a
// trail of its own, with the elevation profile, distance left and the
// off-route alarm, and switches on field mode.
//
// The pin is the same crosshair as the drive planner: fixed to the middle of
// the screen, with the map moving under it. Tapping to drop a marker fights
// with panning and rotating on a phone; this does not.

type Step = 'A' | 'B' | 'done';
interface PickedPoint { lat: number; lon: number; km: number | null }
interface ScoredRoute extends WalkRoute { gain: number | null; loss: number | null }

const LINE_SRC = 'measure-lines';
const PT_SRC = 'measure-points';
const LAYERS = ['measure-line-casing', 'measure-line', 'measure-pt', 'measure-pt-label'];
const ROUTE_COLORS = ['#facc15', '#a78bfa', '#34d399'];

function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)} מ׳` : `${km.toFixed(km < 10 ? 2 : 1)} ק״מ`;
}

function climbOf(coords: Coordinate3D[]): { gain: number; loss: number } | null {
  const eles = coords.map((c) => c[2] || 0);
  if (Math.max(...eles) - Math.min(...eles) < 1) return null;
  return computeElevationGain(eles);
}

export default function MeasureTool({
  map, trail, styleRev, onClose, onNavigate,
}: {
  map: mapboxgl.Map;
  trail: TrailData | null;
  styleRev: number;
  onClose: () => void;
  onNavigate: (coords: Coordinate3D[], name: string) => void;
}) {
  const onTrail = !!trail;
  const [step, setStep] = useState<Step>('A');
  const [a, setA] = useState<PickedPoint | null>(null);
  const [b, setB] = useState<PickedPoint | null>(null);
  const [liveSnap, setLive] = useState<TrailSnap | null>(null);
  const [routes, setRoutes] = useState<ScoredRoute[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Trail mode: the pin snaps to the trail as the map moves ──
  const lastKmRef = useRef<number | null>(null);
  useEffect(() => {
    if (!trail || step === 'done') return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const c = map.getCenter();
      const snap = snapToTrail(trail.coords, trail.accumulatedDistances, c.lat, c.lng, lastKmRef.current);
      if (snap) lastKmRef.current = snap.km;
      setLive(snap);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    map.on('move', schedule);
    return () => { map.off('move', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [map, trail, step]);
  const live = trail && step !== 'done' ? liveSnap : null;

  // The measured stretch of trail, in walking order.
  const segment = useMemo(() => {
    if (!trail || !a || !b || a.km == null || b.km == null) return null;
    const coords = sliceTrail(trail.coords, trail.accumulatedDistances, a.km, b.km);
    return { coords, km: Math.abs(b.km - a.km), climb: climbOf(coords) };
  }, [trail, a, b]);

  const pick = useCallback(async () => {
    setError(null);
    const c = map.getCenter();
    const point: PickedPoint = trail && live
      ? { lat: live.lat, lon: live.lon, km: live.km }
      : { lat: c.lat, lon: c.lng, km: null };

    if (step === 'A') { setA(point); setStep('B'); return; }
    if (step !== 'B' || !a) return;
    setB(point);
    setStep('done');
    if (trail) return;

    // No trail: ask for walking routes, then give each its elevation so the
    // three can be compared on climb as well as length.
    setBusy(true);
    try {
      const found = await walkRoutes([a.lon, a.lat], [point.lon, point.lat]);
      // One elevation pass for all of them — they share most of their tiles.
      const all = await withElevation(found.flatMap((r) => r.coords));
      let at = 0;
      const scored = found.map((r) => {
        const coords = all.slice(at, at + r.coords.length);
        at += r.coords.length;
        const climb = climbOf(coords);
        return { ...r, coords, gain: climb?.gain ?? null, loss: climb?.loss ?? null };
      });
      setRoutes(scored);
      setSelected(0);
    } catch (e) {
      setError(describeSearchOrDirectionsError(e));
    } finally {
      setBusy(false);
    }
  }, [map, trail, live, step, a]);

  const reset = () => {
    setA(null); setB(null); setRoutes(null); setError(null); setSelected(0); setStep('A');
  };

  // ── What is drawn on the map ──
  const drawn = useMemo(() => {
    const lines: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    if (segment) {
      lines.push({ type: 'Feature', properties: { idx: 0, color: ROUTE_COLORS[0], sel: 1 }, geometry: { type: 'LineString', coordinates: segment.coords.map((c) => [c[1], c[0]]) } });
    } else if (routes) {
      // The selected route last, so it is drawn over the others where they share a path.
      routes
        .map((r, i) => ({ r, i }))
        .sort((x, y) => (x.i === selected ? 1 : 0) - (y.i === selected ? 1 : 0))
        .forEach(({ r, i }) => lines.push({
          type: 'Feature',
          properties: { idx: i, color: ROUTE_COLORS[i], sel: i === selected ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: r.coords.map((c) => [c[1], c[0]]) },
        }));
    }
    const pts: GeoJSON.Feature<GeoJSON.Point>[] = [];
    if (a) pts.push({ type: 'Feature', properties: { label: 'א', role: 'end' }, geometry: { type: 'Point', coordinates: [a.lon, a.lat] } });
    if (b) pts.push({ type: 'Feature', properties: { label: 'ב', role: 'end' }, geometry: { type: 'Point', coordinates: [b.lon, b.lat] } });
    if (live && step !== 'done') pts.push({ type: 'Feature', properties: { label: '', role: 'live' }, geometry: { type: 'Point', coordinates: [live.lon, live.lat] } });
    return {
      lines: { type: 'FeatureCollection', features: lines } as GeoJSON.FeatureCollection,
      pts: { type: 'FeatureCollection', features: pts } as GeoJSON.FeatureCollection,
    };
  }, [segment, routes, selected, a, b, live, step]);

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
            'line-opacity': ['case', ['==', ['get', 'sel'], 1], 1, 0.7],
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
      const idx = e.features?.[0]?.properties?.idx;
      if (typeof idx === 'number') setSelected(idx);
    };
    map.on('click', 'measure-line', onClick);
    return () => { map.off('click', 'measure-line', onClick); };
  }, [map]);

  // Frame the answer once it is in.
  useEffect(() => {
    const coords = segment?.coords ?? routes?.flatMap((r) => r.coords);
    if (!coords || coords.length < 2) return;
    const bounds = new mapboxgl.LngLatBounds();
    coords.forEach((c) => bounds.extend([c[1], c[0]]));
    map.fitBounds(bounds, { padding: { top: 80, bottom: 280, left: 60, right: 60 }, duration: 900, maxZoom: 16 });
  }, [map, segment, routes]);

  const startNavigation = () => {
    if (segment && trail) {
      onNavigate(segment.coords, `קטע מתוך ${trail.name} · ${fmtKm(segment.km)}`);
    } else if (routes?.[selected]) {
      onNavigate(routes[selected].coords, `הליכה · ${fmtKm(routes[selected].distanceKm)}`);
    }
  };

  const picking = step !== 'done';
  const liveKm = trail && a?.km != null && live ? Math.abs(live.km - a.km) : null;
  const farFromTrail = !!live && live.offTrailKm > 0.5;

  return (
    <>
      {/* The floating pin */}
      {picking && (
        <div className="absolute inset-0 z-[44] pointer-events-none flex items-center justify-center">
          <MapPin className="w-10 h-10 text-orange-500 fill-orange-500/30 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] -translate-y-5" />
          <div className="absolute w-2 h-2 rounded-full bg-orange-500 border border-white/80" />
        </div>
      )}

      <div className="absolute bottom-3 inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[400px] z-[50] bg-zinc-900/95 border border-white/10 rounded-3xl shadow-2xl backdrop-blur-md p-4 flex flex-col gap-3" dir="rtl">
        <div className="flex items-center justify-between">
          <div className="text-white font-bold text-sm flex items-center gap-2">
            <Ruler className="w-4 h-4 text-orange-400" />
            {onTrail ? 'מדידה לאורך המסלול' : 'מדידת מרחק הליכה'}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white p-1" aria-label="סגור מדידה"><X size={18} /></button>
        </div>

        {picking && (
          <>
            <p className="text-xs text-zinc-300 leading-relaxed">
              הזז את המפה כך שהנעץ יעמוד על {step === 'A' ? <b className="text-white">נקודת ההתחלה</b> : <b className="text-white">נקודת הסיום</b>}
              {onTrail && ' — הנקודה תוצמד לתוואי המסלול (העיגול הכתום).'}
            </p>
            {onTrail && live && (
              <div className="text-[11px] text-zinc-400 flex justify-between">
                <span>{fmtKm(live.km)} מתחילת המסלול</span>
                {liveKm != null && <span className="text-orange-300 font-bold">{fmtKm(liveKm)} מנקודה א׳</span>}
              </div>
            )}
            {onTrail && farFromTrail && (
              <div className="text-[11px] text-amber-300">הנעץ רחוק מהמסלול — הנקודה תוצמד למקום הקרוב ביותר עליו.</div>
            )}
            <div className="flex gap-2">
              <button
                onClick={pick}
                className="flex-1 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold py-2.5 rounded-2xl transition-colors"
              >
                <MapPin className="w-4 h-4" /> {step === 'A' ? 'קבע נקודה א׳' : 'קבע נקודה ב׳'}
              </button>
              {step === 'B' && (
                <button onClick={reset} className="px-3 bg-zinc-800 text-zinc-200 text-sm font-bold rounded-2xl border border-white/10" title="התחל מחדש">
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
            </div>
          </>
        )}

        {step === 'done' && segment && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-yellow-300">{fmtKm(segment.km)}</span>
              <span className="text-xs text-zinc-400">לאורך המסלול</span>
            </div>
            {segment.climb && (
              <div className="flex gap-4 text-xs font-bold">
                <span className="text-emerald-400 flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" /> עלייה {segment.climb.gain} מ׳</span>
                <span className="text-red-400 flex items-center gap-1"><TrendingDown className="w-3.5 h-3.5" /> ירידה {segment.climb.loss} מ׳</span>
              </div>
            )}
          </div>
        )}

        {step === 'done' && !onTrail && busy && (
          <div className="flex items-center gap-2 text-xs text-zinc-300"><Loader2 className="w-4 h-4 animate-spin" /> מחפש דרכי הליכה…</div>
        )}

        {step === 'done' && !onTrail && routes && (
          <div className="flex flex-col gap-1.5">
            {routes.map((r, i) => (
              <button
                key={i}
                onClick={() => setSelected(i)}
                aria-pressed={selected === i}
                className={`flex items-center gap-3 text-right rounded-2xl px-3 py-2 border transition-colors ${
                  selected === i ? 'bg-white/10 border-white/30' : 'bg-white/5 border-transparent hover:bg-white/10'
                }`}
              >
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: ROUTE_COLORS[i] }} />
                <span className="flex-1 min-w-0">
                  <span className="text-sm font-bold text-white">{fmtKm(r.distanceKm)}</span>
                  <span className="text-[11px] text-zinc-400 mr-2">
                    <Footprints className="inline w-3 h-3 ml-0.5" />{formatDuration(r.durationSec)}
                    {r.gain != null && <> · ↑{r.gain} ↓{r.loss} מ׳</>}
                  </span>
                </span>
                {i === 0 && <span className="text-[10px] text-emerald-400 font-bold shrink-0">הקצרה</span>}
              </button>
            ))}
            {routes.length < 3 && (
              <p className="text-[10px] text-zinc-500">
                {routes.length === 1 ? 'נמצאה דרך אחת בלבד' : `נמצאו ${routes.length} דרכים`} — אין בין הנקודות האלה דרכי הליכה שונות נוספות.
              </p>
            )}
            <p className="text-[10px] text-zinc-500">דרכי הליכה לפי Mapbox (שבילים, דרכי עפר ורחובות). הזמן הוא הערכה להליכה במישור.</p>
          </div>
        )}

        {error && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">{error}</div>
        )}

        {step === 'done' && !busy && (
          <div className="flex gap-2">
            {(segment || routes?.length) ? (
              <button
                onClick={startNavigation}
                className="flex-1 flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-400 text-white text-sm font-bold py-2.5 rounded-2xl transition-colors"
              >
                <Navigation className="w-4 h-4" /> התחל ניווט
              </button>
            ) : null}
            <button onClick={reset} className="flex items-center justify-center gap-1.5 px-4 bg-zinc-800 text-zinc-200 text-sm font-bold py-2.5 rounded-2xl border border-white/10">
              <RotateCcw className="w-4 h-4" /> מדידה חדשה
            </button>
          </div>
        )}
      </div>
    </>
  );
}
