const DB_NAME = 'ghost-secure';
const STORE_NAME = 'secrets';
const DB_VERSION = 1;
const FALLBACK_PREFIX = 'ghost-fallback:';

const memoryStore = new Map<string, unknown>();

function canUseIndexedDb(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.indexedDB !== 'undefined';
}

function canUseLocalStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const key = '__ghost_probe__';
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function fallbackSet(key: string, value: unknown): void {
  if (canUseLocalStorage()) {
    window.localStorage.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
    return;
  }
  memoryStore.set(key, value);
}

function fallbackGet<T>(key: string): T | undefined {
  if (canUseLocalStorage()) {
    const raw = window.localStorage.getItem(`${FALLBACK_PREFIX}${key}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
  return memoryStore.get(key) as T | undefined;
}

function fallbackDelete(key: string): void {
  if (canUseLocalStorage()) {
    window.localStorage.removeItem(`${FALLBACK_PREFIX}${key}`);
    return;
  }
  memoryStore.delete(key);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('indexedDB unavailable'));
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

export async function idbSet(key: string, value: unknown): Promise<void> {
  if (!canUseIndexedDb()) {
    fallbackSet(key, value);
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    fallbackSet(key, value);
  }
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  if (!canUseIndexedDb()) {
    return fallbackGet<T>(key);
  }

  try {
    const db = await openDb();
    const value = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch {
    return fallbackGet<T>(key);
  }
}

export async function idbDelete(key: string): Promise<void> {
  if (!canUseIndexedDb()) {
    fallbackDelete(key);
    return;
  }

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    fallbackDelete(key);
  }
}
