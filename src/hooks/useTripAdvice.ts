import { useCallback, useEffect, useMemo, useState } from 'react';
import { adviceKey, fallbackAdvice, type AdviceInput } from '../lib/tripAdvice';

export type AdviceSource = 'ai' | 'saved' | 'plain';
// Why the plain sentences are showing: switched off (the default), no free
// key on the server, or the model could not be reached.
export type PlainReason = 'off' | 'not-configured' | 'unavailable';

export interface TripAdvice {
  text: string | null;
  source: AdviceSource | null;
  loading: boolean;
  reason: PlainReason | null;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

const PREFIX = 'navi:advice:';
const ENABLED_KEY = 'navi:tripAdviceAI';
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

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

// The written explanation for the chosen day.
//
// By default it is the plain sentences built on the device from the same
// facts as the panel — no model involved. The model is asked only when it has
// been switched on, and then: what the device already has is shown at once,
// otherwise the model is asked, and if it cannot be (no signal, no free key)
// the plain sentences stand in, so the section is never empty.
export function useTripAdvice(input: AdviceInput | null): TripAdvice {
  const key = useMemo(() => (input ? adviceKey(input) : null), [input]);
  const [enabled, setEnabledState] = useState<boolean>(() => (typeof window === 'undefined' ? false : readEnabled()));
  const [fetched, setFetched] = useState<{ key: string; text: string } | null>(null);
  // The key the model failed to answer for, and why — from then on, plain sentences.
  const [failed, setFailed] = useState<{ key: string; reason: PlainReason } | null>(null);

  const saved = useMemo(() => (enabled && key ? readSaved(key) : null), [enabled, key]);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      if (on) localStorage.setItem(ENABLED_KEY, '1');
      else localStorage.removeItem(ENABLED_KEY);
    } catch {
      // Not remembered — off again next time.
    }
  }, []);

  useEffect(() => {
    if (!enabled || !input || !key || saved) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/trip-advice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (data.status === 'ok' && typeof data.text === 'string') {
          writeSaved(key, data.text);
          setFetched({ key, text: data.text });
        } else {
          setFailed({ key, reason: data.status === 'not-configured' ? 'not-configured' : 'unavailable' });
        }
      } catch {
        if (!controller.signal.aborted) setFailed({ key, reason: 'unavailable' });
      }
    }, DEBOUNCE_MS);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, input, key, saved]);

  return useMemo(() => {
    const base = { enabled, setEnabled };
    if (!input || !key) return { ...base, text: null, source: null, loading: false, reason: null };
    const plain = (reason: PlainReason) => ({ ...base, text: fallbackAdvice(input), source: 'plain' as const, loading: false, reason });
    if (!enabled) return plain('off');
    if (fetched?.key === key) return { ...base, text: fetched.text, source: 'ai' as const, loading: false, reason: null };
    if (saved) return { ...base, text: saved, source: 'saved' as const, loading: false, reason: null };
    if (failed?.key === key) return plain(failed.reason);
    // Offline: nothing to wait for.
    if (typeof navigator !== 'undefined' && !navigator.onLine) return plain('unavailable');
    // Still to be asked (or being asked): say so rather than flash the plain
    // version for the second before the model's arrives.
    return { ...base, text: null, source: null, loading: true, reason: null };
  }, [enabled, setEnabled, input, key, fetched, saved, failed]);
}
