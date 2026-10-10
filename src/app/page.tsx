"use client";

import React, { useState, useEffect, useCallback, useMemo, memo, useRef, useSyncExternalStore } from "react";
import mapboxgl from "mapbox-gl";
import { EyeOff, TriangleAlert, LocateFixed, VolumeX, Undo2, X } from "lucide-react";
import MapComponent from "@/components/Map";
import StatsPanel from "@/components/StatsPanel";
import TrailDiscovery from "@/components/TrailDiscovery";
import Controls, { BottomBar } from "@/components/Controls";
import AIAssistantUI, { NoGuidePointsHint } from "@/components/AIAssistantUI";
import SettingsPanel from "@/components/SettingsPanel";
import SettingsActions from "@/components/SettingsActions";
import PersonalArea, { type Tab as PersonalTab } from "@/components/PersonalArea";
import RecordPanel from "@/components/RecordPanel";
import { useRecorder } from "@/hooks/useRecorder";
import { track } from "@/lib/track";
import { recordingCoords, recordingToGpx } from "@/lib/recording/gpx";
import { syncRecordings, upsertRecording } from "@/lib/recording/sync";
import type { Recording } from "@/lib/recording/types";
import GuidePointsPanel from "@/components/GuidePointsPanel";
import WorldTrailCard from "@/components/WorldTrailCard";
import TrailInfoPanel from "@/components/TrailInfoPanel";
import { nakebIdFromUrl, trailInfoKey, type TrailInfoRequest } from "@/lib/trailInfo/types";
import DrivePlanner, { type DriveRequest, type DrivePlan } from "@/components/DrivePlanner";
import PlaceSearchBox from "@/components/PlaceSearchBox";
import MeasureTool, { type MeasureWaypoint } from "@/components/MeasureTool";
import Coachmark from "@/components/help/Coachmark";
import HelpSection from "@/components/help/HelpSection";
import { WELCOME_STEPS, TRAIL_STEPS, DRIVE_STEPS, trackingSteps } from "@/components/help/tours";
import { hasSeen, markSeen, resetOnboarding, type HelpKey } from "@/lib/onboarding";
import { driveRoute, thinCoords } from "@/lib/mapboxDirections";
import { encodeDrive, decodeDrive, type DriveLink } from "@/lib/driveLink";
import { rememberOpenTrail, recallOpenTrail, forgetOpenTrail } from "@/lib/openTrailMemory";
import { rememberRecentTrail, rememberRecentWorldTrail, type RecentTrail } from "@/lib/recentTrails";
import RecentTrailsButton from "@/components/RecentTrailsButton";
import { useTrailData } from "@/hooks/useTrailData";
import { useTour, tourSecondsLeft, formatTourTimeLeft } from "@/hooks/useTour";
import { useAIGuide } from "@/hooks/useAIGuide";
import { useHeightVar } from "@/hooks/useHeightVar";
import { isTrailInIsrael } from "@/lib/inIsrael";
import { usePOIGeofence } from "@/hooks/usePOIGeofence";
import { pointAtDistance, snapToTrail, coordsToGpx, parseGPX, type Coordinate3D } from "@/utils/trailUtils";
import { useOffRouteAlert } from "@/hooks/useOffRouteAlert";
import { primeAlarm } from "@/lib/offRouteAlert";
import { isNativeApp, watchNativePosition, openAppSettings } from "@/lib/native";
import { useTrailPOIs } from "@/hooks/useTrailPOIs";
import { useAuth } from "@/hooks/useAuth";
import { useOfflineTrail } from "@/hooks/useOfflineTrail";
import { useOnline } from "@/hooks/useOnline";
import { listMapPacks, trimMapCache, type MapPack } from "@/lib/offlineMap";
import { useSummerConditions } from "@/hooks/useSummerConditions";
import { useTripWeather } from "@/hooks/useTripWeather";
import { useTrailClimate } from "@/hooks/useTrailClimate";
import { useWorldTrails } from "@/hooks/useWorldTrails";
import { usePlacePhotos } from "@/hooks/usePlacePhotos";
import { useTrailLeaders } from "@/hooks/useTrailLeaders";
import { useHikerHeat, readHikerHeat } from "@/hooks/useHikerHeat";
import type { Bounds } from "@/lib/trailHeat";
import { useWmtStages } from "@/hooks/useWmtStages";
import type { TrailStages } from "@/components/StatsPanel";
import type { WmtRouteSummary } from "@/lib/waymarked";
import {
  saveTrail, recordTour, SavedTrail, describeSupabaseError, clearPersonalCache,
  listSavedTrails, listTourHistory, listTrailNotes, cachePersonalData, warmSavedTrailFiles,
} from "@/lib/personalArea";
import type { TrailData, TrailPOI, DrivePlace, TrailSource, WmtParent } from "@/hooks/useTrailData";
import CreditsAlert from "@/components/CreditsAlert";
import HelpChat from "@/components/HelpChat";
import PhotoViewer from "@/components/PhotoViewer";
import { useTrailPhotosMap } from "@/hooks/useTrailPhotosMap";
import type { TrailPhoto } from "@/lib/trailPhotos/types";
import type { HelpActionId } from "@/lib/helpChat/actions";
import { HELP_PLACES, type HelpPlaceId } from "@/lib/helpChat/places";

// Which of the two worlds the home screen is in: hiking trails, or a drive
// between two places. Not remembered: the app always opens on the trails, and
// a drive is one tap away. (It used to open on whichever was used last, which
// made the drive planner the first thing seen after a single road trip.)
// Only a shared or saved drive switches it on its own.
type AppMode = 'trails' | 'drive';
const modeListeners = new Set<() => void>();
let currentAppMode: AppMode = 'trails';
function readAppMode(): AppMode {
  return currentAppMode;
}
function writeAppMode(mode: AppMode) {
  currentAppMode = mode;
  modeListeners.forEach((l) => l());
}
function subscribeAppMode(l: () => void) {
  modeListeners.add(l);
  return () => { modeListeners.delete(l); };
}

// A trail kept as GPX text (a saved drive or OSM route carries its own
// points) read back into points — no network needed.
function coordsFromGpxText(text: string | null | undefined): Coordinate3D[] | null {
  if (!text) return null;
  try {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) return null;
    const coords = parseGPX(doc);
    return coords.length >= 2 ? coords : null;
  } catch {
    return null;
  }
}

// A narration runs about 40 seconds. Firing it 150 m out means it finishes
// roughly as the point is reached, rather than starting there and trailing
// behind the walker for the next stretch of trail.
const GEOFENCE_RADIUS_KM = 0.15;

const MemoizedMapComponent = memo(MapComponent);
const MemoizedTrailDiscovery = memo(TrailDiscovery);
const MemoizedStatsPanel = memo(StatsPanel);
const MemoizedControls = memo(Controls);
const MemoizedBottomBar = memo(BottomBar);

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
  // For what reads it without re-running on a toggle: the fit to a newly
  // opened trail, and a change of map style.
  const is3DRef = useRef(is3D);
  useEffect(() => { is3DRef.current = is3D; }, [is3D]);
  const [mapBearing, setMapBearing] = useState(0);
  const [styleRev, setStyleRev] = useState(0);
  // Which of the three map styles is showing. The offline pack is saved in
  // one style and, with no reception, that is the one that has tiles.
  const [styleKey, setStyleKey] = useState('satellite');
  const online = useOnline();
  
  const { trail, setTrail, trailSource, loadTrailFile, loadTrailFromUrl, loadTrailFromText, loadTrailFromCoords, trailError, trailLoading } = useTrailData();
  // Marked hiking routes from OSM, worldwide, as an overlay anyone can tap.
  const worldTrails = useWorldTrails(map, styleRev, { onLoadTrail: loadTrailFromCoords, focused: !!trail });
  // A tap on a beach, peak or village named on the map offers its photos on Google.
  usePlacePhotos(map);
  // A world trail chosen from "מסלולים בעולם" opens its card, as one picked
  // in the search box does — with the layer on, so it can be seen.
  const { enable: enableWorldTrails, select: selectWorldTrail } = worldTrails;
  const pickWorldTrail = useCallback((summary: WmtRouteSummary) => {
    enableWorldTrails();
    selectWorldTrail(summary.id, summary, { fit: true });
  }, [enableWorldTrails, selectWorldTrail]);
  // ── Going back ────────────────────────────────────────────────────────────
  // A card opened from "מסלולים בעולם" leads back to that list, and so does
  // closing a trail loaded from such a card: the panel opens where the reader
  // left it (it remembers the country, area, month and filters). Any closed
  // trail can be brought back with one tap, until another one is opened.
  const [cardFromList, setCardFromList] = useState(false);
  const [discoveryOpen, setDiscoveryOpen] = useState(0);
  const trailFromListRef = useRef(false);
  const [lastClosed, setLastClosed] = useState<{ trail: TrailData; source: TrailSource | null } | null>(null);
  const pickFromList = useCallback((summary: WmtRouteSummary) => {
    setCardFromList(true);
    pickWorldTrail(summary);
  }, [pickWorldTrail]);
  const pickFromMap = useCallback((summary: WmtRouteSummary) => {
    setCardFromList(false);
    pickWorldTrail(summary);
  }, [pickWorldTrail]);
  const closeTrail = useCallback(() => {
    if (trail) setLastClosed({ trail, source: trailSource });
    setTrail(null);
    if (trailFromListRef.current) {
      trailFromListRef.current = false;
      setDiscoveryOpen((n) => n + 1);
    }
  }, [trail, trailSource, setTrail]);
  const reopenLastTrail = useCallback(() => {
    if (!lastClosed) return;
    const { trail: t, source } = lastClosed;
    setLastClosed(null);
    loadTrailFromCoords(t.coords, t.name, source ?? { kind: 'file', content: coordsToGpx(t.coords, t.name) }, {
      kind: t.kind, driveDurationSec: t.driveDurationSec,
    });
  }, [lastClosed, loadTrailFromCoords]);

  // The leading trails of the collected countries, as stars over the overlay.
  useTrailLeaders(map, styleRev, {
    enabled: worldTrails.enabled,
    muted: !!trail || !!worldTrails.selection,
    onPick: pickFromMap,
  });

  // "על המסלול": which trail's description is open, if any.
  const [infoRequest, setInfoRequest] = useState<TrailInfoRequest | null>(null);
  // The open trail's description, when it is one the app knows the source
  // of: a world trail by its OSM relation, an Israeli one by its Nakeb id.
  const openTrailInfo = useMemo<TrailInfoRequest | null>(() => {
    if (!trail || !trailSource || trail.kind === 'drive') return null;
    const url = trailSource.kind === 'url' ? trailSource.url : trailSource.kind === 'pack' ? trailSource.sourceUrl : null;
    const wmtId = trailSource.kind === 'wmt' ? trailSource.id : Number(/^wmt:(\d+)$/.exec(url ?? '')?.[1] ?? NaN);
    if (Number.isFinite(wmtId)) return { kind: 'wmt', id: wmtId, name: trail.name };
    const nakebId = nakebIdFromUrl(url);
    if (nakebId == null) return null;
    const start = trail.start;
    return { kind: 'nakeb', id: nakebId, name: trail.name, ...(start ? { lat: start[0], lon: start[1] } : {}) };
  }, [trail, trailSource]);
  const showOpenTrailInfo = useCallback(() => setInfoRequest(openTrailInfo), [openTrailInfo]);

  // The tapped route's long trail, when it is a stage of one: its list of
  // stages gives the card "המקטע הקודם / הבא".
  const worldSiblings = useWmtStages(worldTrails.selection?.parent?.id ?? null, { climb: false });

  // A world trail made of stages lists them on its card, and a stage leads
  // back to its long trail. Either opens as the trail, in place of this one.
  const openWmtId = openTrailInfo?.kind === 'wmt' ? openTrailInfo.id : null;
  const wmtStructure = useWmtStages(openWmtId);
  const [stageLoading, setStageLoading] = useState<number | null>(null);
  const { loadById: loadWorldTrailById } = worldTrails;
  const openParent = openWmtId == null ? null
    : (trailSource?.kind === 'wmt' ? trailSource.parent : undefined) ?? wmtStructure?.parents[0] ?? null;
  const openSiblings = useWmtStages(openParent?.id ?? null, { climb: false });
  const trailStages = useMemo<TrailStages | null>(() => {
    if (openWmtId == null || !trail) return null;
    const parent = openParent;
    const stages = wmtStructure?.stages ?? [];
    if (!parent && stages.length === 0) return null;
    const open = async (id: number, from?: WmtParent) => {
      setStageLoading(id);
      try { await loadWorldTrailById(id, from); } finally { setStageLoading(null); }
    };
    return {
      currentId: openWmtId,
      stages,
      parent,
      pendingId: stageLoading,
      onPick: (stage) => open(stage.id, { id: openWmtId, name: trail.name }),
      onBack: () => { if (parent) open(parent.id); },
      siblings: openSiblings?.stages.length ? openSiblings.stages : null,
      // A neighbouring stage keeps the same long trail to go back to.
      onStep: (stage) => open(stage.id, parent ?? undefined),
    };
  }, [openWmtId, openParent, trail, wmtStructure, openSiblings, stageLoading, loadWorldTrailById]);

  // Hiking trails or a road trip — the home screen's two faces.
  const appMode = useSyncExternalStore(subscribeAppMode, readAppMode, () => 'trails' as AppMode);
  const isDrive = trail?.kind === 'drive';
  const [drivePreview, setDrivePreview] = useState<DrivePlan>({ from: null, to: null, vias: [] });
  const handleDrivePreview = useCallback((plan: DrivePlan) => setDrivePreview(plan), []);
  // The places of the drive last opened: closing it goes back to the planner
  // with them filled in, ready to add a stop or pick another road.
  const [lastDrivePlan, setLastDrivePlan] = useState<DrivePlan | null>(null);

  const openDrive = useCallback((req: DriveRequest) => {
    setLastDrivePlan({ from: req.from, to: req.to, vias: req.vias });
    loadTrailFromCoords(
      req.coords,
      `${req.from.name} ← ${req.to.name}`,
      { kind: 'drive', from: req.from, to: req.to, vias: req.vias },
      { kind: 'drive', driveDurationSec: req.durationSec }
    );
  }, [loadTrailFromCoords]);

  // A saved or shared drive. With its road on hand it opens as it was;
  // otherwise the quickest road through its places is asked for again.
  const openDriveFromLink = useCallback(async (link: DriveLink, coords?: Coordinate3D[] | null): Promise<boolean> => {
    if (coords) {
      openDrive({
        from: link.from, to: link.to, vias: link.vias, coords,
        distanceKm: 0, // worked out from the points by the trail itself
        durationSec: link.durationSec ?? 0,
      });
      return true;
    }
    try {
      const points = [link.from, ...link.vias, link.to].map((p) => [p.lon, p.lat] as [number, number]);
      const route = await driveRoute(points);
      openDrive({ from: link.from, to: link.to, vias: link.vias, ...route });
      return true;
    } catch (e) {
      console.error('Drive re-route failed:', e);
      return false;
    }
  }, [openDrive]);
  const { isActive: isTourActive, startTour, stopTour, speed: tourSpeed, setSpeed: setTourSpeed, progress, setProgressByJump } = useTour(map, trail);
  const { requestGuideForPoint, unlockAudio, isSpeaking, isLoading, currentScript, stopSpeaking, queueLength, currentVoice, currentFromDevice, voiceNotice } = useAIGuide();

  // The guide is opt-in, every time. It starts off, and goes back to off when
  // a new trail is opened and when a virtual tour reaches its end — so a tour
  // or a walk never narrates, and never spends a TTS credit, unless it was
  // switched on for that tour or that walk. Off is
  // a real off: the geofence never fires, so not a single request goes out.
  // Tapping a point on the map or in the list still plays it — that is a
  // deliberate press, not the automatic guide.
  const [isGuideEnabled, setIsGuideEnabled] = useState(false);

  // "Map only" mode: everything except the trail, the traveller and the one
  // button that brings the chrome back is taken off the screen.
  const [uiHidden, setUiHidden] = useState(false);
  // "שאלו את Navi", the help chat in the bottom corner.
  const [helpChatOpen, setHelpChatOpen] = useState(false);
  // The button a help-chat answer was about, lit up by "הראה לי איפה".
  const [helpPoint, setHelpPoint] = useState<HelpPlaceId | null>(null);
  // "תמונות מהמסלול": the open trail's photos once its card loaded them —
  // marked on the map until the trail is closed — the one open on the whole
  // screen, and the one last shown on the map. Each is kept with the trail it
  // belongs to, so a new trail starts with none.
  const [trailPhotosOf, setTrailPhotosOf] = useState<{ of: unknown; photos: TrailPhoto[] } | null>(null);
  const [photoViewOf, setPhotoViewOf] = useState<{ of: unknown; photos: TrailPhoto[]; index: number } | null>(null);
  const [photoFocusOf, setPhotoFocusOf] = useState<{ of: unknown; id: string } | null>(null);
  const trailKey = trail?.coords;
  const trailPhotos = trailPhotosOf && trailPhotosOf.of === trailKey ? trailPhotosOf.photos : null;
  const photoView = photoViewOf && photoViewOf.of === trailKey ? photoViewOf : null;
  const photoFocus = photoFocusOf && photoFocusOf.of === trailKey ? photoFocusOf.id : null;
  const setPhotoView = useCallback((v: { photos: TrailPhoto[]; index: number } | null) => {
    setPhotoViewOf(v ? { of: trailKey, ...v } : null);
  }, [trailKey]);
  const showTrailPhotos = useCallback((photos: TrailPhoto[]) => setTrailPhotosOf({ of: trailKey, photos }), [trailKey]);
  const openTrailPhoto = useCallback((photos: TrailPhoto[], index: number) => setPhotoView({ photos, index }), [setPhotoView]);
  const photoHandlers = useMemo(() => ({ onShow: showTrailPhotos, onOpen: openTrailPhoto }), [showTrailPhotos, openTrailPhoto]);
  useTrailPhotosMap(
    map, styleRev, trail && !uiHidden ? trailPhotos : null, photoFocus,
    (index) => { if (trailPhotos) setPhotoView({ photos: trailPhotos, index }); },
  );
  // "הצג במפה": the viewer closes and the map flies to where the photo was
  // taken, its mark drawn larger.
  const showPhotoOnMap = useCallback((photo: TrailPhoto) => {
    setPhotoView(null);
    setPhotoFocusOf({ of: trailKey, id: photo.id });
    if (map && photo.lat != null && photo.lon != null) {
      map.flyTo({ center: [photo.lon, photo.lat], zoom: Math.max(map.getZoom(), 15), duration: 1500, essential: true });
    }
  }, [map, trailKey, setPhotoView]);
  const [showGuidePoints, setShowGuidePoints] = useState(false);
  // The bottom of a phone screen, measured: the tour transport with the guide
  // above it, and the tour progress bar above that. The trail card stacks on
  // top of whatever of them is showing (see StatsPanel).
  const bottomStackRef = useHeightVar('--bottom-stack-h');
  const progressBarRef = useHeightVar('--progress-bar-h');
  // Switched on outside a virtual tour, it is for a real walk: the guide goes
  // by where the phone is, so the live location comes on with it.
  const handleToggleGuide = useCallback(() => {
    if (isGuideEnabled) {
      stopSpeaking();
    } else {
      unlockAudio(); // the toggle is a user gesture — use it to unlock audio
      if (!isTourActive) { primeAlarm(); setIsTracking(true); }
    }
    setIsGuideEnabled(!isGuideEnabled);
  }, [isGuideEnabled, isTourActive, stopSpeaking, unlockAudio]);

  // The live location: once switched on (the locate button, the guide, or
  // starting to navigate a measured route) the blue dot follows the phone,
  // the trail card counts down the distance left, the off-route alarm listens
  // and the guide — if it is on — narrates the points as they are reached.
  // (This used to be split across a separate "field mode" button, which added
  // a screen lock on top. Nothing needed the button, and the lock emptied the
  // battery.)
  const [isTracking, setIsTracking] = useState(false);
  const [gpsPos, setGpsPos] = useState<{ lat: number; lon: number; accuracy: number | null } | null>(null);
  const centerOnNextFixRef = useRef(false);

  // Measuring a distance between two points — along the trail if one is open.
  const [isMeasuring, setIsMeasuring] = useState(false);

  // Recording the walk (useRecorder). The fixes come from the live location
  // below; the recorder keeps the ones that count.
  const recorder = useRecorder();
  // The recorder's functions are stable; its state changes with every point.
  const { addFix: recorderAddFix, start: recStart, pause: recPause, save: recSave, status: recStatus } = recorder;
  const recActive = recStatus !== 'idle';
  const [recOpenSignal, setRecOpenSignal] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Auth + personal area + settings
  const { user, sessionLive, signInWithGoogle, signOut, isAuthAvailable } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [showPersonalArea, setShowPersonalArea] = useState(false);
  const [personalTab, setPersonalTab] = useState<PersonalTab | undefined>(undefined);
  const [saveTrailState, setSaveTrailState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Reset the save indicator whenever a different trail loads
  useEffect(() => {
    setSaveTrailState('idle');
  }, [trail?.name]);

  const handleSaveTrail = useCallback(async () => {
    if (!trail || !user) return;
    if (!online) {
      alert('אין אינטרנט כרגע. אפשר לשמור את המסלול כשיחזור החיבור.');
      return;
    }
    // The account is remembered on the device but the server no longer takes
    // its sign-in. Signing in again leaves the page — the open trail is kept
    // and comes back with it.
    if (!sessionLive) {
      if (window.confirm('החיבור לחשבון Google פג. להתחבר מחדש כדי לשמור את המסלול?')) signInWithGoogle();
      return;
    }
    setSaveTrailState('saving');
    try {
      await saveTrail({
        name: trail.name,
        sourceUrl: trailSource?.kind === 'url' ? trailSource.url
          : trailSource?.kind === 'pack' ? trailSource.sourceUrl
          : trailSource?.kind === 'wmt' ? `wmt:${trailSource.id}`
          : trailSource?.kind === 'drive'
            ? encodeDrive({ from: trailSource.from, to: trailSource.to, vias: trailSource.vias ?? [], durationSec: trail.driveDurationSec })
            : null,
        // A drive and an OSM route keep their points too: the road chosen
        // (not necessarily the quickest), and a trail that opens with no
        // reception, when the services that made them cannot be reached.
        sourceContent: trailSource?.kind === 'file' ? trailSource.content
          : trailSource?.kind === 'drive' ? coordsToGpx(thinCoords(trail.coords, 0.02), trail.name)
          : trailSource?.kind === 'wmt' ? coordsToGpx(trail.coords, trail.name)
          : null,
        totalDistance: trail.totalDistance,
      });
      setSaveTrailState('saved');
    } catch (e) {
      console.error('Save trail failed:', e);
      alert(describeSupabaseError(e));
      setSaveTrailState('idle');
    }
  }, [trail, user, trailSource, online, sessionLive, signInWithGoogle]);

  const handleLoadSavedTrail = useCallback((saved: SavedTrail) => {
    setShowPersonalArea(false);
    const wmtId = saved.source_url?.match(/^wmt:(\d+)$/)?.[1];
    const drive = decodeDrive(saved.source_url);
    const savedCoords = coordsFromGpxText(saved.source_content);
    if (drive) {
      writeAppMode('drive');
      openDriveFromLink(drive, savedCoords).then((ok) => {
        if (!ok) alert('לא הצלחנו לחשב מחדש את מסלול הנסיעה.');
      });
    } else if (wmtId && savedCoords) {
      loadTrailFromCoords(savedCoords, saved.name, { kind: 'wmt', id: Number(wmtId) });
    } else if (wmtId) {
      worldTrails.loadById(Number(wmtId)).then((ok) => {
        if (!ok) alert('המסלול לא זמין כרגע משירות Waymarked Trails.');
      });
    } else if (saved.source_url) {
      loadTrailFromUrl(saved.source_url, saved.name);
    } else if (saved.source_content) {
      loadTrailFromText(saved.source_content, saved.name);
    } else {
      alert('למסלול השמור אין מקור לטעינה.');
    }
  }, [loadTrailFromUrl, loadTrailFromText, loadTrailFromCoords, worldTrails, openDriveFromLink]);

  // Record a completed virtual tour in the personal history (once per trail load)
  const tourRecordedRef = useRef(false);
  useEffect(() => {
    tourRecordedRef.current = false;
  }, [trail?.name]);
  useEffect(() => {
    if (!user || !sessionLive || !trail || tourRecordedRef.current) return;
    if (progress >= 0.995) {
      tourRecordedRef.current = true;
      recordTour({
        trailName: trail.name,
        distanceKm: trail.totalDistance,
        completedPct: 100,
        mode: 'virtual',
      }).catch((e) => console.error('Tour history record failed:', e));
    }
  }, [progress, user, sessionLive, trail]);

  // Virtual position of the tour camera. The camera advances by *distance*
  // along the route, so this has to as well — interpolating by point index
  // drifts badly on GPX tracks whose points are unevenly spaced.
  const virtualKm = trail && isTourActive ? progress * trail.totalDistance : null;
  const virtualPos = useMemo(() => {
    if (!trail || virtualKm == null || trail.coords.length < 2) return null;
    const pt = pointAtDistance(trail.coords, trail.accumulatedDistances, virtualKm);
    return { lat: pt[0], lon: pt[1] };
  }, [trail, virtualKm]);

  // During a virtual tour the camera is the "traveler"; otherwise, with the
  // live location on, it is the real GPS.
  const guidePos = isTourActive ? virtualPos : gpsPos;

  // Back to opt-in: a new trail, a tour that has run to its end. Pausing a
  // tour and resuming it keeps the choice.
  useEffect(() => { setIsGuideEnabled(false); }, [trail]);
  useEffect(() => {
    if (!isTourActive && progress >= 1) setIsGuideEnabled(false);
  }, [isTourActive, progress]);

  // The walker snapped onto the open trail: how far along, how far off it.
  // Measured to the line itself, not to its nearest point, so a sparse route
  // does not read as "off the trail" between two far-apart points.
  const lastUserKmRef = useRef<number | null>(null);
  useEffect(() => { lastUserKmRef.current = null; }, [trail]);
  const userOnTrail = useMemo(() => {
    if (!trail || !gpsPos) return null;
    const snap = snapToTrail(trail.coords, trail.accumulatedDistances, gpsPos.lat, gpsPos.lon, lastUserKmRef.current);
    if (!snap) return null;
    if (snap.offTrailKm <= 0.3) lastUserKmRef.current = snap.km;
    return { km: snap.km, offTrailM: snap.offTrailKm * 1000, ele: snap.ele };
  }, [trail, gpsPos]);

  // How far along the trail the traveler is — exact for the virtual tour,
  // from the GPS otherwise. This is what lets the guide narrate points in the
  // order they are actually walked. Wandered well off the route, the
  // along-trail position means nothing.
  const walkerKm = userOnTrail && userOnTrail.offTrailM <= 300 ? userOnTrail.km : null;
  const travelerKm = isTourActive ? virtualKm : walkerKm;

  // The trail's guide points: real places along it with something of their own
  // to be said. Best-effort; empty until discovery answers.
  const { pois: enrichedPois, source: poiSource, discoveryFailed: poiDiscoveryFailed, retry: retryPoiDiscovery } =
    useTrailPOIs(isDrive ? null : trail);

  // Why there is nothing to narrate, when there is nothing. Discovery failing
  // is not the same as the trail having nothing worth hearing, and only one of
  // the two is worth offering a retry for.
  const noPointsState: 'searching' | 'failed' | 'empty' | 'skipped' =
    poiDiscoveryFailed ? 'failed'
      : poiSource === 'pending' ? 'searching'
      : poiSource === 'skipped' ? 'skipped'
      : 'empty';

  // Where each narration point sits along the route, in kilometres — the
  // ordering key the geofence needs so point N+1 cannot speak before point N.
  const poiDistancesKm = useMemo(
    () => (trail ? enrichedPois.map((poi) => trail.accumulatedDistances[poi.index] ?? 0) : null),
    [trail, enrichedPois]
  );

  const { reset: resetGeofence } = usePOIGeofence(
    enrichedPois,
    guidePos,
    (poi) => requestGuideForPoint(poi, trail!.name),
    {
      enabled: isGuideEnabled && !isDrive && (isTourActive || isTracking),
      radiusKm: GEOFENCE_RADIUS_KM,
      resetKey: trail?.name,
      poiDistancesKm,
      travelerKm,
    }
  );

  // Narration audio and the map along the trail, kept on the device so the
  // walk works with no reception.
  const offlineTrail = useOfflineTrail(
    trail,
    enrichedPois,
    map,
    styleKey,
    styleRev,
    trailSource?.kind === 'url' ? trailSource.url : trailSource?.kind === 'pack' ? trailSource.sourceUrl : null
  );

  // Trails saved for the field, for the home screen — the only list there is
  // when the index itself cannot be fetched.
  const [mapPacks, setMapPacks] = useState<MapPack[]>([]);
  useEffect(() => {
    let cancelled = false;
    listMapPacks().then((packs) => { if (!cancelled) setMapPacks(packs); });
    return () => { cancelled = true; };
  }, [trail, offlineTrail.mapPack]);

  // Once per session, after the map has had its moment: drop map tiles past
  // their thirty days and keep the passive cache within bounds.
  useEffect(() => {
    const t = setTimeout(() => { void trimMapCache(); }, 15000);
    return () => clearTimeout(t);
  }, []);

  const openPack = useCallback((pack: MapPack) => {
    loadTrailFromCoords(
      pack.coords,
      pack.trailName,
      { kind: 'pack', slug: pack.trailSlug, sourceUrl: pack.sourceUrl },
      { kind: pack.kind }
    );
  }, [loadTrailFromCoords]);

  // Whether the open trail is in Israel. The summer water and shade, and the
  // reminder to check with רשות הטבע והגנים, mean nothing anywhere else, so a
  // trail abroad gets neither (and asks Overpass nothing about water).
  const [israelCheck, setIsraelCheck] = useState<{ trail: typeof trail; inIsrael: boolean } | null>(null);
  useEffect(() => {
    if (!trail || isDrive) return;
    let live = true;
    isTrailInIsrael(trail.coords).then((inIsrael) => { if (live) setIsraelCheck({ trail, inIsrael }); });
    return () => { live = false; };
  }, [trail, isDrive]);
  const trailInIsrael = !isDrive && israelCheck?.trail === trail ? israelCheck.inIsrael : null;

  // How shaded the trail is — read from a grid that ships with the app, so this
  // costs no request and works offline.
  const { shade, shadeLoading, water, waterStatus } = useSummerConditions(trailInIsrael ? trail : null);

  // The forecast for the chosen trip day, and the water and layers it calls for.
  const tripWeather = useTripWeather(trail);
  const trailClimate = useTrailClimate(trail, tripWeather.hours);

  // Replaying a point someone asked for jumps the queue — they pressed a
  // button and expect to hear it now.
  const playPoiNow = useCallback((poi: TrailPOI) => {
    if (!trail) return;
    unlockAudio();
    requestGuideForPoint(poi, trail.name, { immediate: true });
  }, [trail, unlockAudio, requestGuideForPoint]);

  const handleMapLoad = useCallback((initializedMap: mapboxgl.Map) => {
    setMap(initializedMap);
    // Track bearing for compass rotation
    initializedMap.on('rotate', () => setMapBearing(initializedMap.getBearing()));
  }, []);

  // An open trail, and a world trail's card, each get an entry in the
  // browser's history, so the phone's back button steps back out of them:
  // the trail closes (to the list it was opened from, if any — and it can be
  // brought back, see "Going back"), the card goes back to its list or
  // closes. No "are you sure": nothing is lost by stepping back.
  const hasCard = !!worldTrails.selection;
  useEffect(() => {
    if (trail) window.history.pushState({ navi: 'trail' }, "");
  }, [trail]);
  useEffect(() => {
    if (hasCard) window.history.pushState({ navi: 'card' }, "");
  }, [hasCard]);
  useEffect(() => {
    if (helpChatOpen) window.history.pushState({ navi: 'help-chat' }, "");
  }, [helpChatOpen]);
  const photoOpen = !!photoView;
  useEffect(() => {
    if (photoOpen) window.history.pushState({ navi: 'photo' }, "");
  }, [photoOpen]);
  const backRef = useRef<() => void>(() => {});
  useEffect(() => {
    backRef.current = () => {
      // The chat is on top of everything else: back closes it first, then a
      // photo open on the whole screen.
      if (helpChatOpen) setHelpChatOpen(false);
      else if (photoView) setPhotoView(null);
      else if (trail) closeTrail();
      else if (worldTrails.selection) {
        if (cardFromList) setDiscoveryOpen((n) => n + 1);
        setCardFromList(false);
        worldTrails.clearSelection();
      }
    };
  });
  useEffect(() => {
    const handlePopState = () => backRef.current();
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleStyleChange = useCallback((key: string) => {
    if (!map) return;
    const styleUrl = key === 'satellite' ? 'mapbox://styles/mapbox/satellite-streets-v12' :
                     key === 'terrain' ? 'mapbox://styles/mapbox/outdoors-v12' :
                     'mapbox://styles/mapbox/light-v11';
    map.setStyle(styleUrl);
    map.once('style.load', () => {
      // Map.tsx puts the terrain back on every new style; 2D stays 2D.
      if (!is3DRef.current) { try { map.setTerrain(null); } catch {} }
      setStyleKey(key);
      setStyleRev(r => r + 1);
    });
  }, [map]);

  // With no reception, a trail downloaded in another style is switched to
  // that style: it is the one with tiles on the device.
  const packStyleKey = offlineTrail.mapPack?.styleKey ?? null;
  useEffect(() => {
    if (online || !trail || !packStyleKey || packStyleKey === styleKey) return;
    handleStyleChange(packStyleKey);
  }, [online, trail, packStyleKey, styleKey, handleStyleChange]);

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

  // ── "מפת חום של מטיילים" ─────────────────────────────────────────────────
  // Read over the light map, flat: turning it on switches to both, and
  // turning it off puts back the map and the 3D that were there — unless the
  // reader picked another map in between. With no reception the downloaded
  // style stays (it is the one with tiles).
  const hikerHeat = useHikerHeat(map, styleRev);
  const { setEnabled: setHikerHeat } = hikerHeat;
  const beforeHeatRef = useRef<{ style: string; is3D: boolean } | null>(null);
  const styleLocked = !online && !!trail && !!packStyleKey;
  const flatten = useCallback(() => {
    if (!map || !is3DRef.current) return;
    is3DRef.current = false;
    setIs3D(false);
    try { map.setTerrain(null); } catch {}
    map.easeTo({ pitch: 0, duration: 800 });
  }, [map]);
  const showHikerHeat = useCallback(() => {
    if (!map) return;
    beforeHeatRef.current = { style: styleKey, is3D: is3DRef.current };
    flatten();
    if (styleKey !== 'light' && !styleLocked) handleStyleChange('light');
    setHikerHeat(true);
    track('hiker_heat');
  }, [map, styleKey, styleLocked, flatten, handleStyleChange, setHikerHeat]);
  const hideHikerHeat = useCallback(() => {
    setHikerHeat(false);
    const before = beforeHeatRef.current;
    beforeHeatRef.current = null;
    if (!map || !before || styleKey !== 'light') return;
    if (before.style !== 'light' && !styleLocked) handleStyleChange(before.style);
    if (before.is3D && !is3DRef.current) {
      is3DRef.current = true;
      setIs3D(true);
      try { map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.8 }); } catch {}
      map.easeTo({ pitch: 60, duration: 800 });
    }
  }, [map, styleKey, styleLocked, handleStyleChange, setHikerHeat]);
  const toggleHikerHeat = useCallback(() => {
    if (hikerHeat.enabled) hideHikerHeat(); else showHikerHeat();
  }, [hikerHeat.enabled, hideHikerHeat, showHikerHeat]);
  // Left on last time: the map opens on the light style, flat.
  const heatRestored = useRef(false);
  useEffect(() => {
    if (!map || heatRestored.current) return;
    heatRestored.current = true;
    if (!readHikerHeat()) return;
    beforeHeatRef.current = { style: 'satellite', is3D: true };
    flatten();
    handleStyleChange('light');
  }, [map, flatten, handleStyleChange]);
  // A country picked in "מסלולים בעולם" while the heat is on: the map goes
  // there, so its busy areas show at once.
  const viewCountry = useCallback((box: Bounds) => {
    if (!map || !readHikerHeat()) return;
    const wide = window.innerWidth >= 768;
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {
      // Clear of the place search and the control rail as well as the panel.
      padding: wide ? { top: 100, bottom: 50, left: 120, right: 440 } : { top: 130, bottom: 210, left: 70, right: 20 },
      maxZoom: 8,
      duration: 1400,
      pitch: 0,
    });
  }, [map]);

  const updateUserLocLayer = useCallback((longitude: number, latitude: number) => {
    if (!map) return;
    if (!map.getStyle()) return;
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
    // The walker sits on top of the route line, not under it.
    if (map.getLayer("user-loc-dot")) map.moveLayer("user-loc-dot");
  }, [map]);

  // First tap: switch the live location on and fly to it. After that, a tap
  // brings the map back to it — the dot keeps following either way.
  const handleLocateUser = useCallback(() => {
    if (!navigator.geolocation || !map) {
      alert("הדפדפן שלך לא תומך באיתור מיקום");
      return;
    }
    primeAlarm(); // a tap — the one moment the off-route alarm may be given its sound
    if (isTracking && gpsPos) {
      map.easeTo({ center: [gpsPos.lon, gpsPos.lat], zoom: Math.max(map.getZoom(), 15), duration: 1000 });
      return;
    }
    centerOnNextFixRef.current = true;
    setIsTracking(true);
  }, [map, isTracking, gpsPos]);

  // Continuous GPS tracking, for as long as the live location is on. In the
  // Android app it comes from the app itself and keeps coming with the screen
  // off; in a browser, from watchPosition, which stops when the screen does.
  useEffect(() => {
    if (!isTracking) {
      setGpsPos(null);
      return;
    }
    const onFix = (longitude: number, latitude: number, accuracy: number | null, ele: number | null, t: number) => {
      setGpsPos({ lat: latitude, lon: longitude, accuracy });
      recorderAddFix({ lat: latitude, lon: longitude, ele, t, acc: accuracy });
      updateUserLocLayer(longitude, latitude);
      if (centerOnNextFixRef.current && map) {
        centerOnNextFixRef.current = false;
        map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 15), duration: 1500 });
      }
    };
    if (isNativeApp()) {
      return watchNativePosition(
        (fix) => onFix(fix.lon, fix.lat, fix.accuracy, fix.ele, fix.t),
        (message, needsSettings) => {
          setIsTracking(false);
          if (needsSettings && window.confirm(`${message}\nלפתוח את הגדרות האפליקציה כדי לאשר מיקום?`)) openAppSettings();
          else if (!needsSettings) alert('שגיאה באיתור מיקום: ' + message);
        },
        { recording: recActive }
      );
    }
    if (!navigator.geolocation) {
      alert("הדפדפן שלך לא תומך באיתור מיקום");
      setIsTracking(false);
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { longitude, latitude, accuracy, altitude } = pos.coords;
        onFix(longitude, latitude, Number.isFinite(accuracy) ? accuracy : null, altitude != null && Number.isFinite(altitude) ? altitude : null, pos.timestamp);
      },
      (err) => {
        alert("שגיאה באיתור מיקום: " + err.message);
        setIsTracking(false);
      },
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
    // recActive: in the app, the notification says "recording" while one is
    // under way, so the watcher is set up again when that changes.
  }, [isTracking, updateUserLocLayer, map, recorderAddFix, recActive]);

  // The dot is a layer on the map style; a style switch wipes it until the
  // next fix. Put it straight back instead.
  useEffect(() => {
    if (gpsPos) updateUserLocLayer(gpsPos.lon, gpsPos.lat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleRev]);

  const offRoute = useOffRouteAlert(
    userOnTrail ? userOnTrail.offTrailM : null,
    gpsPos?.accuracy ?? null,
    trail
  );

  // First-visit help: a short tour the first time the home screen and a trail
  // are seen, and a one-off tip the first time the live location or the drive
  // planner is switched on (components/help). Each is shown once and then
  // remembered on the device; "מדריכים ומידע נוסף" in the settings brings them back.
  // Never on top of something that needs the screen more: a running tour, the
  // off-route alarm, an open window, a hidden UI, a measurement, a trail still
  // loading.
  const [helpTour, setHelpTour] = useState<HelpKey | null>(null);

  // ── The users report ("משתמשים ושימוש") ─────────────────────────────────
  // What was opened and switched on, counted once each time it starts
  // (lib/track; the names and their Hebrew labels are in lib/appEvents).
  useEffect(() => { track('app_open', { native: isNativeApp() }); }, []);
  useEffect(() => {
    if (!trail) return;
    const kind = trailSource?.kind;
    const inWorld = kind === 'wmt' || (trailSource?.kind === 'pack' && /^wmt:/.test(trailSource.sourceUrl ?? ''));
    track(
      trail.kind === 'drive' || kind === 'drive' ? 'drive_open'
        : kind === 'file' ? 'trail_open_file'
        : inWorld ? 'trail_open_world'
        : 'trail_open_israel',
      { name: trail.name, offline: kind === 'pack' },
    );
    // Once per trail opened, not on every change of its source's details.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail?.coords]);
  const selectedWorldId = worldTrails.selection?.id ?? null;
  useEffect(() => { if (selectedWorldId != null) track('world_card'); }, [selectedWorldId]);
  useEffect(() => { if (isTourActive) track('virtual_tour'); }, [isTourActive]);
  useEffect(() => { if (isGuideEnabled) track('guide_on'); }, [isGuideEnabled]);
  useEffect(() => { if (infoRequest) track('trail_info'); }, [infoRequest]);
  useEffect(() => { if (photoOpen) track('photos_open'); }, [photoOpen]);
  useEffect(() => { if (isTracking) track('live_location'); }, [isTracking]);
  useEffect(() => { if (isMeasuring) track('measure'); }, [isMeasuring]);
  useEffect(() => { if (showPersonalArea) track('personal_area'); }, [showPersonalArea]);
  useEffect(() => { if (helpChatOpen) track('help_chat'); }, [helpChatOpen]);
  useEffect(() => { if (helpTour) track('help_tour', { tour: helpTour }); }, [helpTour]);
  useEffect(() => { if (saveTrailState === 'saved') track('save_trail'); }, [saveTrailState]);
  const signedInId = user && sessionLive ? user.id : null;
  useEffect(() => { if (signedInId) track('sign_in'); }, [signedInId]);
  const helpQuiet = isTourActive || !!offRoute.alert || showSettings || showPersonalArea
    || showGuidePoints || uiHidden || isMeasuring || trailLoading || !!worldTrails.selection
    || recStatus === 'review';
  // Whether the screen still is the one the help was meant for — a shared
  // link can open a trail under the welcome tour. One that no longer fits is
  // simply not drawn, and gives way to whatever is due on the new screen.
  const helpFits = helpTour === 'welcome' ? !trail && appMode === 'trails'
    : helpTour === 'drive' ? !trail && appMode === 'drive'
    : !!trail;
  useEffect(() => {
    if ((helpTour && helpFits) || helpQuiet || !map) return;
    const due: HelpKey | null = trail
      ? (!isDrive && !hasSeen('trail') ? 'trail' : isTracking && !hasSeen('tracking') ? 'tracking' : null)
      : appMode === 'drive' ? (hasSeen('drive') ? null : 'drive')
      : hasSeen('welcome') ? null : 'welcome';
    if (!due) return;
    // Let the screen settle first: a trail flies into view, the list loads.
    const t = setTimeout(() => setHelpTour(due), due === 'tracking' ? 800 : 1500);
    return () => clearTimeout(t);
  }, [map, trail, isDrive, isTracking, appMode, helpQuiet, helpTour, helpFits]);
  const finishHelp = useCallback(() => {
    if (helpTour) markSeen(helpTour);
    setHelpTour(null);
  }, [helpTour]);

  // A measured stretch opened as a trail of its own, and walked: the live
  // location goes on with it. Kept as GPX so it can be saved to
  // the personal area like an uploaded file.
  // The points the walk was measured through, kept with it so they show on the
  // map and in the trail card while it is walked. Tied to the trail by name:
  // opening anything else leaves them behind.
  const [routeWaypoints, setRouteWaypoints] = useState<{ trailName: string; points: MeasureWaypoint[] } | null>(null);
  const activeWaypoints = routeWaypoints && trail && routeWaypoints.trailName === trail.name ? routeWaypoints.points : null;

  const handleMeasureNavigate = useCallback((coords: Coordinate3D[], name: string, waypoints: MeasureWaypoint[]) => {
    setIsMeasuring(false);
    setRouteWaypoints({ trailName: name, points: waypoints });
    loadTrailFromCoords(coords, name, { kind: 'file', content: coordsToGpx(coords, name) }, { kind: 'hike' });
    unlockAudio();
    primeAlarm();
    setIsTracking(true);
  }, [loadTrailFromCoords, unlockAudio]);

  const handleToggleMeasure = useCallback(() => {
    if (!isMeasuring && isTourActive) stopTour();
    setIsMeasuring(!isMeasuring);
  }, [isMeasuring, isTourActive, stopTour]);

  // The record button: starts a recording, or opens the one under way. The
  // live location comes on with it; if it was off before, it goes off again
  // when the recording is saved or thrown away.
  const trackingBeforeRecRef = useRef(false);
  const handleRecord = useCallback(() => {
    if (recStatus !== 'idle') {
      setRecOpenSignal((n) => n + 1);
      return;
    }
    trackingBeforeRecRef.current = isTracking;
    if (!isTracking) centerOnNextFixRef.current = true;
    setIsTracking(true);
    recStart();
    track('record_start');
  }, [recStatus, recStart, isTracking]);

  // A recording brought back after the page was dropped needs the location
  // on again to go on.
  useEffect(() => {
    if (recStatus === 'recording' && !isTracking) setIsTracking(true);
    // Only when a recording (re)starts, not every time the location is switched off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recStatus]);

  const endRecording = useCallback(() => {
    if (!trackingBeforeRecRef.current) setIsTracking(false);
  }, []);

  const handleSaveRecording = useCallback(async (name: string) => {
    const rec = await recSave(name, user?.id ?? null);
    if (!rec) return;
    track('record_save');
    endRecording();
    setToast('ההקלטה נשמרה — היא באזור האישי, בלשונית ״הקלטות״.');
    if (user && sessionLive && online) upsertRecording(rec, user.id).catch((e) => console.error('Recording upload failed:', e));
  }, [recSave, user, sessionLive, online, endRecording]);

  // Thrown away from the summary.
  const prevRecStatusRef = useRef(recStatus);
  useEffect(() => {
    if (prevRecStatusRef.current === 'review' && recStatus === 'idle') endRecording();
    prevRecStatusRef.current = recStatus;
  }, [recStatus, endRecording]);

  const handleLoadRecording = useCallback((rec: Recording) => {
    setShowPersonalArea(false);
    loadTrailFromCoords(recordingCoords(rec), rec.name, { kind: 'file', content: recordingToGpx(rec) }, { kind: 'hike' });
  }, [loadTrailFromCoords]);

  // "כבה מיקום חי" while recording: the recording cannot go on without it.
  const handleStopTracking = useCallback(() => {
    if (recStatus === 'recording') {
      if (!window.confirm('ההקלטה פעילה. כיבוי המיקום ישהה אותה. להמשיך?')) return;
      recPause();
    }
    setIsTracking(false);
  }, [recStatus, recPause]);

  // The trail on screen is kept on the device, so that when Android drops the
  // page while another app is in front, coming back reopens it — points and
  // all, no network needed — instead of landing on the home screen. Closing
  // the trail forgets it. (Not on the very first render: there is no trail
  // yet then, and forgetting would wipe the one about to be brought back.)
  const hadTrailRef = useRef(false);
  useEffect(() => {
    if (trail) {
      hadTrailRef.current = true;
      rememberOpenTrail(trail, trailSource, isTracking);
    } else if (hadTrailRef.current) {
      forgetOpenTrail();
    }
  }, [trail, trailSource, isTracking]);

  const restoreOpenTrail = useCallback(() => {
    const kept = recallOpenTrail();
    if (!kept) return;
    // A file's text was not kept; the points are the same trail written out.
    const source: TrailSource = kept.source && kept.source.kind !== 'file'
      ? kept.source
      : { kind: 'file', content: coordsToGpx(kept.coords, kept.name) };
    if (source.kind === 'drive') setLastDrivePlan({ from: source.from, to: source.to, vias: source.vias ?? [] });
    loadTrailFromCoords(kept.coords, kept.name, source, { kind: kept.kind, driveDurationSec: kept.driveDurationSec });
    // The live location was on: it goes back on. The permission was given
    // already, so no tap is needed for it.
    if (kept.tracking) setIsTracking(true);
  }, [loadTrailFromCoords, setIsTracking]);

  // The trails looked at lately, for the history button on the home screen:
  // every trail opened on the map, and every world trail whose card was shown.
  useEffect(() => {
    if (trail && trailSource) rememberRecentTrail(trail, trailSource);
  }, [trail, trailSource]);
  const viewedWorldId = worldTrails.selection?.details ? worldTrails.selection.id : null;
  const viewedWorldName = worldTrails.selection?.details?.name ?? worldTrails.selection?.summary?.name ?? null;
  const viewedWorldSummary = worldTrails.selection?.summary ?? null;
  useEffect(() => {
    if (viewedWorldId == null) return;
    rememberRecentWorldTrail(viewedWorldId, viewedWorldName ?? `מסלול ${viewedWorldId}`, viewedWorldSummary);
    // Once per trail shown, not again as its elevation comes in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewedWorldId]);
  const openRecent = useCallback((item: RecentTrail) => {
    if (item.type === 'world') {
      setCardFromList(false);
      enableWorldTrails();
      selectWorldTrail(item.id, item.summary, { fit: true });
      return;
    }
    const { source } = item;
    const src: TrailSource = source.kind === 'file'
      ? { kind: 'file', content: coordsToGpx(item.coords, item.name) }
      : source;
    const fromKept = () => loadTrailFromCoords(item.coords, item.name, src, { kind: item.kind });
    // A long trail was kept thinned: with reception it is fetched whole again.
    if (item.thinned && online) {
      if (source.kind === 'url') { loadTrailFromUrl(source.url, item.name); return; }
      if (source.kind === 'wmt') {
        enableWorldTrails();
        void loadWorldTrailById(source.id, source.parent).then((ok) => { if (!ok) fromKept(); });
        return;
      }
    }
    fromKept();
  }, [enableWorldTrails, selectWorldTrail, online, loadTrailFromUrl, loadWorldTrailById, loadTrailFromCoords]);

  // A copy of the personal area on the device, refreshed whenever there is a
  // live sign-in and reception — so the saved trails are there in the field
  // even if the personal area was never opened since they were saved. Their
  // GPX files are fetched once too, for the service worker to keep.
  const userId = user?.id ?? null;
  const justSaved = saveTrailState === 'saved';
  useEffect(() => {
    if (!userId || !sessionLive || !online) return;
    let cancelled = false;
    Promise.all([listSavedTrails(), listTourHistory(), listTrailNotes()])
      .then(([trails, history, notes]) => {
        if (cancelled) return;
        cachePersonalData(userId, { trails, history, notes });
        warmSavedTrailFiles(trails);
      })
      .catch(() => {}); // the copy from last time stands
    return () => { cancelled = true; };
  }, [userId, sessionLive, online, justSaved]);

  // Recordings made with no reception, or before signing in, go up to the
  // account as soon as it can be reached.
  useEffect(() => {
    if (!userId || !sessionLive || !online) return;
    syncRecordings(userId).catch(() => {}); // tried again next time
  }, [userId, sessionLive, online]);

  // Open a shared trail link: /?trail=<encoded url> auto-loads that trail
  const didLoadFromUrlRef = useRef(false);
  useEffect(() => {
    if (didLoadFromUrlRef.current) return;
    didLoadFromUrlRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('trail');
    const sharedWmt = params.get('wmt');
    const sharedDrive = decodeDrive(params.get('drive'));
    const sharedWalk = params.get('walk');
    if (sharedWalk && /^[0-9a-f-]{36}$/i.test(sharedWalk)) {
      // A recording someone shared (lib/recording/share.ts, api/walk).
      window.history.replaceState({}, '', window.location.pathname);
      fetch(`/api/walk?id=${sharedWalk}`)
        .then(async (res) => {
          if (res.status === 404) throw new Error('gone');
          if (!res.ok) throw new Error(String(res.status));
          const walk = await res.json() as { name: string; gpx: string };
          loadTrailFromText(walk.gpx, walk.name);
        })
        .catch((e) => alert(e?.message === 'gone'
          ? 'ההקלטה הזו כבר לא משותפת, או שנמחקה.'
          : 'לא הצלחנו לפתוח את ההקלטה ששותפה. נסו שוב כשיש קליטה.'));
    } else if (shared) {
      loadTrailFromUrl(shared);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (sharedWmt && /^\d+$/.test(sharedWmt)) {
      worldTrails.loadById(Number(sharedWmt));
      window.history.replaceState({}, '', window.location.pathname);
    } else if (sharedDrive) {
      writeAppMode('drive');
      // Once, on arrival: what the address and the device hold decide the
      // first screen.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      openDriveFromLink(sharedDrive);
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      restoreOpenTrail();
    }
  }, [loadTrailFromUrl, loadTrailFromText, worldTrails, openDriveFromLink, restoreOpenTrail]);

  // Share the current trail (only trails that can be re-opened from a link)
  const handleShare = useCallback(async () => {
    if (!trail || !trailSource || trailSource.kind === 'file') return;
    // A pack shares as the URL it came from; one that came from a file
    // cannot be shared, like the file itself.
    const packUrl = trailSource.kind === 'pack' ? trailSource.sourceUrl : null;
    if (trailSource.kind === 'pack' && !packUrl) return;
    const shareUrl = trailSource.kind === 'url' || packUrl
      ? `${window.location.origin}/?trail=${encodeURIComponent(trailSource.kind === 'url' ? trailSource.url : packUrl!)}`
      : trailSource.kind === 'wmt'
        ? `${window.location.origin}/?wmt=${trailSource.id}`
        : trailSource.kind === 'drive'
          ? `${window.location.origin}/?drive=${encodeURIComponent(encodeDrive({ from: trailSource.from, to: trailSource.to, vias: trailSource.vias ?? [] }))}`
          : '';
    if (!shareUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: `מסלול: ${trail.name}`, text: `בוא לטייל ב${trail.name} עם Navi`, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        alert('הקישור למסלול הועתק ללוח 📋');
      }
    } catch (e) {
      // user cancelled the share sheet — ignore
    }
  }, [trail, trailSource]);

  const handleZoomIn = useCallback(() => map?.zoomIn(), [map]);
  const handleZoomOut = useCallback(() => map?.zoomOut(), [map]);
  const handleCompass = useCallback(() => map?.easeTo({ bearing: 0, pitch: map.getPitch(), duration: 800 }), [map]);
  const handleFitToTrail = useCallback(() => {
    if (!map || !trail) return;
    const lons = trail.coords.map(c => c[1]);
    const lats = trail.coords.map(c => c[0]);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, duration: 1200, pitch: is3D ? 45 : 0 }
    );
  }, [map, trail, is3D]);

  // Render trail cleanly via useEffect to avoid rendering phase side-effects
  const currentTrailIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Closed, a trail is forgotten here: opened again (from "חזרה ל…"),
    // it is framed again like any new one.
    if (!trail) currentTrailIdRef.current = null;
    if (!map || !trail) return;

    const addTrailLayers = () => {
      // Remove previous layers/sources if they exist
      if (map.getLayer('route-line')) map.removeLayer('route-line');
      if (map.getLayer('route-casing')) map.removeLayer('route-casing');
      if (map.getSource('route')) map.removeSource('route');
      if (map.getLayer('fly-ring')) map.removeLayer('fly-ring');
      if (map.getLayer('fly-dot')) map.removeLayer('fly-dot');
      if (map.getSource('fly-pos')) map.removeSource('fly-pos');

      const geoJson = trail.geoJson;
      
      map.addSource('route', { type: 'geojson', data: geoJson as any });
      // A dark edge under the line, so the open trail stands out from every
      // other line on the map — roads, and the world trails overlay (which
      // fades to grey while a trail is open, see useWorldTrails).
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#18181b', 'line-width': 10, 'line-opacity': 0.85 }
      });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': trail.kind === 'drive' ? '#3b82f6' : '#f97316', 'line-width': 6 }
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
        map.fitBounds(bounds, { padding: 80, duration: 1500, pitch: is3DRef.current ? 45 : 0 });
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
            if (map.getLayer('route-casing')) map.removeLayer('route-casing');
            if (map.getSource('route')) map.removeSource('route');
            if (map.getLayer('fly-ring')) map.removeLayer('fly-ring');
            if (map.getLayer('fly-dot')) map.removeLayer('fly-dot');
            if (map.getSource('fly-pos')) map.removeSource('fly-pos');
          }
        } catch(e) {}
      }
    };
  }, [map, trail, styleRev]);

  // Render discovered POI markers (with Hebrew labels) on the map
  useEffect(() => {
    if (!map) return;

    const syncPoiLayers = () => {
      if (!map.getStyle()) return;
      const fc = {
        type: 'FeatureCollection',
        features: enrichedPois.map((p, i) => ({
          type: 'Feature',
          properties: { label: p.name ? `${p.type} · ${p.name}` : p.type, poiIdx: i },
          geometry: { type: 'Point', coordinates: [p.coord[1], p.coord[0]] },
        })),
      };
      if (!map.getSource('trail-pois')) {
        map.addSource('trail-pois', { type: 'geojson', data: fc as any });
        map.addLayer({
          id: 'trail-poi-dot', type: 'circle', source: 'trail-pois',
          paint: {
            'circle-radius': 6,
            'circle-color': '#22d3ee',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
        map.addLayer({
          id: 'trail-poi-label', type: 'symbol', source: 'trail-pois',
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 12,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#e0f2fe',
            'text-halo-color': '#0c4a6e',
            'text-halo-width': 1.5,
          },
        });
      } else {
        (map.getSource('trail-pois') as mapboxgl.GeoJSONSource).setData(fc as any);
      }
    };

    // Tapping a point replays its narration. Once it has been narrated it
    // costs nothing to hear again — the audio is already cached, so this works
    // offline too.
    const handlePoiClick = (e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] }) => {
      const idx = e.features?.[0]?.properties?.poiIdx;
      if (typeof idx !== 'number') return;
      const poi = enrichedPois[idx];
      if (poi) playPoiNow(poi);
    };
    const showPointer = () => { map.getCanvas().style.cursor = 'pointer'; };
    const hidePointer = () => { map.getCanvas().style.cursor = ''; };

    try { syncPoiLayers(); } catch (e) {}
    map.on('style.load', syncPoiLayers);
    map.on('click', 'trail-poi-dot', handlePoiClick);
    map.on('mouseenter', 'trail-poi-dot', showPointer);
    map.on('mouseleave', 'trail-poi-dot', hidePointer);
    return () => {
      map.off('style.load', syncPoiLayers);
      map.off('click', 'trail-poi-dot', handlePoiClick);
      map.off('mouseenter', 'trail-poi-dot', showPointer);
      map.off('mouseleave', 'trail-poi-dot', hidePointer);
    };
  }, [map, enrichedPois, styleRev, playPoiNow]);

  // The points a measured walk was made through, lettered as they were when
  // it was measured.
  useEffect(() => {
    if (!map) return;
    const pts = activeWaypoints ?? [];
    const sync = () => {
      if (!map.getStyle()) return;
      const fc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
        type: 'FeatureCollection',
        features: pts.map((p) => ({ type: 'Feature', properties: { label: p.label }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
      };
      if (!map.getSource('route-waypoints')) {
        map.addSource('route-waypoints', { type: 'geojson', data: fc });
        map.addLayer({
          id: 'route-waypoints-dot', type: 'circle', source: 'route-waypoints',
          paint: { 'circle-radius': 11, 'circle-color': '#18181b', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
        });
        map.addLayer({
          id: 'route-waypoints-label', type: 'symbol', source: 'route-waypoints',
          layout: { 'text-field': ['get', 'label'], 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'], 'text-size': 13, 'text-allow-overlap': true },
          paint: { 'text-color': '#ffffff' },
        });
      } else {
        (map.getSource('route-waypoints') as mapboxgl.GeoJSONSource).setData(fc);
      }
    };
    try { sync(); } catch {}
    map.on('style.load', sync);
    return () => { map.off('style.load', sync); };
  }, [map, activeWaypoints, styleRev]);

  // Water sources along the trail. Drawn in the same shape as the POI layer
  // above, but kept as its own source so the two do not fight over labels, and
  // coloured by whether we can stand behind it: a confirmed pool or perennial
  // stream is solid blue, a spring or an unverified polygon is hollow. The
  // hollow ones are on the map because they are the best information there is,
  // not because they are a promise of water — same distinction the panel makes.
  // The two ends of a drive being planned, as pins with names. Cleared once
  // the drive opens (the planner unmounts and the route has its own marker).
  useEffect(() => {
    if (!map) return;
    const ends = trail ? [] : [
      drivePreview.from && { ...drivePreview.from, role: 'מוצא' },
      ...drivePreview.vias.map((v, i) => v && { ...v, role: `עצירה ${i + 1}` }),
      drivePreview.to && { ...drivePreview.to, role: 'יעד' },
    ].filter((p): p is DrivePlace & { role: string } => !!p);

    const syncDriveEnds = () => {
      if (!map.getStyle()) return;
      const fc: GeoJSON.FeatureCollection<GeoJSON.Point> = {
        type: 'FeatureCollection',
        features: ends.map((p) => ({
          type: 'Feature',
          properties: { label: `${p.role} · ${p.name}` },
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        })),
      };
      if (!map.getSource('drive-ends')) {
        map.addSource('drive-ends', { type: 'geojson', data: fc });
        map.addLayer({
          id: 'drive-ends-dot', type: 'circle', source: 'drive-ends',
          paint: { 'circle-radius': 7, 'circle-color': '#3b82f6', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
        });
        map.addLayer({
          id: 'drive-ends-label', type: 'symbol', source: 'drive-ends',
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 12,
            'text-offset': [0, -1.4],
            'text-anchor': 'bottom',
          },
          paint: { 'text-color': '#dbeafe', 'text-halo-color': '#1e3a8a', 'text-halo-width': 1.5 },
        });
      } else {
        (map.getSource('drive-ends') as mapboxgl.GeoJSONSource).setData(fc);
      }
      if (ends.length >= 2) {
        const bounds = new mapboxgl.LngLatBounds();
        ends.forEach((p) => bounds.extend([p.lon, p.lat]));
        map.fitBounds(bounds, { padding: 100, duration: 1000, maxZoom: 12 });
      } else if (ends.length === 1) {
        map.easeTo({ center: [ends[0].lon, ends[0].lat], zoom: Math.max(map.getZoom(), 10), duration: 800 });
      }
    };

    try { syncDriveEnds(); } catch {}
    map.on('style.load', syncDriveEnds);
    return () => { map.off('style.load', syncDriveEnds); };
  }, [map, drivePreview, trail, styleRev]);

  useEffect(() => {
    if (!map) return;

    const points = water?.points ?? [];

    const syncWaterLayers = () => {
      if (!map.getStyle()) return;
      const fc = {
        type: 'FeatureCollection',
        features: points.map((p) => ({
          type: 'Feature',
          properties: {
            label: p.name ? `${p.label} · ${p.name}` : p.label,
            confident: p.counted ? 1 : 0,
          },
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        })),
      };
      if (!map.getSource('trail-water')) {
        map.addSource('trail-water', { type: 'geojson', data: fc as any });
        map.addLayer({
          id: 'trail-water-dot', type: 'circle', source: 'trail-water',
          paint: {
            'circle-radius': 6,
            'circle-color': ['case', ['==', ['get', 'confident'], 1], '#0ea5e9', '#1e293b'],
            'circle-stroke-color': ['case', ['==', ['get', 'confident'], 1], '#e0f2fe', '#7dd3fc'],
            'circle-stroke-width': 2,
          },
        });
        map.addLayer({
          id: 'trail-water-label', type: 'symbol', source: 'trail-water',
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 12,
            'text-offset': [0, -1.4],
            'text-anchor': 'bottom',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#e0f2fe',
            'text-halo-color': '#082f49',
            'text-halo-width': 1.5,
          },
        });
      } else {
        (map.getSource('trail-water') as mapboxgl.GeoJSONSource).setData(fc as any);
      }
    };

    try { syncWaterLayers(); } catch (e) {}
    map.on('style.load', syncWaterLayers);
    return () => { map.off('style.load', syncWaterLayers); };
  }, [map, water, styleRev]);

  // Changing between trails and a drive starts the map afresh: the drive's
  // pins and route options, a half-done measurement, a tapped world trail and
  // a searched-for place all belong to the side that was left.
  const switchAppMode = (mode: AppMode) => {
    if (mode === appMode) return;
    writeAppMode(mode);
    setDrivePreview({ from: null, to: null, vias: [] });
    setLastDrivePlan(null);
    setIsMeasuring(false);
    worldTrails.clearSelection();
  };

  // A button under a help-chat answer (lib/helpChat/actions.ts): the same
  // thing the button it talks about does. The chat has closed itself first,
  // so a tour or a panel opened here is not put away by it.
  const helpChatHidden = uiHidden || isTourActive || isMeasuring || recStatus === 'review'
    || !!(helpTour && helpFits && !helpQuiet);
  const runHelpAction = (id: HelpActionId) => {
    switch (id) {
      case 'openDiscovery': setDiscoveryOpen((n) => n + 1); break;
      case 'openWorldTrails': worldTrails.enable(); break;
      case 'openHikerHeat': if (!hikerHeat.enabled) showHikerHeat(); break;
      case 'openDrive': switchAppMode('drive'); break;
      case 'planRoute': if (!isMeasuring) handleToggleMeasure(); break;
      case 'locate': handleLocateUser(); break;
      case 'record': handleRecord(); break;
      case 'openGuidePoints': setShowGuidePoints(true); break;
      case 'startVirtualTour':
        if (isTourActive) break;
        unlockAudio();
        if (progress === 0 || progress >= 1) resetGeofence();
        startTour();
        break;
      case 'openSettings': setShowSettings(true); break;
      case 'openRecordings': setPersonalTab('recordings'); setShowPersonalArea(true); break;
      case 'showTour': setHelpTour(trail ? 'trail' : appMode === 'drive' ? 'drive' : 'welcome'); break;
    }
  };

  // Text in the panels and cards can be selected and copied — a village's
  // name to look up, a place from "על המסלול". The map and the button rails
  // are not (Map.tsx, Controls.tsx): there a long press is a gesture.
  return (
    <div className="w-full h-dvh relative bg-zinc-900 overflow-hidden m-0 p-0 touch-none" dir="rtl">
      {/* Map Engine Layer */}
      <MemoizedMapComponent onMapLoad={handleMapLoad} />

      {/* Where in the world to look — on both home screens, and over an open
          trail too: a village named in "על המסלול", the way to the start.
          A place picked there only moves the map and gets a pin; the trail
          stays as it is. */}
      {map && !uiHidden && !isMeasuring && (
        <PlaceSearchBox
          // A new one for each mode, so the pin of a place searched on the
          // other side goes with it.
          key={appMode}
          map={map}
          // Clear of the left rail, which is at its widest with the button
          // labels showing, and of the trail panel on a wide screen.
          className="top-3 left-[124px] right-4 md:left-20 md:right-[412px]"
          // Trails are found by name only where trails are being looked for.
          // A route picked from the list should be visible on the map, so the
          // world trails layer is switched on with it.
          onPickTrail={appMode === 'trails' && !trail ? (t) => {
            setCardFromList(false);
            worldTrails.enable();
            worldTrails.select(t.id, t, { fit: true });
          } : undefined}
          accessory={appMode === 'trails' && !trail
            ? <RecentTrailsButton onPick={openRecent} />
            : undefined}
        />
      )}

      {/* Trail Discovery overlay with markers & GPX upload fallback.
          The home panels are hidden rather than unmounted for "map only" and
          while a tapped world trail's card takes their place at the bottom of
          the screen: the trail markers stay on the map, and a half-planned
          drive or a filtered list is still there when they come back. */}
      {map && !trail && appMode === 'trails' && !isMeasuring && (
        <div className={uiHidden || worldTrails.selection ? 'hidden' : 'contents'}>
          <MemoizedTrailDiscovery 
            map={map} 
            onSelectTrail={loadTrailFromUrl} 
            onFileLoad={loadTrailFile} 
            loading={trailLoading} 
            error={trailError} 
            styleRev={styleRev}
            offlinePacks={mapPacks}
            onSelectPack={openPack}
            online={online}
            onPickWorldTrail={pickFromList}
            onCountryView={viewCountry}
            openSignal={discoveryOpen}
          />
        </div>
      )}
      {map && !trail && appMode === 'drive' && !isMeasuring && (
        <div className={uiHidden || worldTrails.selection ? 'hidden' : 'contents'}>
          <DrivePlanner map={map} onRoute={openDrive} onPreview={handleDrivePreview} initial={lastDrivePlan} onClose={() => switchAppMode('trails')} />
        </div>
      )}

      {/* Restore button — the only chrome that survives "map only" mode */}
      {uiHidden && (
        <button
          onClick={() => setUiHidden(false)}
          className="absolute top-3 right-3 z-[60] h-10 px-3 gap-1.5 flex items-center justify-center bg-zinc-900/90 text-amber-400 rounded-2xl border border-white/10 backdrop-blur-md shadow-xl"
          title="הצג שוב את הנתונים על המפה"
          dir="rtl"
        >
          <EyeOff className="w-[18px] h-[18px]" />
          <span className="text-sm font-bold">הצג הכל</span>
        </button>
      )}

      {/* Stats UI Layer */}
      {trail && !uiHidden && !isMeasuring && (
        <MemoizedStatsPanel trail={trail} progress={progress} onClose={closeTrail} isTourActive={isTourActive} shade={shade} shadeLoading={shadeLoading} water={water} waterStatus={waterStatus} userPos={userOnTrail} weather={tripWeather} climate={trailClimate} waypoints={activeWaypoints} onShowInfo={openTrailInfo ? showOpenTrailInfo : undefined} inIsrael={trailInIsrael === true} stages={trailStages} worldId={openWmtId} photos={photoHandlers} />
      )}

      {/* Measuring: the floating pin and its panel. Keyed by the trail so
          opening or leaving one starts the measurement afresh. */}
      {map && isMeasuring && !uiHidden && (
        <MeasureTool
          key={trail?.name ?? 'free'}
          map={map}
          trail={trail}
          styleRev={styleRev}
          onClose={() => setIsMeasuring(false)}
          onNavigate={handleMeasureNavigate}
        />
      )}

      {/* Recording a walk: its line on the map, the bar under the search,
          and the summary when it is finished. Mounted while a recording
          exists — "hide all" hides the bar but keeps the line. */}
      {map && recActive && (
        <RecordPanel
          map={map}
          rec={recorder}
          styleRev={styleRev}
          openSignal={recOpenSignal}
          hidden={uiHidden}
          nativeApp={isNativeApp()}
          gpsOn={isTracking}
          onSave={handleSaveRecording}
        />
      )}
      {toast && !uiHidden && (
        <button
          onClick={() => setToast(null)}
          className="absolute bottom-[calc(var(--bottom-stack-h,0px)_+_12px)] left-1/2 -translate-x-1/2 z-50 max-w-[calc(100%-24px)] bg-zinc-900/95 text-white text-sm font-bold px-4 py-2.5 rounded-2xl border border-white/15 backdrop-blur-md shadow-xl"
          dir="rtl"
        >
          {toast}
        </button>
      )}

      {/* Strayed off the route: said once, loudly, until back on it */}
      {/* The admin's alone: the server answers 403 to everyone else. */}
      <CreditsAlert signedInAs={sessionLive ? user?.id ?? null : null} />

      {offRoute.alert && (
        <div className={`absolute top-16 inset-x-3 md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:w-[400px] z-[55] bg-red-600 text-white rounded-2xl shadow-2xl border border-red-300/40 p-3 flex items-center gap-2 ${offRoute.alert.silenced ? '' : 'animate-pulse'}`} dir="rtl" role="alert">
          <TriangleAlert className="w-7 h-7 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm">סטית מהמסלול</div>
            <div className="text-xs text-white">
              {offRoute.alert.distanceM >= 1000 ? `${(offRoute.alert.distanceM / 1000).toFixed(1)} ק״מ` : `${offRoute.alert.distanceM} מ׳`} מהתוואי
            </div>
          </div>
          {gpsPos && map && (
            <button
              onClick={() => map.easeTo({ center: [gpsPos.lon, gpsPos.lat], zoom: Math.max(map.getZoom(), 15), duration: 800 })}
              className="p-2 rounded-xl bg-white/15 hover:bg-white/25"
              aria-label="הצג את המיקום שלי"
            >
              <LocateFixed className="w-4 h-4" />
            </button>
          )}
          {!offRoute.alert.silenced && (
            <button onClick={offRoute.silence} className="flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-xl bg-white text-red-700">
              <VolumeX className="w-4 h-4" /> השתק
            </button>
          )}
          <button onClick={offRoute.dismiss} className="text-xs font-bold px-3 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white">סגור</button>
        </div>
      )}

      {/* Map Controls */}
      {!uiHidden && <MemoizedControls 
        onStyleChange={handleStyleChange}
        offlineStyleKey={!online && trail ? packStyleKey : null}
        onToggle3D={handleToggle3D}
        is3D={is3D}
        onToggleTour={() => {
          if (isTourActive) {
            stopTour();
          } else {
            unlockAudio();
            if (progress === 0 || progress >= 1) resetGeofence();
            startTour();
          }
        }}
        isTourActive={isTourActive}
        tourSpeed={tourSpeed}
        onTourSpeedChange={setTourSpeed}
        onLocateUser={handleLocateUser}
        isTracking={isTracking}
        onMeasure={handleToggleMeasure}
        isMeasuring={isMeasuring}
        onRecord={handleRecord}
        recStatus={recStatus}
        onDrive={trail ? undefined : () => switchAppMode(appMode === 'drive' ? 'trails' : 'drive')}
        isDriving={appMode === 'drive'}
        map={map}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onCompass={handleCompass}
        mapBearing={mapBearing}
        onFitToTrail={handleFitToTrail}
        hasTrail={!!trail}
        onHome={closeTrail}
        tourProgress={progress}
        onOpenSettings={() => setShowSettings(true)}
        isGuideEnabled={isGuideEnabled}
        onToggleGuide={isDrive ? undefined : handleToggleGuide}
        onOpenGuidePoints={isDrive ? undefined : () => setShowGuidePoints(true)}
        guidePointCount={enrichedPois.length}
        onHideUI={() => setUiHidden(true)}
        showWorldTrails={worldTrails.enabled}
        onToggleWorldTrails={worldTrails.toggle}
        showHikerHeat={hikerHeat.enabled}
        onToggleHikerHeat={toggleHikerHeat}
        hikerHeatCountries={hikerHeat.countries?.length ?? null}
      />}

      {/* "שאלו את Navi". Hidden rather than unmounted with "הסתר הכל", like
          the other panels; out of the way of a running tour, a measurement,
          a recording's summary and the first-visit help. */}
      <div className={helpChatHidden ? 'hidden' : 'contents'}>
        <HelpChat
          screen={{
            hasTrail: !!trail,
            driveTrail: isDrive,
            mode: appMode,
            recording: recActive,
            nativeApp: isNativeApp(),
            inIsrael: trailInIsrael === true,
          }}
          online={online}
          open={helpChatOpen && !helpChatHidden}
          onOpenChange={setHelpChatOpen}
          onAction={runHelpAction}
          onPoint={setHelpPoint}
        />
      </div>

      {/* A trail photo on the whole screen, above the card and the rails. */}
      {photoView && !uiHidden && (
        <PhotoViewer
          photos={photoView.photos}
          index={photoView.index}
          onIndex={(index) => setPhotoView({ photos: photoView.photos, index })}
          onClose={() => setPhotoView(null)}
          onShowOnMap={showPhotoOnMap}
        />
      )}

      {/* A tapped route in the world trails overlay */}
      {worldTrails.selection && !uiHidden && (
        <WorldTrailCard
          // A new card always opens unfolded.
          key={worldTrails.selection.id}
          selection={worldTrails.selection}
          onClose={() => { setCardFromList(false); worldTrails.clearSelection(); }}
          onLoad={() => {
            trailFromListRef.current = cardFromList;
            setCardFromList(false);
            setLastClosed(null);
            worldTrails.loadSelected();
          }}
          onBackToList={cardFromList ? () => {
            setCardFromList(false);
            worldTrails.clearSelection();
            setDiscoveryOpen((n) => n + 1);
          } : undefined}
          onShowInfo={() => setInfoRequest({
            kind: 'wmt',
            id: worldTrails.selection!.id,
            name: worldTrails.selection!.details?.name ?? worldTrails.selection!.summary?.name,
          })}
          onPickStage={(stage) => {
            const sel = worldTrails.selection!;
            worldTrails.select(
              stage.id,
              stage.name ? { type: 'relation', id: stage.id, name: stage.name, group: '', linear: 'yes' } : null,
              { fit: true, cameFrom: { id: sel.id, name: sel.details?.name ?? sel.summary?.name ?? null } },
            );
          }}
          siblings={worldSiblings?.stages.length ? worldSiblings.stages : null}
          onStep={(stage) => {
            worldTrails.select(
              stage.id,
              stage.name ? { type: 'relation', id: stage.id, name: stage.name, group: '', linear: 'yes' } : null,
              { fit: true, cameFrom: worldTrails.selection!.parent ?? undefined },
            );
          }}
          onBackToParent={() => {
            const parent = worldTrails.selection!.parent!;
            worldTrails.select(
              parent.id,
              parent.name ? { type: 'relation', id: parent.id, name: parent.name, group: '', linear: 'yes' } : null,
              { fit: true },
            );
          }}
        />
      )}
      {infoRequest && <TrailInfoPanel key={trailInfoKey(infoRequest)} request={infoRequest} onClose={() => setInfoRequest(null)} />}
      {/* The trail just closed, one tap from coming back — below the place
          search, where a closed trail's reader is likely looking. */}
      {lastClosed && !trail && !uiHidden && !isMeasuring && !worldTrails.selection && !recActive && (
        <div className="absolute top-[60px] right-4 md:top-[68px] md:right-[412px] z-40 flex items-center gap-1 bg-zinc-900/90 border border-white/15 rounded-full shadow-xl backdrop-blur-md max-w-[calc(100%-140px)] md:max-w-sm" dir="rtl">
          <button
            onClick={reopenLastTrail}
            className="flex items-center gap-1.5 min-w-0 pr-3 pl-1 py-2 text-sm font-bold text-white"
          >
            <Undo2 className="w-4 h-4 shrink-0 text-orange-400" />
            <span className="truncate">חזרה ל<bdi>{lastClosed.trail.name}</bdi></span>
          </button>
          <button onClick={() => setLastClosed(null)} className="p-2 shrink-0 text-white" aria-label="הסתר">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {worldTrails.hint && (
        // Below the place search, which used to be hidden under it.
        <div className="absolute top-[60px] md:top-[68px] left-1/2 -translate-x-1/2 z-50 bg-zinc-900/90 text-white text-xs font-bold px-4 py-2 rounded-full border border-white/10 backdrop-blur-md shadow-xl pointer-events-none" dir="rtl">
          {worldTrails.hint}
        </div>
      )}

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          help={
            <HelpSection
              // An open drive has no tour of its own.
              onReplay={isDrive ? undefined : () => {
                setShowSettings(false);
                setHelpTour(trail ? 'trail' : appMode === 'drive' ? 'drive' : 'welcome');
              }}
              onReset={resetOnboarding}
            />
          }
        >
          <SettingsActions
            authAvailable={isAuthAvailable}
            isSignedIn={!!user}
            onAuthClick={() => { setShowSettings(false); if (user) { setPersonalTab(undefined); setShowPersonalArea(true); } else signInWithGoogle(); }}
            onOpenRecordings={() => { setShowSettings(false); setPersonalTab('recordings'); setShowPersonalArea(true); }}
            hasTrail={!!trail}
            onSaveTrail={handleSaveTrail}
            saveTrailState={saveTrailState}
            canShare={!!trailSource && trailSource.kind !== 'file' && !(trailSource.kind === 'pack' && !trailSource.sourceUrl)}
            onShare={() => { setShowSettings(false); handleShare(); }}
            isTracking={isTracking}
            onStopTracking={handleStopTracking}
          />
        </SettingsPanel>
      )}

      {/* Personal area modal */}
      {showPersonalArea && (
        <PersonalArea
          user={user}
          initialTab={personalTab}
          authAvailable={isAuthAvailable}
          onLoadRecording={handleLoadRecording}
          sessionLive={sessionLive}
          online={online}
          onSignIn={signInWithGoogle}
          onClose={() => setShowPersonalArea(false)}
          onSignOut={() => { clearPersonalCache(); signOut(); setShowPersonalArea(false); }}
          onLoadSavedTrail={handleLoadSavedTrail}
        />
      )}

      {/* Narration points in this trail */}
      {showGuidePoints && trail && (
        <GuidePointsPanel
          trail={trail}
          pois={enrichedPois}
          onClose={() => setShowGuidePoints(false)}
          onPlay={playPoiNow}
          offlineStateFor={(poi) => (offlineTrail.isSaved(poi) ? 'saved' : 'missing')}
          poiSource={poiSource}
          poiDiscoveryFailed={poiDiscoveryFailed}
          onRetryDiscovery={retryPoiDiscovery}
          offline={{
            savedCount: offlineTrail.savedCount,
            total: offlineTrail.total,
            status: offlineTrail.status,
            phase: offlineTrail.phase,
            message: offlineTrail.message,
            progress: offlineTrail.progress,
            mapPack: offlineTrail.mapPack,
            mapProgress: offlineTrail.mapProgress,
            estimate: offlineTrail.estimate,
            mapDaysLeft: offlineTrail.mapDaysLeft,
            mapExpired: offlineTrail.mapExpired,
            online,
            onDownload: offlineTrail.download,
            onCancel: offlineTrail.cancel,
            onDelete: offlineTrail.remove,
          }}
        />
      )}

      {/* Bottom stack — the narration card sits *above* the tour transport, so
          the transcript can never cover the speed buttons the way it used to. */}
      {trail && !uiHidden && !isMeasuring && (
        <div ref={bottomStackRef} className="absolute bottom-0 inset-x-0 z-50 flex flex-col items-center gap-2 px-3 pb-3 pointer-events-none">
          {!isDrive && <AIAssistantUI
            isLoading={isLoading}
            isSpeaking={isSpeaking}
            currentScript={currentScript}
            onStop={stopSpeaking}
            guideEnabled={isGuideEnabled}
            onToggleGuide={handleToggleGuide}
            hasPoints={enrichedPois.length > 0}
            queueLength={queueLength}
            voice={currentVoice}
            voiceFromDevice={currentFromDevice}
            voiceNotice={voiceNotice}
          />}
          <div className="flex items-center gap-2">
          {!isDrive && !isLoading && !currentScript && enrichedPois.length === 0 && (
            <NoGuidePointsHint state={noPointsState} onRetry={retryPoiDiscovery} />
          )}
          <MemoizedBottomBar
            hasTrail={!!trail}
            trailKind={trail.kind}
            isTourActive={isTourActive}
            tourSpeed={tourSpeed}
            onTourSpeedChange={setTourSpeed}
            tourProgress={progress}
            onToggleTour={() => {
              if (isTourActive) {
                stopTour();
              } else {
                unlockAudio(); // first user gesture unlocks audio for auto-narration
                if (progress === 0 || progress >= 1) resetGeofence();
                startTour();
              }
            }}
          />
          </div>
        </div>
      )}

      {/* Tour Progress Bar */}
      {trail && !uiHidden && !isMeasuring && progress > 0 && Math.floor(progress * trail.coords.length) < trail.coords.length && (
        <div ref={progressBarRef} className="absolute bottom-[calc(var(--bottom-stack-h,64px)_+_4px)] left-3 right-3 md:bottom-auto md:top-3 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-[55%] md:max-w-md z-40 bg-black/80 px-3 py-2 rounded-2xl border border-white/10 backdrop-blur-md">
          <div className="flex justify-between text-xs font-bold mb-1" dir="rtl">
            <div className="text-emerald-300">הושלם: {(trail.totalDistance * progress).toFixed(1)} ק״מ ({Math.round(progress*100)}%)</div>
            <div className="text-sky-300">נותר: {(trail.totalDistance * (1 - progress)).toFixed(1)} ק״מ</div>
          </div>
          {/* The time left follows the speed buttons at once — the one place a
              new speed is unmistakable (see tourSecondsLeft). */}
          <div className="text-center text-white text-xs font-bold mb-1.5" dir="rtl">
            {!isDrive && <><span className="text-orange-300">גובה {Math.round(trail.elevations[Math.floor(progress * (trail.elevations.length - 1))])} מ׳</span> · </>}
            סוף הסיור בעוד {formatTourTimeLeft(tourSecondsLeft(trail.totalDistance, progress, tourSpeed))} <span className="text-orange-300">(x{tourSpeed})</span>
          </div>
          {/* dir=ltr forces correct offsetX math; we flip the visual with scale */}
          <div dir="ltr" className="w-full h-3 bg-zinc-800 rounded-full cursor-pointer relative overflow-hidden" onClick={(e) => {
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

      {/* "הראה לי איפה" from the help chat: a tip round the button, gone at
          the next tap (a tap on the button itself included). */}
      {helpPoint && (
        <Coachmark
          key={`point-${helpPoint}`}
          steps={[{ target: helpPoint, body: <>כאן: <b>״{HELP_PLACES[helpPoint].name}״</b></> }]}
          dim={false}
          onDone={() => setHelpPoint(null)}
        />
      )}

      {/* First-visit help, above everything else on the screen */}
      {helpTour && helpFits && !helpQuiet && (
        <Coachmark
          // Prefixed: the place search beside it is keyed by the mode, and
          // "drive" would otherwise be the key of both.
          key={`tour-${helpTour}`}
          steps={
            helpTour === 'welcome' ? WELCOME_STEPS
              : helpTour === 'trail' ? TRAIL_STEPS
              : helpTour === 'drive' ? DRIVE_STEPS
              : trackingSteps(isNativeApp())
          }
          dim={helpTour === 'welcome' || helpTour === 'trail'}
          onDone={finishHelp}
        />
      )}
    </div>
  );
}
