import { useEffect, useMemo, useState } from 'react';
import { adviceKey, fallbackAdvice, type AdviceInput } from '../lib/tripAdvice';
import { AI_PROVIDER_STORAGE_KEY } from './useAIGuide';

export type AdviceSource = 'ai' | 'saved' | 'plain';

export interface TripAdvice {
  text: string | null;
  source: AdviceSource | null;
  loading: boolean;
}

const PREFIX = 'navi:advice:';
const MAX_ENTRIES = 40;
// Flicking along the week should not fire a request per day passed on the
// way — only the day that is settled on.
const DEBOUNCE_MS = 700;

function readSaved(key: string): string | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as { text: string }).text : null;
  } catch {
    return null;
  }
}

function writeSaved(key: string, text: string): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ savedAt: Date.now(), text }));
    const keys: Array<{ k: string; at: number }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      let at = 0;
      try { at = JSON.parse(localStorage.getItem(k) || '{}').savedAt ?? 0; } catch { /* oldest */ }
      keys.push({ k, at });
    }
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => a.at - b.at);
      for (const e of keys.slice(0, keys.length - MAX_ENTRIES)) localStorage.removeItem(e.k);
    }
  } catch {
    // Not kept — asked for again next time.
  }
}

// The written explanation for the chosen day. What the device already has is
// shown at once; otherwise the model is asked, and until it answers — or if it
// cannot be reached, as at a trailhead with no signal — the plain sentences
// from the same facts stand in, so the section is never empty.
export function useTripAdvice(input: AdviceInput | null): TripAdvice {
  const key = useMemo(() => (input ? adviceKey(input) : null), [input]);
  const [fetched, setFetched] = useState<{ key: string; text: string } | null>(null);
  // The key the model failed to answer for — from then on, plain sentences.
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const saved = useMemo(() => (key ? readSaved(key) : null), [key]);

  useEffect(() => {
    if (!input || !key || saved) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/trip-advice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, provider: localStorage.getItem(AI_PROVIDER_STORAGE_KEY) || undefined }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (data.status === 'ok' && typeof data.text === 'string') {
          writeSaved(key, data.text);
          setFetched({ key, text: data.text });
        } else {
          setFailedKey(key);
        }
      } catch {
        if (!controller.signal.aborted) setFailedKey(key);
      }
    }, DEBOUNCE_MS);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [input, key, saved]);

  return useMemo(() => {
    if (!input || !key) return { text: null, source: null, loading: false };
    if (fetched?.key === key) return { text: fetched.text, source: 'ai', loading: false };
    if (saved) return { text: saved, source: 'saved', loading: false };
    // Still to be asked (or being asked): say so rather than flash the plain
    // version for the second before the model's arrives.
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (!offline && failedKey !== key) return { text: null, source: null, loading: true };
    return { text: fallbackAdvice(input), source: 'plain', loading: false };
  }, [input, key, fetched, saved, failedKey]);
}
