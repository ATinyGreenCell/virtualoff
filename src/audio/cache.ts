/**
 * Keeps the rendered sound library in IndexedDB, so return visits skip the boot render (seconds of
 * synthesis on a phone) and just copy samples back into AudioBuffers.
 *
 * The cache is keyed by __SOUND_VERSION__, a build-time hash of the audio source: any change to the
 * sound code re-renders and replaces it. The version record is written last, so a write that was
 * cut short is never trusted. Every failure (no IndexedDB, quota, a stuck open) just means
 * "render as usual" — the cache can only ever save time.
 */

const DB_NAME = 'virtual-off-audio';
const STORE = 'sounds';
const META = '__meta';
/** Some Safari versions never answer indexedDB.open in odd states; don't wait on them. */
const OPEN_TIMEOUT_MS = 1500;

interface Meta {
  version: string;
  keys: string[];
}

interface Record {
  rate: number;
  length: number;
  /** one Float32 PCM buffer per channel */
  ch: ArrayBuffer[];
}

export const cacheEnabled = () => !import.meta.env.DEV && typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

/** Every buffer in `keys`, or null when anything is missing, stale or unreadable. */
export async function readCache(version: string, keys: string[], sampleRate: number): Promise<Map<string, AudioBuffer> | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    const meta = (await request(store.get(META))) as Meta | undefined;
    if (!meta || meta.version !== version || keys.some((k) => !meta.keys.includes(k))) return null;
    // one request per sound: each success event is its own task, so no single long main-thread stall
    const recs = await Promise.all(keys.map((k) => request(store.get(k)) as Promise<Record | undefined>));
    // validate everything before building anything: an incomplete cache costs no work
    const valid = (r: Record | undefined): r is Record =>
      !!r && r.rate === sampleRate && r.length > 0 && Array.isArray(r.ch) && r.ch.length >= 1 && r.ch.length <= 2 && r.ch.every((c) => c.byteLength === r.length * 4);
    if (!recs.every(valid)) return null;
    const out = new Map<string, AudioBuffer>();
    recs.forEach((r, i) => {
      const b = new AudioBuffer({ numberOfChannels: r!.ch.length, length: r!.length, sampleRate: r!.rate });
      r!.ch.forEach((pcm, c) => b.copyToChannel(new Float32Array(pcm), c));
      out.set(keys[i], b);
    });
    return out;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Replace the cache with `entries`; resolves quietly whatever happens. */
export async function writeCache(version: string, entries: [string, AudioBuffer][]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    // drop the old version first: a reader that races this sees no meta and simply renders
    let tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await committed(tx);
    for (let i = 0; i < entries.length; i += 8) {
      tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [key, b] of entries.slice(i, i + 8)) {
        const ch: ArrayBuffer[] = [];
        for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c).slice().buffer);
        store.put({ rate: b.sampleRate, length: b.length, ch } satisfies Record, key);
      }
      await committed(tx);
      // let frames through between batches
      await new Promise((r) => setTimeout(r, 0));
    }
    tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ version, keys: entries.map(([k]) => k) } satisfies Meta, META);
    await committed(tx);
  } catch {
    // quota or a closed database: next visit renders again
  } finally {
    db.close();
  }
}
