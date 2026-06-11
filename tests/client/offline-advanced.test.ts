import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OfflineManager,
  InMemoryOfflineStorage,
  LocalStorageOfflineStorage,
  IndexedDBOfflineStorage,
  isIndexedDBAvailable,
  createOfflineStorage,
  mergeConflict,
} from "../../src/client/offline";
import { ConflictError, OfflineMutation } from "../../src/client/types";
import { createTabSync, TabSyncMessage } from "../../src/client/tab-sync";

describe("mergeConflict (field-level)", () => {
  it("keeps non-conflicting client edits, server wins on shared changes", () => {
    const base = { title: "A", done: false, notes: "x" };
    const client = { title: "A", done: true, notes: "y" }; // client changed done + notes
    const server = { title: "B", done: false, notes: "z" }; // server changed title + notes

    const merged = mergeConflict(base, client, server);

    // title: only server changed -> server
    expect(merged.title).toBe("B");
    // done: only client changed -> client
    expect(merged.done).toBe(true);
    // notes: both changed -> server wins
    expect(merged.notes).toBe("z");
  });

  it("treats all client fields as changed when no base provided", () => {
    const client = { done: true };
    const server = { done: false, title: "S" };
    const merged = mergeConflict(undefined, client, server);
    // No base: client field considered changed, server didn't change it relative to (unknown) base
    expect(merged.done).toBe(true);
    expect(merged.title).toBe("S");
  });
});

describe("OfflineManager merge conflict strategy", () => {
  const makeConflictError = (
    serverState: unknown,
    baseState?: unknown
  ): ConflictError => ({
    code: "CONFLICT",
    serverState,
    clientState: null,
    baseState,
  });

  it("merges non-conflicting field changes from both sides and retries", async () => {
    const syncCalls: OfflineMutation[] = [];
    let firstUpdate = true;

    const onMutationSync = vi.fn(async (mutation: OfflineMutation) => {
      syncCalls.push({ ...mutation });
      if (mutation.type === "update" && firstUpdate) {
        firstUpdate = false;
        // Server rejects with a conflict: base done=false, server set title="Server"
        throw makeConflictError(
          { title: "Server", done: false },
          { title: "Base", done: false }
        );
      }
      return { success: true };
    });

    const manager = new OfflineManager({
      config: {
        enabled: true,
        storage: new InMemoryOfflineStorage(),
        conflictResolution: "merge",
      },
      onMutationSync,
    });

    (manager as any).isOnline = false;
    // Client changed done -> true (did not touch title)
    await manager.queueMutation("update", "/todos", { done: true }, "todo-1");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();
    // Retry pass
    await manager.syncPendingMutations();

    // Two update attempts: original (conflict) then merged retry
    const updateCalls = syncCalls.filter((m) => m.type === "update");
    expect(updateCalls.length).toBe(2);

    // Retried data should carry the client's done=true (non-conflicting field preserved)
    expect((updateCalls[1].data as any).done).toBe(true);

    const pending = await manager.getPendingMutations();
    expect(pending).toHaveLength(0);
  });

  it("server-wins still discards on conflict (default behavior unchanged)", async () => {
    const onMutationSync = vi.fn(async (mutation: OfflineMutation) => {
      if (mutation.type === "update") {
        throw makeConflictError({ done: false });
      }
      return { success: true };
    });

    const manager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() }, // default server-wins
      onMutationSync,
    });

    (manager as any).isOnline = false;
    await manager.queueMutation("update", "/todos", { done: true }, "todo-1");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    const pending = await manager.getPendingMutations();
    expect(pending).toHaveLength(0); // discarded
  });
});

describe("IndexedDBOfflineStorage", () => {
  // Minimal in-memory IndexedDB mock (no new deps). Implements just enough of the
  // IDB surface used by IndexedDBOfflineStorage.
  const installFakeIndexedDB = () => {
    const stores = new Map<string, Map<string, any>>();

    const makeRequest = <T>(compute: () => T) => {
      const req: any = { onsuccess: null, onerror: null, result: undefined, error: null };
      queueMicrotask(() => {
        try {
          req.result = compute();
          req.onsuccess?.();
        } catch (e) {
          req.error = e;
          req.onerror?.();
        }
      });
      return req;
    };

    const objectStore = (name: string) => {
      const store = stores.get(name)!;
      return {
        getAll: () => makeRequest(() => Array.from(store.values())),
        get: (key: string) => makeRequest(() => store.get(key)),
        put: (value: any) => makeRequest(() => store.set(value.id, value)),
        delete: (key: string) => makeRequest(() => store.delete(key)),
        clear: () => makeRequest(() => store.clear()),
      };
    };

    const db = {
      objectStoreNames: { contains: (n: string) => stores.has(n) },
      createObjectStore: (n: string) => {
        stores.set(n, new Map());
        return {};
      },
      transaction: (_names: string | string[], _mode?: string) => ({
        objectStore,
      }),
    };

    (globalThis as any).indexedDB = {
      open: (_name: string, _version?: number) => {
        const req: any = {
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          result: db,
          error: null,
        };
        queueMicrotask(() => {
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    };
  };

  beforeEach(() => {
    installFakeIndexedDB();
  });

  afterEach(() => {
    delete (globalThis as any).indexedDB;
  });

  it("reports availability", () => {
    expect(isIndexedDBAvailable()).toBe(true);
  });

  it("round-trips queued mutations", async () => {
    const storage = new IndexedDBOfflineStorage("test-db", "muts");

    const m1: OfflineMutation = {
      id: "1",
      idempotencyKey: "k1",
      type: "create",
      resource: "/todos",
      data: { title: "A" },
      timestamp: 1,
      retryCount: 0,
      status: "pending",
    };
    const m2: OfflineMutation = {
      id: "2",
      idempotencyKey: "k2",
      type: "update",
      resource: "/todos",
      data: { done: true },
      objectId: "x",
      timestamp: 2,
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(m1);
    await storage.addMutation(m2);

    let all = await storage.getMutations();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.id)).toEqual(["1", "2"]); // sorted by timestamp

    await storage.updateMutation("2", { status: "failed", retryCount: 1 });
    all = await storage.getMutations();
    const updated = all.find((m) => m.id === "2")!;
    expect(updated.status).toBe("failed");
    expect(updated.retryCount).toBe(1);

    await storage.removeMutation("1");
    all = await storage.getMutations();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("2");

    await storage.clear();
    expect(await storage.getMutations()).toHaveLength(0);
  });

  it("createOfflineStorage prefers IndexedDB when available", () => {
    const storage = createOfflineStorage();
    expect(storage).toBeInstanceOf(IndexedDBOfflineStorage);
  });

  it("createOfflineStorage falls back to LocalStorage, then in-memory, when IndexedDB unavailable", () => {
    delete (globalThis as any).indexedDB;
    const savedLS = (globalThis as any).localStorage;

    // With localStorage available -> LocalStorage backend
    (globalThis as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    };
    const lsStorage = createOfflineStorage();
    expect(lsStorage).toBeInstanceOf(LocalStorageOfflineStorage);

    // With neither -> in-memory
    delete (globalThis as any).localStorage;
    const memStorage = createOfflineStorage();
    expect(memStorage).toBeInstanceOf(InMemoryOfflineStorage);

    (globalThis as any).localStorage = savedLS;
  });
});

describe("BroadcastChannel tab sync", () => {
  // In-memory BroadcastChannel mock shared across instances on the same channel.
  const installFakeBroadcastChannel = () => {
    const channels = new Map<string, Set<any>>();
    class FakeBC {
      private listeners = new Set<(e: { data: unknown }) => void>();
      constructor(public name: string) {
        if (!channels.has(name)) channels.set(name, new Set());
        channels.get(name)!.add(this);
      }
      postMessage(data: unknown) {
        for (const peer of channels.get(this.name)!) {
          if (peer === this) continue;
          for (const l of peer.listeners) l({ data });
        }
      }
      addEventListener(_t: string, l: (e: { data: unknown }) => void) {
        this.listeners.add(l);
      }
      removeEventListener(_t: string, l: (e: { data: unknown }) => void) {
        this.listeners.delete(l);
      }
      close() {
        channels.get(this.name)!.delete(this);
      }
    }
    (globalThis as any).BroadcastChannel = FakeBC;
  };

  let originalBC: unknown;
  beforeEach(() => {
    originalBC = (globalThis as any).BroadcastChannel;
    installFakeBroadcastChannel();
  });
  afterEach(() => {
    (globalThis as any).BroadcastChannel = originalBC;
  });

  it("propagates messages between two instances", () => {
    const a = createTabSync("ch1");
    const b = createTabSync("ch1");

    const received: TabSyncMessage[] = [];
    b.subscribe((m) => received.push(m));

    a.post({ kind: "invalidate", paths: ["/api/todos"] });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ kind: "invalidate", paths: ["/api/todos"] });

    a.close();
    b.close();
  });

  it("OfflineManager mirrors id-remaps across tabs and elects a single leader", async () => {
    const storageA = new InMemoryOfflineStorage();
    const storageB = new InMemoryOfflineStorage();

    const onIdRemappedB = vi.fn();

    const a = new OfflineManager({
      config: { enabled: true, storage: storageA, tabSync: "shared" },
      onMutationSync: vi.fn().mockResolvedValue({ success: true, serverId: "srv-1" }),
    });
    const b = new OfflineManager({
      config: { enabled: true, storage: storageB, tabSync: "shared" },
      onIdRemapped: onIdRemappedB,
    });

    (a as any).isOnline = false;
    await a.queueMutation("create", "/todos", { title: "T" }, undefined, "opt-1");
    (a as any).isOnline = true;
    await a.syncPendingMutations();

    // Tab B should have learned the id mapping via BroadcastChannel
    expect(b.resolveId("opt-1")).toBe("srv-1");
    expect(onIdRemappedB).toHaveBeenCalledWith("opt-1", "srv-1");

    a.destroy();
    b.destroy();
  });
});
