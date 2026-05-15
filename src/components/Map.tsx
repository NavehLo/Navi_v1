"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

export default function MapComponent({ onMapLoad }: { onMapLoad?: (map: mapboxgl.Map) => void }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  const [needsToken, setNeedsToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [mapError, setMapError] = useState<string | null>(null);

  const initMap = (token: string) => {
    if (!mapContainer.current || mapRef.current) return;

    try {
      mapboxgl.accessToken = token;
    } catch (e) {
      setMapError("Token שגוי");
      return;
    }

    try {
      if (mapboxgl.getRTLTextPluginStatus() === "unavailable") {
        mapboxgl.setRTLTextPlugin(
          "https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.3.0/mapbox-gl-rtl-text.js",
          () => {},
          true
        );
      }
    } catch (_) {}

    let mapInstance: mapboxgl.Map;
    try {
      mapInstance = new mapboxgl.Map({
        container: mapContainer.current,
        style: "mapbox://styles/mapbox/satellite-streets-v12",
        center: [34.8516, 31.0461],
        zoom: 6,
        pitch: 0,
        attributionControl: false,
        // Disable heavy features upfront — added after load
        antialias: false,
      });
    } catch (e: any) {
      setMapError("לא ניתן לאתחל את המפה: " + (e?.message || "בדוק את ה-Token"));
      localStorage.removeItem("mapbox_token");
      setNeedsToken(true);
      return;
    }

    mapRef.current = mapInstance;

    // Notify parent IMMEDIATELY so GPXLoader appears
    if (onMapLoad) onMapLoad(mapInstance);

    mapInstance.on("style.load", () => {
      try {
        if (!mapInstance.getSource("mapbox-dem")) {
          mapInstance.addSource("mapbox-dem", {
            type: "raster-dem",
            url: "mapbox://mapbox.mapbox-terrain-dem-v1",
            tileSize: 512,
            maxzoom: 14,
          });
        }
        mapInstance.setTerrain({ source: "mapbox-dem", exaggeration: 1.8 });

        if (!mapInstance.getLayer("sky")) {
          mapInstance.addLayer({
            id: "sky",
            type: "sky",
            paint: {
              "sky-type": "atmosphere",
              "sky-atmosphere-sun": [0.0, 0.0],
              "sky-atmosphere-sun-intensity": 15,
            },
          });
        }

        mapInstance.setFog({
          range: [0.5, 10],
          color: "#a8c8e8",
          "horizon-blend": 0.1,
        });
      } catch (_) {
        // 3D features not supported — that's OK, 2D works fine
      }
    });

    mapInstance.on("error", (e) => {
      console.error("Mapbox error:", e);
      // If we get a 401 / unauthorized error, clear the token and ask again
      if ((e.error as any)?.status === 401 || String(e.error?.message).includes("401")) {
        localStorage.removeItem("mapbox_token");
        mapInstance.remove();
        mapRef.current = null;
        setMapError("Token לא תקין. אנא הכנס token חדש.");
        setNeedsToken(true);
      }
    });
  };

  useEffect(() => {
    const savedToken = localStorage.getItem("mapbox_token");
    if (!savedToken) {
      setNeedsToken(true);
      return;
    }
    initMap(savedToken);

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTokenSubmit = () => {
    const t = tokenInput.trim();
    if (!t) return;
    localStorage.setItem("mapbox_token", t);
    setNeedsToken(false);
    setMapError(null);
    initMap(t);
  };

  return (
    <div style={{ width: "100%", height: "100%", position: "absolute" }} className="z-0">
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />

      {/* Token input overlay — no window.prompt, works on all devices */}
      {(needsToken || mapError) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm" style={{ zIndex: 9999 }}>
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-8 max-w-sm w-full mx-4 flex flex-col gap-4">
            <h2 className="text-white font-bold text-lg text-center">Mapbox Access Token</h2>
            {mapError && (
              <div className="text-red-300 text-sm text-center bg-red-900/40 border border-red-700/50 px-3 py-2 rounded-xl">
                {mapError}
              </div>
            )}
            <p className="text-zinc-400 text-sm text-center">
              הכנס Mapbox token להפעלת המפה.
              ניתן לקבל ב-<span className="text-orange-400">mapbox.com</span>
            </p>
            <input
              type="text"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleTokenSubmit()}
              placeholder="pk.eyJ1..."
              className="w-full bg-zinc-800 border border-white/10 rounded-lg px-3 py-2 text-white text-sm placeholder:text-zinc-600 focus:outline-none focus:border-orange-500"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              onClick={handleTokenSubmit}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-bold py-2.5 rounded-lg transition-colors"
            >
              אישור
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
