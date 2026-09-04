import { useState, useCallback, useRef, useEffect } from "react";
import { Coordinate3D } from "../utils/trailUtils";
import { supabase } from "../lib/supabase";
import { poiKeyFor } from "../lib/poiKey";
import { getStoredNarration } from "../lib/offlineAudio";

// Tiny silent WAV — played once on a user gesture to unlock the shared
// audio element for later programmatic playback (browser autoplay policy).
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let audioUnlocked = false;

interface GuideEntry {
  text: string;
  audioUrl: string | null;   // durable URL from the narration cache
  audioB64: string | null;   // inline audio, when no durable URL exists
  audioBlob?: Blob | null;   // downloaded to the device, plays with no network
  audioFormat: string;
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export const AI_PROVIDER_STORAGE_KEY = "ai_provider";

// What the guide needs to know about a point. The OSM identifiers matter
// because the server keys its permanent cache on them: the same spring found
// on two different trails is narrated, and paid for, exactly once.
export interface GuideTarget {
  coord: Coordinate3D;
  type: string;
  name?: string | null;
  osmType?: string | null;
  osmId?: number | string | null;
  tags?: Record<string, string> | null;
}

interface QueueItem {
  target: GuideTarget;
  trailSlug: string;
}

export function useAIGuide() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSynthesizerActive, setIsSynthesizerActive] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [queueLength, setQueueLength] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, GuideEntry>>(new Map());

  // Narrations play one after another instead of interrupting each other.
  // Points can arrive faster than they can be spoken — a virtual tour at x2
  // covers ~22 m/s, so a 40-second narration is still going when the next
  // point is reached. The old code aborted whatever was playing, which meant
  // that at speed nothing was ever heard to the end.
  const queueRef = useRef<QueueItem[]>([]);
  const pumpingRef = useRef(false);
  // Resolves the promise the pump is waiting on. Pausing the audio element
  // fires no event, so without this an interruption would leave the pump
  // awaiting a narration that had already stopped, and nothing would ever play
  // again.
  const endCurrentRef = useRef<(() => void) | null>(null);

  const interruptPlayback = useCallback(() => {
    audioRef.current?.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    endCurrentRef.current?.();
  }, []);

  // What has already been narrated on the trail being walked, so each point
  // adds something new instead of retelling the last one. Reset when the trail
  // changes; deliberately not part of any cache key.
  const coveredRef = useRef<{ slug: string; topics: string[] }>({ slug: "", topics: [] });

  const getAudioEl = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    return audioRef.current;
  };

  const releaseObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  // Must be called from a user-gesture handler (button click). Idempotent.
  const unlockAudio = useCallback(() => {
    if (audioUnlocked || typeof window === "undefined") return;
    audioUnlocked = true;
    const el = getAudioEl();
    el.src = SILENT_WAV;
    el.play().then(() => el.pause()).catch(() => { audioUnlocked = false; });
  }, []);

  // Each play* helper resolves when the narration has finished, so the queue
  // knows when it may start the next one.
  const speakTextFallback = (text: string): Promise<void> =>
    new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "he-IL";
      utterance.rate = 1.0;

      utterance.onstart = () => {
        setIsSpeaking(true);
        setIsSynthesizerActive(true);
      };
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        endCurrentRef.current = null;
        setIsSpeaking(false);
        setIsSynthesizerActive(false);
        resolve();
      };
      utterance.onend = utterance.onerror = finish;
      endCurrentRef.current = finish;

      window.speechSynthesis.speak(utterance);
    });

  // Plays a clip from a URL. Remote narration URLs come straight from the
  // cache bucket, so the browser and service worker can hold on to them
  // instead of us re-decoding base64 on every playback.
  const playFromUrl = (url: string, fallbackText: string): Promise<void> =>
    new Promise((resolve) => {
      const el = getAudioEl();
      el.pause();

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        endCurrentRef.current = null;
        setIsSpeaking(false);
        setIsSynthesizerActive(false);
        releaseObjectUrl();
        resolve();
      };
      endCurrentRef.current = finish;

      el.onplay = () => {
        setIsSpeaking(true);
        setIsSynthesizerActive(true);
      };
      el.onended = finish;
      el.onerror = finish;

      el.src = url;
      el.play().catch(() => {
        if (settled) return;
        settled = true;
        endCurrentRef.current = null;
        speakTextFallback(fallbackText).then(resolve);
      });
    });

  const playEntry = (entry: GuideEntry): Promise<void> => {
    if (entry.audioBlob && entry.audioBlob.size > 0) {
      releaseObjectUrl();
      const url = URL.createObjectURL(entry.audioBlob);
      objectUrlRef.current = url;
      return playFromUrl(url, entry.text);
    }
    if (entry.audioUrl) {
      releaseObjectUrl();
      return playFromUrl(entry.audioUrl, entry.text);
    }
    if (entry.audioB64) {
      try {
        releaseObjectUrl();
        const bytes = atob(entry.audioB64);
        const buf = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
        const mime = AUDIO_MIME[entry.audioFormat] || "audio/mpeg";
        const url = URL.createObjectURL(new Blob([buf], { type: mime }));
        objectUrlRef.current = url;
        return playFromUrl(url, entry.text);
      } catch (e) {
        console.error("Audio playback failed, falling back to speech synthesis:", e);
      }
    }
    return speakTextFallback(entry.text);
  };

  const stopSpeaking = useCallback(() => {
    queueRef.current = [];
    setQueueLength(0);
    abortRef.current?.abort();
    if (audioRef.current) audioRef.current.currentTime = 0;
    interruptPlayback();
    setIsSpeaking(false);
    setIsSynthesizerActive(false);
    setCurrentScript(null);
  }, [interruptPlayback]);

  const entryCacheKey = (target: GuideTarget, trailSlug: string) => {
    const providerPref = typeof window !== "undefined"
      ? localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "auto"
      : "auto";
    return `${providerPref}:${trailSlug}:${target.type}:${target.coord[0].toFixed(4)},${target.coord[1].toFixed(4)}`;
  };

  // Fetches one narration. Three layers, cheapest first: this session's map,
  // then whatever was downloaded to the device, then the network.
  const fetchEntry = useCallback(async (item: QueueItem): Promise<GuideEntry | null> => {
    const cacheKey = entryCacheKey(item.target, item.trailSlug);
    const cached = cacheRef.current.get(cacheKey);
    if (cached) return cached;

    // A downloaded trail plays with no request at all — which matters in a
    // wadi with no reception, and is also why a saved point starts instantly
    // instead of after the three to eight seconds a round trip takes.
    const stored = await getStoredNarration(
      poiKeyFor({
        lat: item.target.coord[0],
        lon: item.target.coord[1],
        type: item.target.type,
        osmType: item.target.osmType,
        osmId: item.target.osmId,
        trailSlug: item.trailSlug,
      })
    );
    if (stored) {
      const entry: GuideEntry = {
        text: stored.text,
        audioUrl: null,
        audioB64: null,
        audioBlob: stored.blob,
        audioFormat: stored.format,
      };
      cacheRef.current.set(cacheKey, entry);
      return entry;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);

    try {
      // Attach the signed-in user's token so the server can enforce a real
      // per-account daily quota instead of just an IP-based one.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (supabase) {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
      }

      const response = await fetch("/api/tour-guide", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          lat: item.target.coord[0],
          lon: item.target.coord[1],
          type: item.target.type,
          name: item.target.name || undefined,
          osmType: item.target.osmType || undefined,
          osmId: item.target.osmId ?? undefined,
          tags: item.target.tags ?? undefined,
          trailSlug: item.trailSlug,
          covered: coveredRef.current.topics.slice(-6),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Rate limit / quota message — show it in the guide UI instead of failing silently
        setCurrentScript(data.error || "שגיאה בקבלת המדריך. נסה שוב.");
        return null;
      }
      if (!data.text) return null;

      const entry: GuideEntry = {
        text: data.text,
        audioUrl: data.audioUrl ?? null,
        audioB64: data.audio ?? null,
        audioFormat: data.audioFormat || "mp3",
      };
      cacheRef.current.set(cacheKey, entry);
      return entry;
    } catch (e: any) {
      if (e?.name !== "AbortError") console.error("AI Guide failed:", e);
      return null;
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, []);

  // Drains the queue one narration at a time.
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const item = queueRef.current.shift()!;
        setQueueLength(queueRef.current.length);

        if (coveredRef.current.slug !== item.trailSlug) {
          coveredRef.current = { slug: item.trailSlug, topics: [] };
        }

        const entry = await fetchEntry(item);
        if (!entry) continue;

        const topic = item.target.name ? `${item.target.type} ${item.target.name}` : item.target.type;
        if (!coveredRef.current.topics.includes(topic)) coveredRef.current.topics.push(topic);

        setCurrentScript(entry.text);
        await playEntry(entry);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [fetchEntry]);

  // `immediate` is for the buttons a person presses — the manual trigger and
  // replaying a point from the map. Those should be heard now, so they clear
  // whatever the geofence had lined up. Automatic triggers queue instead.
  const requestGuideForPoint = useCallback(
    (target: GuideTarget, trailSlug: string, opts?: { immediate?: boolean }) => {
      if (opts?.immediate) {
        queueRef.current = [];
        abortRef.current?.abort();
        interruptPlayback();
      }
      queueRef.current.push({ target, trailSlug });
      setQueueLength(queueRef.current.length);
      void pump();
    },
    [pump, interruptPlayback]
  );

  useEffect(() => {
    return () => {
      queueRef.current = [];
      abortRef.current?.abort();
      audioRef.current?.pause();
      endCurrentRef.current?.();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  return {
    requestGuideForPoint,
    unlockAudio,
    isSpeaking,
    isLoading,
    currentScript,
    stopSpeaking,
    isSynthesizerActive,
    queueLength,
  };
}
