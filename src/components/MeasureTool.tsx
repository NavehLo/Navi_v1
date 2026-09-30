import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  MapPin, X, Loader2, Navigation, RotateCcw, Ruler, Undo2, Check, Plus,
} from 'lucide-react';
import type { TrailData } from '../hooks/useTrailData';
import {
  snapToTrail, sliceTrail, computeElevationGain, type Coordinate3D,
} from '../utils/trailUtils';
import { describeSearchOrDirectionsError, type WalkRoute } from '../lib/mapboxDirections';
import { findWalkRoutes } from '../lib/routeAlternatives';
import { withElevation } from '../lib/demElevation';
import { snapToRenderedPath } from '../lib/pathSnap';
import { formatDuration } from './DrivePlanner';

// Measuring a distance by walking, never as the crow flies — across as many
// points as the walk needs, with every leg and the whole shown separately.
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
// trail of its own, with the elevation profile, the distance left and the
// off-route alarm, and switches on the live location.
//
// The pin is a crosshair fixed to the middle of the screen, with the map
// moving under it; tapping to drop a marker fights with panning on a phone.
// The point taken is the ground under that exact pixel. (Not map.getCenter():
// on a tilted 3D map that is a different place from the one under the pin,
// which is how points used to land beside it.)

interface PickedPoint { lat: number; lon: number; km: number | null }
interface ScoredRoute extends WalkRoute { gain: number | null; loss: number | null }
interface FreeLeg { status: 'loading' | 'ok' | 'error'; routes: ScoredRoute[]; selected: number; error?: string }
interface LegSummary { km: number; gain: number | null; loss: number | null; durationSec: number | null; coords: Coordinate3D[] }

const LINE_SRC = 'measure-lines';
const PT_SRC = 'measure-points';
const LAYERS = ['measure-line-casing', 'measure-line', 'measure-pt', 'measure-pt-label'];
const ROUTE_COLORS = ['#facc15', '#a78bfa', '#34d399'];
const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';

const letter = (i: number) => LETTERS[i] ?? String(i + 1);

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
  const [points, setPoints] = useState<PickedPoint[]>([]);
  const [picking, setPicking] = useState(true);
  const [legs, setLegs] = useState<FreeLeg[]>([]);
  const [liveSnap, setLive] = useState<PickedPoint | null>(null);

  // The ground under the pin, snapped to the trail or to a path, as the map
  // moves. Recomputed at most once a frame.
  const lastKmRef = useRef<number | null>(null);
  useEffect(() => {
    if (!picking) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const el = map.getContainer();
      const px = el.clientWidth / 2, py = el.clientHeight / 2;
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
  }, [map, trail, picking]);
  const live = picking ? liveSnap : null;

  // ── Free mode: the walking routes of one leg ──
  // A generation per leg, so a leg that was undone and picked again does not
  // take the answer that was on its way for the old one.
  const legGenRef = useRef<number[]>([]);
  const routeLeg = useCallback(async (i: number, from: PickedPoint, to: PickedPoint) => {
    const gen = (legGenRef.current[i] ?? 0) + 1;
    legGenRef.current[i] = gen;
    setLegs((ls) => { const n = ls.slice(0, i); n[i] = { status: 'loading', routes: [], selected: 0 }; return n; });
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
      if (legGenRef.current[i] !== gen) return;
      setLegs((ls) => { const n = ls.slice(); n[i] = { status: 'ok', routes, selected: 0 }; return n; });
      // The walk really starts and ends on the way the router found: move
      // the markers there. The new end is where the next leg starts from.
      setPoints((ps) => ps.map((p, k) => {
        if (k === i && i === 0 && found.start) return { ...p, lon: found.start[0], lat: found.start[1] };
        if (k === i + 1 && found.end) return { ...p, lon: found.end[0], lat: found.end[1] };
        return p;
      }));
    } catch (e) {
      if (legGenRef.current[i] !== gen) return;
      setLegs((ls) => { const n = ls.slice(); n[i] = { status: 'error', routes: [], selected: 0, error: describeSearchOrDirectionsError(e) }; return n; });
    }
  }, []);

  const addPoint = () => {
    const el = map.getContainer();
    const c = map.unproject([el.clientWidth / 2, el.clientHeight / 2]);
    const point: PickedPoint = live ?? { lat: c.lat, lon: c.lng, km: null };
    const prev = points[points.length - 1];
    setPoints([...points, point]);
    if (!trail && prev) void routeLeg(points.length - 1, prev, point);
  };

  const undo = () => {
    if (!points.length) return;
    const n = points.length - 1;
    setPoints(points.slice(0, n));
    if (!trail && n >= 1) {
      legGenRef.current[n - 1] = (legGenRef.current[n - 1] ?? 0) + 1; // drop anything in flight
      setLegs(legs.slice(0, n - 1));
    }
    setPicking(true);
  };

  const reset = () => {
    legGenRef.current = legGenRef.current.map((g) => g + 1);
    setPoints([]); setLegs([]); setPicking(true);
  };

  const selectRoute = useCallback((leg: number, idx: number) =>
    setLegs((ls) => ls.map((l, i) => (i === leg ? { ...l, selected: idx } : l))), []);

  // ── Every leg as a number ──
  const summaries: (LegSummary | null)[] = useMemo(() => {
    const out: (LegSummary | null)[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      if (trail) {
        const a = points[i].km, b = points[i + 1].km;
        if (a == null || b == null) { out.push(null); continue; }
        const coords = sliceTrail(trail.coords, trail.accumulatedDistances, a, b);
        const climb = climbOf(coords);
        out.push({ km: Math.abs(b - a), gain: climb?.gain ?? null, loss: climb?.loss ?? null, durationSec: null, coords });
      } else {
        const leg = legs[i];
        const r = leg?.status === 'ok' ? leg.routes[leg.selected] : null;
        out.push(r ? { km: r.distanceKm, gain: r.gain, loss: r.loss, durationSec: r.durationSec, coords: r.coords } : null);
      }
    }
    return out;
  }, [points, legs, trail]);

  const complete = summaries.length > 0 && summaries.every(Boolean);
  const total = useMemo(() => {
    if (!complete) return null;
    const s = summaries as LegSummary[];
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
  }, [complete, summaries, trail]);

  // ── What is drawn on the map ──
  const drawn = useMemo(() => {
    const lines: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    const line = (coords: Coordinate3D[], props: Record<string, unknown>) =>
      lines.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords.map((c) => [c[1], c[0]]) } });
    if (trail) {
      summaries.forEach((s, i) => s && line(s.coords, { leg: i, idx: 0, color: ROUTE_COLORS[0], sel: 1 }));
    } else {
      // Unchosen alternatives first, so the chosen routes are drawn on top.
      legs.forEach((l, i) => l.routes.forEach((r, k) => {
        if (k !== l.selected) line(r.coords, { leg: i, idx: k, color: ROUTE_COLORS[k], sel: 0 });
      }));
      legs.forEach((l, i) => {
        const r = l.routes[l.selected];
        if (r) line(r.coords, { leg: i, idx: l.selected, color: ROUTE_COLORS[l.selected], sel: 1 });
      });
    }
    const pts: GeoJSON.Feature<GeoJSON.Point>[] = points.map((p, i) => ({
      type: 'Feature', properties: { label: letter(i), role: 'end' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    }));
    if (live) pts.push({ type: 'Feature', properties: { label: '', role: 'live' }, geometry: { type: 'Point', coordinates: [live.lon, live.lat] } });
    return {
      lines: { type: 'FeatureCollection', features: lines } as GeoJSON.FeatureCollection,
      pts: { type: 'FeatureCollection', features: pts } as GeoJSON.FeatureCollection,
    };
  }, [trail, summaries, legs, points, live]);

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
      if (typeof p?.leg === 'number' && typeof p?.idx === 'number') selectRoute(p.leg, p.idx);
    };
    map.on('click', 'measure-line', onClick);
    return () => { map.off('click', 'measure-line', onClick); };
  }, [map, selectRoute]);

  // Done picking: frame the whole walk. Never while picking — that would move
  // the map out from under the pin.
  const finish = () => {
    setPicking(false);
    const coords = trail
      ? summaries.flatMap((s) => s?.coords ?? [])
      : legs.flatMap((l) => l.routes.flatMap((r) => r.coords));
    const all = coords.length ? coords : points.map((p) => [p.lat, p.lon, 0] as Coordinate3D);
    if (all.length < 2) return;
    const bounds = new mapboxgl.LngLatBounds();
    all.forEach((c) => bounds.extend([c[1], c[0]]));
    map.fitBounds(bounds, { padding: { top: 80, bottom: 340, left: 60, right: 60 }, duration: 900, maxZoom: 16 });
  };

  const startNavigation = () => {
    if (!total) return;
    onNavigate(total.coords, trail ? `קטע מתוך ${trail.name} · ${fmtKm(total.km)}` : `הליכה · ${fmtKm(total.km)}`);
  };

  const n = points.length;
  const liveFromLast = trail && n > 0 && points[n - 1].km != null && live?.km != null ? Math.abs(live.km - points[n - 1].km!) : null;
  const liveOffTrailFar = !!trail && !!live && (() => {
    const el = map.getContainer();
    const c = map.unproject([el.clientWidth / 2, el.clientHeight / 2]);
    return c.distanceTo(new mapboxgl.LngLat(live.lon, live.lat)) > 500;
  })();
  const anyLoading = legs.some((l) => l.status === 'loading');

  return (
    <>
      {/* The floating pin */}
      {picking && (
        <div className="absolute inset-0 z-[44] pointer-events-none flex items-center justify-center">
          <MapPin className="w-10 h-10 text-orange-500 fill-orange-500/30 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] -translate-y-5" />
          <div className="absolute w-2 h-2 rounded-full bg-orange-500 border border-white/80" />
        </div>
      )}

      <div className="absolute bottom-3 inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[420px] z-[50] bg-zinc-900/95 border border-white/15 rounded-3xl shadow-2xl backdrop-blur-md p-4 flex flex-col gap-3 text-white max-h-[55vh]" dir="rtl">
        <div className="flex items-center justify-between shrink-0">
          <div className="font-bold text-base flex items-center gap-2">
            <Ruler className="w-4 h-4 text-orange-400" />
            {onTrail ? 'מדידה לאורך המסלול' : 'מדידת מרחק הליכה'}
          </div>
          <button onClick={onClose} className="text-white hover:text-orange-300 p-1" aria-label="סגור מדידה"><X size={20} /></button>
        </div>

        {picking && (
          <div className="flex flex-col gap-2 shrink-0">
            <p className="text-sm leading-relaxed">
              {n === 0
                ? <>הזז את המפה כך שהנעץ יעמוד על <b>נקודת ההתחלה</b>.</>
                : <>הזז את המפה אל <b>נקודה {letter(n)}׳</b>{n >= 2 && ', או לחץ ״סיום״'}.</>}
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
                {liveFromLast != null && <span className="text-orange-300 font-bold">{fmtKm(liveFromLast)} מנקודה {letter(n - 1)}׳</span>}
              </div>
            )}
            {liveOffTrailFar && (
              <div className="text-sm text-amber-200">הנעץ רחוק מהמסלול — הנקודה תוצמד למקום הקרוב ביותר עליו.</div>
            )}
            <div className="flex gap-2">
              <button
                onClick={addPoint}
                className="flex-1 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-400 text-white text-sm font-bold py-2.5 rounded-2xl transition-colors"
              >
                {n === 0 ? <MapPin className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {n === 0 ? 'קבע נקודה א׳' : `הוסף נקודה ${letter(n)}׳`}
              </button>
              {n >= 2 && (
                <button onClick={finish} className="flex items-center gap-1.5 px-4 bg-white text-zinc-900 text-sm font-bold rounded-2xl">
                  <Check className="w-4 h-4" /> סיום
                </button>
              )}
              {n >= 1 && (
                <button onClick={undo} className="px-3 bg-zinc-800 text-white text-sm font-bold rounded-2xl border border-white/15" title="בטל את הנקודה האחרונה" aria-label="בטל את הנקודה האחרונה">
                  <Undo2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Every leg, then the whole */}
        {n >= 2 && (
          <div className="flex flex-col gap-2 overflow-y-auto overscroll-contain min-h-0">
            {summaries.map((s, i) => {
              const leg = legs[i];
              return (
                <div key={i} className="rounded-2xl bg-white/5 border border-white/10 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold">{letter(i)}׳ ← {letter(i + 1)}׳</span>
                    {s ? (
                      <span className="text-sm">
                        <b className="text-yellow-300">{fmtKm(s.km)}</b>
                        {s.durationSec != null && <> · {formatDuration(s.durationSec)}</>}
                        {s.gain != null && <> · ↑{s.gain} ↓{s.loss} מ׳</>}
                      </span>
                    ) : leg?.status === 'loading' ? (
                      <span className="text-sm flex items-center gap-1.5"><Loader2 className="w-4 h-4 animate-spin" /> מחפש דרכים…</span>
                    ) : null}
                  </div>
                  {leg?.status === 'error' && <div className="text-sm text-amber-200 mt-1">{leg.error}</div>}
                  {/* The ways round, when there is more than one */}
                  {!onTrail && leg?.status === 'ok' && leg.routes.length > 1 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {leg.routes.map((r, k) => (
                        <button
                          key={k}
                          onClick={() => selectRoute(i, k)}
                          aria-pressed={leg.selected === k}
                          className={`flex items-center gap-1.5 text-sm rounded-xl px-2.5 py-1 border transition-colors ${
                            leg.selected === k ? 'bg-white/15 border-white' : 'bg-transparent border-white/20 hover:bg-white/10'
                          }`}
                        >
                          <span className="w-2.5 h-2.5 rounded-full" style={{ background: ROUTE_COLORS[k] }} />
                          {fmtKm(r.distanceKm)}
                          {k === 0 && <span className="text-emerald-300 text-xs font-bold">הקצרה</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {!onTrail && leg?.status === 'ok' && leg.routes.length === 1 && (
                    <div className="text-xs text-white mt-1">דרך אחת בלבד — לא נמצאה בין הנקודות האלה דרך הליכה שונה באמת.</div>
                  )}
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

            {!onTrail && (
              <p className="text-xs text-white leading-relaxed">
                דרכי הליכה לפי Mapbox: שבילים, דרכי עפר ורחובות. הזמן הוא הערכה להליכה במישור. אפשר לבחור דרך גם בלחיצה על הקו במפה.
              </p>
            )}
            {total?.gain == null && complete && onTrail && (
              <p className="text-xs text-white">לקובץ המסלול אין נתוני גובה, לכן אין עלייה וירידה.</p>
            )}
          </div>
        )}

        {!picking && (
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
