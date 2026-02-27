const DB_NAME = 'ghost-secure';
const STORE_NAME = 'secrets';
const DB_VERSION = 1;
const LEGACY_FALLBACK_PREFIX = 'ghost-fallback:';

function canUseIndexedDb(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('IndexedDB unavailable — secure key storage requires a modern browser.'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * One-shot migration: if a key exists in localStorage (legacy fallback)
 * but not in IndexedDB, move it to IndexedDB and delete the localStorage entry.
 */
async function migrateLegacy(key: string): Promise<void> {
  if (typeof window === 'undefined') return;

  const legacyKey = `${LEGACY_FALLBACK_PREFIX}${key}`;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(legacyKey);
  } catch {
    return;
  }
  if (!raw) return;

  try {
    const value = JSON.parse(raw);
    const db = await openDb();
    const existing = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (existing === undefined) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    db.close();
    window.localStorage.removeItem(legacyKey);
  } catch {
    // Migration failed — localStorage entry stays until next attempt
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  await migrateLegacy(key);

  const db = await openDb();
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
