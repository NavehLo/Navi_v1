"use client";

import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from "react";
import mapboxgl from "mapbox-gl";
import MapComponent from "@/components/Map";
import StatsPanel from "@/components/StatsPanel";
import TrailDiscovery from "@/components/TrailDiscovery";
import Controls from "@/components/Controls";
import AIAssistantUI from "@/components/AIAssistantUI";
import SettingsPanel from "@/components/SettingsPanel";
import PersonalArea from "@/components/PersonalArea";
import { useTrailData } from "@/hooks/useTrailData";
import { useTour } from "@/hooks/useTour";
import { useAIGuide } from "@/hooks/useAIGuide";
import { usePOIGeofence } from "@/hooks/usePOIGeofence";
import { useAuth } from "@/hooks/useAuth";
import { saveTrail, recordTour, SavedTrail } from "@/lib/personalArea";

const MemoizedMapComponent = memo(MapComponent);
const MemoizedTrailDiscovery = memo(TrailDiscovery);
const MemoizedStatsPanel = memo(StatsPanel);
const MemoizedControls = memo(Controls);

// ── Token Gate ────────────────────────────────────────────────────────────────
function TokenGate({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    const t = localStorage.getItem("mapbox_token");
    if (t) setToken(t);
  }, []);

  if (token) return <>{children}</>;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-zinc-950" style={{ zIndex: 99999 }}>
      <div className="bg-zinc-900 border border-white/10 rounded-2xl p-8 max-w-sm w-full mx-4 flex flex-col gap-4">
        <h2 className="text-white font-bold text-xl text-center">Mapbox Access Token</h2>
        <p className="text-zinc-400 text-sm text-center">
          הכנס Mapbox token להפעלת המפה.<br />
          <span className="text-orange-400">mapbox.com → Account → Tokens</span>
        </p>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              const t = input.trim();
              if (!t) return;
              localStorage.setItem("mapbox_token", t);
              setToken(t);
            }
          }}
          placeholder="pk.eyJ1..."
          className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-3 text-white text-sm placeholder:text-zinc-600 focus:outline-none focus:border-orange-500"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          onClick={() => {
            const t = input.trim();
            if (!t) return;
            localStorage.setItem("mapbox_token", t);
            setToken(t);
          }}
          className="w-full bg-orange-500 text-white font-bold py-3 rounded-xl text-base"
        >
          אישור
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function TrailApp() {
  const [map, setMap] = useState<mapboxgl.Map | null>(null);
  const [is3D, setIs3D] = useState(true);
  const [mapBearing, setMapBearing] = useState(0);
  const [styleRev, setStyleRev] = useState(0);
  
  const { trail, setTrail, trailSource, loadTrailFile, loadTrailFromUrl, loadTrailFromText, trailError, trailLoading } = useTrailData();
  const { isActive: isTourActive, startTour, stopTour, speed: tourSpeed, setSpeed: setTourSpeed, progress, setProgressByJump } = useTour(map, trail);
  const { requestGuideForPoint, unlockAudio, isSpeaking, isLoading, currentScript, stopSpeaking } = useAIGuide();

  // Real GPS "field mode": continuous tracking that feeds the POI geofence
  const [isFieldMode, setIsFieldMode] = useState(false);
  const [gpsPos, setGpsPos] = useState<{ lat: number; lon: number } | null>(null);

  // Auth + personal area + settings
  const { user, signInWithGoogle, signOut, isAuthAvailable } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [showPersonalArea, setShowPersonalArea] = useState(false);
  const [saveTrailState, setSaveTrailState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Reset the save indicator whenever a different trail loads
  useEffect(() => {
    setSaveTrailState('idle');
  }, [trail?.name]);

  const handleSaveTrail = useCallback(async () => {
    if (!trail || !user) return;
    setSaveTrailState('saving');
    try {
      await saveTrail({
        name: trail.name,
        sourceUrl: trailSource?.kind === 'url' ? trailSource.url : null,
        sourceContent: trailSource?.kind === 'file' ? trailSource.content : null,
        totalDistance: trail.totalDistance,
      });
      setSaveTrailState('saved');
    } catch (e) {
      console.error('Save trail failed:', e);
      alert('שגיאה בשמירת המסלול. ודא שהרצת את קובץ הסכמה ב-Supabase.');
      setSaveTrailState('idle');
    }
  }, [trail, user, trailSource]);

  const handleLoadSavedTrail = useCallback((saved: SavedTrail) => {
    setShowPersonalArea(false);
    if (saved.source_url) {
      loadTrailFromUrl(saved.source_url, saved.name);
    } else if (saved.source_content) {
      loadTrailFromText(saved.source_content, saved.name);
    } else {
      alert('למסלול השמור אין מקור לטעינה.');
    }
  }, [loadTrailFromUrl, loadTrailFromText]);

  // Record a completed virtual tour in the personal history (once per trail load)
  const tourRecordedRef = useRef(false);
  useEffect(() => {
    tourRecordedRef.current = false;
  }, [trail?.name]);
  useEffect(() => {
    if (!user || !trail || tourRecordedRef.current) return;
    if (progress >= 0.995) {
      tourRecordedRef.current = true;
      recordTour({
        trailName: trail.name,
        distanceKm: trail.totalDistance,
        completedPct: 100,
        mode: 'virtual',
      }).catch((e) => console.error('Tour history record failed:', e));
    }
  }, [progress, user, trail]);

  // Virtual position of the tour camera, interpolated from progress
  // (index-based, mirroring the progress-bar jump logic below)
  const virtualPos = useMemo(() => {
    if (!trail || !isTourActive) return null;
    const n = trail.coords.length - 1;
    if (n < 1) return null;
    const fi = Math.min(progress * n, n);
    const lo = Math.floor(fi), hi = Math.min(lo + 1, n), frac = fi - lo;
    const c1 = trail.coords[lo], c2 = trail.coords[hi];
    return { lat: c1[0] + (c2[0] - c1[0]) * frac, lon: c1[1] + (c2[1] - c1[1]) * frac };
  }, [trail, isTourActive, progress]);

  // During a virtual tour the camera is the "traveler"; in field mode it's the real GPS
  const guidePos = isTourActive ? virtualPos : (isFieldMode ? gpsPos : null);

  const { reset: resetGeofence } = usePOIGeofence(
    trail,
    guidePos,
    (poi) => requestGuideForPoint(poi.coord, poi.type, `${trail!.name}:${poi.index}`),
    { enabled: isTourActive || isFieldMode }
  );

  const handleMapLoad = useCallback((initializedMap: mapboxgl.Map) => {
    setMap(initializedMap);
    // Track bearing for compass rotation
    initializedMap.on('rotate', () => setMapBearing(initializedMap.getBearing()));
  }, []);

  // Handle Android/Smartphone back button
  useEffect(() => {
    if (trail) {
      // Add a history entry when a trail becomes active
      window.history.pushState({ trailLoaded: true }, "");
    }
  }, [trail]);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (trail) {
        const confirmExit = window.confirm("האם ברצונך לצאת ממפת המסלול ולחזור למסך הבית?");
        if (confirmExit) {
          setTrail(null);
        } else {
          // Push state again to keep them on the trail
          window.history.pushState({ trailLoaded: true }, "");
        }
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [trail, setTrail]);

  const handleStyleChange = useCallback((styleKey: string) => {
    if (!map) return;
    const styleUrl = styleKey === 'satellite' ? 'mapbox://styles/mapbox/satellite-streets-v12' :
                     styleKey === 'terrain' ? 'mapbox://styles/mapbox/outdoors-v12' :
                     'mapbox://styles/mapbox/light-v11';
    map.setStyle(styleUrl);
    map.once('style.load', () => setStyleRev(r => r + 1));
  }, [map]);

  const handleToggle3D = useCallback(() => {
    if (!map) return;
    setIs3D(!is3D);
    if (!is3D) {
      map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.8 });
      map.easeTo({ pitch: 60, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, duration: 800 });
    }
  }, [map, is3D]);

  const updateUserLocLayer = useCallback((longitude: number, latitude: number) => {
    if (!map) return;
    if (!map.getSource("user-loc")) {
      map.addSource("user-loc", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [longitude, latitude] } }
      });
      map.addLayer({
        id: "user-loc-dot", type: "circle", source: "user-loc",
        paint: { "circle-radius": 8, "circle-color": "#38bdf8", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 }
      });
    } else {
      (map.getSource("user-loc") as mapboxgl.GeoJSONSource).setData({
        type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [longitude, latitude] }
      });
    }
  }, [map]);

  const handleLocateUser = useCallback(() => {
    if (!navigator.geolocation || !map) {
      alert("הדפדפן שלך לא תומך באיתור מיקום");
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { longitude, latitude } = pos.coords;
      updateUserLocLayer(longitude, latitude);
      map.easeTo({ center: [longitude, latitude], zoom: 14, duration: 1500 });
    }, (err) => {
      alert("שגיאה באיתור מיקום: " + err.message);
    });
  }, [map, updateUserLocLayer]);

  // Field mode: continuous GPS tracking via watchPosition
  useEffect(() => {
    if (!isFieldMode) {
      setGpsPos(null);
      return;
    }
    if (!navigator.geolocation) {
      alert("הדפדפן שלך לא תומך באיתור מיקום");
      setIsFieldMode(false);
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { longitude, latitude } = pos.coords;
        setGpsPos({ lat: latitude, lon: longitude });
        updateUserLocLayer(longitude, latitude);
      },
      (err) => {
        alert("שגיאה באיתור מיקום: " + err.message);
        setIsFieldMode(false);
      },
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [isFieldMode, updateUserLocLayer]);

  const handleToggleFieldMode = useCallback(() => {
    setIsFieldMode(prev => {
      if (!prev) unlockAudio(); // toggle-on is a user gesture — unlock audio for TTS
      return !prev;
    });
  }, [unlockAudio]);

  const handleZoomIn = useCallback(() => map?.zoomIn(), [map]);
  const handleZoomOut = useCallback(() => map?.zoomOut(), [map]);
  const handleCompass = useCallback(() => map?.easeTo({ bearing: 0, pitch: map.getPitch(), duration: 800 }), [map]);
  const handleFitToTrail = useCallback(() => {
    if (!map || !trail) return;
    const lons = trail.coords.map(c => c[1]);
    const lats = trail.coords.map(c => c[0]);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, duration: 1200, pitch: 45 }
    );
  }, [map, trail]);

  // Render trail cleanly via useEffect to avoid rendering phase side-effects
  const currentTrailIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!map || !trail) return;

    const addTrailLayers = () => {
      // Remove previous layers/sources if they exist
      if (map.getLayer('route-line')) map.removeLayer('route-line');
      if (map.getSource('route')) map.removeSource('route');
      if (map.getLayer('fly-ring')) map.removeLayer('fly-ring');
      if (map.getLayer('fly-dot')) map.removeLayer('fly-dot');
      if (map.getSource('fly-pos')) map.removeSource('fly-pos');

      const geoJson = trail.geoJson;
      
      map.addSource('route', { type: 'geojson', data: geoJson as any });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#f97316', 'line-width': 6 }
      });

      map.addSource('fly-pos', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [trail.start![1], trail.start![0], trail.start![2] || 0] } }
      });
      map.addLayer({ id: 'fly-ring', type: 'circle', source: 'fly-pos',
        paint: { 'circle-radius': 12, 'circle-color': 'rgba(249,115,22,0.25)', 'circle-stroke-color': '#f97316', 'circle-stroke-width': 2 }
      });
      map.addLayer({ id: 'fly-dot', type: 'circle', source: 'fly-pos',
        paint: { 'circle-radius': 6, 'circle-color': '#f97316' }
      });

      // Fit bounds to the new trail so it shows on screen fully ONLY IF IT IS NEW
      if (currentTrailIdRef.current !== trail.name) {
        currentTrailIdRef.current = trail.name || "temp";
        const bounds = new mapboxgl.LngLatBounds();
        trail.coords.forEach(c => bounds.extend([c[1], c[0]]));
        map.fitBounds(bounds, { padding: 80, duration: 1500, pitch: 45 });
      }
    };

    const tryAddLayers = () => {
      try {
        if (map.getStyle() && !map.getSource('route')) {
          addTrailLayers();
        }
      } catch (e) {
        // Style not fully parsed yet, will retry on style.load
      }
    };

    tryAddLayers();
    map.on('style.load', tryAddLayers);

    return () => {
      map.off('style.load', tryAddLayers);
      // Cleanup layers when trail changes or unmounts
      if (map) {
        try {
          if (map.isStyleLoaded()) {
            if (map.getLayer('route-line')) map.removeLayer('route-line');
            if (map.getSource('route')) map.removeSource('route');
            if (map.getLayer('fly-ring')) map.removeLayer('fly-ring');
            if (map.getLayer('fly-dot')) map.removeLayer('fly-dot');
            if (map.getSource('fly-pos')) map.removeSource('fly-pos');
          }
        } catch(e) {}
      }
    };
  }, [map, trail, styleRev]);

  return (
    <div className="w-full h-screen relative bg-zinc-900 overflow-hidden m-0 p-0 select-none touch-none" dir="rtl">
      {/* Map Engine Layer */}
      <MemoizedMapComponent onMapLoad={handleMapLoad} />

      {/* Trail Discovery overlay with markers & GPX upload fallback */}
      {map && !trail && (
        <MemoizedTrailDiscovery 
          map={map} 
          onSelectTrail={loadTrailFromUrl} 
          onFileLoad={loadTrailFile} 
          loading={trailLoading} 
          error={trailError} 
          styleRev={styleRev}
        />
      )}

      {/* Stats UI Layer */}
      {trail && (
        <MemoizedStatsPanel trail={trail} progress={progress} onClose={() => setTrail(null)} isTourActive={isTourActive} />
      )}

      {/* Map Controls */}
      <MemoizedControls 
        onStyleChange={handleStyleChange}
        onToggle3D={handleToggle3D}
        is3D={is3D}
        onToggleTour={() => {
          if (isTourActive) {
            stopTour();
          } else {
            unlockAudio(); // first user gesture unlocks audio for auto-narration
            if (progress === 0 || progress >= 1) resetGeofence();
            startTour();
          }
        }}
        isTourActive={isTourActive}
        tourSpeed={tourSpeed}
        onTourSpeedChange={setTourSpeed}
        onLocateUser={handleLocateUser}
        isFieldMode={isFieldMode}
        onToggleFieldMode={handleToggleFieldMode}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onCompass={handleCompass}
        mapBearing={mapBearing}
        onFitToTrail={handleFitToTrail}
        hasTrail={!!trail}
        onHome={() => setTrail(null)}
        tourProgress={progress}
        onOpenSettings={() => setShowSettings(true)}
        authAvailable={isAuthAvailable}
        isSignedIn={!!user}
        onAuthClick={() => user ? setShowPersonalArea(true) : signInWithGoogle()}
        onSaveTrail={handleSaveTrail}
        saveTrailState={saveTrailState}
      />

      {/* Settings modal */}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {/* Personal area modal */}
      {showPersonalArea && user && (
        <PersonalArea
          user={user}
          onClose={() => setShowPersonalArea(false)}
          onSignOut={() => { signOut(); setShowPersonalArea(false); }}
          onLoadSavedTrail={handleLoadSavedTrail}
        />
      )}

      {/* AI Assistant Overlay */}
      {trail && (
        <AIAssistantUI
          isLoading={isLoading}
          isSpeaking={isSpeaking}
          currentScript={currentScript}
          onStop={stopSpeaking}
          onManualTrigger={() => {
            unlockAudio();
            requestGuideForPoint(trail.pois[0].coord, trail.pois[0].type, `${trail.name}:${trail.pois[0].index}`);
          }}
        />
      )}

      {/* Tour Progress Bar */}
      {trail && progress > 0 && Math.floor(progress * trail.coords.length) < trail.coords.length && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[90%] max-w-lg z-50 bg-black/80 px-4 py-3 rounded-2xl border border-white/10 backdrop-blur-md">
          <div className="flex justify-between text-xs font-bold mb-3" dir="rtl">
            <div className="text-emerald-400">הושלם: {(trail.totalDistance * progress).toFixed(1)} ק"מ <span className="text-emerald-300 font-bold">({Math.round(progress*100)}%)</span></div>
            <div className="text-sky-400">נותר: {(trail.totalDistance * (1 - progress)).toFixed(1)} ק"מ</div>
          </div>
          <div className="text-center text-orange-400 text-[10px] font-bold mb-2 uppercase tracking-widest">
            גובה נוכחי: {Math.round(trail.elevations[Math.floor(progress * (trail.elevations.length - 1))])} מ'
          </div>
          {/* dir=ltr forces correct offsetX math; we flip the visual with scale */}
          <div dir="ltr" className="w-full h-4 bg-zinc-800 rounded-full cursor-pointer relative overflow-hidden" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            // Since we visually flip with scaleX(-1), a click on the right = start = low pct
            const rawPct = ((e.clientX - rect.left) / rect.width) * 100;
            const pct = 100 - rawPct; // flip for RTL visual
            setProgressByJump(pct);
            // Immediately jump camera to the new position
            if (map && trail) {
              const n = trail.coords.length - 1;
              const t = pct / 100;
              const fi = Math.min(t * n, n);
              const lo = Math.floor(fi), hi = Math.min(lo + 1, n);
              const frac = fi - lo;
              const c1 = trail.coords[lo];
              const c2 = trail.coords[hi];
              const jumpPt = [
                c1[0] + (c2[0] - c1[0]) * frac,
                c1[1] + (c2[1] - c1[1]) * frac,
              ];
              map.easeTo({ center: [jumpPt[1], jumpPt[0]], duration: 400 });
            }
          }}>
            {/* scaleX(-1) flips the bar so it fills from right */}
            <div style={{ transform: 'scaleX(-1)', height: '100%' }}>
              <div className="h-full bg-orange-500 shadow-[0_0_8px_#f97316] pointer-events-none transition-all duration-75" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
