import { useCallback, useEffect, useMemo, useState } from 'react';
import { thinForPhotos, type TrailPhotos, type TrailPhotosStatus } from '../lib/trailPhotos/types';
import { authHeaders } from '../lib/authHeaders';
import type { Coordinate3D } from '../utils/trailUtils';

// "תמונות מהמסלול" for one trail: from this device if they were loaded here
// before (the links still need a connection to show the pictures, but the
// list opens at once), else from the server, which chooses them the first
// time anyone opens the trail and keeps the choice for everyone.

export type TrailPhotosState =
  | { status: 'loading' }
  | { status: 'ok'; photos: TrailPhotos }
  | { status: Exclude<TrailPhotosStatus, 'ok'> | 'offline' };

const PREFIX = 'navi:trailPhotos:v1:';
const MAX_ENTRIES = 30;

// A short, stable name for the trail's points on this device.
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function readSavedPhotos(key: string): TrailPhotos | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as TrailPhotos) : null;
  } catch {
    return null;
  }
}

function writeSaved(key: string, photos: TrailPhotos): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(photos));
    const keys: Array<{ k: string; at: string }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        keys.push({ k, at: (JSON.parse(localStorage.getItem(k) ?? '{}') as TrailPhotos).generatedAt ?? '' });
      } catch { keys.push({ k, at: '' }); }
    }
    keys.sort((a, b) => a.at.localeCompare(b.at));
    for (const { k } of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) localStorage.removeItem(k);
  } catch { /* storage full or blocked — the server still has it */ }
}

// What the device sends for a trail, and the name it keeps the answer under.
export function photosRequest(coords: Coordinate3D[], wmtId: number | null) {
  const points = thinForPhotos(coords);
  return { points, key: hashOf(JSON.stringify([points, wmtId])) };
}

export function useTrailPhotos(coords: Coordinate3D[], wmtId: number | null): { state: TrailPhotosState; retry: () => void } {
  const { points, key } = useMemo(() => photosRequest(coords, wmtId), [coords, wmtId]);
  const [state, setState] = useState<TrailPhotosState>(() => {
    const saved = readSavedPhotos(key);
    if (saved) return { status: 'ok', photos: saved };
    if (typeof navigator !== 'undefined' && !navigator.onLine) return { status: 'offline' };
    return { status: 'loading' };
  });
  const loading = state.status === 'loading';

  useEffect(() => {
    if (!loading) return;
    let live = true;
    authHeaders()
      .then((auth) => fetch('/api/trail-photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ coords: points, ...(wmtId ? { wmtId } : {}) }),
      }))
      .then((r) => r.json() as Promise<{ status?: TrailPhotosStatus; photos?: TrailPhotos }>)
      .then((body) => {
        if (!live) return;
        if (body.status === 'ok' && body.photos) {
          writeSaved(key, body.photos);
          setState({ status: 'ok', photos: body.photos });
        } else {
          setState({ status: body.status && body.status !== 'ok' ? body.status : 'unavailable' });
        }
      })
      .catch(() => live && setState({ status: navigator.onLine ? 'unavailable' : 'offline' }));
    return () => { live = false; };
    // Runs when a load starts — on opening, and again on "נסו שוב".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loading]);

  const retry = useCallback(() => setState({ status: 'loading' }), []);
  return { state, retry };
}
