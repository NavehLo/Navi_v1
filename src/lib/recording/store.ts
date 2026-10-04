import type { RecPoint, Recording } from './types';

// Where recordings live on the device.
//
// Saved recordings: IndexedDB, a database of their own (not offlineAudio's —
// its versions belong to the narrations and the map packs). A long walk is a
// few hundred kilobytes of points; localStorage would fill up after a dozen.
//
// The recording in progress: localStorage, written every few points. Android
// drops a page that has been in the background long enough, and a reload is
// one swipe away; either way the walk so far must come back. It is small
// enough (a five-hour walk is well under a megabyte) and localStorage can be
// written synchronously, right up to the moment the page goes.

const DB_NAME = 'navi-recordings';
const DB_VERSION = 1;
const STORE = 'recordings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function localStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

// Every recording on the device, newest first.
export async function listLocal(): Promise<Recording[]> {
  if (!localStoreAvailable()) return [];
  const db = await openDb();
  const all = await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<Recording[]>);
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getLocal(id: string): Promise<Recording | null> {
  if (!localStoreAvailable()) return null;
  const db = await openDb();
  return (await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).get(id) as IDBRequest<Recording | undefined>)) ?? null;
}

export async function putLocal(rec: Recording): Promise<void> {
  const db = await openDb();
  await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec) as IDBRequest);
}

export async function deleteLocal(id: string): Promise<void> {
  if (!localStoreAvailable()) return;
  const db = await openDb();
  await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id) as IDBRequest);
}

// ── Deleted while out of reception ───────────────────────────────────────────
// A recording already in the account and deleted on the device with no
// reception is remembered here, and deleted from the account on the next sync.
const DELETED_KEY = 'navi:recording.deleted.v1';

export function pendingDeletes(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setPendingDeletes(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(DELETED_KEY, JSON.stringify(ids));
    else localStorage.removeItem(DELETED_KEY);
  } catch {}
}

// ── The recording in progress ────────────────────────────────────────────────
const ACTIVE_KEY = 'navi:recording.active.v1';

export interface ActiveRecording {
  id: string;
  startedAt: number;
  segments: RecPoint[][];
  pausedMs: number;              // the pauses that have ended
  pausedSince: number | null;    // set while paused
  endedAt: number | null;        // set once "סיים" was pressed (the summary)
}

export function saveActive(rec: ActiveRecording): void {
  try { localStorage.setItem(ACTIVE_KEY, JSON.stringify(rec)); } catch {}
}

export function loadActive(): ActiveRecording | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ActiveRecording;
    if (!rec || typeof rec.id !== 'string' || !Array.isArray(rec.segments)) return null;
    return rec;
  } catch {
    return null;
  }
}

export function clearActive(): void {
  try { localStorage.removeItem(ACTIVE_KEY); } catch {}
}
