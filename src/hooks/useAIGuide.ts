import { useState, useCallback, useRef, useEffect } from "react";
import { Coordinate3D } from "../utils/trailUtils";

// Tiny silent WAV — played once on a user gesture to unlock the shared
// audio element for later programmatic playback (iOS Safari autoplay policy).
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

let audioUnlocked = false;

interface GuideEntry {
  text: string;
  audioB64: string | null;
  audioFormat: string;
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export const AI_PROVIDER_STORAGE_KEY = "ai_provider";

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

  const playAudio = (base64: string, format: string, fallbackText: string) => {
    try {
      const el = getAudioEl();
      el.pause();
      releaseObjectUrl();

      const bytes = atob(base64);
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      const mime = AUDIO_MIME[format] || "audio/mpeg";
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      objectUrlRef.current = url;

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
    } catch (e) {
      console.error("Audio playback failed, falling back to speech synthesis:", e);
      speakTextFallback(fallbackText);
    }
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

  const requestGuideForPoint = useCallback(async (coord: Coordinate3D, typeName: string, cacheKey?: string, poiName?: string | null) => {
    // Newest request wins: cancel in-flight fetch and current narration
    abortRef.current?.abort();
    audioRef.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();

    const providerPref = typeof window !== "undefined"
      ? localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || "auto"
      : "auto";
    if (cacheKey) cacheKey = `${providerPref}:${cacheKey}`;

    const cached = cacheKey ? cacheRef.current.get(cacheKey) : undefined;
    if (cached) {
      setCurrentScript(cached.text);
      if (cached.audioB64) playAudio(cached.audioB64, cached.audioFormat, cached.text);
      else speakTextFallback(cached.text);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setCurrentScript(null);

    const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
    const currentMonth = monthNames[new Date().getMonth()];

    try {
      const response = await fetch('/api/tour-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          lat: coord[0],
          lon: coord[1],
          month: currentMonth,
          type: typeName,
          name: poiName || undefined,
          provider: localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || undefined
        })
      });

      const data = await response.json();
      if (data.text) {
        const format = data.audioFormat || "mp3";
        if (cacheKey) cacheRef.current.set(cacheKey, { text: data.text, audioB64: data.audio ?? null, audioFormat: format });
        setCurrentScript(data.text);
        if (data.audio) playAudio(data.audio, format, data.text);
        else speakTextFallback(data.text);
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
