import { describe, it, expect, vi, beforeEach } from "vitest";
import { Repository, createRepository } from "../../src/client/repository";
import { Transport } from "../../src/client/transport";
import { OfflineManager, InMemoryOfflineStorage } from "../../src/client/offline";

interface TestUser {
  id: string;
  name: string;
  email: string;
  age?: number;
}

describe("Repository", () => {
  let repository: Repository<TestUser>;
  let mockTransport: Transport;
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequest = vi.fn();
    mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    repository = new Repository<TestUser>({
      transport: mockTransport,
      resourcePath: "/users",
    });
  });

  describe("list", () => {
    it("should list resources with default options", async () => {
      mockRequest.mockResolvedValue({
        data: {
          items: [{ id: "1", name: "Alice", email: "alice@test.com" }],
          hasMore: false,
          nextCursor: null,
        },
      });

      const result = await repository.list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: {},
      });
      expect(result.items).toHaveLength(1);
    });

    it("should list with filter", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });

      await repository.list({ filter: 'age>=18;role=="admin"' });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: 'age>=18;role=="admin"' },
      });
    });

    it("should list with select projection", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });

      await repository.list({ select: ["id", "name"] });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { select: "id,name" },
      });
    });

    it("should list with pagination", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: true, nextCursor: "cursor123" } });

      await repository.list({ cursor: "prevCursor", limit: 20 });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { cursor: "prevCursor", limit: 20 },
      });
    });

    it("should list with orderBy", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });

      await repository.list({ orderBy: "name:asc,age:desc" });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { orderBy: "name:asc,age:desc" },
      });
    });

    it("should list with totalCount", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null, totalCount: 100 },
      });

      const result = await repository.list({ totalCount: true });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { totalCount: true },
      });
      expect(result.totalCount).toBe(100);
    });

    it("should list with withDeleted", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });

      await repository.list({ withDeleted: true });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { withDeleted: true },
      });
    });

    it("should list with all options combined", async () => {
      mockRequest.mockResolvedValue({ data: { items: [], hasMore: false, nextCursor: null } });

      await repository.list({
        filter: "active==true",
        select: ["id", "name"],
        cursor: "abc",
        limit: 10,
        orderBy: "name:asc",
        totalCount: true,
      });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: {
          filter: "active==true",
          select: "id,name",
          cursor: "abc",
          limit: 10,
          orderBy: "name:asc",
          totalCount: true,
        },
      });
    });
  });

  describe("get", () => {
    it("should get single resource", async () => {
      mockRequest.mockResolvedValue({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const result = await repository.get("1");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/1",
        params: {},
      });
      expect(result.name).toBe("Alice");
    });

    it("should get with select projection", async () => {
      mockRequest.mockResolvedValue({ data: { id: "1", name: "Alice" } });

      await repository.get("1", { select: ["id", "name"] });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/1",
        params: { select: "id,name" },
      });
    });
  });

  describe("count", () => {
    it("should get count without filter", async () => {
      mockRequest.mockResolvedValue({ data: { count: 42 } });

      const result = await repository.count();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/count",
        params: {},
      });
      expect(result).toBe(42);
    });

    it("should get count with filter", async () => {
      mockRequest.mockResolvedValue({ data: { count: 10 } });

      const result = await repository.count("active==true");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/count",
        params: { filter: "active==true" },
      });
      expect(result).toBe(10);
    });
  });

  describe("search", () => {
    it("should search with query only", async () => {
      mockRequest.mockResolvedValue({
        data: {
          items: [{ id: "1", name: "Alice", email: "alice@test.com" }],
          total: 1,
        },
      });

      const result = await repository.search("alice");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/search",
        params: { q: "alice" },
      });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("should search with filter", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], total: 0 },
      });

      await repository.search("test", { filter: "active==true" });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/search",
        params: { q: "test", filter: "active==true" },
      });
    });

    it("should search with pagination", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], total: 100 },
      });

      await repository.search("test", { limit: 10, offset: 20 });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/search",
        params: { q: "test", limit: 10, offset: 20 },
      });
    });

    it("should search with highlights", async () => {
      mockRequest.mockResolvedValue({
        data: {
          items: [{ id: "1", name: "Alice", email: "alice@test.com" }],
          total: 1,
          highlights: { "1": { name: ["<em>Alice</em>"] } },
        },
      });

      const result = await repository.search("alice", { highlight: true });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/search",
        params: { q: "alice", highlight: true },
      });
      expect(result.highlights).toBeDefined();
      expect(result.highlights?.["1"]?.name).toContain("<em>Alice</em>");
    });

    it("should search with all options combined", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], total: 0 },
      });

      await repository.search("test", {
        filter: "active==true",
        limit: 20,
        offset: 10,
        highlight: true,
      });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/search",
        params: {
          q: "test",
          filter: "active==true",
          limit: 20,
          offset: 10,
          highlight: true,
        },
      });
    });
  });

  describe("aggregate", () => {
    it("should aggregate with groupBy and count", async () => {
      mockRequest.mockResolvedValue({
        data: {
          groups: [
            { key: { role: "admin" }, count: 5 },
            { key: { role: "user" }, count: 95 },
          ],
        },
      });

      const result = await repository.aggregate({
        groupBy: ["role"],
        count: true,
      });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/aggregate",
        params: { groupBy: "role", count: true },
      });
      expect(result.groups).toHaveLength(2);
    });

    it("should aggregate with numeric functions", async () => {
      mockRequest.mockResolvedValue({
        data: {
          groups: [{ key: null, sum: { age: 1000 }, avg: { age: 25 }, min: { age: 18 }, max: { age: 65 } }],
        },
      });

      await repository.aggregate({
        sum: ["age"],
        avg: ["age"],
        min: ["age"],
        max: ["age"],
      });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/aggregate",
        params: {
          sum: "age",
          avg: "age",
          min: "age",
          max: "age",
        },
      });
    });

    it("should aggregate with filter", async () => {
      mockRequest.mockResolvedValue({ data: { groups: [] } });

      await repository.aggregate({
        filter: "active==true",
        groupBy: ["department"],
        count: true,
      });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/aggregate",
        params: {
          filter: "active==true",
          groupBy: "department",
          count: true,
        },
      });
    });
  });

  describe("create", () => {
    it("should create resource", async () => {
      mockRequest.mockResolvedValue({
        data: { id: "new123", name: "Bob", email: "bob@test.com" },
      });

      const result = await repository.create({ name: "Bob", email: "bob@test.com" });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/users",
        body: { name: "Bob", email: "bob@test.com" },
      });
      expect(result.id).toBe("new123");
    });
  });

  describe("update", () => {
    it("should update resource", async () => {
      mockRequest.mockResolvedValue({
        data: { id: "1", name: "Alice Updated", email: "alice@test.com" },
      });

      const result = await repository.update("1", { name: "Alice Updated" });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "PATCH",
        path: "/users/1",
        body: { name: "Alice Updated" },
      });
      expect(result.name).toBe("Alice Updated");
    });
  });

  describe("replace", () => {
    it("should replace resource", async () => {
      mockRequest.mockResolvedValue({
        data: { id: "1", name: "Alice New", email: "newalice@test.com" },
      });

      const result = await repository.replace("1", { name: "Alice New", email: "newalice@test.com" });

      expect(mockRequest).toHaveBeenCalledWith({
        method: "PUT",
        path: "/users/1",
        body: { name: "Alice New", email: "newalice@test.com" },
      });
      expect(result.email).toBe("newalice@test.com");
    });
  });

  describe("delete", () => {
    it("should delete resource", async () => {
      mockRequest.mockResolvedValue({ data: undefined });

      await repository.delete("1");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "DELETE",
        path: "/users/1",
      });
    });
  });

  describe("batch operations", () => {
    it("should batch create", async () => {
      mockRequest.mockResolvedValue({
        data: {
          items: [
            { id: "1", name: "Alice", email: "alice@test.com" },
            { id: "2", name: "Bob", email: "bob@test.com" },
          ],
        },
      });

      const result = await repository.batchCreate([
        { name: "Alice", email: "alice@test.com" },
        { name: "Bob", email: "bob@test.com" },
      ]);

      expect(mockRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/users/batch",
        body: {
          items: [
            { name: "Alice", email: "alice@test.com" },
            { name: "Bob", email: "bob@test.com" },
          ],
        },
      });
      expect(result).toHaveLength(2);
    });

    it("should batch update", async () => {
      mockRequest.mockResolvedValue({ data: { count: 5 } });

      const result = await repository.batchUpdate("active==false", { active: true } as any);

      expect(mockRequest).toHaveBeenCalledWith({
        method: "PATCH",
        path: "/users/batch",
        params: { filter: "active==false" },
        body: { active: true },
      });
      expect(result.count).toBe(5);
    });

    it("should batch delete", async () => {
      mockRequest.mockResolvedValue({ data: { count: 3 } });

      const result = await repository.batchDelete('status=="inactive"');

      expect(mockRequest).toHaveBeenCalledWith({
        method: "DELETE",
        path: "/users/batch",
        params: { filter: 'status=="inactive"' },
      });
      expect(result.count).toBe(3);
    });
  });

  describe("subscribe", () => {
    it("should create subscription", () => {
      mockTransport.createEventSource = vi.fn().mockReturnValue({
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null,
      });

      const subscription = repository.subscribe(
        { filter: "active==true" },
        { onAdded: vi.fn() }
      );

      expect(subscription).toBeDefined();
      expect(typeof subscription.unsubscribe).toBe("function");
    });
  });

  describe("rpc", () => {
    it("should call RPC procedure", async () => {
      mockRequest.mockResolvedValue({
        data: { data: { orderId: "order123", total: 99.99 } },
      });

      const result = await repository.rpc<{ items: string[] }, { orderId: string; total: number }>(
        "createOrder",
        { items: ["item1", "item2"] }
      );

      expect(mockRequest).toHaveBeenCalledWith({
        method: "POST",
        path: "/users/rpc/createOrder",
        body: { items: ["item1", "item2"] },
      });
      expect(result.orderId).toBe("order123");
    });
  });

  describe("custom idField", () => {
    it("should use custom idField", () => {
      const customRepo = new Repository<{ id: string; uuid: string; name: string }>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "uuid",
      });

      expect((customRepo as any).idField).toBe("uuid");
    });
  });
});

describe("Repository with offline support", () => {
  let repository: Repository<{ id: string; name: string }>;
  let mockTransport: Transport;
  let mockRequest: ReturnType<typeof vi.fn>;
  let offlineManager: OfflineManager;

  beforeEach(() => {
    mockRequest = vi.fn();
    mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    offlineManager = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });

    repository = new Repository({
      transport: mockTransport,
      resourcePath: "/users",
      offline: offlineManager,
    });
  });

  describe("optimistic by default", () => {
    it("should return optimistic result immediately for create by default", async () => {
      // Request will hang forever - but optimistic should return immediately
      mockRequest.mockImplementation(() => new Promise(() => {}));

      const result = await repository.create({ name: "Test" });

      // Should return immediately with optimistic ID (default behavior)
      expect(result.id).toContain("optimistic_");
      expect(result.name).toBe("Test");
    });

    it("should return optimistic result immediately for update by default", async () => {
      mockRequest.mockImplementation(() => new Promise(() => {}));

      const result = await repository.update("123", { name: "Updated" });

      expect(result.id).toBe("123");
      expect(result.name).toBe("Updated");
    });

    it("should return immediately for delete by default", async () => {
      mockRequest.mockImplementation(() => new Promise(() => {}));

      // Should not hang
      await repository.delete("123");
    });

    it("should use provided optimisticId for create", async () => {
      mockRequest.mockImplementation(() => new Promise(() => {}));

      const result = await repository.create(
        { name: "Test" },
        { optimisticId: "my-custom-id" }
      );

      expect(result.id).toBe("my-custom-id");
    });

    it("should register ID mapping on successful background sync", async () => {
      mockRequest.mockResolvedValue({ data: { id: "server-123", name: "Test" } });

      const result = await repository.create({ name: "Test" });

      // Wait for background sync
      await new Promise((r) => setTimeout(r, 10));

      expect(offlineManager.resolveId(result.id)).toBe("server-123");
    });

    it("should queue mutation on background sync failure", async () => {
      mockRequest.mockRejectedValue(new Error("Network error"));

      const result = await repository.create({ name: "Test" });

      // Wait for background sync to fail and queue
      await new Promise((r) => setTimeout(r, 10));

      const pending = await offlineManager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("create");
      expect(pending[0].optimisticId).toBe(result.id);
    });
  });

  describe("opt-out of optimistic mode", () => {
    it("should wait for server response on create with optimistic: false", async () => {
      mockRequest.mockResolvedValue({ data: { id: "server-id", name: "Test" } });

      const result = await repository.create({ name: "Test" }, { optimistic: false });

      expect(mockRequest).toHaveBeenCalled();
      expect(result.id).toBe("server-id");
    });

    it("should wait for server response on update with optimistic: false", async () => {
      mockRequest.mockResolvedValue({ data: { id: "123", name: "Updated" } });

      const result = await repository.update("123", { name: "Updated" }, { optimistic: false });

      expect(mockRequest).toHaveBeenCalled();
      expect(result.name).toBe("Updated");
    });

    it("should throw on network failure with optimistic: false", async () => {
      mockRequest.mockRejectedValue(new Error("Network error"));

      await expect(repository.create({ name: "Test" }, { optimistic: false })).rejects.toThrow("Network error");
      await expect(repository.update("123", { name: "Updated" }, { optimistic: false })).rejects.toThrow("Network error");
      await expect(repository.delete("123", { optimistic: false })).rejects.toThrow("Network error");
    });
  });

  describe("ID resolution for updates/deletes", () => {
    it("should resolve optimistic ID to server ID for update", async () => {
      // First, set up an ID mapping
      offlineManager.registerIdMapping("optimistic_123", "server_456");

      mockRequest.mockResolvedValue({ data: { id: "server_456", name: "Updated" } });

      await repository.update("optimistic_123", { name: "Updated" }, { optimistic: true });

      // Wait for background sync
      await new Promise((r) => setTimeout(r, 10));

      // Should have called with resolved ID
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/users/server_456",
        })
      );
    });

    it("should resolve optimistic ID to server ID for delete", async () => {
      offlineManager.registerIdMapping("optimistic_123", "server_456");

      mockRequest.mockResolvedValue({ data: undefined });

      await repository.delete("optimistic_123", { optimistic: true });

      // Wait for background sync
      await new Promise((r) => setTimeout(r, 10));

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/users/server_456",
        })
      );
    });
  });
});

describe("createRepository", () => {
  it("should create Repository instance", () => {
    const mockTransport = {
      request: vi.fn(),
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    const repo = createRepository<{ id: string }>({
      transport: mockTransport,
      resourcePath: "/items",
    });

    expect(repo).toBeDefined();
    expect(typeof repo.list).toBe("function");
    expect(typeof repo.get).toBe("function");
    expect(typeof repo.create).toBe("function");
    expect(typeof repo.update).toBe("function");
    expect(typeof repo.delete).toBe("function");
    expect(typeof repo.subscribe).toBe("function");
  });
});

describe("Repository error handling", () => {
  let repository: Repository<{ id: string; name: string }>;
  let mockTransport: Transport;
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequest = vi.fn();
    mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    repository = new Repository({
      transport: mockTransport,
      resourcePath: "/users",
    });
  });

  it("should propagate transport errors on list", async () => {
    mockRequest.mockRejectedValue(new Error("Network error"));

    await expect(repository.list()).rejects.toThrow("Network error");
  });

  it("should propagate transport errors on get", async () => {
    mockRequest.mockRejectedValue(new Error("Not found"));

    await expect(repository.get("123")).rejects.toThrow("Not found");
  });

  it("should propagate transport errors on create", async () => {
    mockRequest.mockRejectedValue(new Error("Validation failed"));

    await expect(repository.create({ name: "Test" })).rejects.toThrow("Validation failed");
  });

  it("should propagate transport errors on update", async () => {
    mockRequest.mockRejectedValue(new Error("Update failed"));

    await expect(repository.update("123", { name: "Updated" })).rejects.toThrow("Update failed");
  });

  it("should propagate transport errors on delete", async () => {
    mockRequest.mockRejectedValue(new Error("Delete forbidden"));

    await expect(repository.delete("123")).rejects.toThrow("Delete forbidden");
  });

  it("should propagate transport errors on count", async () => {
    mockRequest.mockRejectedValue(new Error("Count failed"));

    await expect(repository.count()).rejects.toThrow("Count failed");
  });

  it("should propagate transport errors on aggregate", async () => {
    mockRequest.mockRejectedValue(new Error("Aggregation failed"));

    await expect(repository.aggregate({ count: true })).rejects.toThrow("Aggregation failed");
  });

  it("should propagate transport errors on batchCreate", async () => {
    mockRequest.mockRejectedValue(new Error("Batch create failed"));

    await expect(repository.batchCreate([{ name: "Test" }])).rejects.toThrow("Batch create failed");
  });

  it("should propagate transport errors on batchUpdate", async () => {
    mockRequest.mockRejectedValue(new Error("Batch update failed"));

    await expect(repository.batchUpdate("active==true", { name: "Updated" })).rejects.toThrow("Batch update failed");
  });

  it("should propagate transport errors on batchDelete", async () => {
    mockRequest.mockRejectedValue(new Error("Batch delete failed"));

    await expect(repository.batchDelete("active==false")).rejects.toThrow("Batch delete failed");
  });

  it("should propagate transport errors on rpc", async () => {
    mockRequest.mockRejectedValue(new Error("RPC failed"));

    await expect(repository.rpc("myProcedure", { input: "test" })).rejects.toThrow("RPC failed");
  });
});
