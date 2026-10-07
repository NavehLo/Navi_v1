import { useCallback, useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Search, X, Loader2, MapPin, Building2, Globe2, Trees, Waves, Mountain, Landmark, Binoculars, Route,
} from 'lucide-react';
import {
  newSessionToken, suggestPlacesAndPois, retrievePlace,
  type Place, type PlaceCategory, type PlaceSuggestion,
} from '../lib/mapboxSearch';
import { describeSearchOrDirectionsError } from '../lib/mapboxDirections';
import { nameMatches, normalizeName } from '../lib/osmPlaces';
import { groupLabel } from '../lib/waymarked';
import { latinName } from '../lib/trailNames';
import { countryName, searchWorldTrails, translateWorldTrails, type WorldTrailHit } from '../lib/worldTrailSearch';

// "Where do I want to look?" — a country, a city, a nature reserve, a wadi —
// answered by moving the map there. It is the home screen's own search, and it
// stays out of the way of the panel that lists trails: this one chooses the
// part of the world, that one chooses the walk in it.
//
// It has nothing to say once a trail is open, so the home screen unmounts it
// there and the marker goes with it.
//
// On the trails screen it also finds the marked routes of the world trails
// layer by name — in their own language, or in English where the name is in
// a script the reader may not read. Picking one opens its card, the same card
// a tap on the route opens.

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

// Each half of the answer gets this many rows when both have something to say.
const PER_SECTION = 5;

type Item =
  | { kind: 'place'; key: string; s: PlaceSuggestion }
  | { kind: 'trail'; key: string; t: WorldTrailHit };

// Places first, unless the query looks like it was a trail's name: a trail
// matches it and no place starts with it. "Menal" is the Menalon Trail and no
// town; "תל" is Tel Aviv before it is any trail through a tel.
function orderItems(places: PlaceSuggestion[], trails: WorldTrailHit[], english: Record<number, string>, query: string): Item[] {
  const p: Item[] = places
    .slice(0, trails.length ? PER_SECTION : undefined)
    .map((s) => ({ kind: 'place', key: s.mapboxId, s }));
  const t: Item[] = trails
    .slice(0, places.length ? PER_SECTION : undefined)
    .map((h) => ({ kind: 'trail', key: `wmt:${h.id}`, t: h }));
  const q = normalizeName(query);
  const placeStarts = places.some((s) => normalizeName(s.name).startsWith(q));
  const trailMatches = trails.some((h) => nameMatches(h.name ?? '', query) || nameMatches(h.name_en ?? english[h.id] ?? '', query));
  return trailMatches && !placeStarts ? [...t, ...p] : [...p, ...t];
}

export default function PlaceSearchBox({
  map,
  className = '',
  onPickTrail,
  accessory,
}: {
  map: mapboxgl.Map;
  className?: string;
  // A button at the empty box's end (the history of trails looked at), where
  // the clear button goes once something is typed.
  accessory?: React.ReactNode;
  // Given only where trails are what is being looked for; without it the box
  // finds places alone.
  onPickTrail?: (trail: WorldTrailHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [trails, setTrails] = useState<WorldTrailHit[]>([]);
  const [english, setEnglish] = useState<Record<number, string>>({});
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placesBusy, setPlacesBusy] = useState(false);
  const [trailsBusy, setTrailsBusy] = useState(false);
  const searching = placesBusy || trailsBusy;
  const [failed, setFailed] = useState<string | null>(null);
  // What the box shows once something is picked: a place (with its pin) or a trail.
  const [selected, setSelected] = useState<{ name: string } | null>(null);
  const searchTrails = !!onPickTrail;

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
  // Mapbox bills a search session, and the OSM geocoder and Waymarked Trails
  // are somebody's good will. Places and trails are asked together and each
  // half shows as soon as it is in; a slow one does not hold the other back.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => {
      setFailed(null);
      setPlacesBusy(true);
      (async () => {
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
          if (!controller.signal.aborted) setPlacesBusy(false);
        }
      })();

      if (!searchTrails) return;
      setTrailsBusy(true);
      (async () => {
        try {
          const hits = await searchWorldTrails(q, controller.signal);
          if (controller.signal.aborted) return;
          setTrails(hits);
          setHighlight(0);
          setOpen(true);
          // English names the server did not have yet arrive after the list,
          // and slot into it.
          const missing = hits.filter((h) => h.needs_en && !h.name_en).map((h) => h.id);
          if (missing.length) {
            translateWorldTrails(missing).then((names) => {
              if (names.size) setEnglish((prev) => ({ ...prev, ...Object.fromEntries(names) }));
            });
          }
        } catch {
          // Aborted by the next keystroke.
        } finally {
          if (!controller.signal.aborted) setTrailsBusy(false);
        }
      })();
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, map, searchTrails]);

  const items = orderItems(suggestions, trails, english, query);

  const pick = useCallback(async (s: PlaceSuggestion) => {
    // A trail search still on its way must not reopen the list over the pick.
    abortRef.current?.abort();
    setTrailsBusy(false);
    setOpen(false);
    setPlacesBusy(true);
    setFailed(null);
    try {
      const place = await retrievePlace(s, sessionRef.current);
      setSelected(place);
      setQuery('');
      setSuggestions([]);
      setTrails([]);
      goTo(place, s.category);
    } catch (e) {
      setFailed(describeSearchOrDirectionsError(e));
    } finally {
      setPlacesBusy(false);
      // A retrieve closes the billing session; the next search opens a new one.
      sessionRef.current = newSessionToken();
    }
  }, [goTo]);

  // The map goes to the trail and its card opens (onPickTrail); the box keeps
  // its name so it is clear what was picked. No pin — the route is drawn.
  const pickTrail = useCallback((t: WorldTrailHit) => {
    abortRef.current?.abort();
    setOpen(false);
    setPlacesBusy(false);
    setTrailsBusy(false);
    clearMarker();
    setSelected({ name: t.name ?? `מסלול ${t.id}` });
    setQuery('');
    setSuggestions([]);
    setTrails([]);
    onPickTrail?.(t);
  }, [clearMarker, onPickTrail]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'place') pick(item.s);
    else pickTrail(item.t);
  };

  const clear = useCallback(() => {
    setSelected(null);
    setQuery('');
    setSuggestions([]);
    setTrails([]);
    setFailed(null);
    clearMarker();
  }, [clearMarker]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => (i + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((i) => (i - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[highlight] ?? items[0]); }
  };

  const label = searchTrails ? 'חפש מקום או מסלול' : 'חפש מקום או נקודת עניין';
  const bothKinds = suggestions.length > 0 && trails.length > 0;

  return (
    <div className={`absolute z-[45] ${className}`} dir="rtl" data-tour="search">
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-300 pointer-events-none" size={16} />
        <input
          type="text"
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls={LIST_ID}
          aria-label={label}
          value={selected ? selected.name : query}
          readOnly={!!selected}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Emptying the box takes the old answers with it, rather than
            // leaving them under a query that no longer asks for them.
            if (e.target.value.trim().length < 2) {
              setSuggestions([]); setTrails([]); setPlacesBusy(false); setTrailsBusy(false);
            }
          }}
          onFocus={() => { if (!selected) { setOpen(true); if (!query) sessionRef.current = newSessionToken(); } }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder={label}
          className={`w-full bg-black/80 backdrop-blur-xl border rounded-2xl py-2.5 pr-9 pl-9 text-sm text-white placeholder:text-zinc-300 font-medium shadow-2xl focus:outline-none transition-colors
            ${selected ? 'border-orange-500/60 font-bold cursor-default' : 'border-white/10 focus:border-orange-500/50'}`}
        />
        {searching && <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 animate-spin" size={16} />}
        {!searching && (selected || query) && (
          <button
            type="button"
            onClick={clear}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 hover:text-white transition-colors"
            aria-label="נקה חיפוש"
          >
            <X size={16} />
          </button>
        )}
        {!searching && !selected && !query && accessory}
      </div>

      {failed && (
        <div className="mt-1 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 leading-relaxed backdrop-blur-md">
          {failed}
        </div>
      )}

      {open && items.length > 0 && (
        <div
          id={LIST_ID}
          role="listbox"
          className="absolute top-full mt-1 right-0 left-0 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-[50vh] overflow-y-auto overscroll-contain"
        >
          {items.map((item, i) => {
            // A heading where the list turns from one kind to the other.
            const heading = bothKinds && (i === 0 || items[i - 1].kind !== item.kind)
              ? (item.kind === 'trail' ? 'מסלולים מסומנים' : 'מקומות')
              : null;
            const active = i === highlight;
            const row = item.kind === 'place'
              ? <PlaceRow s={item.s} />
              : <TrailRow t={item.t} english={latinName(item.t.name, item.t.name_en ?? english[item.t.id], item.t.countries?.[0])} />;
            return (
              <div key={item.key}>
                {heading && (
                  <div className="px-3 pt-2 pb-1 text-xs font-bold text-orange-300 border-t border-white/10 first:border-t-0">
                    {heading}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(item)}
                  className={`w-full text-right px-3 py-2.5 text-sm transition-colors flex items-center gap-2.5 ${active ? 'bg-white/10 text-orange-400' : 'text-white'}`}
                >
                  {row}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PlaceRow({ s }: { s: PlaceSuggestion }) {
  const Icon = ICONS[s.category] ?? MapPin;
  return (
    <>
      <Icon className="shrink-0 text-orange-500/80" size={16} />
      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="font-bold truncate">{s.name}</span>
        {s.placeFormatted && (
          <span className="text-xs text-zinc-200 font-medium truncate">{s.placeFormatted}</span>
        )}
      </span>
    </>
  );
}

function TrailRow({ t, english }: { t: WorldTrailHit; english: string | null }) {
  return (
    <>
      <Route className="shrink-0 text-orange-500/80" size={16} />
      <span className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="font-bold truncate">{t.name ?? `מסלול ${t.id}`}</span>
        {english && (
          <span className="text-xs text-sky-200 font-semibold truncate" dir="ltr" style={{ textAlign: 'right' }}>
            {english}
          </span>
        )}
        {/* Where it is, first: of two routes with one name, the country is
            what tells them apart. */}
        <span className="text-xs text-zinc-200 font-medium truncate">
          {t.countries?.length > 0 && (
            <span className="text-white font-bold">{t.countries.map(countryName).join(' · ')}</span>
          )}
          {t.countries?.length > 0 && ' · '}
          {groupLabel(t.group)}
        </span>
      </span>
    </>
  );
}
