import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Search, X, Loader2, MapPin, Building2, Globe2, Trees, Waves, Mountain, Landmark, Binoculars,
} from 'lucide-react';
import {
  newSessionToken, suggestPlacesAndPois, retrievePlace,
  type Place, type PlaceCategory, type PlaceSuggestion,
} from '../lib/mapboxSearch';
import { describeSearchOrDirectionsError } from '../lib/mapboxDirections';

// "Where do I want to look?" — a country, a city, a nature reserve, a wadi —
// answered by moving the map there. It is the home screen's own search, and it
// stays out of the way of the panel that lists trails: this one chooses the
// part of the world, that one chooses the walk in it.
//
// It has nothing to say once a trail is open, so the home screen unmounts it
// there and the marker goes with it.

const ICONS: Record<PlaceCategory, typeof MapPin> = {
  settlement: Building2,
  region: Globe2,
  park: Trees,
  water: Waves,
  summit: Mountain,
  heritage: Landmark,
  viewpoint: Binoculars,
  address: MapPin,
  other: MapPin,
};

// How close to go when the place is a point and nothing says how big it is.
const ZOOM: Partial<Record<PlaceCategory, number>> = {
  region: 6,
  settlement: 11,
  park: 13,
  water: 13,
  summit: 13,
};

// A bounding box is only worth framing if it has some size to it; OSM gives a
// single-node spring an extent of nothing at all.
function usableBbox(place: Place): [number, number, number, number] | null {
  const b = place.bbox;
  if (!b) return null;
  const [west, south, east, north] = b;
  return east - west > 1e-4 && north - south > 1e-4 ? b : null;
}

const LIST_ID = 'place-search-suggestions';

export default function PlaceSearchBox({
  map,
  className = '',
}: {
  map: mapboxgl.Map;
  className?: string;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<Place | null>(null);

  const sessionRef = useRef<string>(newSessionToken());
  const abortRef = useRef<AbortController | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);

  // The marker is a DOM overlay, so it survives a change of map style and only
  // ever needs taking down when the search is cleared or the box goes away.
  const clearMarker = useCallback(() => {
    markerRef.current?.remove();
    markerRef.current = null;
  }, []);
  useEffect(() => clearMarker, [clearMarker]);

  const goTo = useCallback((place: Place, category: PlaceCategory) => {
    clearMarker();
    markerRef.current = new mapboxgl.Marker({ color: '#f97316' })
      .setLngLat([place.lon, place.lat])
      .addTo(map);

    const bbox = usableBbox(place);
    if (bbox) {
      map.fitBounds(bbox, { padding: 80, maxZoom: 14, duration: 1200 });
    } else {
      map.easeTo({ center: [place.lon, place.lat], zoom: ZOOM[category] ?? 12, duration: 1200 });
    }
  }, [map, clearMarker]);

  // Suggestions 300 ms after the last keystroke, never under two characters —
  // Mapbox bills a search session, and the OSM geocoder is somebody's
  // good will.
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
        const list = await suggestPlacesAndPois(q, sessionRef.current, [c.lng, c.lat], controller.signal);
        if (controller.signal.aborted) return;
        setSuggestions(list);
        setHighlight(0);
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

  const pick = useCallback(async (s: PlaceSuggestion) => {
    setOpen(false);
    setSearching(true);
    setFailed(null);
    try {
      const place = await retrievePlace(s, sessionRef.current);
      setSelected(place);
      setQuery('');
      setSuggestions([]);
      goTo(place, s.category);
    } catch (e) {
      setFailed(describeSearchOrDirectionsError(e));
    } finally {
      setSearching(false);
      // A retrieve closes the billing session; the next search opens a new one.
      sessionRef.current = newSessionToken();
    }
  }, [goTo]);

  const clear = useCallback(() => {
    setSelected(null);
    setQuery('');
    setSuggestions([]);
    setFailed(null);
    clearMarker();
  }, [clearMarker]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => (i + 1) % suggestions.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(suggestions[highlight] ?? suggestions[0]); }
  };

  return (
    <div className={`absolute z-[45] ${className}`} dir="rtl">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" size={16} />
        <input
          type="text"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={LIST_ID}
          aria-label="חפש מקום או נקודת עניין"
          value={selected ? selected.name : query}
          readOnly={!!selected}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Emptying the box takes the old answers with it, rather than
            // leaving them under a query that no longer asks for them.
            if (e.target.value.trim().length < 2) { setSuggestions([]); setSearching(false); }
          }}
          onFocus={() => { if (!selected) { setOpen(true); if (!query) sessionRef.current = newSessionToken(); } }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="חפש מקום או נקודת עניין"
          className={`w-full bg-black/80 backdrop-blur-xl border rounded-2xl py-2.5 pr-9 pl-9 text-sm text-white placeholder:text-zinc-500 font-medium shadow-2xl focus:outline-none transition-colors
            ${selected ? 'border-orange-500/60 font-bold cursor-default' : 'border-white/10 focus:border-orange-500/50'}`}
        />
        {searching && <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 animate-spin" size={16} />}
        {!searching && (selected || query) && (
          <button
            type="button"
            onClick={clear}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white transition-colors"
            aria-label="נקה חיפוש"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {failed && (
        <div className="mt-1 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 leading-relaxed backdrop-blur-md">
          {failed}
        </div>
      )}

      {open && suggestions.length > 0 && (
        <div
          id={LIST_ID}
          role="listbox"
          className="absolute top-full mt-1 right-0 left-0 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-[50vh] overflow-y-auto overscroll-contain"
        >
          {suggestions.map((s, i) => {
            const Icon = ICONS[s.category] ?? MapPin;
            return (
              <button
                key={s.mapboxId}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(s)}
                className={`w-full text-right px-3 py-2.5 text-sm transition-colors flex items-center gap-2.5 ${i === highlight ? 'bg-white/10 text-orange-400' : 'text-zinc-200'}`}
              >
                <Icon className="shrink-0 text-orange-500/80" size={16} />
                <span className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span className="font-bold truncate">{s.name}</span>
                  {s.placeFormatted && (
                    <span className="text-[10px] text-zinc-500 font-bold truncate">{s.placeFormatted}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
