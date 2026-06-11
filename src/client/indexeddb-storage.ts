import { OfflineMutation, OfflineStorage } from "./types";

interface IDBLike {
  open(name: string, version?: number): IDBOpenDBRequestLike;
}

interface IDBOpenDBRequestLike {
  result: IDBDatabaseLike;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
}

interface IDBDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): unknown;
  transaction(stores: string | string[], mode?: "readonly" | "readwrite"): IDBTransactionLike;
}

interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
}

interface IDBObjectStoreLike {
  getAll(): IDBRequestLike<OfflineMutation[]>;
  get(key: string): IDBRequestLike<OfflineMutation | undefined>;
  put(value: OfflineMutation): IDBRequestLike<unknown>;
  delete(key: string): IDBRequestLike<unknown>;
  clear(): IDBRequestLike<unknown>;
}

interface IDBRequestLike<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

const getIndexedDB = (): IDBLike | null => {
  if (typeof globalThis === "undefined") return null;
  const idb = (globalThis as { indexedDB?: IDBLike }).indexedDB;
  return idb ?? null;
};

export const isIndexedDBAvailable = (): boolean => getIndexedDB() !== null;

const promisify = <T>(request: IDBRequestLike<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * IndexedDB-backed offline storage. Suitable for larger mutation queues than
 * LocalStorage can hold. Feature-detected: throws on construction only if
 * IndexedDB is missing — prefer `createOfflineStorage()` which falls back to
 * LocalStorage automatically.
 */
export class IndexedDBOfflineStorage implements OfflineStorage {
  private dbName: string;
  private storeName: string;
  private dbPromise: Promise<IDBDatabaseLike> | null = null;

  constructor(dbName = "concave-offline", storeName = "mutations") {
    this.dbName = dbName;
    this.storeName = storeName;
    if (!isIndexedDBAvailable()) {
      throw new Error(
        "IndexedDBOfflineStorage: indexedDB is not available in this environment."
      );
    }
  }

  private getDB(): Promise<IDBDatabaseLike> {
    if (this.dbPromise) return this.dbPromise;
    const idb = getIndexedDB();
    if (!idb) {
      this.dbPromise = Promise.reject(new Error("indexedDB unavailable"));
      return this.dbPromise;
    }
    this.dbPromise = new Promise<IDBDatabaseLike>((resolve, reject) => {
      const request = idb.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.dbPromise;
  }

  private async withStore<T>(
    mode: "readonly" | "readwrite",
    fn: (store: IDBObjectStoreLike) => IDBRequestLike<T>
  ): Promise<T> {
    const db = await this.getDB();
    const tx = db.transaction(this.storeName, mode);
    const store = tx.objectStore(this.storeName);
    return promisify(fn(store));
  }

  async getMutations(): Promise<OfflineMutation[]> {
    try {
      const all = await this.withStore("readonly", (store) => store.getAll());
      return [...(all ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    }
  }

  async addMutation(mutation: OfflineMutation): Promise<void> {
    await this.withStore("readwrite", (store) => store.put(mutation));
  }

  async updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void> {
    const existing = await this.withStore("readonly", (store) => store.get(id));
    if (!existing) return;
    await this.withStore("readwrite", (store) =>
      store.put({ ...existing, ...update })
    );
  }

  async removeMutation(id: string): Promise<void> {
    await this.withStore("readwrite", (store) => store.delete(id));
  }

  async clear(): Promise<void> {
    await this.withStore("readwrite", (store) => store.clear());
  }
}
