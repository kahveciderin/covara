import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryOfflineStorage,
  LocalStorageOfflineStorage,
  OfflineManager,
  createOfflineManager,
} from "../../src/client/offline";
import { OfflineMutation } from "../../src/client/types";

describe("OfflineManager.hasPendingMutationsForId", () => {
  it("should return true for pending create mutation with matching optimisticId", async () => {
    const manager = createOfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_123");

    expect(await manager.hasPendingMutationsForId("opt_123")).toBe(true);
    expect(await manager.hasPendingMutationsForId("other")).toBe(false);
  });

  it("should return true for pending update mutation with matching objectId", async () => {
    const manager = createOfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    await manager.queueMutation("update", "/todos", { completed: true }, "todo_123");

    expect(await manager.hasPendingMutationsForId("todo_123")).toBe(true);
    expect(await manager.hasPendingMutationsForId("other")).toBe(false);
  });

  it("should return true when querying by optimisticId that resolves to objectId", async () => {
    const manager = createOfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    // Register ID mapping
    manager.registerIdMapping("opt_123", "srv_456");

    // Queue update with server ID
    await manager.queueMutation("update", "/todos", { completed: true }, "srv_456");

    // Query by optimistic ID should still find it (via resolveId)
    expect(await manager.hasPendingMutationsForId("opt_123")).toBe(true);
    expect(await manager.hasPendingMutationsForId("srv_456")).toBe(true);
  });

  it("should return false for synced mutations", async () => {
    const storage = new InMemoryOfflineStorage();
    const manager = createOfflineManager({
      config: { enabled: true, storage },
    });

    await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_123");

    // Mark as synced by removing
    const mutations = await storage.getMutations();
    await storage.removeMutation(mutations[0].id);

    expect(await manager.hasPendingMutationsForId("opt_123")).toBe(false);
  });

  it("should return true for failed mutations (will be retried)", async () => {
    const storage = new InMemoryOfflineStorage();
    const manager = createOfflineManager({
      config: { enabled: true, storage },
    });

    await manager.queueMutation("update", "/todos", { completed: true }, "todo_123");

    // Mark as failed
    const mutations = await storage.getMutations();
    await storage.updateMutation(mutations[0].id, { status: "failed" });

    expect(await manager.hasPendingMutationsForId("todo_123")).toBe(true);
  });

  it("should handle multiple mutations for same item", async () => {
    const manager = createOfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    // Create then update
    await manager.queueMutation("create", "/todos", { title: "Test" }, undefined, "opt_123");
    await manager.queueMutation("update", "/todos", { completed: true }, "opt_123");

    expect(await manager.hasPendingMutationsForId("opt_123")).toBe(true);
  });
});

describe("InMemoryOfflineStorage", () => {
  let storage: InMemoryOfflineStorage;

  beforeEach(() => {
    storage = new InMemoryOfflineStorage();
  });

  it("should start with empty mutations", async () => {
    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });

  it("should add mutation", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      data: { name: "Test" },
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    const mutations = await storage.getMutations();

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual(mutation);
  });

  it("should return copy of mutations array", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    const mutations1 = await storage.getMutations();
    const mutations2 = await storage.getMutations();

    expect(mutations1).not.toBe(mutations2);
  });

  it("should update mutation", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    await storage.updateMutation("1", { status: "processing", retryCount: 1 });

    const mutations = await storage.getMutations();
    expect(mutations[0].status).toBe("processing");
    expect(mutations[0].retryCount).toBe(1);
  });

  it("should not fail when updating non-existent mutation", async () => {
    await expect(
      storage.updateMutation("nonexistent", { status: "failed" })
    ).resolves.toBeUndefined();
  });

  it("should remove mutation", async () => {
    const mutation1: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };
    const mutation2: OfflineMutation = {
      id: "2",
      type: "update",
      resource: "/users",
      objectId: "user1",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation1);
    await storage.addMutation(mutation2);
    await storage.removeMutation("1");

    const mutations = await storage.getMutations();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("2");
  });

  it("should clear all mutations", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });
    await storage.addMutation({
      id: "2",
      type: "delete",
      resource: "/users",
      objectId: "1",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.clear();

    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });
});

describe("LocalStorageOfflineStorage", () => {
  let storage: LocalStorageOfflineStorage;
  let mockLocalStorage: { [key: string]: string };

  beforeEach(() => {
    mockLocalStorage = {};
    global.localStorage = {
      getItem: (key: string) => mockLocalStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockLocalStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockLocalStorage[key];
      },
      clear: () => {
        mockLocalStorage = {};
      },
      length: 0,
      key: () => null,
    };

    storage = new LocalStorageOfflineStorage();
  });

  it("should use default storage key", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    expect(mockLocalStorage["covara_offline_mutations"]).toBeDefined();
  });

  it("should use custom storage key", async () => {
    storage = new LocalStorageOfflineStorage("my_custom_key");

    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    expect(mockLocalStorage["my_custom_key"]).toBeDefined();
  });

  it("should return empty array for invalid JSON", async () => {
    mockLocalStorage["covara_offline_mutations"] = "invalid json";

    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });

  it("should persist mutations across instances", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      data: { name: "Test" },
      timestamp: 1234567890,
      retryCount: 0,
      status: "pending",
    });

    const newStorage = new LocalStorageOfflineStorage();
    const mutations = await newStorage.getMutations();

    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("1");
  });

  it("should update mutation and persist", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.updateMutation("1", { status: "failed", error: "Network error" });

    const mutations = await storage.getMutations();
    expect(mutations[0].status).toBe("failed");
    expect(mutations[0].error).toBe("Network error");
  });

  it("should remove mutation and persist", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });
    await storage.addMutation({
      id: "2",
      type: "update",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.removeMutation("1");

    const mutations = await storage.getMutations();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("2");
  });

  it("should clear storage", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.clear();

    expect(mockLocalStorage["covara_offline_mutations"]).toBeUndefined();
    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });
});

describe("OfflineManager", () => {
  let manager: OfflineManager;
  let mockSyncHandler: ReturnType<typeof vi.fn>;
  let mockFailedHandler: ReturnType<typeof vi.fn>;
  let mockCompleteHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSyncHandler = vi.fn().mockResolvedValue({ success: true });
    mockFailedHandler = vi.fn();
    mockCompleteHandler = vi.fn();

    manager = new OfflineManager({
      config: { enabled: true, maxRetries: 3 },
      onMutationSync: mockSyncHandler,
      onMutationFailed: mockFailedHandler,
      onSyncComplete: mockCompleteHandler,
    });
  });

  describe("queueMutation", () => {
    it("should queue create mutation", async () => {
      // set offline to prevent auto-sync
      (manager as any).isOnline = false;

      const id = await manager.queueMutation("create", "/users", { name: "Test" });

      expect(id).toBeDefined();
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("create");
      expect(pending[0].resource).toBe("/users");
      expect(pending[0].data).toEqual({ name: "Test" });
    });

    it("should queue update mutation with objectId", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("update", "/users", { name: "Updated" }, "user123");

      const pending = await manager.getPendingMutations();
      expect(pending[0].type).toBe("update");
      expect(pending[0].objectId).toBe("user123");
    });

    it("should queue delete mutation", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("delete", "/users", undefined, "user123");

      const pending = await manager.getPendingMutations();
      expect(pending[0].type).toBe("delete");
      expect(pending[0].objectId).toBe("user123");
    });

    it("should auto-sync when online", async () => {
      await manager.queueMutation("create", "/users", { name: "Test" });

      // give sync time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSyncHandler).toHaveBeenCalled();
    });
  });

  describe("syncPendingMutations", () => {
    it("should sync pending mutations in order", async () => {
      // manually set offline then queue
      (manager as any).isOnline = false;

      // Use different resources to avoid dedupe detection
      await manager.queueMutation("create", "/users", { name: "First" });
      await manager.queueMutation("create", "/posts", { title: "Second" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockSyncHandler).toHaveBeenCalledTimes(2);
      expect(mockSyncHandler.mock.calls[0][0].data.name).toBe("First");
      expect(mockSyncHandler.mock.calls[1][0].data.title).toBe("Second");
    });

    it("should remove mutation after successful sync", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });

    it("should handle sync failure", async () => {
      mockSyncHandler.mockRejectedValueOnce(new Error("Network error"));

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockFailedHandler).toHaveBeenCalled();
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("failed");
      expect(pending[0].retryCount).toBe(1);
    });

    it("should skip mutations that exceeded max retries", async () => {
      const storage = (manager as any).storage;
      await storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 3,
        status: "failed",
      });

      await manager.syncPendingMutations();

      expect(mockSyncHandler).not.toHaveBeenCalled();
    });

    it("should call onSyncComplete after sync", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockCompleteHandler).toHaveBeenCalled();
    });

    it("should not sync when already in progress", async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      mockSyncHandler.mockImplementationOnce(async () => {
        await firstPromise;
        return { success: true };
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      const sync1 = manager.syncPendingMutations();
      const sync2 = manager.syncPendingMutations();

      resolveFirst!();
      await Promise.all([sync1, sync2]);

      // should only sync once
      expect(mockSyncHandler).toHaveBeenCalledTimes(1);
    });

    it("should not sync when offline", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      await manager.syncPendingMutations();

      expect(mockSyncHandler).not.toHaveBeenCalled();
    });

    it("should not sync without sync handler", async () => {
      const managerNoHandler = new OfflineManager({
        config: { enabled: true },
      });

      (managerNoHandler as any).isOnline = false;
      await (managerNoHandler as any).storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      });

      (managerNoHandler as any).isOnline = true;
      await managerNoHandler.syncPendingMutations();

      // should not throw
    });
  });

  describe("getPendingMutations", () => {
    it("should return only pending and failed mutations", async () => {
      const storage = (manager as any).storage;
      await storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      });
      await storage.addMutation({
        id: "2",
        type: "update",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 1,
        status: "failed",
      });
      await storage.addMutation({
        id: "3",
        type: "delete",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "processing",
      });

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(2);
      expect(pending.map((m) => m.id)).toContain("1");
      expect(pending.map((m) => m.id)).toContain("2");
    });
  });

  describe("clearMutations", () => {
    it("should clear all mutations", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      await manager.clearMutations();

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });
  });

  describe("getIsOnline", () => {
    it("should return online status", () => {
      expect(manager.getIsOnline()).toBe(true);

      (manager as any).isOnline = false;
      expect(manager.getIsOnline()).toBe(false);
    });
  });

  describe("online/offline events", () => {
    it("should handle coming online", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      // simulate coming online
      (manager as any).handleOnline();

      await new Promise((r) => setTimeout(r, 10));

      expect(manager.getIsOnline()).toBe(true);
      expect(mockSyncHandler).toHaveBeenCalled();
    });

    it("should handle going offline", () => {
      (manager as any).handleOffline();

      expect(manager.getIsOnline()).toBe(false);
    });
  });

  describe("custom storage", () => {
    it("should use provided storage", async () => {
      const customStorage = new InMemoryOfflineStorage();
      const managerWithStorage = new OfflineManager({
        config: { enabled: true, storage: customStorage },
      });

      (managerWithStorage as any).isOnline = false;
      await managerWithStorage.queueMutation("create", "/users", { name: "Test" });

      const storageMutations = await customStorage.getMutations();
      expect(storageMutations).toHaveLength(1);
    });
  });
});

describe("createOfflineManager", () => {
  it("should create OfflineManager instance", () => {
    const manager = createOfflineManager({
      config: { enabled: true },
    });

    expect(manager).toBeDefined();
    expect(typeof manager.queueMutation).toBe("function");
    expect(typeof manager.syncPendingMutations).toBe("function");
  });
});

describe("ID remapping", () => {
  it("should call onIdRemapped when server returns different ID", async () => {
    const onIdRemapped = vi.fn();
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "server-123",
    });

    const manager = new OfflineManager({
      config: { enabled: true },
      onMutationSync: mockSyncHandler,
      onIdRemapped,
    });

    // Queue with optimistic ID
    (manager as any).isOnline = false;
    await manager.queueMutation("create", "/users", { name: "Test" }, undefined, "optimistic-abc");

    // Sync
    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    expect(onIdRemapped).toHaveBeenCalledWith("optimistic-abc", "server-123");
  });

  it("should store ID mapping internally", async () => {
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "server-456",
    });

    const manager = new OfflineManager({
      config: { enabled: true },
      onMutationSync: mockSyncHandler,
    });

    (manager as any).isOnline = false;
    await manager.queueMutation("create", "/users", { name: "Test" }, undefined, "optimistic-xyz");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    expect(manager.getServerIdForOptimisticId("optimistic-xyz")).toBe("server-456");
  });

  it("should not call onIdRemapped when IDs match", async () => {
    const onIdRemapped = vi.fn();
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "optimistic-same",
    });

    const manager = new OfflineManager({
      config: { enabled: true },
      onMutationSync: mockSyncHandler,
      onIdRemapped,
    });

    (manager as any).isOnline = false;
    await manager.queueMutation("create", "/users", { name: "Test" }, undefined, "optimistic-same");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    expect(onIdRemapped).not.toHaveBeenCalled();
  });

  it("should resolve optimistic ID to server ID using resolveId", async () => {
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "server-789",
    });

    const manager = new OfflineManager({
      config: { enabled: true },
      onMutationSync: mockSyncHandler,
    });

    (manager as any).isOnline = false;
    await manager.queueMutation("create", "/users", { name: "Test" }, undefined, "optimistic-resolve");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    // resolveId should return server ID for optimistic ID
    expect(manager.resolveId("optimistic-resolve")).toBe("server-789");
    // resolveId should return the same ID if not in mappings
    expect(manager.resolveId("unknown-id")).toBe("unknown-id");
  });

  it("should clear ID mappings when clearing mutations", async () => {
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "server-clear",
    });

    const manager = new OfflineManager({
      config: { enabled: true },
      onMutationSync: mockSyncHandler,
    });

    (manager as any).isOnline = false;
    await manager.queueMutation("create", "/users", { name: "Test" }, undefined, "optimistic-clear");

    (manager as any).isOnline = true;
    await manager.syncPendingMutations();

    expect(manager.resolveId("optimistic-clear")).toBe("server-clear");

    await manager.clearMutations();

    // After clearing, resolveId should return the ID as-is
    expect(manager.resolveId("optimistic-clear")).toBe("optimistic-clear");
  });
});

describe("Optimistic update flow", () => {
  it("should return immediately with optimistic result even when network hangs (default behavior)", async () => {
    // Request hangs forever
    const mockRequest = vi.fn().mockImplementation(() => new Promise(() => {}));
    const mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    const offlineManager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    const { Repository } = await import("../../src/client/repository");
    const repository = new Repository({
      transport: mockTransport,
      resourcePath: "/todos",
      offline: offlineManager,
    });

    // Should return immediately without waiting for network (default behavior)
    const result = await repository.create({ title: "Test Todo", completed: false });

    expect(result.id).toContain("optimistic_");
    expect(result.title).toBe("Test Todo");
  });

  it("should queue mutation on background sync failure", async () => {
    const mockRequest = vi.fn().mockRejectedValue(new Error("Network error"));
    const mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    const offlineManager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    const { Repository } = await import("../../src/client/repository");
    const repository = new Repository({
      transport: mockTransport,
      resourcePath: "/todos",
      offline: offlineManager,
    });

    // Optimistic is default, no need to specify
    const result = await repository.create({ title: "Test Todo", completed: false });

    // Wait for background sync to fail
    await new Promise((r) => setTimeout(r, 10));

    const pending = await offlineManager.getPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("create");
    expect(pending[0].optimisticId).toBe(result.id);
  });

  it("should sync optimistic mutations and remap IDs when back online", async () => {
    const onIdRemapped = vi.fn();
    const mockSyncHandler = vi.fn().mockResolvedValue({
      success: true,
      serverId: "real-server-id-123",
    });

    const offlineManager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
      onMutationSync: mockSyncHandler,
      onIdRemapped,
    });

    // Simulate offline state
    (offlineManager as any).isOnline = false;

    // Queue a create mutation
    await offlineManager.queueMutation(
      "create",
      "/todos",
      { title: "Offline Todo" },
      undefined,
      "optimistic_12345"
    );

    // Verify mutation is pending
    let pending = await offlineManager.getPendingMutations();
    expect(pending).toHaveLength(1);

    // Simulate coming back online and syncing
    (offlineManager as any).isOnline = true;
    await offlineManager.syncPendingMutations();

    // ID should be remapped
    expect(onIdRemapped).toHaveBeenCalledWith("optimistic_12345", "real-server-id-123");

    // Mutation should be removed after sync
    pending = await offlineManager.getPendingMutations();
    expect(pending).toHaveLength(0);

    // Future operations can use resolveId to get the real ID
    expect(offlineManager.resolveId("optimistic_12345")).toBe("real-server-id-123");
  });

  it("should use resolved ID when updating a previously created optimistic item", async () => {
    const syncedMutations: any[] = [];
    const mockSyncHandler = vi.fn().mockImplementation(async (mutation) => {
      syncedMutations.push({ ...mutation });
      if (mutation.type === "create") {
        return { success: true, serverId: "server-todo-456" };
      }
      return { success: true };
    });

    const offlineManager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
      onMutationSync: mockSyncHandler,
    });

    // Create offline
    (offlineManager as any).isOnline = false;
    await offlineManager.queueMutation(
      "create",
      "/todos",
      { title: "New Todo" },
      undefined,
      "optimistic_abc"
    );

    // Update the same item offline (using optimistic ID)
    await offlineManager.queueMutation(
      "update",
      "/todos",
      { completed: true },
      "optimistic_abc"
    );

    // Come online and sync
    (offlineManager as any).isOnline = true;
    await offlineManager.syncPendingMutations();

    // Both mutations should have been synced
    expect(syncedMutations).toHaveLength(2);
    expect(syncedMutations[0].type).toBe("create");
    expect(syncedMutations[1].type).toBe("update");

    // After sync, resolveId should map the optimistic ID to server ID
    expect(offlineManager.resolveId("optimistic_abc")).toBe("server-todo-456");
  });
});

describe("registerIdMapping", () => {
  it("should register mapping and call onIdRemapped", () => {
    const onIdRemapped = vi.fn();
    const manager = new OfflineManager({
      config: { enabled: true },
      onIdRemapped,
    });

    manager.registerIdMapping("optimistic_1", "server_1");

    expect(manager.resolveId("optimistic_1")).toBe("server_1");
    expect(onIdRemapped).toHaveBeenCalledWith("optimistic_1", "server_1");
  });

  it("should not call onIdRemapped if IDs are the same", () => {
    const onIdRemapped = vi.fn();
    const manager = new OfflineManager({
      config: { enabled: true },
      onIdRemapped,
    });

    manager.registerIdMapping("same_id", "same_id");

    expect(onIdRemapped).not.toHaveBeenCalled();
  });
});
