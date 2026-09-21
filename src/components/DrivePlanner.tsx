import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { Car, MapPin, X, Loader2, Search, ArrowLeftRight, Check } from 'lucide-react';
import {
  newSessionToken, suggestPlaces, retrievePlace, reversePlace,
  type Place, type PlaceSuggestion,
} from '../lib/mapboxSearch';
import { driveRoute, describeSearchOrDirectionsError } from '../lib/mapboxDirections';
import type { Coordinate3D } from '../utils/trailUtils';

// The road-trip planner: where from, where to, and a drive to preview before
// taking it. Both ends come from a place search with suggestions, or — when
// the place has no name to search for — from a pin dropped on the map.
//
// The pin is a crosshair fixed to the centre of the screen: the map moves
// under it and "נעץ כאן" takes wherever it ends up. Tapping the map to place a
// marker fights with dragging and rotating; this does not.

export interface DriveRequest {
  from: Place;
  to: Place;
  coords: Coordinate3D[];
  distanceKm: number;
  durationSec: number;
}

type Field = 'from' | 'to';

export function formatDuration(sec: number): string {
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h === 0) return `${m} דק'`;
  if (m === 0) return `${h} שע'`;
  return `${h} שע' ${m} דק'`;
}

export default function DrivePlanner({
  map, onRoute, onPreview,
}: {
  map: mapboxgl.Map;
  onRoute: (req: DriveRequest) => void;
  // The two endpoints as they are picked, so the page can show markers.
  onPreview?: (from: Place | null, to: Place | null) => void;
}) {
  const [places, setPlaces] = useState<{ from: Place | null; to: Place | null }>({ from: null, to: null });
  const [pinning, setPinning] = useState<Field | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [routing, setRouting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => { onPreview?.(places.from, places.to); }, [places, onPreview]);

  const setPlace = useCallback((field: Field, place: Place | null) => {
    setError(null);
    setPlaces((p) => ({ ...p, [field]: place }));
  }, []);

  const swap = () => setPlaces((p) => ({ from: p.to, to: p.from }));

  const dropPin = async () => {
    if (!pinning) return;
    setPinBusy(true);
    const c = map.getCenter();
    const place = await reversePlace(c.lng, c.lat);
    setPlace(pinning, place);
    setPinBusy(false);
    setPinning(null);
  };

  const calculate = async () => {
    if (!places.from || !places.to || routing) return;
    setRouting(true);
    setError(null);
    try {
      const route = await driveRoute([places.from.lon, places.from.lat], [places.to.lon, places.to.lat]);
      onRoute({ from: places.from, to: places.to, ...route });
    } catch (e) {
      setError(describeSearchOrDirectionsError(e));
    } finally {
      setRouting(false);
    }
  };

  // ── Pin mode: the panel gets out of the way, the crosshair takes over ──
  if (pinning) {
    return (
      <>
        <div className="absolute inset-0 z-[44] pointer-events-none flex items-center justify-center">
          {/* The pin's tip is the point; lift the glyph so it sits on the centre */}
          <MapPin className="w-10 h-10 text-orange-500 fill-orange-500/30 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] -translate-y-5" />
          <div className="absolute w-2 h-2 rounded-full bg-orange-500 border border-white/80" />
        </div>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[44] bg-zinc-900/90 text-white text-xs font-bold px-4 py-2 rounded-full border border-white/10 backdrop-blur-md shadow-xl pointer-events-none" dir="rtl">
          הזז את המפה כך שהנעץ יעמוד על {pinning === 'from' ? 'נקודת המוצא' : 'היעד'}
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

  const ready = !!places.from && !!places.to;

  return (
    <div
      className={`absolute left-4 right-4 z-40 flex flex-col md:w-[380px] md:bottom-auto md:right-6 md:left-auto md:top-6 bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl transition-all
        ${isExpanded ? 'bottom-16 rounded-3xl p-5 max-h-[70vh]' : 'bottom-16 rounded-2xl p-4 md:rounded-3xl md:p-5'}`}
      dir="rtl"
    >
      <div className="flex justify-between items-center cursor-pointer md:cursor-default" onClick={() => setIsExpanded(!isExpanded)}>
        <h2 className="font-extrabold text-white flex items-center gap-2 tracking-tight text-lg md:text-xl md:mb-4">
          <Car className="text-orange-500" size={24} />
          נסיעה בכביש
        </h2>
      </div>

      <div className={`flex-col gap-3 md:flex ${isExpanded ? 'flex mt-3 md:mt-0' : 'hidden'}`}>
        <PlaceField
          label="מוצא"
          value={places.from}
          map={map}
          onChange={(p) => setPlace('from', p)}
          onPin={() => setPinning('from')}
        />
        <div className="flex justify-center -my-1">
          <button onClick={swap} className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 transition-colors" title="החלף בין מוצא ליעד">
            <ArrowLeftRight className="w-4 h-4 rotate-90" />
          </button>
        </div>
        <PlaceField
          label="יעד"
          value={places.to}
          map={map}
          onChange={(p) => setPlace('to', p)}
          onPin={() => setPinning('to')}
        />

        {error && (
          <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 leading-relaxed">{error}</div>
        )}

        <button
          onClick={calculate}
          disabled={!ready || routing}
          className="flex items-center justify-center gap-2 bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-400 text-white text-sm font-bold px-4 py-3 rounded-2xl shadow-lg hover:bg-orange-400 transition-colors mt-1"
        >
          {routing ? <><Loader2 className="w-4 h-4 animate-spin" /> מחשב מסלול…</> : <><Car className="w-4 h-4" /> חשב מסלול</>}
        </button>

        <p className="text-[10px] text-zinc-500 leading-relaxed">
          חיפוש וניווט: Mapbox. אחרי חישוב המסלול אפשר להריץ סיור וירטואלי לאורך הדרך, עד פי 50.
        </p>
      </div>
    </div>
  );
}

// One endpoint: a search box with suggestions, or the picked place with a
// clear button. Suggestions are asked for 300 ms after the last keystroke and
// never for fewer than two characters — each session is billed.
function PlaceField({
  label, value, map, onChange, onPin,
}: {
  label: string;
  value: Place | null;
  map: mapboxgl.Map;
  onChange: (place: Place | null) => void;
  onPin: () => void;
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
        <span className="text-[10px] text-orange-400 font-bold shrink-0">{label}</span>
        <span className="text-sm text-white font-bold truncate flex-1" title={value.name}>{value.name}</span>
        <button onClick={() => onChange(null)} className="p-1 text-zinc-400 hover:text-white transition-colors" aria-label={`נקה ${label}`}>
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" size={16} />
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
            className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pr-9 pl-9 text-sm text-white placeholder:text-zinc-500 font-medium focus:outline-none focus:border-orange-500/50 focus:bg-white/10 transition-colors"
          />
          {searching && <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 animate-spin" size={16} />}
        </div>
        <button
          onClick={onPin}
          className="shrink-0 p-2.5 rounded-xl bg-white/5 border border-white/10 text-orange-400 hover:bg-white/10 transition-colors"
          title="בחר נקודה על המפה"
          aria-label={`בחר ${label} על המפה`}
        >
          <MapPin size={18} />
        </button>
      </div>

      {failed && <div className="text-[11px] text-amber-300 mt-1 px-1">{failed}</div>}

      {open && suggestions.length > 0 && (
        <div className="absolute top-full mt-1 right-0 left-0 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          {suggestions.map((s) => (
            <button
              key={s.mapboxId}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="w-full text-right px-4 py-2.5 text-sm text-zinc-200 hover:bg-white/10 hover:text-orange-400 transition-colors flex flex-col gap-0.5"
            >
              <span className="font-bold">{s.name}</span>
              {s.placeFormatted && <span className="text-[10px] text-zinc-500 font-bold">{s.placeFormatted}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
