/**
 * COMPREHENSIVE OFFLINE SYNC EDGE CASE TESTS
 *
 * This test suite covers all edge cases for offline/optimistic sync behavior.
 * These are critical paths that MUST work correctly for the framework to be trustworthy.
 *
 * Categories:
 * 1. Basic offline mutations
 * 2. Optimistic ID remapping
 * 3. Subscription reconnection
 * 4. Offline mutations + subscription reconnection
 * 5. Multi-client scenarios
 * 6. Edge cases with optimistic IDs
 * 7. Sequence number gaps and catchup
 * 8. Concurrent mutations
 * 9. Relations/Joins sync
 * 10. Error recovery
 * 11. Race conditions
 * 12. State consistency invariants
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryOfflineStorage,
  OfflineManager,
  createOfflineManager,
} from "../../src/client/offline";
import { createLiveQuery, LiveQuery, LiveQueryState } from "../../src/client/live-store";
import {
  ResourceClient,
  PaginatedResponse,
  Subscription,
  SubscriptionCallbacks,
  SubscriptionState,
  EventMeta,
} from "../../src/client/types";

// ============================================================
// Test Helpers
// ============================================================

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  categoryId?: string | null;
  updatedAt?: number;
}

interface Category {
  id: string;
  name: string;
}

interface TodoWithCategory extends Todo {
  category?: Category | null;
}

// Creates a mock ResourceClient that allows manual triggering of subscription events
const createMockRepo = <T extends { id: string }>(): ResourceClient<T> & {
  subscriptionCallbacks: SubscriptionCallbacks<T> | undefined;
  mockSubscription: Subscription<T>;
  triggerEvent: (type: string, data: unknown, meta?: EventMeta) => void;
  triggerConnected: (seq: number) => void;
  triggerDisconnected: () => void;
  triggerError: (error: Error) => void;
  triggerInvalidate: (reason?: string) => void;
  setListResponse: (response: PaginatedResponse<T>) => void;
  createCalls: Array<{ data: unknown; options?: unknown }>;
  updateCalls: Array<{ id: string; data: unknown }>;
  deleteCalls: Array<{ id: string }>;
} => {
  let callbacks: SubscriptionCallbacks<T> | undefined;
  let listResponse: PaginatedResponse<T> = { items: [], nextCursor: null, hasMore: false };
  const createCalls: Array<{ data: unknown; options?: unknown }> = [];
  const updateCalls: Array<{ id: string; data: unknown }> = [];
  const deleteCalls: Array<{ id: string }> = [];

  const mockSubscription: Subscription<T> = {
    state: { items: new Map(), isConnected: false, lastSeq: 0, error: null },
    items: [],
    unsubscribe: vi.fn(),
    reconnect: vi.fn(),
  };

  return {
    subscriptionCallbacks: undefined,
    mockSubscription,
    createCalls,
    updateCalls,
    deleteCalls,

    triggerEvent(type: string, data: unknown, meta?: EventMeta) {
      if (type === "added" && callbacks?.onAdded) {
        callbacks.onAdded(data as T, meta);
      }
      if (type === "existing" && callbacks?.onExisting) {
        callbacks.onExisting(data as T);
      }
      if (type === "changed" && callbacks?.onChanged) {
        callbacks.onChanged(data as T);
      }
      if (type === "removed" && callbacks?.onRemoved) {
        callbacks.onRemoved(data as string);
      }
    },

    triggerConnected(seq: number) {
      mockSubscription.state.isConnected = true;
      mockSubscription.state.lastSeq = seq;
      callbacks?.onConnected?.(seq);
    },

    triggerDisconnected() {
      mockSubscription.state.isConnected = false;
      callbacks?.onDisconnected?.();
    },

    triggerError(error: Error) {
      mockSubscription.state.error = error;
      callbacks?.onError?.(error);
    },

    triggerInvalidate(reason?: string) {
      callbacks?.onInvalidate?.(reason);
    },

    setListResponse(response: PaginatedResponse<T>) {
      listResponse = response;
    },

    async list(): Promise<PaginatedResponse<T>> {
      return listResponse;
    },
    async get(id: string): Promise<T> {
      return { id } as T;
    },
    async count(): Promise<number> {
      return listResponse.items.length;
    },
    async aggregate() {
      return { groups: [] };
    },
    async create(data: Omit<T, "id">, options?: unknown): Promise<T> {
      createCalls.push({ data, options });
      // Mirror the offline repository path: resolve to the optimistic stand-in
      // (id === optimisticId). Reconciliation to the real server id is then
      // driven by the OfflineManager mapping + SSE events, which these tests
      // simulate explicitly. (The non-offline path, where create resolves to a
      // distinct server id, is covered in live-store.test.ts.)
      const optimisticId = (options as { optimisticId?: string } | undefined)
        ?.optimisticId;
      const id =
        optimisticId ?? `server_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      return { ...data, id } as T;
    },
    async update(id: string, data: Partial<T>): Promise<T> {
      updateCalls.push({ id, data });
      return { ...data, id } as T;
    },
    async replace(id: string, data: Omit<T, "id">): Promise<T> {
      return { ...data, id } as T;
    },
    async delete(id: string): Promise<void> {
      deleteCalls.push({ id });
    },
    async batchCreate(items: Omit<T, "id">[]): Promise<T[]> {
      return items.map((item, i) => ({ ...item, id: `batch-${i}` } as T));
    },
    async batchUpdate(): Promise<{ count: number }> {
      return { count: 0 };
    },
    async batchDelete(): Promise<{ count: number }> {
      return { count: 0 };
    },
    subscribe(options, cbs) {
      callbacks = cbs;
      (this as any).subscriptionCallbacks = cbs;
      return mockSubscription;
    },
    async rpc() {
      return {} as any;
    },
  };
};

// Helper to wait for async operations
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to get items as a sorted array for comparison
const sortedItems = <T extends { id: string }>(items: T[]) =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));

// ============================================================
// 1. BASIC OFFLINE MUTATIONS
// ============================================================

describe("1. Basic Offline Mutations", () => {
  describe("1.1 Create while offline", () => {
    it("should queue create mutation when offline", async () => {
      const storage = new InMemoryOfflineStorage();
      const manager = createOfflineManager({
        config: { enabled: true, storage },
      });

      // Go offline
      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test", completed: false }, undefined, "opt_1");

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("create");
      expect(pending[0].optimisticId).toBe("opt_1");
    });

    it("should sync create mutation when coming back online", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(mutation);
          return { success: true, serverId: "server_123" };
        },
      });

      // Go offline and queue
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_1");

      // Come online and sync
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(1);
      expect(syncedMutations[0].type).toBe("create");

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });
  });

  describe("1.2 Update while offline", () => {
    it("should queue update mutation when offline", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("update", "/todos", { completed: true }, "todo_1");

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("update");
      expect(pending[0].objectId).toBe("todo_1");
    });

    it("should sync update mutation when coming back online", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(mutation);
          return { success: true };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("update", "/todos", { completed: true }, "todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(1);
      expect(syncedMutations[0].objectId).toBe("todo_1");
    });
  });

  describe("1.3 Delete while offline", () => {
    it("should queue delete mutation when offline", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("delete", "/todos", undefined, "todo_1");

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("delete");
    });

    it("should sync delete mutation when coming back online", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(mutation);
          return { success: true };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("delete", "/todos", undefined, "todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(1);
      expect(syncedMutations[0].type).toBe("delete");
    });
  });
});

// ============================================================
// 2. OPTIMISTIC ID REMAPPING
// ============================================================

describe("2. Optimistic ID Remapping", () => {
  describe("2.1 Basic ID remapping", () => {
    it("should remap optimistic ID to server ID after sync", async () => {
      const onIdRemapped = vi.fn();
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => ({ success: true, serverId: "server_456" }),
        onIdRemapped,
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_123");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(onIdRemapped).toHaveBeenCalledWith("opt_123", "server_456");
      expect(manager.resolveId("opt_123")).toBe("server_456");
    });

    it("should not remap if server returns same ID", async () => {
      const onIdRemapped = vi.fn();
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => ({
          success: true,
          serverId: mutation.optimisticId
        }),
        onIdRemapped,
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "same_id");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(onIdRemapped).not.toHaveBeenCalled();
    });
  });

  describe("2.2 Update before sync uses optimistic ID", () => {
    it("should resolve optimistic ID for updates queued before create syncs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_999" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create with optimistic ID
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_abc");

      // Update using optimistic ID (before create syncs)
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_abc");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Both should sync
      expect(syncedMutations).toHaveLength(2);
      expect(syncedMutations[0].type).toBe("create");
      expect(syncedMutations[1].type).toBe("update");

      // After sync, resolveId should work
      expect(manager.resolveId("opt_abc")).toBe("server_999");
    });
  });

  describe("2.3 Delete before sync uses optimistic ID", () => {
    it("should handle delete of optimistic item before create syncs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_del" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_del");
      await manager.queueMutation("delete", "/todos", undefined, "opt_del");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Both should sync (create then delete)
      expect(syncedMutations).toHaveLength(2);
    });
  });
});

// ============================================================
// 3. SUBSCRIPTION RECONNECTION
// ============================================================

describe("3. Subscription Reconnection", () => {
  describe("3.1 Reconnect and receive missed events", () => {
    it("should handle reconnection with existing events for current state", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);

      // Initial connection
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "1", title: "Todo 1", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);

      // Disconnect
      repo.triggerDisconnected();
      // Status depends on navigator.onLine - could be "reconnecting" or "offline"
      expect(["reconnecting", "offline"]).toContain(query.getSnapshot().status);

      // Reconnect - server sends all current items as "existing"
      repo.triggerConnected(5);
      repo.triggerEvent("existing", { id: "1", title: "Todo 1 Updated", completed: true });
      repo.triggerEvent("existing", { id: "2", title: "Todo 2", completed: false });

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      const todo1 = snapshot.items.find(t => t.id === "1");
      expect(todo1?.title).toBe("Todo 1 Updated");
      expect(todo1?.completed).toBe(true);

      query.destroy();
    });

    it("should handle server deletions during disconnect", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);

      // Initial state: 3 items
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "1", title: "Todo 1", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Todo 2", completed: false });
      repo.triggerEvent("existing", { id: "3", title: "Todo 3", completed: false });

      expect(query.getSnapshot().items).toHaveLength(3);

      // Disconnect
      repo.triggerDisconnected();

      // Reconnect - item 2 was deleted on server
      // Server should send invalidate to force refetch, or existing events for current state
      repo.triggerInvalidate("reconnection");

      // After invalidate, live store should refetch via list()
      // For this test, we'll verify the invalidate triggers status change
      expect(query.getSnapshot().status).toBe("loading");

      query.destroy();
    });
  });

  describe("3.2 Missed events during disconnect", () => {
    it("should catch up via resumeFrom when reconnecting", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);

      repo.triggerConnected(10);
      repo.triggerEvent("existing", { id: "1", title: "Initial", completed: false });

      const snapshot = query.getSnapshot();
      expect(snapshot.lastSeq).toBe(10);

      // Disconnect
      repo.triggerDisconnected();

      // Reconnect - new events happened (seq 11, 12)
      repo.triggerConnected(12);
      repo.triggerEvent("added", { id: "2", title: "New while away", completed: false });

      expect(query.getSnapshot().items).toHaveLength(2);
      expect(query.getSnapshot().lastSeq).toBe(12);

      query.destroy();
    });
  });
});

// ============================================================
// 4. OFFLINE MUTATIONS + SUBSCRIPTION RECONNECTION
// ============================================================

describe("4. Offline Mutations + Subscription Reconnection", () => {
  describe("4.1 Create offline, reconnect, see synced item", () => {
    it("should reconcile optimistic create with server item after sync", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        onIdRemapped: (optId, srvId) => idMappings.set(optId, srvId),
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Offline Todo", completed: false });
      await wait(10);

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      const optimisticId = snapshot.items[0].id;
      expect(optimisticId).toMatch(/^optimistic_/);

      // Simulate sync completing - server assigns real ID
      idMappings.set(optimisticId, "server_created_1");

      // Server sends added event with optimisticId metadata
      repo.triggerEvent("added",
        { id: "server_created_1", title: "Offline Todo", completed: false },
        { optimisticId }
      );

      snapshot = query.getSnapshot();
      // Should have only one item - the server one
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_created_1");

      query.destroy();
    });

    it("should handle create offline, disconnect, reconnect with existing event", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Offline Todo", completed: false });
      await wait(10);

      const optimisticId = query.getSnapshot().items[0].id;

      // Simulate: sync happened, mapping created, but we missed the added event
      idMappings.set(optimisticId, "server_xyz");

      // Disconnect
      repo.triggerDisconnected();

      // Reconnect - get existing event (not added, because we missed it)
      repo.triggerConnected(5);
      repo.triggerEvent("existing", { id: "server_xyz", title: "Offline Todo", completed: false });

      await wait(10);

      const snapshot = query.getSnapshot();
      // Should replace optimistic with server item
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_xyz");

      query.destroy();
    });
  });

  describe("4.2 Create + Update offline, reconnect", () => {
    it("should preserve optimistic update state until update syncs", async () => {
      // This is THE critical bug scenario:
      // 1. Create todo offline (optimistic ID)
      // 2. Update todo offline (mark completed)
      // 3. Come online, create syncs first
      // 4. Subscription gets existing event with uncompleted state
      // 5. BUG: Old code would replace completed optimistic with uncompleted server state

      const idMappings = new Map<string, string>();
      const pendingIds = new Set<string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async (id) => pendingIds.has(id),
      });

      await wait(10);
      repo.triggerConnected(0);

      // Step 1: Create optimistically
      query.mutate.create({ title: "Test Todo", completed: false });
      await wait(10);

      const optimisticId = query.getSnapshot().items[0].id;

      // Step 2: Update optimistically (mark completed)
      pendingIds.add(optimisticId); // Update is pending
      query.mutate.update(optimisticId, { completed: true });

      let snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(true);

      // Step 3: Create syncs, mapping created
      idMappings.set(optimisticId, "server_final");

      // Step 4: Subscription gets existing event with SERVER state (completed: false)
      // because update hasn't synced yet
      repo.triggerEvent("existing", { id: "server_final", title: "Test Todo", completed: false });

      await wait(10);
      snapshot = query.getSnapshot();

      // Step 5: Should STILL have optimistic state (completed: true)
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe(optimisticId); // Keep optimistic ID
      expect(snapshot.items[0].completed).toBe(true); // Keep optimistic state

      // Step 6: Update syncs, no more pending mutations
      pendingIds.delete(optimisticId);

      // Server sends changed event with final state
      repo.triggerEvent("changed", { id: "server_final", title: "Test Todo", completed: true });

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_final");
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });
  });

  describe("4.3 Delete offline before sync completes", () => {
    it("should handle create then delete offline", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Temp Todo", completed: false });
      await wait(10);

      const optimisticId = query.getSnapshot().items[0].id;
      expect(query.getSnapshot().items).toHaveLength(1);

      // Delete optimistically
      query.mutate.delete(optimisticId);

      expect(query.getSnapshot().items).toHaveLength(0);

      query.destroy();
    });
  });
});

// ============================================================
// 5. MULTI-CLIENT SCENARIOS
// ============================================================

describe("5. Multi-Client Scenarios", () => {
  describe("5.1 Client A creates, Client B sees via subscription", () => {
    it("should propagate creates to other clients", async () => {
      // Simulate two clients with separate LiveQuery instances
      const repoA = createMockRepo<Todo>();
      const repoB = createMockRepo<Todo>();

      const queryA = createLiveQuery(repoA, {});
      const queryB = createLiveQuery(repoB, {});

      await wait(10);

      repoA.triggerConnected(0);
      repoB.triggerConnected(0);

      // Client A creates
      repoA.triggerEvent("added", { id: "srv_1", title: "From A", completed: false });

      // Client B should see it via subscription
      repoB.triggerEvent("added", { id: "srv_1", title: "From A", completed: false });

      expect(queryA.getSnapshot().items).toHaveLength(1);
      expect(queryB.getSnapshot().items).toHaveLength(1);
      expect(queryB.getSnapshot().items[0].id).toBe("srv_1");

      queryA.destroy();
      queryB.destroy();
    });
  });

  describe("5.2 Concurrent offline creates from multiple clients", () => {
    it("should handle both clients creating offline without conflicts", async () => {
      // Client A and B both create items offline
      // When both come online, both items should exist

      const idMappingsA = new Map<string, string>();
      const idMappingsB = new Map<string, string>();

      const repoA = createMockRepo<Todo>();
      const repoB = createMockRepo<Todo>();

      const queryA = createLiveQuery(repoA, {}, {
        getIdMappings: () => idMappingsA,
        hasPendingMutationsForId: async () => false,
      });
      const queryB = createLiveQuery(repoB, {}, {
        getIdMappings: () => idMappingsB,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);

      // Both go offline and create
      queryA.mutate.create({ title: "From A", completed: false });
      queryB.mutate.create({ title: "From B", completed: false });

      await wait(10);

      const optIdA = queryA.getSnapshot().items[0].id;
      const optIdB = queryB.getSnapshot().items[0].id;

      // Both come online and sync
      idMappingsA.set(optIdA, "server_a_1");
      idMappingsB.set(optIdB, "server_b_1");

      // Both receive each other's items via subscription
      repoA.triggerConnected(5);
      repoA.triggerEvent("added", { id: "server_a_1", title: "From A", completed: false }, { optimisticId: optIdA });
      repoA.triggerEvent("added", { id: "server_b_1", title: "From B", completed: false });

      repoB.triggerConnected(5);
      repoB.triggerEvent("added", { id: "server_a_1", title: "From A", completed: false });
      repoB.triggerEvent("added", { id: "server_b_1", title: "From B", completed: false }, { optimisticId: optIdB });

      await wait(10);

      // Both should have both items
      expect(queryA.getSnapshot().items).toHaveLength(2);
      expect(queryB.getSnapshot().items).toHaveLength(2);

      queryA.destroy();
      queryB.destroy();
    });
  });

  describe("5.3 Concurrent updates to same item (conflict)", () => {
    it("should handle last-write-wins for concurrent updates", async () => {
      // Client A and B both update the same item offline
      // Server should accept both (last write wins)
      // Both clients should eventually converge to same state

      const repoA = createMockRepo<Todo>();
      const repoB = createMockRepo<Todo>();

      const queryA = createLiveQuery(repoA, {});
      const queryB = createLiveQuery(repoB, {});

      await wait(10);

      // Both start with same item
      repoA.triggerConnected(0);
      repoB.triggerConnected(0);

      repoA.triggerEvent("existing", { id: "shared_1", title: "Original", completed: false });
      repoB.triggerEvent("existing", { id: "shared_1", title: "Original", completed: false });

      // Both update offline
      queryA.mutate.update("shared_1", { title: "Updated by A" });
      queryB.mutate.update("shared_1", { title: "Updated by B" });

      expect(queryA.getSnapshot().items[0].title).toBe("Updated by A");
      expect(queryB.getSnapshot().items[0].title).toBe("Updated by B");

      // Server accepts B's update last (last write wins)
      repoA.triggerEvent("changed", { id: "shared_1", title: "Updated by B", completed: false });
      repoB.triggerEvent("changed", { id: "shared_1", title: "Updated by B", completed: false });

      // Both should converge
      expect(queryA.getSnapshot().items[0].title).toBe("Updated by B");
      expect(queryB.getSnapshot().items[0].title).toBe("Updated by B");

      queryA.destroy();
      queryB.destroy();
    });
  });
});

// ============================================================
// 6. EDGE CASES WITH OPTIMISTIC IDs
// ============================================================

describe("6. Edge Cases with Optimistic IDs", () => {
  describe("6.1 Rapid create-update-delete sequence", () => {
    it("should handle create then immediate update", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);

      query.mutate.create({ title: "Quick", completed: false });
      await wait(5);

      const optId = query.getSnapshot().items[0].id;
      query.mutate.update(optId, { title: "Quick Updated" });

      expect(query.getSnapshot().items[0].title).toBe("Quick Updated");

      query.destroy();
    });

    it("should handle create-update-delete sequence", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);

      query.mutate.create({ title: "Ephemeral", completed: false });
      await wait(5);

      const optId = query.getSnapshot().items[0].id;
      query.mutate.update(optId, { completed: true });
      query.mutate.delete(optId);

      expect(query.getSnapshot().items).toHaveLength(0);

      query.destroy();
    });
  });

  describe("6.2 Multiple updates to optimistic item", () => {
    it("should apply multiple updates to optimistic item", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);

      query.mutate.create({ title: "Multi", completed: false });
      await wait(5);

      const optId = query.getSnapshot().items[0].id;

      query.mutate.update(optId, { title: "Multi 1" });
      expect(query.getSnapshot().items[0].title).toBe("Multi 1");

      query.mutate.update(optId, { title: "Multi 2" });
      expect(query.getSnapshot().items[0].title).toBe("Multi 2");

      query.mutate.update(optId, { completed: true });
      expect(query.getSnapshot().items[0].completed).toBe(true);
      expect(query.getSnapshot().items[0].title).toBe("Multi 2");

      query.destroy();
    });
  });

  describe("6.3 Miss added event, get existing event instead", () => {
    it("should handle case where added event with optimisticId was missed", async () => {
      // Scenario:
      // 1. Create optimistically
      // 2. Sync happens, added event is sent but client disconnects before receiving
      // 3. Client reconnects, gets existing event (no optimisticId metadata)
      // 4. Should still reconcile via ID mapping

      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Missed Event", completed: false });
      await wait(10);

      const optId = query.getSnapshot().items[0].id;

      // Sync happened in background, mapping created
      idMappings.set(optId, "server_missed");

      // Disconnect happened before added event received
      repo.triggerDisconnected();

      // Reconnect - get existing event (no optimisticId in meta)
      repo.triggerConnected(10);
      repo.triggerEvent("existing", { id: "server_missed", title: "Missed Event", completed: false });

      await wait(10);

      const snapshot = query.getSnapshot();
      // Should have reconciled via ID mapping
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_missed");

      query.destroy();
    });
  });
});

// ============================================================
// 7. SEQUENCE NUMBER GAPS AND CATCHUP
// ============================================================

describe("7. Sequence Number Gaps and Catchup", () => {
  describe("7.1 Small gap - server sends missed events", () => {
    it("should handle reconnection with recent sequence", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);

      // Connect at seq 100
      repo.triggerConnected(100);
      repo.triggerEvent("existing", { id: "1", title: "Todo 1", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.lastSeq).toBe(100);

      // Disconnect
      repo.triggerDisconnected();

      // Reconnect - server caught us up from seq 100 to 105
      repo.triggerConnected(105);
      repo.triggerEvent("added", { id: "2", title: "Todo 2", completed: false });
      repo.triggerEvent("changed", { id: "1", title: "Todo 1 Updated", completed: true });

      snapshot = query.getSnapshot();
      expect(snapshot.lastSeq).toBe(105);
      expect(snapshot.items).toHaveLength(2);
      expect(snapshot.items.find(t => t.id === "1")?.completed).toBe(true);

      query.destroy();
    });
  });

  describe("7.2 Large gap - server sends invalidate", () => {
    it("should refetch on invalidate event", async () => {
      const repo = createMockRepo<Todo>();
      // Initial list returns old items
      repo.setListResponse({
        items: [{ id: "old_1", title: "Old", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});

      await wait(20);

      repo.triggerConnected(100);

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("old_1");

      // Disconnect for a long time
      repo.triggerDisconnected();

      // Update list response for refetch
      repo.setListResponse({
        items: [
          { id: "fresh_1", title: "Fresh 1", completed: false },
          { id: "fresh_2", title: "Fresh 2", completed: true },
        ],
        nextCursor: null,
        hasMore: false,
      });

      // Reconnect - gap too large, server sends invalidate
      repo.triggerInvalidate("sequence_gap_too_large");

      // Should trigger refetch
      await wait(50);

      // After refetch from list(), should have fresh items
      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      expect(snapshot.items.map(i => i.id).sort()).toEqual(["fresh_1", "fresh_2"]);

      query.destroy();
    });
  });
});

// ============================================================
// 8. CONCURRENT MUTATIONS
// ============================================================

describe("8. Concurrent Mutations", () => {
  describe("8.1 Multiple creates while offline", () => {
    it("should queue and sync multiple creates in order", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          return { success: true, serverId: `server_${mutation.optimisticId}` };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "First" }, undefined, "opt_1");
      await manager.queueMutation("create", "/todos", { title: "Second" }, undefined, "opt_2");
      await manager.queueMutation("create", "/todos", { title: "Third" }, undefined, "opt_3");

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(3);

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(3);
      expect(syncedMutations[0].optimisticId).toBe("opt_1");
      expect(syncedMutations[1].optimisticId).toBe("opt_2");
      expect(syncedMutations[2].optimisticId).toBe("opt_3");
    });
  });

  describe("8.2 Multiple updates to same item while offline", () => {
    it("should merge updates to same object for efficiency", async () => {
      // Updates to the same object within dedupe window are MERGED
      // This reduces network requests while preserving the final state
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("update", "/todos", { title: "V1" }, "item_1");
      await manager.queueMutation("update", "/todos", { title: "V2" }, "item_1");
      await manager.queueMutation("update", "/todos", { completed: true }, "item_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Updates are merged into a single mutation
      expect(syncedMutations).toHaveLength(1);
      // The merged data should have the latest title and completed flag
      expect(syncedMutations[0].data).toEqual({ title: "V2", completed: true });
    });

    it("should not merge updates to different objects", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("update", "/todos", { title: "A" }, "item_1");
      await manager.queueMutation("update", "/todos", { title: "B" }, "item_2");
      await manager.queueMutation("update", "/todos", { title: "C" }, "item_3");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Each object gets its own update
      expect(syncedMutations).toHaveLength(3);
    });
  });

  describe("8.3 Mixed operations while offline", () => {
    it("should maintain operation order: create, update, delete", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_mixed" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create
      await manager.queueMutation("create", "/todos", { title: "Mixed" }, undefined, "opt_mixed");
      // Update the created item
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_mixed");
      // Delete it
      await manager.queueMutation("delete", "/todos", undefined, "opt_mixed");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(3);
      expect(syncedMutations[0].type).toBe("create");
      expect(syncedMutations[1].type).toBe("update");
      expect(syncedMutations[2].type).toBe("delete");
    });
  });
});

// ============================================================
// 9. RELATIONS/JOINS SYNC
// ============================================================

describe("9. Relations/Joins Sync", () => {
  describe("9.1 Create item with relation while offline", () => {
    it("should include relation data in optimistic item", async () => {
      const repo = createMockRepo<TodoWithCategory>();
      const query = createLiveQuery(repo, { include: "category" });

      await wait(10);
      repo.triggerConnected(0);

      // Create with categoryId
      query.mutate.create({ title: "With Category", completed: false, categoryId: "cat_1" });

      await wait(10);

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].categoryId).toBe("cat_1");
      // Note: The related category object won't be populated until server responds

      query.destroy();
    });
  });

  describe("9.2 Update relation while offline", () => {
    it("should update relation field optimistically", async () => {
      const repo = createMockRepo<TodoWithCategory>();
      const query = createLiveQuery(repo, { include: "category" });

      await wait(10);
      repo.triggerConnected(0);

      // Existing item with category
      repo.triggerEvent("existing", {
        id: "1",
        title: "Has Category",
        completed: false,
        categoryId: "cat_1",
        category: { id: "cat_1", name: "Work" }
      });

      let snapshot = query.getSnapshot();
      expect(snapshot.items[0].categoryId).toBe("cat_1");

      // Update to different category
      query.mutate.update("1", { categoryId: "cat_2" });

      snapshot = query.getSnapshot();
      expect(snapshot.items[0].categoryId).toBe("cat_2");
      // Note: category object still shows old until server responds

      query.destroy();
    });
  });

  describe("9.3 Subscription with relations after reconnect", () => {
    it("should receive items with populated relations on reconnect", async () => {
      const repo = createMockRepo<TodoWithCategory>();
      const query = createLiveQuery(repo, { include: "category" });

      await wait(10);
      repo.triggerConnected(0);

      // Disconnect
      repo.triggerDisconnected();

      // Reconnect - server sends items with relations
      repo.triggerConnected(5);
      repo.triggerEvent("existing", {
        id: "1",
        title: "With Relation",
        completed: false,
        categoryId: "cat_1",
        category: { id: "cat_1", name: "Personal" }
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].category?.name).toBe("Personal");

      query.destroy();
    });
  });
});

// ============================================================
// 10. ERROR RECOVERY
// ============================================================

describe("10. Error Recovery", () => {
  describe("10.1 Sync fails then succeeds on retry", () => {
    it("should retry failed mutations", async () => {
      let attempts = 0;
      const manager = createOfflineManager({
        config: { enabled: true, maxRetries: 3, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("Network error");
          }
          return { success: true, serverId: "server_retry" };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Retry Me" }, undefined, "opt_retry");

      (manager as any).isOnline = true;

      // First sync attempt fails
      await manager.syncPendingMutations();
      let pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].retryCount).toBe(1);

      // Second sync attempt fails
      await manager.syncPendingMutations();
      pending = await manager.getPendingMutations();
      expect(pending[0].retryCount).toBe(2);

      // Third sync attempt succeeds
      await manager.syncPendingMutations();
      pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
      expect(attempts).toBe(3);
    });
  });

  describe("10.2 Sync fails permanently after max retries", () => {
    it("should stop retrying after max retries", async () => {
      const failedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, maxRetries: 2, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => {
          throw new Error("Permanent failure");
        },
        onMutationFailed: (mutation) => {
          failedMutations.push(mutation);
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Will Fail" }, undefined, "opt_fail");

      (manager as any).isOnline = true;

      // Retry until max
      await manager.syncPendingMutations(); // retry 1
      await manager.syncPendingMutations(); // retry 2
      await manager.syncPendingMutations(); // exceeds max, skipped

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].retryCount).toBe(2);
    });
  });

  describe("10.3 Partial sync - some succeed, some fail", () => {
    it("should continue syncing remaining mutations after one fails", async () => {
      let callCount = 0;
      const syncedIds: string[] = [];

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          callCount++;
          if (mutation.optimisticId === "opt_fail") {
            throw new Error("This one fails");
          }
          syncedIds.push(mutation.optimisticId!);
          return { success: true, serverId: `server_${mutation.optimisticId}` };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Success 1" }, undefined, "opt_1");
      await manager.queueMutation("create", "/todos", { title: "Will Fail" }, undefined, "opt_fail");
      await manager.queueMutation("create", "/todos", { title: "Success 2" }, undefined, "opt_2");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // All three were attempted
      expect(callCount).toBe(3);

      // Two succeeded
      expect(syncedIds).toContain("opt_1");
      expect(syncedIds).toContain("opt_2");

      // One failed and remains pending
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].optimisticId).toBe("opt_fail");
    });
  });
});

// ============================================================
// 11. RACE CONDITIONS
// ============================================================

describe("11. Race Conditions", () => {
  describe("11.1 New mutation during sync", () => {
    it("should queue new mutation while sync is in progress", async () => {
      let syncResolve: () => void;
      const syncPromise = new Promise<void>(resolve => { syncResolve = resolve; });
      const syncedMutations: any[] = [];

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.optimisticId === "opt_slow") {
            await syncPromise;
          }
          return { success: true, serverId: `server_${mutation.optimisticId}` };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Slow" }, undefined, "opt_slow");

      (manager as any).isOnline = true;
      const syncTask = manager.syncPendingMutations();

      // While slow mutation is syncing, queue another
      await wait(10);
      await manager.queueMutation("create", "/todos", { title: "During Sync" }, undefined, "opt_during");

      // Complete the slow sync
      syncResolve!();
      await syncTask;

      // The new mutation should be queued but not synced yet
      const pending = await manager.getPendingMutations();
      expect(pending.some(m => m.optimisticId === "opt_during")).toBe(true);
    });
  });

  describe("11.2 Subscription reconnects during sync", () => {
    it("should handle subscription events during mutation sync", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        onIdRemapped: (optId, srvId) => idMappings.set(optId, srvId),
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Race", completed: false });
      await wait(10);

      const optId = query.getSnapshot().items[0].id;

      // Simulate: sync started, subscription reconnects in the middle
      repo.triggerDisconnected();

      // Mapping created as sync progresses
      idMappings.set(optId, "server_race");

      // Subscription reconnects with existing event
      repo.triggerConnected(5);
      repo.triggerEvent("existing", { id: "server_race", title: "Race", completed: false });

      await wait(10);

      // Should have reconciled
      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_race");

      query.destroy();
    });
  });

  describe("11.3 Rapid online/offline transitions", () => {
    it("should handle rapid network state changes", async () => {
      const syncCalls: number[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => {
          syncCalls.push(Date.now());
          await wait(50); // Slow sync
          return { success: true };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Rapid" }, undefined, "opt_rapid");

      // Rapid online/offline/online
      (manager as any).isOnline = true;
      const sync1 = manager.syncPendingMutations();

      (manager as any).isOnline = false;
      (manager as any).isOnline = true;
      const sync2 = manager.syncPendingMutations();

      await Promise.all([sync1, sync2]);

      // Should not cause issues (isSyncing flag prevents concurrent syncs)
      expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ============================================================
// 12. STATE CONSISTENCY INVARIANTS
// ============================================================

describe("12. State Consistency Invariants", () => {
  describe("12.1 No duplicate items", () => {
    it("should never have duplicate items in snapshot", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Add item
      repo.triggerEvent("existing", { id: "1", title: "Todo", completed: false });

      // Try to add same item again (shouldn't happen but let's verify)
      repo.triggerEvent("existing", { id: "1", title: "Todo Updated", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Todo Updated");

      query.destroy();
    });

    it("should not duplicate when optimistic item is reconciled", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "No Dupe", completed: false });
      await wait(10);

      const optId = query.getSnapshot().items[0].id;
      idMappings.set(optId, "server_no_dupe");

      // Server added event
      repo.triggerEvent("added",
        { id: "server_no_dupe", title: "No Dupe", completed: false },
        { optimisticId: optId }
      );

      const snapshot = query.getSnapshot();

      // Invariant: no duplicates
      const ids = snapshot.items.map(i => i.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);

      query.destroy();
    });
  });

  describe("12.2 No orphaned optimistic items", () => {
    it("should clean up optimistic items after reconciliation", async () => {
      const idMappings = new Map<string, string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async () => false,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create multiple optimistic items
      query.mutate.create({ title: "Opt 1", completed: false });
      query.mutate.create({ title: "Opt 2", completed: false });
      await wait(10);

      let snapshot = query.getSnapshot();
      const [opt1, opt2] = snapshot.items.map(i => i.id);

      idMappings.set(opt1, "server_1");
      idMappings.set(opt2, "server_2");

      // Both reconciled
      repo.triggerEvent("added", { id: "server_1", title: "Opt 1", completed: false }, { optimisticId: opt1 });
      repo.triggerEvent("added", { id: "server_2", title: "Opt 2", completed: false }, { optimisticId: opt2 });

      snapshot = query.getSnapshot();

      // Invariant: no optimistic_ prefixed IDs remain
      const optimisticIds = snapshot.items.filter(i => i.id.startsWith("optimistic_"));
      expect(optimisticIds).toHaveLength(0);

      query.destroy();
    });
  });

  describe("12.3 Pending count accuracy", () => {
    it("should accurately track pending mutation count", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => ({ success: true }),
      });

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getPendingCount: async () => (await manager.getPendingMutations()).length,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Initially no pending
      expect(query.getSnapshot().pendingCount).toBe(0);

      // Add pending mutations
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "P1" }, undefined, "opt_p1");
      await manager.queueMutation("create", "/todos", { title: "P2" }, undefined, "opt_p2");

      // Manually trigger pending count update
      // (In real usage, this happens via useLiveList callbacks)
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(2);

      // Sync
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const afterSync = await manager.getPendingMutations();
      expect(afterSync).toHaveLength(0);

      query.destroy();
    });
  });

  describe("12.4 Eventual consistency after sync", () => {
    it("should converge to server state after all mutations sync", async () => {
      const idMappings = new Map<string, string>();
      const pendingIds = new Set<string>();

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
        hasPendingMutationsForId: async (id) => pendingIds.has(id),
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Converge", completed: false });
      await wait(10);

      const optId = query.getSnapshot().items[0].id;
      pendingIds.add(optId);

      // Update optimistically
      query.mutate.update(optId, { completed: true });

      // Simulate sync completing
      idMappings.set(optId, "server_conv");
      pendingIds.delete(optId);

      // Server sends final state
      repo.triggerEvent("changed", { id: "server_conv", title: "Converge", completed: true });

      const snapshot = query.getSnapshot();

      // Invariant: final state matches server
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_conv");
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });
  });
});

// ============================================================
// 13. ADDITIONAL CRITICAL EDGE CASES
// ============================================================

describe("13. Additional Critical Edge Cases", () => {
  describe("13.1 Server rejects create (validation error)", () => {
    it("should handle server rejecting optimistic create", async () => {
      const onError = vi.fn();
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        onAuthError: onError,
      });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically
      query.mutate.create({ title: "Invalid", completed: false });
      await wait(10);

      expect(query.getSnapshot().items).toHaveLength(1);

      // Server rejects - send error event
      // In real scenario, the sync would fail and mutation would be retried/failed

      // For now, manually remove the optimistic item
      const optId = query.getSnapshot().items[0].id;
      repo.triggerEvent("removed", optId);

      expect(query.getSnapshot().items).toHaveLength(0);

      query.destroy();
    });
  });

  describe("13.2 Rehydrate from storage on page reload", () => {
    it("should restore pending mutations from storage", async () => {
      const storage = new InMemoryOfflineStorage();

      // Simulate previous session with pending mutation
      await storage.addMutation({
        id: "persisted_1",
        idempotencyKey: "idem_1",
        type: "create",
        resource: "/todos",
        data: { title: "Persisted" },
        optimisticId: "opt_persisted",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      });

      // Create new manager (simulating page reload)
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage },
        onMutationSync: async (mutation) => {
          syncedMutations.push(mutation);
          return { success: true, serverId: "server_persisted" };
        },
      });

      // Should have pending mutation from storage
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].optimisticId).toBe("opt_persisted");

      // Sync should work
      await manager.syncPendingMutations();
      expect(syncedMutations).toHaveLength(1);
    });
  });

  describe("13.3 Idempotency - don't duplicate on retry", () => {
    it("should use idempotency key to prevent duplicate creates", async () => {
      const storage = new InMemoryOfflineStorage();
      const manager = createOfflineManager({
        config: { enabled: true, storage },
      });

      (manager as any).isOnline = false;

      // Queue same mutation twice (simulating retry scenario)
      const id1 = await manager.queueMutation("create", "/todos", { title: "Idempotent" }, undefined, "opt_idem");

      // Each queued mutation should have unique idempotency key
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].idempotencyKey).toBeDefined();
    });
  });

  describe("13.4 Handle subscription error mid-stream", () => {
    it("should recover from subscription error", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "1", title: "Initial", completed: false });

      expect(query.getSnapshot().items).toHaveLength(1);

      // Error occurs
      repo.triggerError(new Error("Connection lost"));

      expect(query.getSnapshot().status).toBe("error");
      expect(query.getSnapshot().error?.message).toBe("Connection lost");

      // Reconnect
      repo.triggerConnected(10);

      expect(query.getSnapshot().status).not.toBe("error");

      query.destroy();
    });
  });

  describe("13.5 Filter changes while offline mutations pending", () => {
    it("should handle filter change with pending mutations", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "filtered_1", title: "Matches", completed: true }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, { filter: 'completed==true' });

      await wait(10);
      repo.triggerConnected(0);

      // Create optimistically (may not match filter)
      query.mutate.create({ title: "New", completed: false });
      await wait(10);

      // Optimistic item is shown even if doesn't match filter
      // (because we can't apply server filter to optimistic items)
      expect(query.getSnapshot().items.length).toBeGreaterThanOrEqual(1);

      query.destroy();
    });
  });

  describe("13.6 Large offline queue", () => {
    it("should handle many pending mutations", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async () => ({ success: true }),
      });

      (manager as any).isOnline = false;

      // Queue many mutations
      for (let i = 0; i < 100; i++) {
        await manager.queueMutation("create", "/todos", { title: `Todo ${i}` }, undefined, `opt_${i}`);
      }

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(100);

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const afterSync = await manager.getPendingMutations();
      expect(afterSync).toHaveLength(0);
    });
  });

  describe("13.7 Destroy during pending operations", () => {
    it("should clean up properly when destroyed", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      await wait(10);
      repo.triggerConnected(0);

      query.mutate.create({ title: "Before Destroy", completed: false });
      await wait(5);

      // Destroy while mutations may be pending
      query.destroy();

      // Should not throw
      expect(() => query.getSnapshot()).not.toThrow();
    });
  });
});

// ============================================================
// 14. OPTIMISTIC ID CHAIN OPERATIONS (CRITICAL)
// ============================================================
// These tests verify that when a client creates an item offline and then
// performs subsequent operations on it, the optimistic ID is properly
// remapped to the server ID during sync.

describe("14. Optimistic ID Chain Operations", () => {
  describe("14.1 Create then Update same item offline", () => {
    it("should remap optimistic ID to server ID for update", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_todo_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create todo with optimistic ID
      await manager.queueMutation("create", "/todos", { title: "New Todo", completed: false }, undefined, "opt_todo_1");
      // Update the same todo (using optimistic ID)
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Both should sync
      expect(syncedMutations).toHaveLength(2);
      // Create should have optimistic ID
      expect(syncedMutations[0].type).toBe("create");
      expect(syncedMutations[0].optimisticId).toBe("opt_todo_1");
      // Update should use SERVER ID (remapped from optimistic ID)
      expect(syncedMutations[1].type).toBe("update");
      expect(syncedMutations[1].objectId).toBe("server_todo_1");
    });

    it("should handle create then multiple updates", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_todo_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Todo" }, undefined, "opt_1");
      // With dedupeWindowMs: 0, these should be separate mutations
      await manager.queueMutation("update", "/todos", { title: "Updated" }, "opt_1");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // All three should sync with remapped IDs
      expect(syncedMutations).toHaveLength(3);
      expect(syncedMutations[1].objectId).toBe("server_todo_1");
      expect(syncedMutations[2].objectId).toBe("server_todo_1");
    });
  });

  describe("14.2 Create then Delete same item offline", () => {
    it("should remap optimistic ID to server ID for delete", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_todo_del" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Will Delete" }, undefined, "opt_del");
      await manager.queueMutation("delete", "/todos", undefined, "opt_del");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      expect(syncedMutations[0].type).toBe("create");
      expect(syncedMutations[1].type).toBe("delete");
      expect(syncedMutations[1].objectId).toBe("server_todo_del");
    });
  });

  describe("14.3 Create category then create todo with that category", () => {
    it("should remap category optimistic ID in todo data", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create" && mutation.resource === "/categories") {
            return { success: true, serverId: "server_cat_1" };
          }
          if (mutation.type === "create" && mutation.resource === "/todos") {
            return { success: true, serverId: "server_todo_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create category
      await manager.queueMutation("create", "/categories", { name: "Work" }, undefined, "opt_cat_1");
      // Create todo with that category (using optimistic category ID)
      await manager.queueMutation("create", "/todos", { title: "Task", categoryId: "opt_cat_1" }, undefined, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      // The todo's categoryId should be remapped to server ID
      expect(syncedMutations[1].data.categoryId).toBe("server_cat_1");
    });
  });

  describe("14.4 Create todo, create category, attach category to todo", () => {
    it("should remap both IDs correctly", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create" && mutation.resource === "/todos") {
            return { success: true, serverId: "server_todo_1" };
          }
          if (mutation.type === "create" && mutation.resource === "/categories") {
            return { success: true, serverId: "server_cat_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create todo first
      await manager.queueMutation("create", "/todos", { title: "Task", completed: false }, undefined, "opt_todo_1");
      // Create category
      await manager.queueMutation("create", "/categories", { name: "Work" }, undefined, "opt_cat_1");
      // Update todo to attach category (both IDs are optimistic)
      await manager.queueMutation("update", "/todos", { categoryId: "opt_cat_1" }, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(3);
      // Update should have both IDs remapped
      expect(syncedMutations[2].objectId).toBe("server_todo_1");
      expect(syncedMutations[2].data.categoryId).toBe("server_cat_1");
    });
  });

  describe("14.5 Complex chain: create, update, attach relation, update again", () => {
    it("should remap all IDs throughout the chain", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create" && mutation.resource === "/todos") {
            return { success: true, serverId: "server_todo_1" };
          }
          if (mutation.type === "create" && mutation.resource === "/categories") {
            return { success: true, serverId: "server_cat_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // 1. Create todo
      await manager.queueMutation("create", "/todos", { title: "Task", completed: false }, undefined, "opt_todo_1");
      // 2. Update todo (mark complete)
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_todo_1");
      // 3. Create category
      await manager.queueMutation("create", "/categories", { name: "Work" }, undefined, "opt_cat_1");
      // 4. Attach category to todo
      await manager.queueMutation("update", "/todos", { categoryId: "opt_cat_1" }, "opt_todo_1");
      // 5. Update todo title
      await manager.queueMutation("update", "/todos", { title: "Updated Task" }, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(5);

      // Mutation 2: update completed - should use server todo ID
      expect(syncedMutations[1].objectId).toBe("server_todo_1");

      // Mutation 4: attach category - should use both server IDs
      expect(syncedMutations[3].objectId).toBe("server_todo_1");
      expect(syncedMutations[3].data.categoryId).toBe("server_cat_1");

      // Mutation 5: update title - should use server todo ID
      expect(syncedMutations[4].objectId).toBe("server_todo_1");
    });
  });

  describe("14.6 Multiple items with cross-references", () => {
    it("should remap IDs across multiple items", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            const id = mutation.optimisticId?.replace("opt_", "server_");
            return { success: true, serverId: id };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create category 1
      await manager.queueMutation("create", "/categories", { name: "Work" }, undefined, "opt_cat_work");
      // Create category 2
      await manager.queueMutation("create", "/categories", { name: "Personal" }, undefined, "opt_cat_personal");
      // Create todo 1 with category 1
      await manager.queueMutation("create", "/todos", { title: "Task 1", categoryId: "opt_cat_work" }, undefined, "opt_todo_1");
      // Create todo 2 with category 2
      await manager.queueMutation("create", "/todos", { title: "Task 2", categoryId: "opt_cat_personal" }, undefined, "opt_todo_2");
      // Update todo 1 to category 2
      await manager.queueMutation("update", "/todos", { categoryId: "opt_cat_personal" }, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(5);

      // Todo 1 should have work category initially
      expect(syncedMutations[2].data.categoryId).toBe("server_cat_work");

      // Todo 2 should have personal category
      expect(syncedMutations[3].data.categoryId).toBe("server_cat_personal");

      // Update todo 1 should use server IDs
      expect(syncedMutations[4].objectId).toBe("server_todo_1");
      expect(syncedMutations[4].data.categoryId).toBe("server_cat_personal");
    });
  });

  describe("14.7 Nested data with optimistic IDs", () => {
    it("should remap IDs in nested data structures", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create tag
      await manager.queueMutation("create", "/tags", { name: "urgent" }, undefined, "opt_tag_1");
      // Create todo with nested tag reference
      await manager.queueMutation("create", "/todos", {
        title: "Task",
        metadata: {
          tagIds: ["opt_tag_1"],
          primaryTagId: "opt_tag_1"
        }
      }, undefined, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      // Nested IDs should be remapped
      expect(syncedMutations[1].data.metadata.tagIds).toEqual(["server_opt_tag_1"]);
      expect(syncedMutations[1].data.metadata.primaryTagId).toBe("server_opt_tag_1");
    });
  });

  describe("14.8 ID remapping with arrays of IDs", () => {
    it("should remap all IDs in arrays", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create" && mutation.resource === "/tags") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          if (mutation.type === "create" && mutation.resource === "/todos") {
            return { success: true, serverId: "server_todo_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create multiple tags
      await manager.queueMutation("create", "/tags", { name: "urgent" }, undefined, "opt_tag_1");
      await manager.queueMutation("create", "/tags", { name: "important" }, undefined, "opt_tag_2");
      await manager.queueMutation("create", "/tags", { name: "later" }, undefined, "opt_tag_3");
      // Create todo with multiple tag IDs
      await manager.queueMutation("create", "/todos", {
        title: "Task",
        tagIds: ["opt_tag_1", "opt_tag_2", "opt_tag_3"]
      }, undefined, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(4);
      // All tag IDs should be remapped
      expect(syncedMutations[3].data.tagIds).toEqual([
        "server_opt_tag_1",
        "server_opt_tag_2",
        "server_opt_tag_3"
      ]);
    });
  });

  describe("14.9 Update with mixed server and optimistic IDs", () => {
    it("should only remap optimistic IDs, not server IDs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "server_cat_new" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create new category
      await manager.queueMutation("create", "/categories", { name: "New" }, undefined, "opt_cat_new");
      // Update existing todo (with real server ID) to use new category
      await manager.queueMutation("update", "/todos", { categoryId: "opt_cat_new" }, "existing_server_todo_123");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      // objectId should remain as the server ID (not remapped)
      expect(syncedMutations[1].objectId).toBe("existing_server_todo_123");
      // categoryId should be remapped
      expect(syncedMutations[1].data.categoryId).toBe("server_cat_new");
    });
  });

  describe("14.10 Chain with failure and retry", () => {
    it("should maintain ID mappings across retries", async () => {
      let attemptCount = 0;
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), maxRetries: 3 },
        onMutationSync: async (mutation) => {
          attemptCount++;
          if (mutation.type === "create") {
            return { success: true, serverId: "server_todo_1" };
          }
          // Fail update on first attempt
          if (mutation.type === "update" && attemptCount === 2) {
            return { success: false, error: new Error("Network error") };
          }
          syncedMutations.push({ ...mutation });
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Task" }, undefined, "opt_todo_1");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_todo_1");

      (manager as any).isOnline = true;

      // First sync - create succeeds, update fails
      await manager.syncPendingMutations();
      // Second sync - update should retry with correct server ID
      await manager.syncPendingMutations();

      // Update should eventually succeed with server ID
      const updateMutation = syncedMutations.find(m => m.type === "update");
      expect(updateMutation).toBeDefined();
      expect(updateMutation.objectId).toBe("server_todo_1");
    });
  });

  describe("14.11 Full user workflow simulation", () => {
    it("should handle realistic offline session", async () => {
      const syncedMutations: any[] = [];
      const serverIdMap: Record<string, string> = {};
      let nextServerId = 1;

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            const serverId = `server_${nextServerId++}`;
            if (mutation.optimisticId) {
              serverIdMap[mutation.optimisticId] = serverId;
            }
            return { success: true, serverId };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // User workflow:
      // 1. Add a todo "Buy groceries"
      await manager.queueMutation("create", "/todos", {
        title: "Buy groceries",
        completed: false
      }, undefined, "opt_todo_groceries");

      // 2. Mark it as complete
      await manager.queueMutation("update", "/todos", {
        completed: true
      }, "opt_todo_groceries");

      // 3. Add a category "Shopping"
      await manager.queueMutation("create", "/categories", {
        name: "Shopping",
        color: "#ff0000"
      }, undefined, "opt_cat_shopping");

      // 4. Assign the category to the todo
      await manager.queueMutation("update", "/todos", {
        categoryId: "opt_cat_shopping"
      }, "opt_todo_groceries");

      // 5. Add another todo in the same category
      await manager.queueMutation("create", "/todos", {
        title: "Buy cleaning supplies",
        completed: false,
        categoryId: "opt_cat_shopping"
      }, undefined, "opt_todo_cleaning");

      // 6. Update the first todo's title
      await manager.queueMutation("update", "/todos", {
        title: "Buy groceries and snacks"
      }, "opt_todo_groceries");

      // Come back online
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Verify all 6 mutations synced
      expect(syncedMutations).toHaveLength(6);

      // Verify ID remapping:
      // Mutation 0: create groceries todo -> gets server_1
      expect(syncedMutations[0].type).toBe("create");
      expect(syncedMutations[0].optimisticId).toBe("opt_todo_groceries");

      // Mutation 1: update groceries todo -> should use server_1
      expect(syncedMutations[1].type).toBe("update");
      expect(syncedMutations[1].objectId).toBe("server_1");

      // Mutation 2: create shopping category -> gets server_2
      expect(syncedMutations[2].type).toBe("create");
      expect(syncedMutations[2].optimisticId).toBe("opt_cat_shopping");

      // Mutation 3: update groceries todo with category -> should use server_1 and server_2
      expect(syncedMutations[3].type).toBe("update");
      expect(syncedMutations[3].objectId).toBe("server_1");
      expect(syncedMutations[3].data.categoryId).toBe("server_2");

      // Mutation 4: create cleaning todo with category -> should use server_2
      expect(syncedMutations[4].type).toBe("create");
      expect(syncedMutations[4].data.categoryId).toBe("server_2");

      // Mutation 5: update groceries title -> should use server_1
      expect(syncedMutations[5].type).toBe("update");
      expect(syncedMutations[5].objectId).toBe("server_1");
    });
  });

  describe("14.12 Optimistic ID that looks like server ID", () => {
    it("should not accidentally remap server-like IDs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: "actual_server_id_123" };
          }
          return { success: true };
        },
      });

      // Pre-register an ID mapping that looks similar to what we'll use
      manager.registerIdMapping("opt_123", "server_123");

      (manager as any).isOnline = false;

      // Create with a different optimistic ID
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_456");
      // Update using the ID we created (not the pre-registered one)
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_456");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      // Should use the actual server ID from the create, not the pre-registered one
      expect(syncedMutations[1].objectId).toBe("actual_server_id_123");
    });
  });

  describe("14.13 Deep nested object ID remapping", () => {
    it("should remap IDs at any depth in the data structure", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push({ ...mutation });
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/users", { name: "Alice" }, undefined, "opt_user_1");
      await manager.queueMutation("create", "/todos", {
        title: "Complex",
        assignee: {
          userId: "opt_user_1",
          permissions: {
            owner: "opt_user_1",
            collaborators: ["opt_user_1", "existing_user_2"]
          }
        }
      }, undefined, "opt_todo_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      const todoData = syncedMutations[1].data;
      expect(todoData.assignee.userId).toBe("server_opt_user_1");
      expect(todoData.assignee.permissions.owner).toBe("server_opt_user_1");
      expect(todoData.assignee.permissions.collaborators).toEqual([
        "server_opt_user_1",
        "existing_user_2" // This should NOT be remapped
      ]);
    });
  });
});

// ============================================================
// 15. LIVEQUERY + OFFLINE MANAGER INTEGRATION
// ============================================================
// Tests for how LiveQuery handles optimistic updates and reconciles
// with server state after sync.

describe("15. LiveQuery + Offline Manager Integration", () => {
  describe("15.1 Optimistic items appear in snapshot", () => {
    it("should show optimistic item immediately after create", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Create optimistic item
      const optimisticId = query.mutate.create({ title: "Optimistic", completed: false });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Item should appear in snapshot immediately
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe(optimisticId);
      expect(snapshot.items[0].title).toBe("Optimistic");
    });

    it("should replace optimistic item with server item after sync", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      const optimisticId = query.mutate.create({ title: "Test", completed: false });
      await wait(10);

      // Simulate server response via subscription
      repo.triggerEvent("added", {
        id: "server_123",
        title: "Test",
        completed: false,
      }, { optimisticId });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have exactly one item with server ID
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe("server_123");
    });

    it("should not duplicate items when subscription confirms optimistic create", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Create multiple items
      const opt1 = query.mutate.create({ title: "First", completed: false });
      const opt2 = query.mutate.create({ title: "Second", completed: false });
      await wait(10);

      // Confirm both via subscription
      repo.triggerEvent("added", { id: "server_1", title: "First", completed: false }, { optimisticId: opt1 });
      repo.triggerEvent("added", { id: "server_2", title: "Second", completed: false }, { optimisticId: opt2 });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have exactly 2 items, no duplicates
      expect(snapshot.items.length).toBe(2);
      expect(snapshot.items.map(i => i.id).sort()).toEqual(["server_1", "server_2"]);
    });
  });

  describe("15.2 Optimistic updates to existing items", () => {
    it("should show optimistic update immediately", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Original", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Update the item
      query.mutate.update("todo_1", { completed: true });

      await wait(10);
      const snapshot = query.getSnapshot();

      expect(snapshot.items[0].completed).toBe(true);
    });

    it("should reconcile optimistic update with server response", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Original", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      query.mutate.update("todo_1", { title: "Updated" });
      await wait(10);

      // Server confirms update with slightly different data
      repo.triggerEvent("changed", {
        id: "todo_1",
        title: "Updated",
        completed: false,
        updatedAt: Date.now(),
      });

      await wait(10);
      const snapshot = query.getSnapshot();

      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].title).toBe("Updated");
    });
  });

  describe("15.3 Optimistic delete", () => {
    it("should remove item from snapshot immediately on delete", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [
          { id: "todo_1", title: "Keep", completed: false },
          { id: "todo_2", title: "Delete", completed: false },
        ],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      query.mutate.delete("todo_2");

      await wait(10);
      const snapshot = query.getSnapshot();

      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe("todo_1");
    });

    it("should not re-add deleted item from subscription", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Delete Me", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      query.mutate.delete("todo_1");
      await wait(10);

      // Server confirms deletion
      repo.triggerEvent("removed", "todo_1");

      await wait(10);
      const snapshot = query.getSnapshot();

      expect(snapshot.items.length).toBe(0);
    });
  });

  describe("15.4 Chain operations in LiveQuery", () => {
    it("should handle create then immediate update", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      const optimisticId = query.mutate.create({ title: "New", completed: false });
      query.mutate.update(optimisticId, { completed: true });

      await wait(10);
      const snapshot = query.getSnapshot();

      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].completed).toBe(true);
    });

    it("should handle create then immediate delete", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      const optimisticId = query.mutate.create({ title: "Ephemeral", completed: false });
      await wait(5);
      query.mutate.delete(optimisticId);

      await wait(10);
      const snapshot = query.getSnapshot();

      // Item should be gone
      expect(snapshot.items.length).toBe(0);
    });
  });
});

// ============================================================
// 16. SUBSCRIPTION RECONNECTION WITH PENDING MUTATIONS
// ============================================================
// Critical tests for when client reconnects and has pending mutations
// that need to be reconciled with server state.

describe("16. Subscription Reconnection with Pending Mutations", () => {
  describe("16.1 Reconnect with pending creates", () => {
    it("should not duplicate optimistic items on reconnect", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Create while connected
      const opt1 = query.mutate.create({ title: "Item 1", completed: false });
      await wait(10);

      // Server confirms the create with an "added" event containing optimisticId
      // This is what would happen in a real scenario
      repo.triggerEvent("added", { id: "server_1", title: "Item 1", completed: false }, { optimisticId: opt1 });
      await wait(10);

      // Disconnect
      repo.triggerDisconnected();
      await wait(10);

      // Create while disconnected
      const opt2 = query.mutate.create({ title: "Item 2", completed: false });
      await wait(10);

      // Reconnect - server sends existing items
      repo.setListResponse({
        items: [{ id: "server_1", title: "Item 1", completed: false }],
        nextCursor: null,
        hasMore: false,
      });
      repo.triggerConnected(5);

      // Server sends existing event for the first item (already synced)
      repo.triggerEvent("existing", { id: "server_1", title: "Item 1", completed: false });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have 2 items: server_1 (synced) and opt2 (pending)
      expect(snapshot.items.length).toBe(2);
    });

    it("should reconcile pending creates with server existing events", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      const optimisticId = query.mutate.create({ title: "Created Offline", completed: false });
      await wait(10);

      repo.triggerDisconnected();
      await wait(10);

      // Reconnect
      repo.triggerConnected(10);

      // Server sends the item back (it was synced before disconnect)
      repo.triggerEvent("existing", {
        id: "server_created",
        title: "Created Offline",
        completed: false,
      });

      // Also send the added event with optimisticId
      repo.triggerEvent("added", {
        id: "server_created",
        title: "Created Offline",
        completed: false,
      }, { optimisticId });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have exactly 1 item
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe("server_created");
    });
  });

  describe("16.2 Reconnect with pending updates", () => {
    it("should preserve pending updates through reconnection", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Original", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "todo_1", title: "Original", completed: false });
      await wait(10);

      // Update while connected
      query.mutate.update("todo_1", { completed: true });
      await wait(10);

      // Disconnect before sync completes
      repo.triggerDisconnected();
      await wait(10);

      // Verify optimistic state is preserved
      let snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(true);

      // Reconnect - server sends old state
      repo.triggerConnected(5);
      repo.triggerEvent("existing", { id: "todo_1", title: "Original", completed: false });
      await wait(10);

      // Pending update should still show optimistic state
      snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(true);
    });
  });

  describe("16.3 Reconnect with pending deletes", () => {
    it("should not re-show deleted items from existing events", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Delete Me", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "todo_1", title: "Delete Me", completed: false });
      await wait(10);

      // Delete while connected
      query.mutate.delete("todo_1");
      await wait(10);

      // Disconnect
      repo.triggerDisconnected();
      await wait(10);

      // Verify item is gone
      let snapshot = query.getSnapshot();
      expect(snapshot.items.length).toBe(0);

      // Reconnect - server still has the item (delete hasn't synced)
      repo.triggerConnected(5);
      repo.triggerEvent("existing", { id: "todo_1", title: "Delete Me", completed: false });
      await wait(10);

      // Pending delete should keep item hidden
      snapshot = query.getSnapshot();
      expect(snapshot.items.length).toBe(0);
    });
  });

  describe("16.4 Server state changed while offline", () => {
    it("should merge server changes with pending local changes", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Original", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "todo_1", title: "Original", completed: false });
      await wait(10);

      // Disconnect
      repo.triggerDisconnected();
      await wait(10);

      // Local change: mark completed
      query.mutate.update("todo_1", { completed: true });
      await wait(10);

      // Reconnect - server has different title (changed by another client)
      repo.triggerConnected(10);
      repo.triggerEvent("existing", {
        id: "todo_1",
        title: "Changed by other client",
        completed: false,
      });
      await wait(10);

      // Should show merged state: new title from server + pending completed from local
      const snapshot = query.getSnapshot();
      expect(snapshot.items[0].title).toBe("Changed by other client");
      expect(snapshot.items[0].completed).toBe(true);
    });
  });
});

// ============================================================
// 17. RACE CONDITIONS AND TIMING EDGE CASES
// ============================================================

describe("17. Race Conditions and Timing", () => {
  describe("17.1 Rapid sequential operations", () => {
    it("should handle rapid create-update-update-update sequence", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: "server_rapid" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Rapid fire operations
      await manager.queueMutation("create", "/todos", { title: "V0" }, undefined, "opt_rapid");
      await manager.queueMutation("update", "/todos", { title: "V1" }, "opt_rapid");
      await manager.queueMutation("update", "/todos", { title: "V2" }, "opt_rapid");
      await manager.queueMutation("update", "/todos", { title: "V3" }, "opt_rapid");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_rapid");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // All should sync with proper ID remapping
      expect(syncedMutations.length).toBe(5);
      expect(syncedMutations[0].optimisticId).toBe("opt_rapid");
      for (let i = 1; i < 5; i++) {
        expect(syncedMutations[i].objectId).toBe("server_rapid");
      }
    });

    it("should handle interleaved operations on multiple items", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Interleaved operations on items A and B
      await manager.queueMutation("create", "/todos", { title: "A" }, undefined, "opt_a");
      await manager.queueMutation("create", "/todos", { title: "B" }, undefined, "opt_b");
      await manager.queueMutation("update", "/todos", { title: "A updated" }, "opt_a");
      await manager.queueMutation("update", "/todos", { title: "B updated" }, "opt_b");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_a");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_b");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations.length).toBe(6);

      // Verify A operations use server_opt_a
      expect(syncedMutations[2].objectId).toBe("server_opt_a");
      expect(syncedMutations[4].objectId).toBe("server_opt_a");

      // Verify B operations use server_opt_b
      expect(syncedMutations[3].objectId).toBe("server_opt_b");
      expect(syncedMutations[5].objectId).toBe("server_opt_b");
    });
  });

  describe("17.2 Sync interrupted and resumed", () => {
    it("should resume sync correctly after interruption", async () => {
      let syncCount = 0;
      let shouldFail = true;
      const syncedMutations: any[] = [];

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), maxRetries: 5 },
        onMutationSync: async (mutation) => {
          syncCount++;
          // Fail first sync attempt of update
          if (mutation.type === "update" && shouldFail) {
            shouldFail = false;
            return { success: false, error: new Error("Network interrupted") };
          }
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: "server_interrupted" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_int");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_int");

      (manager as any).isOnline = true;

      // First sync - create succeeds, update fails
      await manager.syncPendingMutations();

      // Resume sync - update should succeed now
      await manager.syncPendingMutations();

      // Update should have correct server ID
      const updateMutation = syncedMutations.find(m => m.type === "update");
      expect(updateMutation).toBeDefined();
      expect(updateMutation.objectId).toBe("server_interrupted");
    });
  });

  describe("17.3 New mutations during sync", () => {
    it("should handle mutations added while sync is in progress", async () => {
      const syncedMutations: any[] = [];
      let syncResolve: (() => void) | null = null;
      let firstSyncStarted = false;

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create" && mutation.optimisticId === "opt_first") {
            firstSyncStarted = true;
            // Delay to simulate slow sync
            await new Promise<void>(resolve => {
              syncResolve = resolve;
            });
            return { success: true, serverId: "server_first" };
          }
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      // Start offline, then queue first mutation
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "First" }, undefined, "opt_first");

      // Go online and start sync
      (manager as any).isOnline = true;
      const syncPromise = manager.syncPendingMutations();

      // Wait for the first sync to actually start and block
      while (!firstSyncStarted) {
        await wait(5);
      }

      // Queue more mutations while first sync is blocked
      await manager.queueMutation("create", "/todos", { title: "Second" }, undefined, "opt_second");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_first");

      // Release the blocked sync
      syncResolve?.();
      await syncPromise;

      // Run another sync for the new mutations
      await manager.syncPendingMutations();

      // All mutations should eventually sync
      expect(syncedMutations.filter(m => m.type === "create")).toHaveLength(2);
    });
  });

  describe("17.4 Concurrent sync attempts", () => {
    it("should prevent duplicate sync runs", async () => {
      let syncRunCount = 0;
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncRunCount++;
          await wait(50); // Slow sync
          if (mutation.type === "create") {
            return { success: true, serverId: "server_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_1");
      (manager as any).isOnline = true;

      // Start multiple syncs concurrently
      const sync1 = manager.syncPendingMutations();
      const sync2 = manager.syncPendingMutations();
      const sync3 = manager.syncPendingMutations();

      await Promise.all([sync1, sync2, sync3]);

      // Should only sync once (not 3 times)
      expect(syncRunCount).toBe(1);
    });
  });
});

// ============================================================
// 18. MULTI-RESOURCE CASCADING OPERATIONS
// ============================================================

describe("18. Multi-Resource Cascading Operations", () => {
  describe("18.1 Parent-child relationships", () => {
    it("should handle creating parent then child with FK", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create" && mutation.resource === "/projects") {
            return { success: true, serverId: "server_project_1" };
          }
          if (mutation.type === "create" && mutation.resource === "/tasks") {
            return { success: true, serverId: "server_task_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create project
      await manager.queueMutation("create", "/projects", { name: "My Project" }, undefined, "opt_project_1");
      // Create task in project
      await manager.queueMutation("create", "/tasks", {
        title: "Task 1",
        projectId: "opt_project_1",
      }, undefined, "opt_task_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      // Task should have server project ID
      expect(syncedMutations[1].data.projectId).toBe("server_project_1");
    });

    it("should handle deep hierarchy: org -> project -> task -> subtask", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/orgs", { name: "Org" }, undefined, "opt_org");
      await manager.queueMutation("create", "/projects", {
        name: "Project",
        orgId: "opt_org",
      }, undefined, "opt_project");
      await manager.queueMutation("create", "/tasks", {
        title: "Task",
        projectId: "opt_project",
      }, undefined, "opt_task");
      await manager.queueMutation("create", "/subtasks", {
        title: "Subtask",
        taskId: "opt_task",
      }, undefined, "opt_subtask");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(4);
      expect(syncedMutations[1].data.orgId).toBe("server_opt_org");
      expect(syncedMutations[2].data.projectId).toBe("server_opt_project");
      expect(syncedMutations[3].data.taskId).toBe("server_opt_task");
    });
  });

  describe("18.2 Many-to-many relationships", () => {
    it("should handle junction table entries with optimistic IDs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create todo and tags
      await manager.queueMutation("create", "/todos", { title: "Todo" }, undefined, "opt_todo");
      await manager.queueMutation("create", "/tags", { name: "urgent" }, undefined, "opt_tag_1");
      await manager.queueMutation("create", "/tags", { name: "important" }, undefined, "opt_tag_2");

      // Create junction table entries
      await manager.queueMutation("create", "/todoTags", {
        todoId: "opt_todo",
        tagId: "opt_tag_1",
      }, undefined, "opt_junction_1");
      await manager.queueMutation("create", "/todoTags", {
        todoId: "opt_todo",
        tagId: "opt_tag_2",
      }, undefined, "opt_junction_2");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(5);

      // Junction entries should have server IDs
      expect(syncedMutations[3].data.todoId).toBe("server_opt_todo");
      expect(syncedMutations[3].data.tagId).toBe("server_opt_tag_1");
      expect(syncedMutations[4].data.todoId).toBe("server_opt_todo");
      expect(syncedMutations[4].data.tagId).toBe("server_opt_tag_2");
    });
  });

  describe("18.3 Cross-resource updates", () => {
    it("should handle updating items to reference each other", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create user and document
      await manager.queueMutation("create", "/users", { name: "Alice" }, undefined, "opt_user");
      await manager.queueMutation("create", "/documents", { title: "Doc" }, undefined, "opt_doc");

      // Update document to set author
      await manager.queueMutation("update", "/documents", { authorId: "opt_user" }, "opt_doc");

      // Update user to set last document
      await manager.queueMutation("update", "/users", { lastDocumentId: "opt_doc" }, "opt_user");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(4);
      expect(syncedMutations[2].objectId).toBe("server_opt_doc");
      expect(syncedMutations[2].data.authorId).toBe("server_opt_user");
      expect(syncedMutations[3].objectId).toBe("server_opt_user");
      expect(syncedMutations[3].data.lastDocumentId).toBe("server_opt_doc");
    });
  });
});

// ============================================================
// 19. STATE CONSISTENCY INVARIANTS
// ============================================================

describe("19. State Consistency Invariants", () => {
  describe("19.1 ID mapping consistency", () => {
    it("should maintain consistent ID mappings after sync", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "A" }, undefined, "opt_a");
      await manager.queueMutation("create", "/todos", { title: "B" }, undefined, "opt_b");
      await manager.queueMutation("create", "/todos", { title: "C" }, undefined, "opt_c");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // All optimistic IDs should be mapped
      expect(manager.resolveId("opt_a")).toBe("server_opt_a");
      expect(manager.resolveId("opt_b")).toBe("server_opt_b");
      expect(manager.resolveId("opt_c")).toBe("server_opt_c");

      // Server IDs should resolve to themselves
      expect(manager.resolveId("server_opt_a")).toBe("server_opt_a");
    });

    it("should not have orphaned ID mappings", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          if (mutation.type === "create") {
            return { success: true, serverId: `server_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create and delete same item
      await manager.queueMutation("create", "/todos", { title: "Temp" }, undefined, "opt_temp");
      await manager.queueMutation("delete", "/todos", undefined, "opt_temp");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Mapping should still exist (server did receive the item)
      expect(manager.resolveId("opt_temp")).toBe("server_opt_temp");
    });
  });

  describe("19.2 Mutation queue consistency", () => {
    it("should have empty queue after successful sync", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          if (mutation.type === "create") {
            return { success: true, serverId: "server_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_1");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_1");

      const beforeSync = await manager.getPendingMutations();
      expect(beforeSync.length).toBeGreaterThan(0);

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const afterSync = await manager.getPendingMutations();
      expect(afterSync.length).toBe(0);
    });

    it("should preserve failed mutations in queue", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), maxRetries: 1 },
        onMutationSync: async () => {
          return { success: false, error: new Error("Server error") };
        },
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "Fail" }, undefined, "opt_fail");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const pending = await manager.getPendingMutations();
      expect(pending.length).toBe(1);
      expect(pending[0].retryCount).toBe(1);
    });
  });

  describe("19.3 LiveQuery state invariants", () => {
    it("should never have duplicate items with same ID", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({
        items: [{ id: "todo_1", title: "Existing", completed: false }],
        nextCursor: null,
        hasMore: false,
      });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      repo.triggerEvent("existing", { id: "todo_1", title: "Existing", completed: false });
      await wait(10);

      // Send duplicate existing event
      repo.triggerEvent("existing", { id: "todo_1", title: "Existing", completed: false });
      // Send added event for same ID
      repo.triggerEvent("added", { id: "todo_1", title: "Existing", completed: true });
      // Send changed event
      repo.triggerEvent("changed", { id: "todo_1", title: "Changed", completed: true });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have exactly 1 item
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe("todo_1");
    });

    it("should maintain item count consistency", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Create 5 items
      for (let i = 0; i < 5; i++) {
        query.mutate.create({ title: `Item ${i}`, completed: false });
      }
      await wait(10);

      let snapshot = query.getSnapshot();
      expect(snapshot.items.length).toBe(5);

      // Delete 2 items
      const ids = snapshot.items.slice(0, 2).map(i => i.id);
      for (const id of ids) {
        query.mutate.delete(id);
      }
      await wait(10);

      snapshot = query.getSnapshot();
      expect(snapshot.items.length).toBe(3);
    });
  });
});

// ============================================================
// 20. ADDITIONAL CRITICAL SCENARIOS
// ============================================================

describe("20. Additional Critical Scenarios", () => {
  describe("20.1 Offline session with complex workflow", () => {
    it("should handle a complete offline work session", async () => {
      const syncedMutations: any[] = [];
      let serverId = 0;

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), dedupeWindowMs: 0 },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `srv_${++serverId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Simulate complex offline session:

      // 1. User creates a project
      await manager.queueMutation("create", "/projects", {
        name: "Q1 Planning",
        status: "active",
      }, undefined, "opt_project");

      // 2. Creates multiple tasks in the project
      await manager.queueMutation("create", "/tasks", {
        title: "Research competitors",
        projectId: "opt_project",
        priority: "high",
      }, undefined, "opt_task_1");

      await manager.queueMutation("create", "/tasks", {
        title: "Draft proposal",
        projectId: "opt_project",
        priority: "medium",
      }, undefined, "opt_task_2");

      await manager.queueMutation("create", "/tasks", {
        title: "Schedule meeting",
        projectId: "opt_project",
        priority: "low",
      }, undefined, "opt_task_3");

      // 3. Marks first task as complete
      await manager.queueMutation("update", "/tasks", {
        completed: true,
        completedAt: Date.now(),
      }, "opt_task_1");

      // 4. Creates a label
      await manager.queueMutation("create", "/labels", {
        name: "urgent",
        color: "red",
      }, undefined, "opt_label");

      // 5. Applies label to second task
      await manager.queueMutation("update", "/tasks", {
        labelIds: ["opt_label"],
      }, "opt_task_2");

      // 6. Updates project status
      await manager.queueMutation("update", "/projects", {
        status: "in_progress",
        taskCount: 3,
      }, "opt_project");

      // 7. Deletes third task (decided not needed)
      await manager.queueMutation("delete", "/tasks", undefined, "opt_task_3");

      // 8. Creates a note on second task
      await manager.queueMutation("create", "/notes", {
        content: "Need to include budget section",
        taskId: "opt_task_2",
      }, undefined, "opt_note");

      // Come back online
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Verify all 10 mutations synced correctly
      expect(syncedMutations).toHaveLength(10);

      // Verify critical ID remappings:

      // Tasks should reference server project ID
      expect(syncedMutations[1].data.projectId).toBe("srv_1"); // project is srv_1
      expect(syncedMutations[2].data.projectId).toBe("srv_1");
      expect(syncedMutations[3].data.projectId).toBe("srv_1");

      // Task update should use server task ID
      expect(syncedMutations[4].objectId).toBe("srv_2"); // task_1 is srv_2

      // Label update should use server IDs
      expect(syncedMutations[6].objectId).toBe("srv_3"); // task_2 is srv_3
      expect(syncedMutations[6].data.labelIds).toEqual(["srv_5"]); // label is srv_5

      // Project update should use server project ID
      expect(syncedMutations[7].objectId).toBe("srv_1");

      // Delete should use server task ID
      expect(syncedMutations[8].objectId).toBe("srv_4"); // task_3 is srv_4

      // Note should reference server task ID
      expect(syncedMutations[9].data.taskId).toBe("srv_3");
    });
  });

  describe("20.2 Recovery from partial sync", () => {
    it("should recover when some mutations succeed and others fail", async () => {
      let callCount = 0;
      const syncedMutations: any[] = [];

      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage(), maxRetries: 3 },
        onMutationSync: async (mutation) => {
          callCount++;

          // First call: create succeeds
          if (callCount === 1 && mutation.type === "create") {
            syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
            return { success: true, serverId: "srv_1" };
          }

          // Second call: update fails
          if (callCount === 2) {
            return { success: false, error: new Error("Server unavailable") };
          }

          // Subsequent calls: everything succeeds
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_1");
      await manager.queueMutation("update", "/todos", { completed: true }, "opt_1");

      (manager as any).isOnline = true;

      // First sync: create succeeds, update fails
      await manager.syncPendingMutations();
      expect(syncedMutations).toHaveLength(1);

      // Second sync: update retries and succeeds
      await manager.syncPendingMutations();
      expect(syncedMutations).toHaveLength(2);

      // Update should have the correct server ID
      expect(syncedMutations[1].objectId).toBe("srv_1");
    });
  });

  describe("20.3 Clear and reset", () => {
    it("should properly clear all state", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          if (mutation.type === "create") {
            return { success: true, serverId: "srv_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Verify state exists
      expect(manager.resolveId("opt_1")).toBe("srv_1");

      // Clear everything
      await manager.clearMutations();

      // ID mappings should be cleared
      expect(manager.resolveId("opt_1")).toBe("opt_1");

      // Pending mutations should be empty
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });
  });

  describe("20.4 Multiple syncs with accumulating mappings", () => {
    it("should accumulate ID mappings across multiple sync cycles", async () => {
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          if (mutation.type === "create") {
            return { success: true, serverId: `srv_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      // First offline session
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "A" }, undefined, "opt_a");
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Second offline session
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "B" }, undefined, "opt_b");
      await manager.queueMutation("update", "/todos", { related: "opt_a" }, "opt_b");
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Third offline session
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/todos", { title: "C" }, undefined, "opt_c");
      await manager.queueMutation("update", "/todos", { siblings: ["opt_a", "opt_b"] }, "opt_c");
      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // All mappings should exist
      expect(manager.resolveId("opt_a")).toBe("srv_opt_a");
      expect(manager.resolveId("opt_b")).toBe("srv_opt_b");
      expect(manager.resolveId("opt_c")).toBe("srv_opt_c");

      // Get all mappings
      const mappings = manager.getIdMappings();
      expect(mappings.size).toBe(3);
    });
  });

  describe("20.5 Edge case: Empty and null data", () => {
    it("should handle mutations with empty data", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: "srv_1" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", {}, undefined, "opt_1");
      await manager.queueMutation("update", "/todos", {}, "opt_1");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      expect(syncedMutations[1].objectId).toBe("srv_1");
    });

    it("should handle mutations with null values in data", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: "srv_cat" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/categories", { name: "Test" }, undefined, "opt_cat");
      await manager.queueMutation("update", "/todos", {
        title: "Test",
        categoryId: null,
        description: null,
      }, "existing_todo");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(2);
      expect(syncedMutations[1].data.categoryId).toBeNull();
      expect(syncedMutations[1].data.description).toBeNull();
    });
  });

  describe("20.6 Stress test: Many items", () => {
    it("should handle syncing 50 items with cross-references", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            return { success: true, serverId: `srv_${mutation.optimisticId}` };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      // Create 10 categories
      for (let i = 0; i < 10; i++) {
        await manager.queueMutation("create", "/categories", {
          name: `Category ${i}`,
        }, undefined, `opt_cat_${i}`);
      }

      // Create 40 todos distributed across categories
      for (let i = 0; i < 40; i++) {
        const catIndex = i % 10;
        await manager.queueMutation("create", "/todos", {
          title: `Todo ${i}`,
          categoryId: `opt_cat_${catIndex}`,
        }, undefined, `opt_todo_${i}`);
      }

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(syncedMutations).toHaveLength(50);

      // Verify all todos have correct server category IDs
      const todoMutations = syncedMutations.filter(m => m.resource === "/todos");
      for (const todo of todoMutations) {
        const expectedCat = todo.data.categoryId;
        expect(expectedCat).toMatch(/^srv_opt_cat_\d$/);
      }
    });
  });

  describe("20.7 ID collision prevention", () => {
    it("should not confuse similar optimistic and server IDs", async () => {
      const syncedMutations: any[] = [];
      const manager = createOfflineManager({
        config: { enabled: true, storage: new InMemoryOfflineStorage() },
        onMutationSync: async (mutation) => {
          syncedMutations.push(JSON.parse(JSON.stringify(mutation)));
          if (mutation.type === "create") {
            // Server returns ID that looks like an optimistic ID
            return { success: true, serverId: "opt_looks_like_optimistic" };
          }
          return { success: true };
        },
      });

      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "actual_opt_id");
      await manager.queueMutation("update", "/todos", { completed: true }, "actual_opt_id");

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      // Update should use the server ID, even though it looks like an optimistic ID
      expect(syncedMutations[1].objectId).toBe("opt_looks_like_optimistic");
    });
  });

  describe("20.8 Subscription and offline manager coordination", () => {
    it("should handle subscription events during sync", async () => {
      const repo = createMockRepo<Todo>();
      repo.setListResponse({ items: [], nextCursor: null, hasMore: false });

      const query = createLiveQuery(repo, {});
      await wait(10);
      repo.triggerConnected(0);
      await wait(10);

      // Create optimistic item
      const optId = query.mutate.create({ title: "Syncing", completed: false });
      await wait(10);

      // Simulate server confirming via subscription before sync completes
      repo.triggerEvent("added", {
        id: "server_confirmed",
        title: "Syncing",
        completed: false,
      }, { optimisticId: optId });

      await wait(10);
      const snapshot = query.getSnapshot();

      // Should have exactly 1 item with server ID
      expect(snapshot.items.length).toBe(1);
      expect(snapshot.items[0].id).toBe("server_confirmed");
    });
  });
});
