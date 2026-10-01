import { useCallback, useEffect, useState } from 'react';
import { trailInfoKey, type TrailInfo, type TrailInfoRequest, type TrailInfoStatus } from '../lib/trailInfo/types';
import { authHeaders } from '../lib/authHeaders';

// The "על המסלול" description of one trail: from this device if it was read
// here before (so it opens in the field without signal), else from the server.

export type TrailInfoState =
  | { status: 'loading'; step: string }
  | { status: 'ok'; info: TrailInfo }
  | { status: Exclude<TrailInfoStatus, 'ok'> | 'offline' };

const PREFIX = 'navi:trailInfo:v1:';
const MAX_ENTRIES = 30;

function readSaved(key: string): TrailInfo | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as TrailInfo) : null;
  } catch {
    return null;
  }
}

function writeSaved(key: string, info: TrailInfo): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(info));
    const keys: Array<{ k: string; at: string }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        keys.push({ k, at: (JSON.parse(localStorage.getItem(k) ?? '{}') as TrailInfo).generatedAt ?? '' });
      } catch { keys.push({ k, at: '' }); }
    }
    keys.sort((a, b) => a.at.localeCompare(b.at));
    for (const { k } of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) localStorage.removeItem(k);
  } catch { /* storage full or blocked — the server still has it */ }
}

// The server answers in one go, so these only say what it is most likely
// doing by now. A trail that is already described answers before the first.
const STEPS: Array<[number, string]> = [
  [0, 'מחפש מקורות על המסלול…'],
  [4000, 'קורא את האתר הרשמי ואת ויקיפדיה…'],
  [11000, 'כותב את הסיכום בעברית…'],
  [30000, 'עוד רגע…'],
];

function initialState(key: string): TrailInfoState {
  const saved = readSaved(key);
  if (saved) return { status: 'ok', info: saved };
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { status: 'offline' };
  return { status: 'loading', step: STEPS[0][1] };
}

// The panel is mounted afresh for each trail (keyed by trail in page.tsx), so
// the request never changes under a mounted hook.
export function useTrailInfo(request: TrailInfoRequest): { state: TrailInfoState; retry: () => void } {
  const key = trailInfoKey(request);
  const [state, setState] = useState<TrailInfoState>(() => initialState(key));
  const loading = state.status === 'loading';

  useEffect(() => {
    if (!loading) return;
    let live = true;
    const timers = STEPS.slice(1).map(([at, step]) => setTimeout(() => live && setState({ status: 'loading', step }), at));
    authHeaders()
      .then((auth) => fetch('/api/trail-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(request),
      }))
      .then((r) => r.json() as Promise<{ status?: TrailInfoStatus; info?: TrailInfo }>)
      .then((body) => {
        if (!live) return;
        if (body.status === 'ok' && body.info) {
          writeSaved(key, body.info);
          setState({ status: 'ok', info: body.info });
        } else {
          setState({ status: body.status && body.status !== 'ok' ? body.status : 'unavailable' });
        }
      })
      .catch(() => live && setState({ status: navigator.onLine ? 'unavailable' : 'offline' }))
      .finally(() => timers.forEach(clearTimeout));
    return () => {
      live = false;
      timers.forEach(clearTimeout);
    };
    // Runs when a load starts — on opening, and again on "נסו שוב".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loading]);

  const retry = useCallback(() => setState({ status: 'loading', step: STEPS[0][1] }), []);
  return { state, retry };
}
