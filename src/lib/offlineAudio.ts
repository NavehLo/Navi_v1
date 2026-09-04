// Narration audio kept on the device, for walking a trail with no reception.
//
// IndexedDB rather than localStorage: these are audio Blobs, a few hundred KB
// each, and localStorage only holds strings and caps out around 5 MB. This is
// the project's first IndexedDB store, so the wrapper below is deliberately
// small — one object store, four operations.
//
// It is also a straight win with reception: a saved narration starts instantly
// instead of after the three to eight seconds a round trip costs.

const DB_NAME = 'navi-offline';
const DB_VERSION = 1;
const STORE = 'narrations';
const TRAIL_INDEX = 'trailSlug';

export interface StoredNarration {
  poiKey: string;      // primary key — see lib/poiKey
  blob: Blob;
  text: string;
  format: string;
  trailSlug: string;   // the trail this was downloaded for
  bytes: number;
  savedAt: number;
}

export function isOfflineAudioSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'poiKey' });
        store.createIndex(TRAIL_INDEX, 'trailSlug', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // A failed open must not poison every later attempt.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Every read is best-effort: a browser with storage blocked should fall back
// to the network, not break the guide.
export async function getStoredNarration(poiKey: string): Promise<StoredNarration | null> {
  if (!isOfflineAudioSupported()) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const result = await promisify(tx.objectStore(STORE).get(poiKey) as IDBRequest<StoredNarration | undefined>);
    return result ?? null;
  } catch (e) {
    console.error('Offline audio read failed:', e);
    return null;
  }
}

export async function putStoredNarration(record: StoredNarration): Promise<boolean> {
  if (!isOfflineAudioSupported()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await promisify(tx.objectStore(STORE).put(record) as IDBRequest);
    return true;
  } catch (e) {
    // Usually a quota error — the caller reports how far the download got.
    console.error('Offline audio write failed:', e);
    return false;
  }
}

export async function listStoredKeys(trailSlug?: string): Promise<Set<string>> {
  if (!isOfflineAudioSupported()) return new Set();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const keys = trailSlug
      ? await promisify(store.index(TRAIL_INDEX).getAllKeys(trailSlug) as IDBRequest<IDBValidKey[]>)
      : await promisify(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    return new Set(keys.map(String));
  } catch (e) {
    console.error('Offline audio list failed:', e);
    return new Set();
  }
}

export async function storedBytesFor(trailSlug: string): Promise<number> {
  if (!isOfflineAudioSupported()) return 0;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const records = await promisify(
      tx.objectStore(STORE).index(TRAIL_INDEX).getAll(trailSlug) as IDBRequest<StoredNarration[]>
    );
    return records.reduce((sum, r) => sum + (r.bytes || 0), 0);
  } catch (e) {
    console.error('Offline audio size read failed:', e);
    return 0;
  }
}

// Frees the space one trail's download took. A point shared with another
// downloaded trail goes with it, but re-downloading it is free — the server
// has it cached and charges nothing to hand it back.
export async function deleteTrailNarrations(trailSlug: string): Promise<void> {
  if (!isOfflineAudioSupported()) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const keys = await promisify(store.index(TRAIL_INDEX).getAllKeys(trailSlug) as IDBRequest<IDBValidKey[]>);
    for (const key of keys) store.delete(key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Offline audio delete failed:', e);
  }
}
