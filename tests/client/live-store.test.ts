import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLiveQuery, LiveQuery } from "../../src/client/live-store";
import { ResourceClient, PaginatedResponse, Subscription, SubscriptionState, SubscriptionCallbacks } from "../../src/client/types";

// Mock resource client
const createMockRepo = <T extends { id: string }>(): ResourceClient<T> & {
  subscriptionCallbacks: SubscriptionCallbacks<T> | undefined;
  triggerEvent: (type: string, data: unknown) => void;
} => {
  let callbacks: SubscriptionCallbacks<T> | undefined;

  const mockSubscription: Subscription<T> = {
    state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
    items: [],
    unsubscribe: vi.fn(),
    reconnect: vi.fn(),
  };

  return {
    subscriptionCallbacks: undefined,
    triggerEvent(type: string, data: unknown) {
      if (type === "added" && callbacks?.onAdded) {
        const { item, meta } = data as { item: T; meta?: { optimisticId?: string } };
        callbacks.onAdded(item, meta);
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
      if (type === "connected" && callbacks?.onConnected) {
        callbacks.onConnected(data as number);
      }
    },
    async list(): Promise<PaginatedResponse<T>> {
      return { items: [], nextCursor: null, hasMore: false };
    },
    async get(id: string): Promise<T> {
      return { id } as T;
    },
    async count(): Promise<number> {
      return 0;
    },
    async aggregate() {
      return { groups: [] };
    },
    async create(data: Omit<T, "id">): Promise<T> {
      return { ...data, id: "new-id" } as T;
    },
    async update(id: string, data: Partial<T>): Promise<T> {
      return { ...data, id } as T;
    },
    async replace(id: string, data: Omit<T, "id">): Promise<T> {
      return { ...data, id } as T;
    },
    async delete(): Promise<void> {},
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

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  categoryId?: string | null;
}

interface Category {
  id: string;
  name: string;
  color?: string;
}

interface Tag {
  id: string;
  name: string;
}

interface TodoWithRelations extends Todo {
  category?: Category | null;
  tags?: Tag[];
}

describe("LiveStore", () => {
  describe("onExisting callback", () => {
    it("should handle existing events", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate existing event
      repo.triggerEvent("existing", { id: "1", title: "Test Todo", completed: false });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("honors a pending delete keyed by the optimistic id after a changed event remaps it (no ghost on refresh)", async () => {
      // Regression: handleChange must record the remap as optimisticId -> serverId
      // (the project-wide convention). If it stores it reversed, a later refresh
      // can't map the returned server row back to the optimistic id, so a
      // pending-deleted item reappears as a ghost.
      const externalMappings = new Map<string, string>();
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery<Todo>(repo, {}, {
        getIdMappings: () => externalMappings,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Optimistic (offline-created) item in cache, known to the OfflineManager.
      repo.triggerEvent("added", { item: { id: "opt_1", title: "Draft", completed: false } });
      externalMappings.set("opt_1", "srv_1");

      // Server confirms the row under its real id via a changed event.
      repo.triggerEvent("changed", { id: "srv_1", title: "Draft", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("srv_1");

      // Delete the item; the pending delete is keyed by the optimistic id.
      query.mutate.delete("opt_1");

      // A refresh returns the server row; it must be suppressed because opt_1
      // (which maps to srv_1) has a pending delete.
      repo.list = async () => ({
        items: [{ id: "srv_1", title: "Draft", completed: false } as Todo],
        nextCursor: null,
        hasMore: false,
      });
      await query.refresh();

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(0);

      query.destroy();
    });

    it("should reconcile optimistic items with existing items via getIdMappings", async () => {
      // This test simulates the ghost todo scenario:
      // 1. Create todo optimistically while offline
      // 2. Come back online
      // 3. Offline manager syncs, creates mapping optimistic -> server
      // 4. Subscription reconnects, sends existing events
      // 5. Live store should remove optimistic item and keep server item

      const idMappings = new Map<string, string>();
      idMappings.set("optimistic_123", "server_456"); // optimistic -> server

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
      });

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate optimistic create (normally done via mutate.create)
      // We'll manually add to the cache by triggering an added event without proper reconciliation
      repo.triggerEvent("added", {
        item: { id: "optimistic_123", title: "Test Todo", completed: false },
        meta: undefined, // No optimisticId in meta since this is the optimistic item itself
      });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("optimistic_123");

      // Now simulate subscription reconnect with existing event for the server item
      repo.triggerEvent("existing", { id: "server_456", title: "Test Todo", completed: false });

      snapshot = query.getSnapshot();
      // Should have only one item - the server one
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_456");

      query.destroy();
    });

    it("should not create ghost items when added event has optimisticId meta", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate optimistic create
      query.mutate.create({ title: "Test Todo", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      const optimisticId = snapshot.items[0].id;
      expect(optimisticId).toMatch(/^optimistic_/);

      // Simulate server returning the item with optimisticId in meta
      repo.triggerEvent("added", {
        item: { id: "server_789", title: "Test Todo", completed: false },
        meta: { optimisticId },
      });

      snapshot = query.getSnapshot();
      // Should have only one item - the server one
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_789");

      query.destroy();
    });

    it("should handle multiple existing events during reconnect", async () => {
      const idMappings = new Map<string, string>();
      idMappings.set("opt_1", "srv_1");
      idMappings.set("opt_2", "srv_2");

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
      });

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add optimistic items
      repo.triggerEvent("added", { item: { id: "opt_1", title: "Todo 1", completed: false } });
      repo.triggerEvent("added", { item: { id: "opt_2", title: "Todo 2", completed: true } });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Simulate reconnect with existing events
      repo.triggerEvent("existing", { id: "srv_1", title: "Todo 1", completed: false });
      repo.triggerEvent("existing", { id: "srv_2", title: "Todo 2", completed: true });
      repo.triggerEvent("existing", { id: "srv_3", title: "Todo 3", completed: false }); // New item

      snapshot = query.getSnapshot();
      // Should have 3 items: srv_1, srv_2, srv_3 (not opt_1, opt_2)
      expect(snapshot.items).toHaveLength(3);
      expect(snapshot.items.map(i => i.id).sort()).toEqual(["srv_1", "srv_2", "srv_3"]);

      query.destroy();
    });
  });

  describe("offline mutation reconciliation", () => {
    it("should update item via mutate.update", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add an item
      repo.triggerEvent("existing", { id: "1", title: "Original", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(false);

      // Update optimistically
      query.mutate.update("1", { completed: true });

      snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });

    it("should delete item via mutate.delete", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add items
      repo.triggerEvent("existing", { id: "1", title: "Keep", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Delete", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Delete optimistically
      query.mutate.delete("2");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });
  });

  describe("status transitions", () => {
    it("should transition to live or offline status after connected based on navigator.onLine", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init and connection
      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("connected", 0);

      const snapshot = query.getSnapshot();
      // Status depends on navigator.onLine - in test env it may be offline
      expect(["live", "offline"]).toContain(snapshot.status);

      query.destroy();
    });
  });
});

describe("Offline Create + Update Sync (Ghost Prevention)", () => {
  it("should NOT replace optimistic item if there are pending mutations", async () => {
    // This is the exact bug scenario:
    // 1. Offline: Create todo with optimistic ID
    // 2. Offline: Update todo (mark as checked)
    // 3. Online: Subscription reconnects, gets existing event with unchecked state
    // 4. BUG: Old code would replace checked optimistic with unchecked server state

    const idMappings = new Map<string, string>();
    idMappings.set("opt_123", "srv_456");

    // Simulate pending update mutation
    const pendingMutationIds = new Set<string>(["opt_123"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item (completed: true - user checked it while offline)
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: true },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");
    expect(snapshot.items[0].completed).toBe(true);

    // Subscription reconnects, sends existing event with SERVER state (completed: false)
    // because the update hasn't synced yet
    repo.triggerEvent("existing", { id: "srv_456", title: "Test Todo", completed: false });

    // Wait for async handleExisting
    await new Promise((resolve) => setTimeout(resolve, 10));

    snapshot = query.getSnapshot();

    // Should STILL have the optimistic item with completed: true
    // because there are pending mutations
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");
    expect(snapshot.items[0].completed).toBe(true);

    // Now simulate mutation completing - clear pending
    pendingMutationIds.clear();

    // Simulate changed event from server (after update synced)
    repo.triggerEvent("changed", { id: "srv_456", title: "Test Todo", completed: true });

    snapshot = query.getSnapshot();

    // Now should have server item with correct state
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("srv_456");
    expect(snapshot.items[0].completed).toBe(true);

    query.destroy();
  });

  it("should replace optimistic item if no pending mutations", async () => {
    const idMappings = new Map<string, string>();
    idMappings.set("opt_123", "srv_456");

    // No pending mutations
    const hasPendingMutationsForId = async () => false;

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");

    // Existing event with server state
    repo.triggerEvent("existing", { id: "srv_456", title: "Test Todo", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 10));

    snapshot = query.getSnapshot();

    // Should have replaced with server item
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("srv_456");

    query.destroy();
  });

  it("should handle offline create + delete scenario", async () => {
    // 1. Offline: Create todo
    // 2. Offline: Delete todo
    // 3. Online: Should not see the todo at all

    const idMappings = new Map<string, string>();
    // No mapping yet - create hasn't synced

    const pendingMutationIds = new Set<string>(["opt_123"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);

    // Delete optimistically
    query.mutate.delete("opt_123");

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(0);

    query.destroy();
  });

  it("should handle multiple offline creates with updates", async () => {
    // 1. Offline: Create todo 1, mark checked
    // 2. Offline: Create todo 2, mark unchecked (no change)
    // 3. Online: Both should sync correctly

    const idMappings = new Map<string, string>();
    idMappings.set("opt_1", "srv_1");
    idMappings.set("opt_2", "srv_2");

    // Only opt_1 has pending update
    const pendingMutationIds = new Set<string>(["opt_1"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic items
    repo.triggerEvent("added", {
      item: { id: "opt_1", title: "Todo 1", completed: true }, // Checked offline
    });
    repo.triggerEvent("added", {
      item: { id: "opt_2", title: "Todo 2", completed: false }, // Not changed
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);

    // Existing events from server (both unchecked initially)
    repo.triggerEvent("existing", { id: "srv_1", title: "Todo 1", completed: false });
    repo.triggerEvent("existing", { id: "srv_2", title: "Todo 2", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 20));

    snapshot = query.getSnapshot();

    // opt_1 should remain (has pending update), opt_2 should be replaced by srv_2
    const items = snapshot.items.sort((a, b) => a.title.localeCompare(b.title));
    expect(items).toHaveLength(2);

    const todo1 = items.find(i => i.title === "Todo 1");
    const todo2 = items.find(i => i.title === "Todo 2");

    // Todo 1: should keep optimistic state (completed: true)
    expect(todo1?.id).toBe("opt_1");
    expect(todo1?.completed).toBe(true);

    // Todo 2: should have server state (no pending mutations)
    expect(todo2?.id).toBe("srv_2");
    expect(todo2?.completed).toBe(false);

    query.destroy();
  });

  it("should handle rapid create/update/delete sequence", async () => {
    const idMappings = new Map<string, string>();
    const pendingMutationIds = new Set<string>();
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Rapid sequence while offline
    query.mutate.create({ title: "Quick Todo", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 5));

    let snapshot = query.getSnapshot();
    const optimisticId = snapshot.items[0]?.id;
    expect(optimisticId).toMatch(/^optimistic_/);

    // Update then delete
    query.mutate.update(optimisticId!, { completed: true });
    query.mutate.delete(optimisticId!);

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(0);

    query.destroy();
  });
});

describe("SubscriptionMode", () => {
  describe("strict mode (default for paginated)", () => {
    it("should ignore server-pushed adds in strict mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "strict" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Server pushes an added event (from another user)
      repo.triggerEvent("added", {
        item: { id: "server_pushed", title: "From Other User", completed: false },
      });

      const snapshot = query.getSnapshot();
      // Should NOT have the server-pushed item
      expect(snapshot.items).toHaveLength(0);

      query.destroy();
    });

    it("should show own creates in strict mode (via optimisticId)", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "strict" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Create via mutate (will have optimisticId)
      query.mutate.create({ title: "My Todo", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      const optimisticId = snapshot.items[0].id;

      // Server confirms creation
      repo.triggerEvent("added", {
        item: { id: "srv_1", title: "My Todo", completed: false },
        meta: { optimisticId },
      });

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("srv_1");

      query.destroy();
    });

    it("should ignore changes to uncached items in strict mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "strict" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add an item via existing
      repo.triggerEvent("existing", { id: "1", title: "Cached Item", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);

      // Server pushes change for an item NOT in cache
      repo.triggerEvent("changed", { id: "uncached", title: "Unknown", completed: true });

      snapshot = query.getSnapshot();
      // Should still only have the cached item
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("should update cached items in strict mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "strict" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add an item via existing
      repo.triggerEvent("existing", { id: "1", title: "Cached Item", completed: false });

      // Server pushes change for cached item
      repo.triggerEvent("changed", { id: "1", title: "Updated", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Updated");
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });
  });

  describe("sorted mode", () => {
    it("should show new items in sorted order", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "sorted", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add existing items
      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Date", completed: false });

      // Server pushes new item
      repo.triggerEvent("added", {
        item: { id: "3", title: "Cherry", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(3);
      // Should be sorted: Banana, Cherry, Date
      expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Cherry", "Date"]);

      query.destroy();
    });

    it("should ignore changes to uncached items in sorted mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "sorted", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Cached", completed: false });

      // Server pushes change for uncached item
      repo.triggerEvent("changed", { id: "uncached", title: "Unknown", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("should show own creates in sorted mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "sorted", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Create via mutate
      query.mutate.create({ title: "Apple", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      // Own create should appear in sorted position
      expect(snapshot.items.map(i => i.title)).toEqual(["Apple", "Banana"]);

      query.destroy();
    });
  });

  describe("append mode", () => {
    it("should show new items at end regardless of sort order", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add existing items
      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Date", completed: false });

      // Server pushes new item
      repo.triggerEvent("added", {
        item: { id: "3", title: "Apple", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(3);
      // Should be: Banana, Date (sorted), then Apple (appended)
      expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Date", "Apple"]);

      query.destroy();
    });

    it("should maintain append order for multiple new items", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add existing item
      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Server pushes multiple items in order
      repo.triggerEvent("added", {
        item: { id: "2", title: "Zebra", completed: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 5)); // Small delay to ensure different timestamps
      repo.triggerEvent("added", {
        item: { id: "3", title: "Apple", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(3);
      // Should be: Banana (sorted), Zebra (first appended), Apple (second appended)
      expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Zebra", "Apple"]);

      query.destroy();
    });

    it("should ignore changes to uncached items in append mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Cached", completed: false });

      // Server pushes change for uncached item
      repo.triggerEvent("changed", { id: "uncached", title: "Unknown", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("should update cached items in append mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Original", completed: false });

      // Server pushes change for cached item
      repo.triggerEvent("changed", { id: "1", title: "Updated", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Updated");
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });

    it("should show own creates in append mode (at end)", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Create via mutate - own creates don't have __appendedAt marker
      query.mutate.create({ title: "Apple", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      // Own create should appear in sorted position (no __appendedAt marker)
      expect(snapshot.items.map(i => i.title)).toEqual(["Apple", "Banana"]);

      query.destroy();
    });
  });

  describe("prepend mode", () => {
    it("should show new items at start regardless of sort order", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add existing items
      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Date", completed: false });

      // Server pushes new item
      repo.triggerEvent("added", {
        item: { id: "3", title: "Zebra", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(3);
      // Should be: Zebra (prepended), then Banana, Date (sorted)
      expect(snapshot.items.map(i => i.title)).toEqual(["Zebra", "Banana", "Date"]);

      query.destroy();
    });

    it("should prepend newest items first", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add existing item
      repo.triggerEvent("existing", { id: "1", title: "Middle", completed: false });

      // Server pushes multiple items
      repo.triggerEvent("added", {
        item: { id: "2", title: "First Prepend", completed: false },
      });
      await new Promise((resolve) => setTimeout(resolve, 5)); // Small delay
      repo.triggerEvent("added", {
        item: { id: "3", title: "Second Prepend", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(3);
      // Should be: Second Prepend (newest), First Prepend (older), Middle (sorted)
      expect(snapshot.items.map(i => i.title)).toEqual(["Second Prepend", "First Prepend", "Middle"]);

      query.destroy();
    });

    it("should ignore changes to uncached items in prepend mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Cached", completed: false });

      // Server pushes change for uncached item
      repo.triggerEvent("changed", { id: "uncached", title: "Unknown", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("should update cached items in prepend mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Original", completed: false });

      // Server pushes change for cached item
      repo.triggerEvent("changed", { id: "1", title: "Updated", completed: true });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Updated");
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });

    it("should show own creates in prepend mode (in sorted position)", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Create via mutate - own creates don't have __prependedAt marker
      query.mutate.create({ title: "Cherry", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      // Own create should appear in sorted position (no __prependedAt marker)
      expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Cherry"]);

      query.destroy();
    });
  });

  describe("remove behavior across modes", () => {
    it("should handle removes in strict mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "strict" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Item 1", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Item 2", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Server sends remove event
      repo.triggerEvent("removed", "1");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("2");

      query.destroy();
    });

    it("should handle removes in append mode (removes appended item)", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "append", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Server pushes new item (appended)
      repo.triggerEvent("added", {
        item: { id: "2", title: "Apple", completed: false },
      });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Apple"]);

      // Remove the appended item
      repo.triggerEvent("removed", "2");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Banana");

      query.destroy();
    });

    it("should handle removes in prepend mode (removes prepended item)", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "prepend", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Banana", completed: false });

      // Server pushes new item (prepended)
      repo.triggerEvent("added", {
        item: { id: "2", title: "Zebra", completed: false },
      });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);
      expect(snapshot.items.map(i => i.title)).toEqual(["Zebra", "Banana"]);

      // Remove the prepended item
      repo.triggerEvent("removed", "2");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].title).toBe("Banana");

      query.destroy();
    });

    it("should handle client-side delete in all modes", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "sorted", orderBy: "title" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("existing", { id: "1", title: "Item 1", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Item 2", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Client-side delete
      query.mutate.delete("1");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("2");

      query.destroy();
    });
  });

  describe("live mode (default for non-paginated)", () => {
    it("should show all items in live mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { subscriptionMode: "live" }); // No limit

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add via existing
      repo.triggerEvent("existing", { id: "1", title: "Existing", completed: false });

      // Server pushes new item
      repo.triggerEvent("added", {
        item: { id: "2", title: "New", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      query.destroy();
    });

    it("should update/add all items in live mode", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { subscriptionMode: "live" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Server pushes change for item not in cache
      repo.triggerEvent("changed", { id: "uncached", title: "Was Not In Cache", completed: true });

      const snapshot = query.getSnapshot();
      // Should have added the uncached item
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("uncached");

      query.destroy();
    });
  });

  describe("default mode selection", () => {
    it("should default to strict when limit is set", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10 }); // No explicit mode

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Server pushes item - should be ignored (strict default)
      repo.triggerEvent("added", {
        item: { id: "server_pushed", title: "Should Be Ignored", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(0);

      query.destroy();
    });

    it("should default to live when no limit is set", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}); // No limit, no mode

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Server pushes item - should be shown (live default)
      repo.triggerEvent("added", {
        item: { id: "server_pushed", title: "Should Be Shown", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);

      query.destroy();
    });

    it("should allow overriding default strict with live", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, { limit: 10, subscriptionMode: "live" }); // Override

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Server pushes item - should be shown despite limit
      repo.triggerEvent("added", {
        item: { id: "server_pushed", title: "Should Be Shown", completed: false },
      });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);

      query.destroy();
    });
  });
});

describe("Mutations on loadMore items", () => {
  // Create a mock repo that tracks calls and supports pagination
  const createPaginatedMockRepo = <T extends { id: string }>(
    page1: T[],
    page2: T[]
  ): ResourceClient<T> & {
    subscriptionCallbacks: SubscriptionCallbacks<T> | undefined;
    triggerEvent: (type: string, data: unknown) => void;
    updateCalls: Array<{ id: string; data: Partial<T> }>;
    deleteCalls: string[];
  } => {
    let callbacks: SubscriptionCallbacks<T> | undefined;
    const updateCalls: Array<{ id: string; data: Partial<T> }> = [];
    const deleteCalls: string[] = [];

    const mockSubscription: Subscription<Todo> = {
      state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
      items: [],
      unsubscribe: vi.fn(),
      reconnect: vi.fn(),
    };

    return {
      subscriptionCallbacks: undefined,
      updateCalls,
      deleteCalls,
      triggerEvent(type: string, data: unknown) {
        if (type === "added" && callbacks?.onAdded) {
          const { item, meta } = data as { item: T; meta?: { optimisticId?: string } };
          callbacks.onAdded(item, meta);
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
        if (type === "connected" && callbacks?.onConnected) {
          callbacks.onConnected(data as number);
        }
      },
      async list(options): Promise<PaginatedResponse<T>> {
        if (options?.cursor === "page2") {
          return { items: page2, nextCursor: null, hasMore: false, totalCount: page1.length + page2.length };
        }
        return { items: page1, nextCursor: "page2", hasMore: true, totalCount: page1.length + page2.length };
      },
      async get(id: string): Promise<T> {
        return { id } as T;
      },
      async count(): Promise<number> {
        return page1.length + page2.length;
      },
      async aggregate() {
        return { groups: [] };
      },
      async create(data: Omit<T, "id">): Promise<T> {
        return { ...data, id: "new-id" } as T;
      },
      async update(id: string, data: Partial<T>): Promise<T> {
        updateCalls.push({ id, data });
        return { ...data, id } as T;
      },
      async replace(id: string, data: Omit<T, "id">): Promise<T> {
        return { ...data, id } as T;
      },
      async delete(id: string): Promise<void> {
        deleteCalls.push(id);
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
        return mockSubscription as unknown as Subscription<T>;
      },
      async rpc() {
        return {} as any;
      },
    };
  };

  it("should persist updates to items loaded via loadMore to the server", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
      { id: "2", title: "Todo 2", completed: false },
    ];
    const page2: Todo[] = [
      { id: "3", title: "Todo 3", completed: false },
      { id: "4", title: "Todo 4", completed: false },
    ];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.hasMore).toBe(true);

    // Load more items
    await query.loadMore();

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(4);

    // Now update an item from page 2 (loaded via loadMore)
    query.mutate.update("3", { completed: true });

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the update was sent to the server
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]).toEqual({ id: "3", data: { completed: true } });

    // Verify the local state was updated
    snapshot = query.getSnapshot();
    const item3 = snapshot.items.find(i => i.id === "3");
    expect(item3?.completed).toBe(true);

    query.destroy();
  });

  it("should persist deletes of items loaded via loadMore to the server", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
      { id: "2", title: "Todo 2", completed: false },
    ];
    const page2: Todo[] = [
      { id: "3", title: "Todo 3", completed: false },
      { id: "4", title: "Todo 4", completed: false },
    ];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Load more items
    await query.loadMore();

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(4);

    // Delete an item from page 2
    query.mutate.delete("4");

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the delete was sent to the server
    expect(repo.deleteCalls).toHaveLength(1);
    expect(repo.deleteCalls[0]).toBe("4");

    // Verify the local state was updated
    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.find(i => i.id === "4")).toBeUndefined();

    query.destroy();
  });

  it("should receive and apply changes from other clients to loadMore items in strict mode", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
      { id: "2", title: "Todo 2", completed: false },
    ];
    const page2: Todo[] = [
      { id: "3", title: "Todo 3", completed: false },
      { id: "4", title: "Todo 4", completed: false },
    ];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Load more items
    await query.loadMore();

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.items.find(i => i.id === "3")?.completed).toBe(false);

    // Another client updates item 3 - we should receive and apply the change
    // because item 3 is in our cache (was loaded via loadMore)
    repo.triggerEvent("changed", { id: "3", title: "Todo 3", completed: true });

    snapshot = query.getSnapshot();
    const item3 = snapshot.items.find(i => i.id === "3");
    expect(item3?.completed).toBe(true);

    query.destroy();
  });

  it("should NOT receive changes from other clients for items NOT in cache (strict mode)", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
      { id: "2", title: "Todo 2", completed: false },
    ];
    const page2: Todo[] = [
      { id: "3", title: "Todo 3", completed: false },
      { id: "4", title: "Todo 4", completed: false },
    ];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load - only page 1 is loaded
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);

    // Another client updates item 3 which is NOT in our cache yet
    repo.triggerEvent("changed", { id: "3", title: "Todo 3 Updated", completed: true });

    snapshot = query.getSnapshot();
    // Should still only have 2 items - item 3 should NOT appear
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find(i => i.id === "3")).toBeUndefined();

    query.destroy();
  });

  it("should handle remove events for items loaded via loadMore", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
      { id: "2", title: "Todo 2", completed: false },
    ];
    const page2: Todo[] = [
      { id: "3", title: "Todo 3", completed: false },
      { id: "4", title: "Todo 4", completed: false },
    ];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Load more items
    await query.loadMore();

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(4);

    // Another client deletes item 3 - we should receive the remove event
    repo.triggerEvent("removed", "3");

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.find(i => i.id === "3")).toBeUndefined();

    query.destroy();
  });

  it("should persist updates to appended items (append mode) to the server", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "append", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);

    // Server pushes a new item (from another client) - will be appended
    repo.triggerEvent("added", {
      item: { id: "new-from-server", title: "New Todo", completed: false },
    });

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Check that it was appended (not in sorted position)
    expect(snapshot.items.map(i => i.id)).toEqual(["1", "new-from-server"]);

    // Now update the appended item
    query.mutate.update("new-from-server", { completed: true });

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the update was sent to the server
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]).toEqual({ id: "new-from-server", data: { completed: true } });

    // Verify the local state was updated
    snapshot = query.getSnapshot();
    const updatedItem = snapshot.items.find(i => i.id === "new-from-server");
    expect(updatedItem?.completed).toBe(true);

    query.destroy();
  });

  it("should persist updates to prepended items (prepend mode) to the server", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "prepend", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item - will be prepended
    repo.triggerEvent("added", {
      item: { id: "new-from-server", title: "New Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Check that it was prepended
    expect(snapshot.items.map(i => i.id)).toEqual(["new-from-server", "1"]);

    // Now update the prepended item
    query.mutate.update("new-from-server", { completed: true });

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the update was sent to the server
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]).toEqual({ id: "new-from-server", data: { completed: true } });

    // Verify the local state was updated
    snapshot = query.getSnapshot();
    const updatedItem = snapshot.items.find(i => i.id === "new-from-server");
    expect(updatedItem?.completed).toBe(true);

    query.destroy();
  });

  it("should receive change events for appended items from other clients", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "append", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item (appended)
    repo.triggerEvent("added", {
      item: { id: "appended", title: "Appended Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.find(i => i.id === "appended")?.completed).toBe(false);

    // Another client updates the appended item
    repo.triggerEvent("changed", { id: "appended", title: "Appended Todo", completed: true });

    snapshot = query.getSnapshot();
    expect(snapshot.items.find(i => i.id === "appended")?.completed).toBe(true);

    query.destroy();
  });

  it("should delete appended items correctly", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Todo 1", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "append", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item (appended)
    repo.triggerEvent("added", {
      item: { id: "appended", title: "Appended Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);

    // Delete the appended item
    query.mutate.delete("appended");

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the delete was sent to the server
    expect(repo.deleteCalls).toHaveLength(1);
    expect(repo.deleteCalls[0]).toBe("appended");

    // Verify the local state was updated
    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items.find(i => i.id === "appended")).toBeUndefined();

    query.destroy();
  });

  it("should handle sorted mode items receiving updates from other clients", async () => {
    const page1: Todo[] = [
      { id: "1", title: "Banana", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "sorted", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item (will be sorted)
    repo.triggerEvent("added", {
      item: { id: "sorted-item", title: "Apple", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Should be sorted alphabetically
    expect(snapshot.items.map(i => i.title)).toEqual(["Apple", "Banana"]);

    // Update the sorted item
    query.mutate.update("sorted-item", { completed: true });

    // Wait for async operations
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Verify the update was sent to the server
    expect(repo.updateCalls).toHaveLength(1);
    expect(repo.updateCalls[0]).toEqual({ id: "sorted-item", data: { completed: true } });

    // Another client updates the item
    repo.triggerEvent("changed", { id: "sorted-item", title: "Apple Updated", completed: true });

    snapshot = query.getSnapshot();
    expect(snapshot.items.find(i => i.id === "sorted-item")?.title).toBe("Apple Updated");

    query.destroy();
  });

  it("should preserve append position when receiving change events for appended items", async () => {
    // BUG TEST: When handleChange replaces an item, it loses the __appendedAt marker
    // causing the item to jump from appended position to sorted position
    const page1: Todo[] = [
      { id: "1", title: "Banana", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "append", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item that would sort BEFORE "Banana" alphabetically
    // In append mode, it should appear AFTER Banana (at the end)
    repo.triggerEvent("added", {
      item: { id: "appended", title: "Apple", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Should be: Banana (sorted), Apple (appended) - NOT alphabetically sorted
    expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Apple"]);

    // Another client updates the appended item
    repo.triggerEvent("changed", { id: "appended", title: "Apple Updated", completed: true });

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Should STILL be: Banana, Apple Updated - the append position should be preserved!
    expect(snapshot.items.map(i => i.title)).toEqual(["Banana", "Apple Updated"]);

    query.destroy();
  });

  it("should preserve prepend position when receiving change events for prepended items", async () => {
    // BUG TEST: Similar to append, prepend position should be preserved
    const page1: Todo[] = [
      { id: "1", title: "Apple", completed: false },
    ];
    const page2: Todo[] = [];

    const repo = createPaginatedMockRepo<Todo>(page1, page2);
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "prepend", orderBy: "title" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server pushes a new item that would sort AFTER "Apple" alphabetically
    // In prepend mode, it should appear BEFORE Apple (at the start)
    repo.triggerEvent("added", {
      item: { id: "prepended", title: "Zebra", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Should be: Zebra (prepended), Apple (sorted) - NOT alphabetically sorted
    expect(snapshot.items.map(i => i.title)).toEqual(["Zebra", "Apple"]);

    // Another client updates the prepended item
    repo.triggerEvent("changed", { id: "prepended", title: "Zebra Updated", completed: true });

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    // Should STILL be: Zebra Updated, Apple - the prepend position should be preserved!
    expect(snapshot.items.map(i => i.title)).toEqual(["Zebra Updated", "Apple"]);

    query.destroy();
  });

  it("should handle changed events for items being loaded via loadMore (race condition)", async () => {
    // BUG TEST: Race condition where changed event arrives during loadMore
    // Scenario:
    // 1. Client 1 and 2 both load page 1 (items 1-2)
    // 2. Both clients call loadMore to get page 2 (items 3-4)
    // 3. Client 2 mutates item 3 WHILE client 1's loadMore is in progress
    // 4. Client 1 should still see the change once loadMore completes

    let listCallCount = 0;
    let callbacks: SubscriptionCallbacks<Todo> | undefined;
    const updateCalls: Array<{ id: string; data: Partial<Todo> }> = [];

    // Create a mock that delays the second list call to simulate race condition
    const createRacyMockRepo = (): ResourceClient<Todo> & {
      triggerEvent: (type: string, data: unknown) => void;
      updateCalls: Array<{ id: string; data: Partial<Todo> }>;
    } => {
      const mockSubscription: Subscription<Todo> = {
        state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
        items: [],
        unsubscribe: vi.fn(),
        reconnect: vi.fn(),
      };

      return {
        updateCalls,
        triggerEvent(type: string, data: unknown) {
          if (type === "changed" && callbacks?.onChanged) {
            callbacks.onChanged(data as Todo);
          }
          if (type === "connected" && callbacks?.onConnected) {
            callbacks.onConnected(data as number);
          }
        },
        async list(options): Promise<PaginatedResponse<Todo>> {
          listCallCount++;
          if (options?.cursor === "page2") {
            // Simulate network delay during which a change event might arrive
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              items: [
                { id: "3", title: "Todo 3", completed: false },
                { id: "4", title: "Todo 4", completed: false },
              ],
              nextCursor: null,
              hasMore: false,
              totalCount: 4,
            };
          }
          return {
            items: [
              { id: "1", title: "Todo 1", completed: false },
              { id: "2", title: "Todo 2", completed: false },
            ],
            nextCursor: "page2",
            hasMore: true,
            totalCount: 4,
          };
        },
        async get(id: string): Promise<Todo> {
          return { id, title: "Todo", completed: false };
        },
        async count(): Promise<number> {
          return 4;
        },
        async aggregate() {
          return { groups: [] };
        },
        async create(data: Omit<Todo, "id">): Promise<Todo> {
          return { ...data, id: "new-id" };
        },
        async update(id: string, data: Partial<Todo>): Promise<Todo> {
          updateCalls.push({ id, data });
          return { ...data, id, title: "Todo", completed: false };
        },
        async replace(id: string, data: Omit<Todo, "id">): Promise<Todo> {
          return { ...data, id };
        },
        async delete(): Promise<void> {},
        async batchCreate(items: Omit<Todo, "id">[]): Promise<Todo[]> {
          return items.map((item, i) => ({ ...item, id: `batch-${i}` }));
        },
        async batchUpdate(): Promise<{ count: number }> {
          return { count: 0 };
        },
        async batchDelete(): Promise<{ count: number }> {
          return { count: 0 };
        },
        subscribe(options, cbs) {
          callbacks = cbs;
          return mockSubscription;
        },
        async rpc() {
          return {} as any;
        },
      };
    };

    const repo = createRacyMockRepo();
    const query = createLiveQuery(repo, { limit: 2, subscriptionMode: "strict" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.hasMore).toBe(true);

    // Start loadMore (which has a delay)
    const loadMorePromise = query.loadMore();

    // While loadMore is in progress (during the 50ms delay), simulate a change event
    // for item 3 which is being loaded
    await new Promise((resolve) => setTimeout(resolve, 10));
    repo.triggerEvent("changed", { id: "3", title: "Todo 3 Updated by Client 2", completed: true });

    // Wait for loadMore to complete
    await loadMorePromise;

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(4);

    // The change should have been applied - either:
    // a) The changed event was queued and applied after loadMore
    // b) The item in cache should reflect the update
    const item3 = snapshot.items.find(i => i.id === "3");
    expect(item3).toBeDefined();
    // This test verifies the race condition is handled - item 3 should have the updated title
    expect(item3?.title).toBe("Todo 3 Updated by Client 2");
    expect(item3?.completed).toBe(true);

    query.destroy();
  });
});

// Helper to create a mock repo that returns items with relations
const createMockRepoWithRelations = (): ResourceClient<TodoWithRelations> & {
  subscriptionCallbacks: SubscriptionCallbacks<TodoWithRelations> | undefined;
  triggerEvent: (type: string, data: unknown) => void;
  updateCalls: Array<{ id: string; data: Partial<TodoWithRelations> }>;
  list: ReturnType<typeof vi.fn>;
} => {
  let callbacks: SubscriptionCallbacks<TodoWithRelations> | undefined;
  const updateCalls: Array<{ id: string; data: Partial<TodoWithRelations> }> = [];

  const mockSubscription: Subscription<TodoWithRelations> = {
    state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
    items: [],
    unsubscribe: vi.fn(),
    reconnect: vi.fn(),
  };

  const listFn = vi.fn().mockResolvedValue({
    items: [
      {
        id: "1",
        title: "Todo 1",
        completed: false,
        categoryId: "cat-1",
        category: { id: "cat-1", name: "Work", color: "#ff0000" },
        tags: [{ id: "tag-1", name: "urgent" }],
      },
    ],
    nextCursor: null,
    hasMore: false,
  });

  return {
    subscriptionCallbacks: undefined,
    updateCalls,
    triggerEvent(type: string, data: unknown) {
      if (type === "added" && callbacks?.onAdded) {
        const { item, meta } = data as { item: TodoWithRelations; meta?: { optimisticId?: string } };
        callbacks.onAdded(item, meta);
      }
      if (type === "existing" && callbacks?.onExisting) {
        callbacks.onExisting(data as TodoWithRelations);
      }
      if (type === "changed" && callbacks?.onChanged) {
        callbacks.onChanged(data as TodoWithRelations);
      }
      if (type === "removed" && callbacks?.onRemoved) {
        callbacks.onRemoved(data as string);
      }
      if (type === "connected" && callbacks?.onConnected) {
        callbacks.onConnected(data as number);
      }
    },
    list: listFn,
    async get(id: string): Promise<TodoWithRelations> {
      return { id, title: "Todo", completed: false };
    },
    async count(): Promise<number> {
      return 1;
    },
    async aggregate() {
      return { groups: [] };
    },
    async create(data: Omit<TodoWithRelations, "id">): Promise<TodoWithRelations> {
      return { ...data, id: "new-id" };
    },
    async update(id: string, data: Partial<TodoWithRelations>): Promise<TodoWithRelations> {
      updateCalls.push({ id, data });
      // Server returns the raw item WITHOUT included relations
      return { id, title: "Todo 1", completed: data.completed ?? false, categoryId: "cat-1" };
    },
    async replace(id: string, data: Omit<TodoWithRelations, "id">): Promise<TodoWithRelations> {
      return { ...data, id };
    },
    async delete(): Promise<void> {},
    async batchCreate(items: Omit<TodoWithRelations, "id">[]): Promise<TodoWithRelations[]> {
      return items.map((item, i) => ({ ...item, id: `batch-${i}` }));
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

describe("Included relations preservation", () => {
  it("should preserve included relations when receiving changed event after update", async () => {
    // BUG TEST: When updating an item, the server sends a changed event
    // with the raw item (without relations). This should NOT remove the
    // relations from the cached item.

    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);

    // Verify initial state has relations
    const initialItem = snapshot.items[0];
    expect(initialItem.category).toBeDefined();
    expect(initialItem.category?.name).toBe("Work");
    expect(initialItem.tags).toHaveLength(1);
    expect(initialItem.tags?.[0].name).toBe("urgent");

    // Update the item (toggle completed) - this triggers optimistic update
    query.mutate.update("1", { completed: true });

    snapshot = query.getSnapshot();
    // Optimistic update should preserve relations
    expect(snapshot.items[0].completed).toBe(true);
    expect(snapshot.items[0].category?.name).toBe("Work");
    expect(snapshot.items[0].tags?.[0].name).toBe("urgent");

    // Wait for server call
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Server sends changed event WITHOUT relations (this is what actually happens)
    // The server's changed event only has the raw item data
    repo.triggerEvent("changed", {
      id: "1",
      title: "Todo 1",
      completed: true,
      categoryId: "cat-1",
      // NOTE: No category or tags included - this is what the server sends!
    });

    snapshot = query.getSnapshot();

    // After the changed event, relations should STILL be preserved
    const finalItem = snapshot.items[0];
    expect(finalItem.completed).toBe(true);
    expect(finalItem.category).toBeDefined();
    expect(finalItem.category?.name).toBe("Work");
    expect(finalItem.tags).toBeDefined();
    expect(finalItem.tags).toHaveLength(1);
    expect(finalItem.tags?.[0].name).toBe("urgent");

    query.destroy();
  });

  it("should preserve included relations when receiving changed event from another client", async () => {
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].category?.name).toBe("Work");
    expect(snapshot.items[0].tags?.[0].name).toBe("urgent");

    // Another client updates the item - server sends changed event without relations
    repo.triggerEvent("changed", {
      id: "1",
      title: "Updated by another client",
      completed: true,
      categoryId: "cat-1",
      // No relations included
    });

    snapshot = query.getSnapshot();

    // Relations should be preserved, only title and completed should change
    const item = snapshot.items[0];
    expect(item.title).toBe("Updated by another client");
    expect(item.completed).toBe(true);
    expect(item.category).toBeDefined();
    expect(item.category?.name).toBe("Work");
    expect(item.tags).toBeDefined();
    expect(item.tags?.[0].name).toBe("urgent");

    query.destroy();
  });

  it("should clear stale relation when foreign key changes", async () => {
    // BUG TEST: When categoryId changes, the old category relation should be cleared
    // because it's now stale. The UI should show no category (or refetch).

    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].categoryId).toBe("cat-1");
    expect(snapshot.items[0].category?.name).toBe("Work");

    // User changes the category - categoryId changes but server doesn't include new category
    repo.triggerEvent("changed", {
      id: "1",
      title: "Todo 1",
      completed: false,
      categoryId: "cat-2", // Changed from cat-1 to cat-2!
      // No category relation included - server doesn't know to include it
    });

    snapshot = query.getSnapshot();

    // categoryId should be updated
    expect(snapshot.items[0].categoryId).toBe("cat-2");
    // The OLD category should be CLEARED because it's now stale
    // (it refers to cat-1 but categoryId is now cat-2)
    expect(snapshot.items[0].category).toBeUndefined();
    // Tags should still be preserved (no tagIds changed)
    expect(snapshot.items[0].tags?.[0].name).toBe("urgent");

    query.destroy();
  });

  it("should clear relation when foreign key is set to null", async () => {
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].categoryId).toBe("cat-1");
    expect(snapshot.items[0].category?.name).toBe("Work");

    // User removes the category
    repo.triggerEvent("changed", {
      id: "1",
      title: "Todo 1",
      completed: false,
      categoryId: null, // Category removed!
    });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].categoryId).toBeNull();
    // Category relation should be cleared
    expect(snapshot.items[0].category).toBeUndefined();

    query.destroy();
  });

  it("should update relation when server includes new relation data", async () => {
    // If the server DOES include the new relation, it should be used
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    // Wait for initial load
    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].category?.name).toBe("Work");

    // Server sends changed event WITH the new category relation
    repo.triggerEvent("changed", {
      id: "1",
      title: "Todo 1",
      completed: false,
      categoryId: "cat-2",
      category: { id: "cat-2", name: "Personal", color: "#00ff00" }, // New category included!
    });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].categoryId).toBe("cat-2");
    expect(snapshot.items[0].category?.id).toBe("cat-2");
    expect(snapshot.items[0].category?.name).toBe("Personal");

    query.destroy();
  });

  it("should preserve relation when foreign key unchanged", async () => {
    // If only title changes but categoryId stays the same, category should be preserved
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].category?.name).toBe("Work");
    expect(snapshot.items[0].categoryId).toBe("cat-1");

    // Server sends changed event - title changed but categoryId unchanged
    repo.triggerEvent("changed", {
      id: "1",
      title: "Updated Title",
      completed: true,
      categoryId: "cat-1", // Same as before
    });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].title).toBe("Updated Title");
    expect(snapshot.items[0].completed).toBe(true);
    expect(snapshot.items[0].categoryId).toBe("cat-1");
    // Category should be PRESERVED because categoryId didn't change
    expect(snapshot.items[0].category?.name).toBe("Work");

    query.destroy();
  });

  it("should handle foreign key set from null to a value", async () => {
    // Item starts with no category, then gets one assigned
    const repo = createMockRepoWithRelations();

    // Override list to return an item with no category
    repo.list = vi.fn().mockResolvedValue({
      items: [
        {
          id: "1",
          title: "Todo 1",
          completed: false,
          categoryId: null,
          category: null,
          tags: [],
        },
      ],
      hasMore: false,
    });

    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].categoryId).toBeNull();
    expect(snapshot.items[0].category).toBeNull();

    // Server sends changed event - categoryId set to a value
    repo.triggerEvent("changed", {
      id: "1",
      title: "Todo 1",
      completed: false,
      categoryId: "cat-1", // Now has a category
    });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].categoryId).toBe("cat-1");
    // Category relation should be undefined (cleared) because server didn't include it
    // and the FK changed from null to a value
    expect(snapshot.items[0].category).toBeUndefined();

    query.destroy();
  });

  it("should not clear relations for non-Id fields", async () => {
    // Ensure we only process fields that end with "Id" (not just contain "id")
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].category?.name).toBe("Work");

    // Simulate an item with a field containing "id" but not ending with "Id"
    // (e.g., "valid", "bid", etc.) - these should not trigger relation clearing
    repo.triggerEvent("changed", {
      id: "1",
      title: "Valid Todo", // "valid" contains "id"
      completed: false,
      categoryId: "cat-1",
    });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].title).toBe("Valid Todo");
    // Category should still be preserved
    expect(snapshot.items[0].category?.name).toBe("Work");

    query.destroy();
  });
});

describe("Optimistic update relation handling", () => {
  it("should clear stale relation when user changes foreign key via mutate.update", async () => {
    // THIS IS THE BUG: When user changes category dropdown, the old category label persists
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].categoryId).toBe("cat-1");
    expect(snapshot.items[0].category?.name).toBe("Work");

    // User changes the category via dropdown (this is what App.tsx does)
    query.mutate.update("1", { categoryId: "cat-2" });

    snapshot = query.getSnapshot();

    // The categoryId should be updated
    expect(snapshot.items[0].categoryId).toBe("cat-2");
    // The OLD category should be CLEARED because it's stale!
    // (categoryId is now cat-2, but category still refers to cat-1)
    expect(snapshot.items[0].category).toBeUndefined();

    query.destroy();
  });

  it("should clear relation when user sets foreign key to null via mutate.update", async () => {
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].categoryId).toBe("cat-1");
    expect(snapshot.items[0].category?.name).toBe("Work");

    // User removes the category
    query.mutate.update("1", { categoryId: null });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].categoryId).toBeNull();
    // Category should be cleared
    expect(snapshot.items[0].category).toBeUndefined();

    query.destroy();
  });

  it("should preserve relation when user updates non-FK fields via mutate.update", async () => {
    const repo = createMockRepoWithRelations();
    const query = createLiveQuery(repo, { include: "category,tags" });

    await new Promise((resolve) => setTimeout(resolve, 20));

    let snapshot = query.getSnapshot();
    expect(snapshot.items[0].category?.name).toBe("Work");

    // User updates title only (not categoryId)
    query.mutate.update("1", { title: "Updated Title", completed: true });

    snapshot = query.getSnapshot();

    expect(snapshot.items[0].title).toBe("Updated Title");
    expect(snapshot.items[0].completed).toBe(true);
    // Category should be PRESERVED because categoryId didn't change
    expect(snapshot.items[0].category?.name).toBe("Work");

    query.destroy();
  });
});

describe("SubscriptionManager onExisting callback", () => {
  it("should call onExisting for existing events", async () => {
    const { SubscriptionManager } = await import("../../src/client/subscription-manager");
    const { FetchTransport } = await import("../../src/client/transport");

    const onExisting = vi.fn();
    const onAdded = vi.fn();

    // Mock EventSource
    const mockEventSource = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null as (() => void) | null,
    };

    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = vi.fn(() => mockEventSource) as any;

    try {
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });

      const manager = new SubscriptionManager({
        transport,
        resourcePath: "/todos",
        idField: "id" as keyof { id: string },
        callbacks: { onExisting, onAdded },
      });

      // Find the message listener
      const messageHandler = mockEventSource.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "message"
      )?.[1] as ((e: MessageEvent) => void) | undefined;

      expect(messageHandler).toBeDefined();

      // Simulate existing event
      messageHandler!({
        data: JSON.stringify({
          type: "existing",
          object: { id: "1", title: "Test" },
          seq: 1,
        }),
      } as MessageEvent);

      expect(onExisting).toHaveBeenCalledWith({ id: "1", title: "Test" });
      expect(onAdded).not.toHaveBeenCalled();

      // Simulate added event
      messageHandler!({
        data: JSON.stringify({
          type: "added",
          object: { id: "2", title: "New" },
          seq: 2,
          meta: { optimisticId: "opt_2" },
        }),
      } as MessageEvent);

      expect(onAdded).toHaveBeenCalledWith({ id: "2", title: "New" }, { optimisticId: "opt_2" });

      manager.unsubscribe();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });
});
