import { useState, useCallback, useEffect, useRef } from 'react';
import { TrailPOI } from './useTrailData';
import { supabase } from '../lib/supabase';
import { poiKeyFor } from '../lib/poiKey';
import {
  deleteTrailNarrations,
  isOfflineAudioSupported,
  listStoredKeys,
  putStoredNarration,
  storedBytesFor,
} from '../lib/offlineAudio';
import { AI_PROVIDER_STORAGE_KEY } from './useAIGuide';
import { readVoicePrefs } from '../lib/voicePrefs';

// "Download this trail for use in the field": fetch every narration, store the
// audio on the device, and report how far it got.

export interface OfflineProgress {
  done: number;
  total: number;
  bytes: number;
}

export type OfflineStatus = 'idle' | 'downloading' | 'done' | 'error';

interface PrefetchResult {
  poiKey: string;
  text: string;
  audioUrl: string | null;
  audio: string | null;
  audioFormat: string;
}

function base64ToBlob(base64: string, format: string): Blob {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
}

export function useOfflineTrail(trailSlug: string | null, pois: TrailPOI[]) {
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<OfflineStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<OfflineProgress>({ done: 0, total: 0, bytes: 0 });
  const cancelRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!trailSlug) {
      setSavedKeys(new Set());
      setProgress({ done: 0, total: 0, bytes: 0 });
      return;
    }
    const keys = await listStoredKeys(trailSlug);
    const bytes = await storedBytesFor(trailSlug);
    setSavedKeys(keys);
    setProgress((p) => ({ ...p, bytes }));
  }, [trailSlug]);

  // Switching trails starts from a clean slate. Done asynchronously and with a
  // cancel flag so a slow read for the previous trail can't land on top of the
  // new one's state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keys = trailSlug ? await listStoredKeys(trailSlug) : new Set<string>();
      const bytes = trailSlug ? await storedBytesFor(trailSlug) : 0;
      if (cancelled) return;
      setSavedKeys(keys);
      setStatus('idle');
      setMessage(null);
      setProgress({ done: keys.size, total: 0, bytes });
    })();
    return () => { cancelled = true; };
  }, [trailSlug]);

  useEffect(() => () => { cancelRef.current = true; }, []);

  const keyFor = useCallback(
    (poi: TrailPOI) =>
      poiKeyFor({
        lat: poi.coord[0],
        lon: poi.coord[1],
        type: poi.type,
        osmType: poi.osmType,
        osmId: poi.osmId,
        trailSlug: trailSlug ?? undefined,
      }),
    [trailSlug]
  );

  const download = useCallback(async () => {
    if (!trailSlug || pois.length === 0) return;
    if (!isOfflineAudioSupported()) {
      setStatus('error');
      setMessage('הדפדפן הזה לא תומך בשמירה למצב אופליין.');
      return;
    }

    cancelRef.current = false;
    setStatus('downloading');
    setMessage(null);
    setProgress({ done: 0, total: pois.length, bytes: 0 });

    const body = {
      trailSlug,
      provider: localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || undefined,
      voice: readVoicePrefs(),
      pois: pois.map((p) => ({
        lat: p.coord[0],
        lon: p.coord[1],
        type: p.type,
        name: p.name ?? undefined,
        osmType: p.osmType ?? undefined,
        osmId: p.osmId ?? undefined,
        tags: p.tags ?? undefined,
      })),
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (supabase) {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const stored = new Set(await listStoredKeys(trailSlug));
    let bytes = await storedBytesFor(trailSlug);

    try {
      // The server fills a few gaps per request so it never runs out of time,
      // and tells us what is still pending. Keep asking until nothing is.
      for (let round = 0; round < pois.length + 2; round++) {
        if (cancelRef.current) return;

        const res = await fetch('/api/tour-guide/prefetch', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה בהורדת המסלול');

        const before = stored.size;
        for (const result of (data.results ?? []) as PrefetchResult[]) {
          if (cancelRef.current) return;
          if (stored.has(result.poiKey)) continue;

          const blob = result.audioUrl
            ? await fetch(result.audioUrl).then((r) => (r.ok ? r.blob() : null))
            : result.audio
              ? base64ToBlob(result.audio, result.audioFormat)
              : null;
          // Text-only points (no voice configured, or synthesis failed) are
          // still worth storing: offline they are read by the browser's own
          // speech synthesis rather than not at all.
          const written = await putStoredNarration({
            poiKey: result.poiKey,
            blob: blob ?? new Blob([], { type: 'audio/mpeg' }),
            text: result.text,
            format: result.audioFormat || 'mp3',
            trailSlug,
            bytes: blob?.size ?? 0,
            savedAt: Date.now(),
          });
          if (!written) throw new Error('אין מספיק מקום פנוי במכשיר לשמירת המסלול.');

          stored.add(result.poiKey);
          bytes += blob?.size ?? 0;
          setProgress({ done: stored.size, total: pois.length, bytes });
          setSavedKeys(new Set(stored));
        }

        const pending: string[] = data.pending ?? [];
        if (pending.length === 0) break;

        const soFar = `הורדו ${stored.size} מתוך ${pois.length} נקודות.`;

        // The quota is checked before the stall guard below, and must be: a
        // round blocked entirely by the quota also stores nothing, so testing
        // the stall first reported "cannot be generated" for what is really
        // "you are out of budget" — two different problems with two different
        // answers.
        if (data.quotaReached) {
          setStatus('error');
          setMessage(
            data.quotaScope === 'anon'
              ? `${soFar} הגעת למכסה היומית לשימוש ללא התחברות. התחבר עם Google לקבלת מכסה גדולה יותר, או נסה שוב מחר.`
              : `${soFar} הגעת למכסה היומית. נסה שוב מחר להשלמת השאר.`
          );
          await refresh();
          return;
        }

        // Nothing new stored and no quota to blame: the server genuinely cannot
        // make progress on the rest.
        if (stored.size === before) {
          setStatus('error');
          setMessage(
            data.hasProvider === false
              ? `${soFar} לא הוגדר ספק AI בשרת.`
              : data.failures > 0
                ? `${soFar} ייצור השאר נכשל — בדוק את מפתח ה-API ואת יתרת הקרדיטים.`
                : `${soFar} השאר לא ניתנות לייצור כרגע.`
          );
          await refresh();
          return;
        }
      }

      setStatus('done');
      setMessage(null);
      await refresh();
    } catch (e: any) {
      console.error('Offline download failed:', e);
      setStatus('error');
      setMessage(e?.message || 'שגיאה בהורדת המסלול.');
      await refresh();
    }
  }, [trailSlug, pois, refresh]);

  const remove = useCallback(async () => {
    if (!trailSlug) return;
    cancelRef.current = true;
    await deleteTrailNarrations(trailSlug);
    setStatus('idle');
    setMessage(null);
    setProgress({ done: 0, total: pois.length, bytes: 0 });
    await refresh();
  }, [trailSlug, pois.length, refresh]);

  const isSaved = useCallback((poi: TrailPOI) => savedKeys.has(keyFor(poi)), [savedKeys, keyFor]);

  return { download, remove, isSaved, savedCount: savedKeys.size, status, message, progress };
}
