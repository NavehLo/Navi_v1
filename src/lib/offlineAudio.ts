// Narration audio kept on the device, for walking a trail with no reception.
//
// IndexedDB rather than localStorage: these are audio Blobs, a few hundred KB
// each, and localStorage only holds strings and caps out around 5 MB. This is
// the project's first IndexedDB store, so the wrapper below is deliberately
// small — one object store, a handful of operations.
//
// It is also a straight win with reception: a saved narration starts instantly
// instead of after the three to eight seconds a round trip costs.
//
// The primary key is `poiKey|voiceSignature`, not the poiKey alone. Version 1
// keyed on the point only, and so a trail downloaded before a voice change kept
// playing the old voice forever, with no way to tell from the app: the durable
// server-side audio cache is keyed on the voice, but the copy on the device
// silently was not, and the device copy is consulted first.

const DB_NAME = 'navi-offline';
const DB_VERSION = 2;
const STORE = 'narrations';
const TRAIL_INDEX = 'trailSlug';
const TRAIL_VOICE_INDEX = 'trailVoice';

// Records saved when no server-side voice existed at all (the browser reads the
// text itself). A fixed string keeps the key shape uniform.
export const NO_VOICE = 'none';

export interface StoredNarration {
  key: string;           // `${poiKey}|${voiceSignature}` — primary key
  poiKey: string;        // see lib/poiKey
  voiceSignature: string;
  // Kept alongside the signature so a clip can name its own voice even when
  // the current one is unknown (offline). Absent on records written before
  // this existed.
  voiceProvider?: string | null;
  voiceId?: string | null;
  blob: Blob;
  text: string;
  format: string;
  trailSlug: string;     // the trail this was downloaded for
  bytes: number;
  savedAt: number;
}

export function narrationKey(poiKey: string, voiceSignature: string | null | undefined): string {
  return `${poiKey}|${voiceSignature || NO_VOICE}`;
}

function poiKeyOf(key: string): string {
  const cut = key.lastIndexOf('|');
  return cut === -1 ? key : key.slice(0, cut);
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
      // v1 records carry no voice, so there is no way to tell which voice they
      // hold. They are dropped rather than migrated: re-downloading them is a
      // cache hit on the server and costs nothing, and keeping them would mean
      // keeping exactly the bug this version fixes.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex(TRAIL_INDEX, 'trailSlug', { unique: false });
      store.createIndex(TRAIL_VOICE_INDEX, ['trailSlug', 'voiceSignature'], { unique: false });
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
//
// `voiceSignature` null means "whichever voice this was saved with" and is for
// the case where the current one is not known — offline on first load, say.
// Any other value is matched exactly, so a clip from a retired voice is never
// played in place of the one that is configured now.
export async function getStoredNarration(
  poiKey: string,
  voiceSignature: string | null
): Promise<StoredNarration | null> {
  if (!isOfflineAudioSupported()) return null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);

    if (voiceSignature !== null) {
      const exact = await promisify(
        store.get(narrationKey(poiKey, voiceSignature)) as IDBRequest<StoredNarration | undefined>
      );
      return exact ?? null;
    }

    // Unknown voice: take the most recently saved copy of this point.
    const range = IDBKeyRange.bound(`${poiKey}|`, `${poiKey}|￿`);
    const any = await promisify(store.getAll(range) as IDBRequest<StoredNarration[]>);
    if (any.length === 0) return null;
    return any.reduce((newest, r) => (r.savedAt > newest.savedAt ? r : newest));
  } catch (e) {
    console.error('Offline audio read failed:', e);
    return null;
  }
}

export async function putStoredNarration(
  record: Omit<StoredNarration, 'key'>
): Promise<boolean> {
  if (!isOfflineAudioSupported()) return false;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    await promisify(
      tx.objectStore(STORE).put({
        ...record,
        key: narrationKey(record.poiKey, record.voiceSignature),
      }) as IDBRequest
    );
    return true;
  } catch (e) {
    // Usually a quota error — the caller reports how far the download got.
    console.error('Offline audio write failed:', e);
    return false;
  }
}

// The points of a trail already saved *in the voice asked for*. Passing null
// counts any voice, which is what the offline badge wants when the current
// voice is not known yet.
export async function listStoredKeys(
  trailSlug?: string,
  voiceSignature?: string | null
): Promise<Set<string>> {
  if (!isOfflineAudioSupported()) return new Set();
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    let keys: IDBValidKey[];
    if (trailSlug && voiceSignature) {
      keys = await promisify(
        store.index(TRAIL_VOICE_INDEX).getAllKeys([trailSlug, voiceSignature]) as IDBRequest<IDBValidKey[]>
      );
    } else if (trailSlug) {
      keys = await promisify(store.index(TRAIL_INDEX).getAllKeys(trailSlug) as IDBRequest<IDBValidKey[]>);
    } else {
      keys = await promisify(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    }
    return new Set(keys.map((k) => poiKeyOf(String(k))));
  } catch (e) {
    console.error('Offline audio list failed:', e);
    return new Set();
  }
}

// All of the trail's stored audio, whatever voice it was saved in — this is
// disk actually occupied, so it counts the copies a voice change left behind
// as well.
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

// Drops this trail's copies in every voice but the current one. Without it each
// voice change would leave a full second copy of the trail on the device, and
// the first sign of that would be a download failing for lack of space.
export async function deleteOtherVoices(trailSlug: string, keepSignature: string): Promise<number> {
  if (!isOfflineAudioSupported()) return 0;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const keys = await promisify(store.index(TRAIL_INDEX).getAllKeys(trailSlug) as IDBRequest<IDBValidKey[]>);
    let removed = 0;
    for (const key of keys) {
      if (String(key).endsWith(`|${keepSignature}`)) continue;
      store.delete(key);
      removed++;
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return removed;
  } catch (e) {
    console.error('Offline audio cleanup failed:', e);
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
