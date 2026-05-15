import { useState, useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { MapPin, Loader2, ChevronUp, ChevronDown } from 'lucide-react';
import GPXLoader from './GPXLoader';

export interface TrailInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  region: string;
  startCoord: [number, number];
}

interface TrailDiscoveryProps {
  map: mapboxgl.Map | null;
  onSelectTrail: (url: string, name: string) => void;
  onFileLoad: (file: File) => void;
  loading?: boolean;
  error?: string | null;
  styleRev?: number;
}

export default function TrailDiscovery({ map, onSelectTrail, onFileLoad, loading, error, styleRev }: TrailDiscoveryProps) {
  const [trails, setTrails] = useState<TrailInfo[]>([]);
  const [filterRegion, setFilterRegion] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [showUploader, setShowUploader] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const onSelectTrailRef = useRef(onSelectTrail);
  useEffect(() => {
    onSelectTrailRef.current = onSelectTrail;
  }, [onSelectTrail]);

  useEffect(() => {
    fetch('/trails.json')
      .then(r => r.json())
      .then(data => setTrails(data))
      .catch(err => console.error('Failed to load trails index', err));
  }, []);

  const filteredTrails = useMemo(() => {
    return trails.filter(t => {
      if (filterRegion && t.region !== filterRegion) return false;
      if (filterType && t.type !== filterType) return false;
      return true;
    });
  }, [trails, filterRegion, filterType]);

  const hasFittedBoundsRef = useRef(false);
  const listenersAddedRef = useRef(false);

  // Handle map markers via Mapbox Clustering
  useEffect(() => {
    if (!map) return;

    const sourceId = 'trails-source';
    
    const initClusterLayers = () => {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 50
        });

        map.addLayer({
          id: 'clusters',
          type: 'circle',
          source: sourceId,
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': '#f97316',
            'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 30, 28],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff'
          }
        });

        map.addLayer({
          id: 'cluster-count',
          type: 'symbol',
          source: sourceId,
          filter: ['has', 'point_count'],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 14
          },
          paint: { 'text-color': '#ffffff' }
        });

        map.addLayer({
          id: 'unclustered-point',
          type: 'circle',
          source: sourceId,
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': '#f97316',
            'circle-radius': 8,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#fff'
          }
        });

        if (!listenersAddedRef.current) {
          listenersAddedRef.current = true;
          // Interactions
          map.on('click', 'clusters', (e) => {
            const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
            if (!features.length) return;
            const clusterId = features[0].properties!.cluster_id;
            (map.getSource(sourceId) as mapboxgl.GeoJSONSource).getClusterLeaves(clusterId, 100, 0, (err, leaves) => {
              if (err || !leaves || !leaves.length) return;
              const bounds = new mapboxgl.LngLatBounds();
              leaves.forEach(l => bounds.extend((l.geometry as any).coordinates));
              map.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 1200 });
            });
          });

          map.on('click', 'unclustered-point', (e) => {
            if (!e.features?.length) return;
            const props = e.features[0].properties;
            onSelectTrailRef.current(props!.path, props!.name);
          });

          const hoverPopup = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: false,
            className: 'trail-hover-popup'
          });

          map.on('mouseenter', 'unclustered-point', (e) => {
            map.getCanvas().style.cursor = 'pointer';
            if (!e.features?.length) return;
            const coordinates = (e.features[0].geometry as any).coordinates.slice();
            const props = e.features[0].properties;
            
            while (Math.abs(e.lngLat.lng - coordinates[0]) > 180) {
              coordinates[0] += e.lngLat.lng > coordinates[0] ? 360 : -360;
            }

            const lengthStr = props?.length ? parseFloat(props.length).toFixed(1) : '?';
            const html = `
              <div class="p-3 flex flex-col gap-1.5 items-center bg-zinc-900/95 backdrop-blur-md text-white rounded-2xl shadow-xl border border-white/10" dir="rtl" style="min-width: 160px;">
                <strong class="text-base font-extrabold text-orange-400 text-center leading-tight">${props?.name}</strong>
                <span class="text-xs text-zinc-300 font-bold mt-1 text-center">${props?.type} • ${props?.region}</span>
                <span class="text-sm text-sky-400 font-black">${lengthStr} ק"מ</span>
                <span class="text-[10px] text-zinc-500 mt-1 font-bold uppercase tracking-widest bg-white/5 px-2 py-0.5 rounded-full">לחץ לטעינה</span>
              </div>
            `;
            hoverPopup.setLngLat(coordinates).setHTML(html).addTo(map);
          });

          map.on('mouseleave', 'unclustered-point', () => {
            map.getCanvas().style.cursor = '';
            hoverPopup.remove();
          });

          map.on('mouseenter', 'clusters', () => map.getCanvas().style.cursor = 'pointer');
          map.on('mouseleave', 'clusters', () => map.getCanvas().style.cursor = '');
        }
      }
    };

    const updateDataAndBounds = () => {
      if (!map.getSource(sourceId)) return;

      const features = filteredTrails.map(t => ({
        type: 'Feature',
        properties: { ...t },
        geometry: { type: 'Point', coordinates: t.startCoord }
      }));
      
      (map.getSource(sourceId) as mapboxgl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: features as any
      });

      if (features.length > 0 && !hasFittedBoundsRef.current) {
        hasFittedBoundsRef.current = true;
        const bounds = new mapboxgl.LngLatBounds();
        features.forEach(f => bounds.extend(f.geometry.coordinates as any));
        setTimeout(() => {
          map.fitBounds(bounds, { padding: 60, duration: 1500, maxZoom: 12 });
        }, 300);
      }
    };

    const tryAddLayers = () => {
      try {
        if (map.getStyle() && !map.getSource(sourceId)) {
          initClusterLayers();
        }
        updateDataAndBounds();
      } catch (e) {
        // Style might not be fully parsed yet, will retry on style.load
      }
    };

    tryAddLayers();
    map.on('style.load', tryAddLayers);

    return () => {
      map.off('style.load', tryAddLayers);
      // Clean up lingering popups
      document.querySelectorAll('.trail-hover-popup').forEach(p => p.remove());
      
      // Don't remove layers on unmount, just hide data
      try {
        if (map && map.isStyleLoaded() && map.getSource(sourceId)) {
          (map.getSource(sourceId) as mapboxgl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
        }
      } catch(e) {}
    };
  }, [map, filteredTrails, styleRev]); // eslint-disable-line react-hooks/exhaustive-deps

  if (showUploader) {
    return (
      <>
        <div className="absolute top-6 right-6 z-[60]">
          <button onClick={() => setShowUploader(false)} className="bg-zinc-800 text-white px-5 py-2.5 rounded-full border border-white/10 font-bold hover:bg-zinc-700 transition shadow-lg flex items-center gap-2">
            חזור למאגר המסלולים
          </button>
        </div>
        <GPXLoader onFileLoad={onFileLoad} loading={loading} error={error} />
      </>
    );
  }

  const regions = Array.from(new Set(trails.map(t => t.region)));
  const types = Array.from(new Set(trails.map(t => t.type)));

  return (
    <div className={`absolute left-4 right-4 z-40 flex flex-col md:w-[380px] md:bottom-6 md:right-6 md:left-auto md:top-6 md:max-h-[calc(100vh-3rem)] bg-black/80 backdrop-blur-xl border border-white/10 shadow-2xl transition-all
      ${isExpanded ? 'bottom-16 top-24 rounded-3xl p-5 md:bottom-6' : 'bottom-16 rounded-2xl p-4 md:rounded-3xl md:p-5 md:bottom-6'} 
      `} dir="rtl">
      
      <div 
        className="flex justify-between items-center cursor-pointer md:cursor-default" 
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <h2 className={`font-extrabold text-white flex items-center gap-2 tracking-tight transition-all ${isExpanded ? 'text-xl mb-2 md:mb-5' : 'text-lg md:text-xl md:mb-5'}`}>
          <MapPin className="text-orange-500 fill-orange-500/20" size={24} /> 
          חפש מסלולים
        </h2>
        <button className="md:hidden text-zinc-400 p-1 flex items-center justify-center bg-white/5 rounded-full hover:bg-white/10 transition-colors">
          {isExpanded ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
        </button>
      </div>
      
      <div className={`flex-col gap-4 md:flex overflow-hidden ${isExpanded ? 'flex flex-1 mt-2 md:mt-0' : 'hidden'}`}>
        <div className="flex flex-wrap gap-2 shrink-0">
          {types.map(type => (
            <button
              key={type}
              onClick={() => setFilterType(filterType === type ? null : type)}
              className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all shadow-sm ${filterType === type ? 'bg-orange-500 text-white shadow-orange-500/30' : 'bg-white/5 text-zinc-300 border border-white/10 hover:bg-white/10'}`}
            >
              {type}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0 pb-2 border-b border-white/5">
          {regions.map(region => (
            <button
              key={region}
              onClick={() => setFilterRegion(filterRegion === region ? null : region)}
              className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all border ${filterRegion === region ? 'bg-white/20 text-white border-white/20' : 'bg-transparent text-zinc-400 border-white/10 hover:bg-white/5'}`}
            >
              {region}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar flex flex-col gap-3 min-h-0">
          {filteredTrails.length === 0 ? (
            <div className="text-zinc-500 text-center py-10 text-sm font-medium">לא נמצאו מסלולים. נסה לשנות את הסינון.</div>
          ) : (
            filteredTrails.map(t => (
              <div key={t.id} onClick={() => onSelectTrail(t.path, t.name)} className="bg-white/5 border border-white/5 p-4 rounded-2xl cursor-pointer hover:bg-white/10 hover:border-orange-500/40 transition-all flex justify-between items-center group shadow-sm">
                <div className="flex flex-col gap-1.5">
                  <span className="text-white font-bold text-sm group-hover:text-orange-400 transition-colors">{t.name}</span>
                  <span className="text-[10px] font-bold tracking-wide text-zinc-400 uppercase bg-black/30 w-fit px-2 py-0.5 rounded-md">{t.type} • {t.region}</span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-white/10 text-center">
          <button
            onClick={() => setShowUploader(true)}
            className="shrink-0 w-full mt-2 text-xs font-bold text-orange-400 p-3 rounded-xl border border-orange-500/20 bg-orange-500/5 hover:bg-orange-500/10 transition-colors"
          >
            העלה קובץ GPX אישי
          </button>
        </div>
      </div>

      {loading && (
        <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center rounded-3xl backdrop-blur-md z-50">
          <Loader2 className="w-10 h-10 animate-spin text-orange-500 mb-4" />
          <span className="text-white font-bold tracking-widest text-sm">מכין את המסלול...</span>
        </div>
      )}
      {error && (
        <div className="absolute bottom-20 left-6 right-6 bg-red-950/90 border border-red-500/50 p-4 rounded-2xl text-white text-sm text-center z-50 backdrop-blur-xl shadow-2xl font-medium">
          {error}
        </div>
      )}
    </div>
  );
}
