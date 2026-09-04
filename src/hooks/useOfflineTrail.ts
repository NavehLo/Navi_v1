import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { TrailPOI } from './useTrailData';
import { supabase } from '../lib/supabase';
import { poiKeyFor } from '../lib/poiKey';
import {
  NO_VOICE,
  deleteOtherVoices,
  deleteTrailNarrations,
  isOfflineAudioSupported,
  listStoredKeys,
  putStoredNarration,
  storedBytesFor,
} from '../lib/offlineAudio';
import { AI_PROVIDER_STORAGE_KEY } from './useAIGuide';
import { readVoicePrefs } from '../lib/voicePrefs';
import { useVoiceStatus } from './useVoiceStatus';

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
  voice: { provider: string; voiceId: string | null; signature: string } | null;
}

type PendingReason = 'batch-limit' | 'quota' | 'no-provider' | 'error';

interface Pending {
  poiKey: string;
  reason: PendingReason;
  detail?: string;
}

function base64ToBlob(base64: string, format: string): Blob {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' });
}

export function useOfflineTrail(trailSlug: string | null, pois: TrailPOI[]) {
  // A point counts as saved only if it was saved in the voice that is
  // configured now. After a voice change the badges go back to "to download"
  // and re-downloading replaces the old audio, instead of the old audio
  // quietly continuing to play.
  const { status: voiceStatus } = useVoiceStatus();
  const currentSignature =
    voiceStatus === undefined ? null : voiceStatus === null ? NO_VOICE : voiceStatus.signature;

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
    const keys = await listStoredKeys(trailSlug, currentSignature);
    const bytes = await storedBytesFor(trailSlug);
    setSavedKeys(keys);
    setProgress((p) => ({ ...p, bytes }));
  }, [trailSlug, currentSignature]);

  // Switching trails starts from a clean slate. Done asynchronously and with a
  // cancel flag so a slow read for the previous trail can't land on top of the
  // new one's state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keys = trailSlug ? await listStoredKeys(trailSlug, currentSignature) : new Set<string>();
      const bytes = trailSlug ? await storedBytesFor(trailSlug) : 0;
      if (cancelled) return;
      setSavedKeys(keys);
      setStatus('idle');
      setMessage(null);
      setProgress({ done: keys.size, total: 0, bytes });
    })();
    return () => { cancelled = true; };
  }, [trailSlug, currentSignature]);

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

  // Two points can share a narration key — the same OSM element met twice on
  // the route, or two unnamed points that round to the same coordinates. The
  // server narrates each key once, so counting raw points made a finished
  // download read as "6 of 8" forever.
  const distinctCount = useMemo(() => new Set(pois.map(keyFor)).size, [pois, keyFor]);

  const download = useCallback(async () => {
    if (!trailSlug || pois.length === 0) return;
    if (!isOfflineAudioSupported()) {
      setStatus('error');
      setMessage('הדפדפן הזה לא תומך בשמירה למצב אופליין.');
      return;
    }

    const total = distinctCount;

    cancelRef.current = false;
    setStatus('downloading');
    setMessage(null);
    setProgress({ done: 0, total, bytes: 0 });

    const basePois = {
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

    // Copies from a voice that is no longer in use are dropped first: they
    // will never be played again, and leaving them there means a second full
    // copy of the trail on the device for every voice ever tried.
    if (currentSignature) await deleteOtherVoices(trailSlug, currentSignature);

    const stored = new Set(await listStoredKeys(trailSlug, currentSignature));
    let bytes = await storedBytesFor(trailSlug);

    try {
      // The server fills a few gaps per request so it never runs out of time,
      // and tells us what is still pending. Keep asking until nothing is.
      for (let round = 0; round < pois.length + 2; round++) {
        if (cancelRef.current) return;

        // What the device already holds goes with every round. The server then
        // spends its per-request budget on points that are still missing,
        // instead of re-doing ones we have.
        const res = await fetch('/api/tour-guide/prefetch', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...basePois, have: [...stored] }),
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
            // The server's own answer for this clip, not the status endpoint's:
            // it is the only value guaranteed to describe the audio in hand.
            voiceSignature: result.voice?.signature ?? currentSignature ?? NO_VOICE,
            voiceProvider: result.voice?.provider ?? null,
            voiceId: result.voice?.voiceId ?? null,
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
          setProgress({ done: stored.size, total, bytes });
          setSavedKeys(new Set(stored));
        }

        const pending: Pending[] = data.pending ?? [];
        if (pending.length === 0) break;

        const soFar = `הורדו ${stored.size} מתוך ${total} נקודות.`;

        // Every stopping condition below names the reason the *server* gave,
        // rather than inferring one from what else is in the payload. The
        // inference was wrong in practice: a point held back by the
        // per-request batch limit was reported as one that "cannot be
        // generated".
        const reasons = new Set(pending.map((p) => p.reason));

        if (reasons.has('no-provider')) {
          setStatus('error');
          setMessage(`${soFar} לא הוגדר ספק AI בשרת.`);
          await refresh();
          return;
        }

        if (reasons.has('quota') || data.quotaReached) {
          setStatus('error');
          setMessage(
            data.quotaScope === 'anon'
              ? `${soFar} הגעת למכסה היומית לשימוש ללא התחברות. התחבר עם Google לקבלת מכסה גדולה יותר, או נסה שוב מחר.`
              : `${soFar} הגעת למכסה היומית. נסה שוב מחר להשלמת השאר.`
          );
          await refresh();
          return;
        }

        const failed = pending.filter((p) => p.reason === 'error');
        if (failed.length > 0 && stored.size === before) {
          setStatus('error');
          setMessage(`${soFar} ייצור ${failed.length} נקודות נכשל: ${failed[0].detail ?? 'שגיאה לא ידועה'}`);
          await refresh();
          return;
        }

        // Only 'batch-limit' left, which means "ask again" — so a round that
        // stored nothing anyway means the server is handing back points the
        // device already has. That happens when narrations do not survive
        // between requests, and it is worth naming: on a serverless host it
        // also means the same point is generated, and paid for, more than once.
        if (stored.size === before) {
          setStatus('error');
          setMessage(
            data.durableCache === false
              ? `${soFar} השרת אינו שומר את הקריינויות בין בקשות — בדוק את SUPABASE_SERVICE_ROLE_KEY ואת טבלאות ה-cache.`
              : `${soFar} השרת מחזיר נקודות שכבר קיימות במכשיר ולא מתקדם. נסה שוב בעוד רגע.`
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
  }, [trailSlug, pois, refresh, currentSignature, distinctCount]);

  const remove = useCallback(async () => {
    if (!trailSlug) return;
    cancelRef.current = true;
    await deleteTrailNarrations(trailSlug);
    setStatus('idle');
    setMessage(null);
    setProgress({ done: 0, total: distinctCount, bytes: 0 });
    await refresh();
  }, [trailSlug, distinctCount, refresh]);

  const isSaved = useCallback((poi: TrailPOI) => savedKeys.has(keyFor(poi)), [savedKeys, keyFor]);

  return {
    download,
    remove,
    isSaved,
    savedCount: savedKeys.size,
    // How many narrations this trail actually has, which is not the same as how
    // many points it has.
    total: distinctCount,
    status,
    message,
    progress,
  };
}
