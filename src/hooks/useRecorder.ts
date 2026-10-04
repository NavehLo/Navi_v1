import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDistance } from '../utils/trailUtils';
import { computeRecStats, MAX_ACCURACY_M, MIN_STEP_M } from '../lib/recording/stats';
import { withModelHeights } from '../lib/recording/sync';
import { clearActive, loadActive, putLocal, saveActive, type ActiveRecording } from '../lib/recording/store';
import type { RecPoint, RecStats, Recording } from '../lib/recording/types';

// Recording a walk: start, pause, resume, finish, then save or throw away.
//
// The fixes come from the live location (page.tsx feeds them in through
// addFix); this hook only decides which to keep. The walk so far is written
// to the device every few points, so a page that Android drops, or a reload,
// brings it back — paused, waiting for "המשך" or "סיים".

export type RecStatus = 'idle' | 'recording' | 'paused' | 'review';

const SAVE_EVERY_POINTS = 5;
const SAVE_EVERY_MS = 10_000;
// Too little to be worth keeping: a tap on the button by mistake.
const MIN_KEEP_KM = 0.05;

export interface RecFix { lat: number; lon: number; ele: number | null; t: number; acc: number | null }

function statusOf(a: ActiveRecording | null): RecStatus {
  if (!a) return 'idle';
  if (a.endedAt != null) return 'review';
  return a.pausedSince != null ? 'paused' : 'recording';
}

// Time spent recording (not paused) up to `now`.
function activeMsOf(a: ActiveRecording, now: number): number {
  const end = a.endedAt ?? now;
  const pausedNow = a.pausedSince != null ? end - a.pausedSince : 0;
  return Math.max(0, end - a.startedAt - a.pausedMs - pausedNow);
}

function pausedMsOf(a: ActiveRecording, now: number): number {
  const end = a.endedAt ?? now;
  return a.pausedMs + (a.pausedSince != null ? end - a.pausedSince : 0);
}

export function defaultRecordingName(startedAt: number): string {
  const d = new Date(startedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  return `הליכה · ${d}`;
}

export function useRecorder() {
  // The state is what is drawn; the ref is the same object, for the callbacks
  // (a fix arrives outside any render). Every change replaces it — the last
  // segment is copied with its new point, the earlier ones are shared.
  const activeRef = useRef<ActiveRecording | null>(null);
  const [active, setActive] = useState<ActiveRecording | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const unsavedRef = useRef({ points: 0, at: 0 });

  const commit = useCallback((next: ActiveRecording | null, persist = true) => {
    activeRef.current = next;
    setActive(next);
    if (!persist) return;
    if (next) saveActive(next); else clearActive();
    unsavedRef.current = { points: 0, at: Date.now() };
  }, []);

  // A walk interrupted by the page going away comes back paused.
  useEffect(() => {
    const kept = loadActive();
    if (!kept) return;
    if (kept.endedAt == null && kept.pausedSince == null) {
      const last = kept.segments.flat().at(-1);
      kept.pausedSince = Math.max(kept.startedAt, last?.t ?? kept.startedAt);
    }
    // Once, on arrival: what the device holds is the first state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    commit(kept);
  }, [commit]);

  const status = statusOf(active);

  // The clock on the panel ticks while recording.
  useEffect(() => {
    if (status !== 'recording') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Pending points are written when the page is hidden — the moment before
  // Android may drop it.
  useEffect(() => {
    const flush = () => { if (activeRef.current) saveActive(activeRef.current); };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const addFix = useCallback((fix: RecFix) => {
    const a = activeRef.current;
    if (!a || a.pausedSince != null || a.endedAt != null) return;
    setLastFixAt(Date.now());
    if (fix.acc != null && fix.acc > MAX_ACCURACY_M) return;
    const seg = a.segments[a.segments.length - 1];
    const last = seg[seg.length - 1];
    if (last && getDistance(last.lat, last.lon, fix.lat, fix.lon) * 1000 < MIN_STEP_M) return;
    const p: RecPoint = {
      lat: fix.lat, lon: fix.lon,
      ele: fix.ele != null && Number.isFinite(fix.ele) ? Math.round(fix.ele * 10) / 10 : null,
      t: fix.t, acc: fix.acc == null ? null : Math.round(fix.acc),
    };
    const next = { ...a, segments: [...a.segments.slice(0, -1), [...seg, p]] };
    const u = unsavedRef.current;
    u.points++;
    commit(next, u.points >= SAVE_EVERY_POINTS || Date.now() - u.at >= SAVE_EVERY_MS);
  }, [commit]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    const t = Date.now();
    setNow(t);
    setLastFixAt(null);
    commit({ id: crypto.randomUUID(), startedAt: t, segments: [[]], pausedMs: 0, pausedSince: null, endedAt: null });
  }, [commit]);

  const pause = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.pausedSince != null || a.endedAt != null) return;
    commit({ ...a, pausedSince: Date.now() });
  }, [commit]);

  const resume = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.pausedSince == null || a.endedAt != null) return;
    const t = Date.now();
    setNow(t);
    setLastFixAt(null);
    // A new stretch: the line and the distance do not join across the pause.
    const segments = a.segments[a.segments.length - 1].length ? [...a.segments, []] : a.segments;
    commit({ ...a, segments, pausedMs: a.pausedMs + (t - a.pausedSince), pausedSince: null });
  }, [commit]);

  const finish = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.endedAt != null) return;
    const t = Date.now();
    setNow(t);
    commit({ ...a, endedAt: t });
  }, [commit]);

  // Back from the summary to recording, for a "סיים" pressed too early.
  const reopen = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.endedAt == null) return;
    commit({ ...a, endedAt: null, pausedSince: a.pausedSince ?? a.endedAt });
  }, [commit]);

  const discard = useCallback(() => commit(null), [commit]);

  // The live numbers, with the phone's own heights. The saved ones use the
  // elevation model (see save).
  // The distance and the climb change only with the points; the clock with
  // every tick. Kept apart so the tick does not go over every point again.
  const pointStats = useMemo(() => active
    ? computeRecStats(active.segments, { activeMs: 0, pausedMs: 0, eleSource: 'gps' })
    : null, [active]);
  const stats: RecStats | null = useMemo(() => active && pointStats
    ? (() => {
      const totalSec = Math.round(activeMsOf(active, now) / 1000);
      return { ...pointStats, totalSec, movingSec: Math.min(pointStats.movingSec, totalSec), pausedSec: Math.round(pausedMsOf(active, now) / 1000) };
    })()
    : null, [active, pointStats, now]);

  const segments = useMemo(() => active?.segments ?? [], [active]);

  const tooShort = !stats || stats.points < 2 || stats.distanceKm < MIN_KEEP_KM;

  // Kept on the device; the caller takes it on to the account.
  const save = useCallback(async (name: string, ownerId: string | null): Promise<Recording | null> => {
    const a = activeRef.current;
    if (!a || a.endedAt == null) return null;
    const segments = a.segments.filter((s) => s.length > 0);
    const model = await withModelHeights(segments).catch(() => null);
    const finalSegments = model ?? segments;
    const rec: Recording = {
      id: a.id,
      name: name.trim() || defaultRecordingName(a.startedAt),
      startedAt: a.startedAt,
      endedAt: a.endedAt,
      segments: finalSegments,
      stats: computeRecStats(finalSegments, {
        activeMs: activeMsOf(a, a.endedAt), pausedMs: pausedMsOf(a, a.endedAt), eleSource: model ? 'dem' : 'gps',
      }),
      ownerId,
      syncedAt: null,
      shared: false,
    };
    await putLocal(rec);
    commit(null);
    return rec;
  }, [commit]);

  return {
    status,
    startedAt: active?.startedAt ?? null,
    stats,
    segments,
    tooShort,
    lastFixAt,
    now,
    addFix,
    start, pause, resume, finish, reopen, discard, save,
  };
}

export type Recorder = ReturnType<typeof useRecorder>;
