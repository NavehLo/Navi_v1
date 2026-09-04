import { useState, useCallback, useRef, useEffect } from "react";
import { Coordinate3D } from "../utils/trailUtils";
import { supabase } from "../lib/supabase";

// Tiny silent WAV — played once on a user gesture to unlock the shared
// audio element for later programmatic playback (browser autoplay policy).
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let audioUnlocked = false;

interface GuideEntry {
  text: string;
  audioUrl: string | null;   // durable URL from the narration cache
  audioB64: string | null;   // inline audio, when no durable URL exists
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
}

export function useAIGuide() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSynthesizerActive, setIsSynthesizerActive] = useState(false);
  const [currentScript, setCurrentScript] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cacheRef = useRef<Map<string, GuideEntry>>(new Map());

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

  const speakTextFallback = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // kill existing

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'he-IL';
    utterance.rate = 1.0;

    utterance.onstart = () => {
        setIsSpeaking(true);
        setIsSynthesizerActive(true);
    };
    utterance.onend = () => {
        setIsSpeaking(false);
        setIsSynthesizerActive(false);
    };

    window.speechSynthesis.speak(utterance);
  };

  // Plays a clip from a URL. Remote narration URLs come straight from the
  // cache bucket, so the browser and service worker can hold on to them
  // instead of us re-decoding base64 on every playback.
  const playFromUrl = (url: string, fallbackText: string) => {
    const el = getAudioEl();
    el.pause();

    el.onplay = () => {
      setIsSpeaking(true);
      setIsSynthesizerActive(true);
    };
    el.onended = el.onerror = () => {
      setIsSpeaking(false);
      setIsSynthesizerActive(false);
      releaseObjectUrl();
    };

    el.src = url;
    el.play().catch(() => speakTextFallback(fallbackText));
  };

  const playEntry = (entry: GuideEntry) => {
    if (entry.audioUrl) {
      releaseObjectUrl();
      playFromUrl(entry.audioUrl, entry.text);
      return;
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
        playFromUrl(url, entry.text);
        return;
      } catch (e) {
        console.error("Audio playback failed, falling back to speech synthesis:", e);
      }
    }
    speakTextFallback(entry.text);
  };

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    setIsSynthesizerActive(false);
    setCurrentScript(null);
  }, []);

  const requestGuideForPoint = useCallback(async (target: GuideTarget, trailSlug: string) => {
    // Newest request wins: cancel in-flight fetch and current narration
    abortRef.current?.abort();
    audioRef.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();

    const providerPref = typeof window !== "undefined"
      ? localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "auto"
      : "auto";
    const cacheKey = `${providerPref}:${trailSlug}:${target.type}:${target.coord[0].toFixed(4)},${target.coord[1].toFixed(4)}`;

    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setCurrentScript(cached.text);
      playEntry(cached);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setCurrentScript(null);

    try {
      // Attach the signed-in user's token so the server can enforce a real
      // per-account daily quota instead of just an IP-based one.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (supabase) {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const response = await fetch('/api/tour-guide', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          lat: target.coord[0],
          lon: target.coord[1],
          type: target.type,
          name: target.name || undefined,
          osmType: target.osmType || undefined,
          osmId: target.osmId ?? undefined,
          trailSlug,
          provider: localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || undefined
        })
      });

      const data = await response.json();

      if (!response.ok) {
        // Rate limit / quota message — show it in the guide UI instead of failing silently
        setCurrentScript(data.error || 'שגיאה בקבלת המדריך. נסה שוב.');
        return;
      }

      if (data.text) {
        const entry: GuideEntry = {
          text: data.text,
          audioUrl: data.audioUrl ?? null,
          audioB64: data.audio ?? null,
          audioFormat: data.audioFormat || "mp3",
        };
        cacheRef.current.set(cacheKey, entry);
        setCurrentScript(entry.text);
        playEntry(entry);
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') console.error("AI Guide failed:", e);
    } finally {
      if (abortRef.current === controller) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    };
  }, []);

  return { requestGuideForPoint, unlockAudio, isSpeaking, isLoading, currentScript, stopSpeaking, isSynthesizerActive };
}
