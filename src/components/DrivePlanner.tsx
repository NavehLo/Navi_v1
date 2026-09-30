import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import mapboxgl from 'mapbox-gl';
import { Car, MapPin, X, Loader2, Search, ArrowLeftRight, Check, LocateFixed, Plus, Navigation, ChevronDown, ChevronUp } from 'lucide-react';
import {
  newSessionToken, suggestPlaces, retrievePlace, reversePlace,
  type Place, type PlaceSuggestion,
} from '../lib/mapboxSearch';
import { describeSearchOrDirectionsError, type RouteOption } from '../lib/mapboxDirections';
import { findDriveRoutes } from '../lib/routeAlternatives';
import type { Coordinate3D } from '../utils/trailUtils';

// The road-trip planner: where from, where to, any stops on the way, and a
// choice of up to three roads to preview before taking one. Every place comes
// from a place search with suggestions, from a pin dropped on the map, or —
// for the start — from where the phone is right now.
//
// The pin is a crosshair fixed to the centre of the screen: the map moves
// under it and "נעץ כאן" takes wherever it ends up. Tapping the map to place a
// marker fights with dragging and rotating; this does not.
//
// Once the roads have been worked out, changing any place — adding a stop,
// moving one, swapping the ends — works them out again, so the times and
// distances on offer always belong to the places on screen.

export interface DriveRequest {
  from: Place;
  to: Place;
  vias: Place[];
  coords: Coordinate3D[];
  distanceKm: number;
  durationSec: number;
}

export interface DrivePlan {
  from: Place | null;
  to: Place | null;
  vias: (Place | null)[]; // null = a stop added but not yet chosen
}

// Which field a pin is being dropped for: an end, or a stop by its index.
type Slot = 'from' | 'to' | number;

const MAX_STOPS = 8;
// The map colours of the three roads on offer, in the order they are listed.
export const DRIVE_OPTION_COLORS = ['#3b82f6', '#a78bfa', '#34d399'];

const OPT_SRC = 'drive-options';
const OPT_LAYERS = ['drive-options-casing', 'drive-options-line'];

export function formatDuration(sec: number): string {
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h === 0) return `${m} דק'`;
  if (m === 0) return `${h} שע'`;
  return `${h} שע' ${m} דק'`;
}

function fmtKm(km: number): string {
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} ק״מ`;
}

const EMPTY_PLAN: DrivePlan = { from: null, to: null, vias: [] };

export default function DrivePlanner({
  map, onRoute, onPreview, initial,
}: {
  map: mapboxgl.Map;
  onRoute: (req: DriveRequest) => void;
  // The places as they are picked, so the page can show markers.
  onPreview?: (plan: DrivePlan) => void;
  // The plan of the drive last opened, so closing it comes back to its places.
  initial?: DrivePlan | null;
}) {
  const [plan, setPlan] = useState<DrivePlan>(initial ?? EMPTY_PLAN);
  const [pinning, setPinning] = useState<Slot | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [routing, setRouting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [options, setOptions] = useState<RouteOption[] | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => { onPreview?.(plan); }, [plan, onPreview]);

  // A generation per calculation, so an answer for places since changed is
  // dropped rather than shown against the new ones.
  const genRef = useRef(0);
  // The latest plan and whether roads are on show, for the handlers that
  // finish after an await (a pin, a GPS fix) and must not act on a stale one.
  const planRef = useRef(plan);
  const shownRef = useRef(false);

  const calculate = useCallback(async (p: DrivePlan) => {
    if (!p.from || !p.to || p.vias.some((v) => !v)) return;
    const gen = ++genRef.current;
    setRouting(true);
    setError(null);
    try {
      const points: [number, number][] = [p.from, ...(p.vias as Place[]), p.to].map((x) => [x.lon, x.lat]);
      const found = await findDriveRoutes(points);
      if (gen !== genRef.current) return;
      shownRef.current = true;
      setOptions(found.routes);
      setSelected(0);
    } catch (e) {
      if (gen !== genRef.current) return;
      shownRef.current = false;
      setOptions(null);
      setError(describeSearchOrDirectionsError(e));
    } finally {
      if (gen === genRef.current) setRouting(false);
    }
  }, []);

  // Every change of places comes through here. Once the roads have been shown,
  // they are worked out again for the new places — or taken away, while a
  // place is still missing.
  const changePlan = (update: (p: DrivePlan) => DrivePlan) => {
    const next = update(planRef.current);
    if (next === planRef.current) return;
    planRef.current = next;
    setPlan(next);
    setError(null);
    if (!shownRef.current) return;
    if (next.from && next.to && next.vias.every(Boolean)) {
      void calculate(next);
    } else {
      genRef.current++;
      shownRef.current = false;
      setOptions(null);
      setRouting(false);
    }
  };

  const setSlot = (slot: Slot, place: Place | null) => changePlan((p) => {
    if (slot === 'from' || slot === 'to') return { ...p, [slot]: place };
    const vias = p.vias.slice();
    vias[slot] = place;
    return { ...p, vias };
  });

  const addStop = () => changePlan((p) => (p.vias.length >= MAX_STOPS ? p : { ...p, vias: [...p.vias, null] }));
  const removeStop = (i: number) => changePlan((p) => ({ ...p, vias: p.vias.filter((_, k) => k !== i) }));
  const swap = () => changePlan((p) => ({ from: p.to, to: p.from, vias: p.vias.slice().reverse() }));

  const dropPin = async () => {
    if (pinning === null) return;
    setPinBusy(true);
    const c = map.getCenter();
    const place = await reversePlace(c.lng, c.lat);
    setSlot(pinning, place);
    setPinBusy(false);
    setPinning(null);
  };

  // The start, from where the phone is. A fix up to half a minute old will
  // do — with the live location already on, that answers at once.
  const locateMe = () => {
    if (!navigator.geolocation) {
      setError('הדפדפן לא מאפשר לאתר את המיקום.');
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { longitude: lon, latitude: lat } = pos.coords;
        const near = await reversePlace(lon, lat);
        // "המיקום שלי" alone would mean nothing once the drive is saved and
        // opened somewhere else; the nearest name keeps it meaningful.
        const short = near.name.split(',')[0].trim();
        const named = short && !/^-?[\d.]+$/.test(short);
        setSlot('from', { name: named ? `המיקום שלי (${short})` : 'המיקום שלי', lon, lat });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setError(err.code === err.PERMISSION_DENIED
          ? 'אין הרשאה לאתר את המיקום. אפשר לתת אותה בהגדרות האתר בדפדפן.'
          : 'לא הצלחנו לאתר את המיקום. נסה שוב, או בחר נקודת מוצא אחרת.');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  };

  const stops = plan.vias.filter((v): v is Place => !!v);
  const ready = !!plan.from && !!plan.to && stops.length === plan.vias.length;

  const go = () => {
    const route = options?.[selected];
    if (!route || !plan.from || !plan.to) return;
    onRoute({ from: plan.from, to: plan.to, vias: stops, ...route });
  };

  // ── The roads on offer, drawn on the map; tapping one chooses it ──
  useEffect(() => {
    const sync = () => {
      if (!map.getStyle()) return;
      const fc: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
        type: 'FeatureCollection',
        features: (options ?? []).map((r, i) => ({
          type: 'Feature',
          properties: { idx: i, color: DRIVE_OPTION_COLORS[i] ?? '#3b82f6', on: i === selected ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: r.coords.map((c) => [c[1], c[0]]) },
        })),
      };
      const src = map.getSource(OPT_SRC) as mapboxgl.GeoJSONSource | undefined;
      if (src) { src.setData(fc); return; }
      map.addSource(OPT_SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: 'drive-options-casing', type: 'line', source: OPT_SRC,
        layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'on'] },
        paint: { 'line-color': '#0f172a', 'line-width': ['case', ['==', ['get', 'on'], 1], 10, 7], 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'drive-options-line', type: 'line', source: OPT_SRC,
        layout: { 'line-join': 'round', 'line-cap': 'round', 'line-sort-key': ['get', 'on'] },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['==', ['get', 'on'], 1], 6, 4],
          'line-opacity': ['case', ['==', ['get', 'on'], 1], 1, 0.7],
        },
      });
    };
    try { sync(); } catch {}
    map.on('style.load', sync);
    return () => { map.off('style.load', sync); };
  }, [map, options, selected]);

  // Frame all the roads when a new set arrives, and again when the panel is
  // folded or unfolded — folded, they get the room it gave up.
  useEffect(() => {
    if (!options?.length) return;
    const bounds = new mapboxgl.LngLatBounds();
    options.forEach((r) => r.coords.forEach((c) => bounds.extend([c[1], c[0]])));
    map.fitBounds(bounds, { padding: { top: 80, bottom: isExpanded ? 320 : 150, left: 40, right: 40 }, duration: 1000, maxZoom: 14 });
  }, [map, options, isExpanded]);

  useEffect(() => {
    const onClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
      const idx = e.features?.[0]?.properties?.idx;
      if (typeof idx === 'number') setSelected(idx);
    };
    map.on('click', 'drive-options-line', onClick);
    return () => { map.off('click', 'drive-options-line', onClick); };
  }, [map]);

  // Gone with the planner: the opened drive draws its own line.
  useEffect(() => () => {
    try {
      OPT_LAYERS.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(OPT_SRC)) map.removeSource(OPT_SRC);
    } catch {}
  }, [map]);

  // ── Pin mode: the panel gets out of the way, the crosshair takes over ──
  if (pinning !== null) {
    const what = pinning === 'from' ? 'נקודת המוצא' : pinning === 'to' ? 'היעד' : `עצירה ${pinning + 1}`;
    return (
      <>
        <div className="absolute inset-0 z-[44] pointer-events-none flex items-center justify-center">
          {/* The pin's tip is the point; lift the glyph so it sits on the centre */}
          <MapPin className="w-10 h-10 text-orange-500 fill-orange-500/30 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] -translate-y-5" />
          <div className="absolute w-2 h-2 rounded-full bg-orange-500 border border-white/80" />
        </div>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[44] bg-zinc-900/90 text-white text-xs font-bold px-4 py-2 rounded-full border border-white/10 backdrop-blur-md shadow-xl pointer-events-none" dir="rtl">
          הזז את המפה כך שהנעץ יעמוד על {what}
        </div>
        <div className="absolute bottom-6 inset-x-0 z-[44] flex justify-center gap-2 px-4" dir="rtl">
          <button
            onClick={dropPin}
            disabled={pinBusy}
            className="flex items-center gap-2 bg-orange-500 disabled:bg-zinc-700 text-white text-sm font-bold px-5 py-2.5 rounded-2xl shadow-2xl hover:bg-orange-400 transition-colors"
          >
            {pinBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} נעץ כאן
          </button>
          <button
            onClick={() => setPinning(null)}
            className="bg-zinc-800 text-white text-sm font-bold px-5 py-2.5 rounded-2xl border border-white/10 shadow-2xl hover:bg-zinc-700 transition-colors"
          >
            ביטול
          </button>
        </div>
      </>
    );
  }

  const fastest = options?.[0];
  const chosen = options?.[selected];

  return (
    <div
      className={`absolute left-4 right-4 z-40 flex flex-col md:w-[380px] md:bottom-auto md:right-6 md:left-auto md:top-6 bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl transition-all
        ${isExpanded ? 'bottom-16 rounded-3xl p-5 max-h-[70vh] md:max-h-[calc(100vh-3rem)]' : 'bottom-16 rounded-2xl p-3'}`}
      dir="rtl"
    >
      {/* The header folds the panel away, on every screen size, so the roads
          on the map can be seen whole. Folded, it still says what matters:
          the road chosen, and a way to open it without unfolding. */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className="flex-1 min-w-0 flex items-center gap-2 text-right"
        >
          <Car className="text-orange-500 shrink-0" size={isExpanded ? 24 : 20} />
          {isExpanded || !chosen ? (
            <span className={`font-extrabold text-white tracking-tight truncate ${isExpanded ? 'text-lg md:text-xl' : 'text-base'}`}>
              נסיעה בכביש
            </span>
          ) : (
            <span className="min-w-0 flex items-center gap-2">
              <span className="w-3 h-3 rounded-full shrink-0 ring-2 ring-white/30" style={{ background: DRIVE_OPTION_COLORS[selected] }} />
              <span className="text-sm font-bold text-white truncate">
                {formatDuration(chosen.durationSec)} · {fmtKm(chosen.distanceKm)}
                {options!.length > 1 && <span className="text-white/85 font-medium"> · דרך {selected + 1} מתוך {options!.length}</span>}
              </span>
            </span>
          )}
        </button>
        {!isExpanded && chosen && (
          <button
            onClick={go}
            disabled={routing}
            className="shrink-0 flex items-center gap-1.5 bg-orange-500 disabled:bg-zinc-700 text-white text-sm font-bold px-3 py-2 rounded-xl hover:bg-orange-400 transition-colors"
          >
            <Navigation className="w-4 h-4" /> פתח
          </button>
        )}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'צמצם את החלונית' : 'הרחב את החלונית'}
          className="shrink-0 flex items-center gap-1 text-xs font-bold text-white bg-white/10 hover:bg-white/20 border border-white/15 px-2.5 py-2 rounded-xl transition-colors"
        >
          {isExpanded ? <><ChevronDown className="w-4 h-4" /> צמצם</> : <><ChevronUp className="w-4 h-4" /> הרחב</>}
        </button>
      </div>
      {!isExpanded && options && options.length > 1 && (
        <p className="text-xs text-white/85 mt-1.5">אפשר לבחור דרך אחרת בלחיצה על הקו שלה במפה.</p>
      )}

      <div className={`flex-col gap-3 overflow-y-auto custom-scrollbar -mx-1 px-1 ${isExpanded ? 'flex mt-3' : 'hidden'}`}>
        <PlaceField
          label="מוצא"
          value={plan.from}
          map={map}
          onChange={(p) => setSlot('from', p)}
          onPin={() => setPinning('from')}
          extra={
            <button
              onClick={locateMe}
              disabled={locating}
              className="shrink-0 p-2.5 rounded-xl bg-sky-500/15 border border-sky-400/40 text-sky-300 hover:bg-sky-500/25 transition-colors disabled:opacity-60"
              title="התחל מהמיקום שלי"
              aria-label="התחל מהמיקום שלי"
            >
              {locating ? <Loader2 size={18} className="animate-spin" /> : <LocateFixed size={18} />}
            </button>
          }
        />
        {!plan.from && (
          <button
            onClick={locateMe}
            disabled={locating}
            className="-mt-1 self-start flex items-center gap-1.5 text-xs font-bold text-sky-300 hover:text-sky-200 transition-colors disabled:opacity-60"
          >
            <LocateFixed size={14} /> {locating ? 'מאתר את המיקום…' : 'התחל מהמיקום הנוכחי שלי'}
          </button>
        )}

        {plan.vias.map((v, i) => (
          <PlaceField
            key={i}
            label={`עצירה ${i + 1}`}
            value={v}
            map={map}
            onChange={(p) => setSlot(i, p)}
            onPin={() => setPinning(i)}
            onRemove={() => removeStop(i)}
          />
        ))}

        <div className="flex items-center justify-between -my-1">
          <button
            onClick={addStop}
            disabled={plan.vias.length >= MAX_STOPS}
            className="flex items-center gap-1.5 text-xs font-bold text-orange-300 hover:text-orange-200 transition-colors disabled:opacity-40 py-1"
          >
            <Plus size={14} /> הוסף עצירה בדרך
          </button>
          <button onClick={swap} className="p-1.5 rounded-full bg-white/10 hover:bg-white/15 text-white transition-colors" title="הפוך את כיוון הנסיעה" aria-label="הפוך את כיוון הנסיעה">
            <ArrowLeftRight className="w-4 h-4 rotate-90" />
          </button>
        </div>

        <PlaceField
          label="יעד"
          value={plan.to}
          map={map}
          onChange={(p) => setSlot('to', p)}
          onPin={() => setPinning('to')}
        />

        {error && (
          <div className="text-sm text-amber-200 bg-amber-500/15 border border-amber-500/30 rounded-xl p-3 leading-relaxed">{error}</div>
        )}

        {options && options.length > 0 ? (
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">
                {options.length > 1 ? `${options.length} דרכים — בחר אחת` : 'הדרך המומלצת'}
              </span>
              {routing && <Loader2 className="w-4 h-4 text-white animate-spin" />}
            </div>
            {options.map((r, i) => (
              <button
                key={i}
                onClick={() => setSelected(i)}
                className={`flex items-center gap-3 text-right rounded-xl p-3 border transition-colors ${
                  i === selected ? 'bg-white/10 border-white/40' : 'bg-white/5 border-white/10 hover:bg-white/10'
                }`}
              >
                <span className="w-3 h-3 rounded-full shrink-0 ring-2 ring-white/30" style={{ background: DRIVE_OPTION_COLORS[i] }} />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold text-white">
                    {formatDuration(r.durationSec)} · {fmtKm(r.distanceKm)}
                  </span>
                  <span className="block text-xs text-white/90 mt-0.5">
                    {i === 0 ? 'המהירה ביותר' : `+${formatDuration(Math.max(60, r.durationSec - fastest!.durationSec))} מהמהירה`}
                  </span>
                </span>
                {i === selected && <Check size={18} className="text-white shrink-0" />}
              </button>
            ))}
            {options.length === 1 && (
              <p className="text-xs text-white/90 leading-relaxed">לא נמצאו דרכים חלופיות סבירות לנסיעה הזו.</p>
            )}
            <button
              onClick={go}
              disabled={routing}
              className="flex items-center justify-center gap-2 bg-orange-500 disabled:bg-zinc-700 text-white text-sm font-bold px-4 py-3 rounded-2xl shadow-lg hover:bg-orange-400 transition-colors"
            >
              <Navigation className="w-4 h-4" /> פתח את הדרך הזו
            </button>
          </div>
        ) : (
          <button
            onClick={() => calculate(plan)}
            disabled={!ready || routing}
            className="flex items-center justify-center gap-2 bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-300 text-white text-sm font-bold px-4 py-3 rounded-2xl shadow-lg hover:bg-orange-400 transition-colors mt-1"
          >
            {routing ? <><Loader2 className="w-4 h-4 animate-spin" /> מחפש דרכים…</> : <><Car className="w-4 h-4" /> חשב מסלול</>}
          </button>
        )}

        <p className="text-xs text-white/80 leading-relaxed">
          חיפוש וניווט: Mapbox. אחרי פתיחת הדרך אפשר להריץ סיור וירטואלי לאורכה, עד פי 50.
        </p>
      </div>
    </div>
  );
}

// One place: a search box with suggestions, or the picked place with a
// clear button. Suggestions are asked for 300 ms after the last keystroke and
// never for fewer than two characters — each session is billed.
function PlaceField({
  label, value, map, onChange, onPin, onRemove, extra,
}: {
  label: string;
  value: Place | null;
  map: mapboxgl.Map;
  onChange: (place: Place | null) => void;
  onPin: () => void;
  // A stop can be taken away altogether, not just emptied.
  onRemove?: () => void;
  // Another button beside the pin (the start's "my location").
  extra?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const sessionRef = useRef<string>(newSessionToken());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(async () => {
      setSearching(true);
      setFailed(null);
      try {
        const c = map.getCenter();
        const list = await suggestPlaces(q, sessionRef.current, [c.lng, c.lat], controller.signal);
        if (controller.signal.aborted) return;
        setSuggestions(list);
        setOpen(true);
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setFailed(describeSearchOrDirectionsError(e));
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, map]);

  const pick = async (s: PlaceSuggestion) => {
    setOpen(false);
    setSearching(true);
    try {
      const place = await retrievePlace(s, sessionRef.current);
      onChange(place);
      setQuery('');
    } catch (e) {
      setFailed(describeSearchOrDirectionsError(e));
    } finally {
      setSearching(false);
      // A retrieve closes the billing session; the next search opens a new one.
      sessionRef.current = newSessionToken();
    }
  };

  if (value) {
    return (
      <div className="flex items-center gap-2 bg-white/5 border border-orange-500/40 rounded-xl py-2 pr-3 pl-2">
        <span className="text-xs text-orange-300 font-bold shrink-0">{label}</span>
        <span className="text-sm text-white font-bold truncate flex-1" title={value.name}>{value.name}</span>
        <button
          onClick={() => (onRemove ? onRemove() : onChange(null))}
          className="p-1 text-white/80 hover:text-white transition-colors"
          aria-label={onRemove ? `הסר את ${label}` : `נקה ${label}`}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70" size={16} />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              if (e.target.value.trim().length < 2) { setSuggestions([]); setSearching(false); }
            }}
            onFocus={() => { setOpen(true); if (!query) sessionRef.current = newSessionToken(); }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
            placeholder={`${label} — עיר, כתובת או מקום`}
            className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pr-9 pl-9 text-sm text-white placeholder:text-white/60 font-medium focus:outline-none focus:border-orange-500/50 focus:bg-white/10 transition-colors"
          />
          {searching && <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70 animate-spin" size={16} />}
        </div>
        {extra}
        <button
          onClick={onPin}
          className="shrink-0 p-2.5 rounded-xl bg-white/5 border border-white/10 text-orange-400 hover:bg-white/10 transition-colors"
          title="בחר נקודה על המפה"
          aria-label={`בחר ${label} על המפה`}
        >
          <MapPin size={18} />
        </button>
        {onRemove && (
          <button
            onClick={onRemove}
            className="shrink-0 p-2.5 rounded-xl bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            aria-label={`הסר את ${label}`}
          >
            <X size={18} />
          </button>
        )}
      </div>

      {failed && <div className="text-xs text-amber-300 mt-1 px-1">{failed}</div>}

      {open && suggestions.length > 0 && (
        <div className="absolute top-full mt-1 right-0 left-0 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          {suggestions.map((s) => (
            <button
              key={s.mapboxId}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="w-full text-right px-4 py-2.5 text-sm text-white hover:bg-white/10 hover:text-orange-400 transition-colors flex flex-col gap-0.5"
            >
              <span className="font-bold">{s.name}</span>
              {s.placeFormatted && <span className="text-xs text-white/75">{s.placeFormatted}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
