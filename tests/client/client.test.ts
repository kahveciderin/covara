import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, CovaraClient } from "../../src/client/index";

describe("createClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
    });
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should create client with minimal config", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
    });

    expect(client).toBeDefined();
    expect(client.transport).toBeDefined();
    expect(client.offline).toBeUndefined();
  });

  it("should create client with headers", async () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      headers: { "X-API-Key": "secret" },
    });

    await client.transport.request({ method: "GET", path: "/test" });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-API-Key": "secret",
        }),
      })
    );
  });

  it("should create client with credentials", async () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      credentials: "include",
    });

    await client.transport.request({ method: "GET", path: "/test" });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        credentials: "include",
      })
    );
  });

  it("should create client with offline support", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      offline: { enabled: true },
    });

    expect(client.offline).toBeDefined();
  });

  it("should not create offline manager when disabled", () => {
    const client = createClient({
      baseUrl: "http://localhost:3000",
      offline: { enabled: false },
    });

    expect(client.offline).toBeUndefined();
  });

  describe("resource method", () => {
    it("should create resource client", () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      const users = client.resource<{ id: string; name: string }>("/users");

      expect(users).toBeDefined();
      expect(typeof users.list).toBe("function");
      expect(typeof users.get).toBe("function");
      expect(typeof users.create).toBe("function");
      expect(typeof users.update).toBe("function");
      expect(typeof users.delete).toBe("function");
      expect(typeof users.subscribe).toBe("function");
    });

    it("should create multiple resource clients", () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      const users = client.resource<{ id: string }>("/users");
      const posts = client.resource<{ id: string }>("/posts");

      expect(users).not.toBe(posts);
    });

    it("should share transport across resources", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ items: [], hasMore: false, nextCursor: null }),
      });

      const users = client.resource<{ id: string }>("/users");
      const posts = client.resource<{ id: string }>("/posts");

      client.setAuthToken("token123");

      await users.list();
      await posts.list();

      // both should use the same auth header
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer token123");
      expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer token123");
    });
  });

  describe("setAuthToken", () => {
    it("should set authorization header", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      client.setAuthToken("my-jwt-token");

      await client.transport.request({ method: "GET", path: "/protected" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer my-jwt-token",
          }),
        })
      );
    });

    it("should update token on subsequent calls", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      client.setAuthToken("token1");
      client.setAuthToken("token2");

      await client.transport.request({ method: "GET", path: "/test" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer token2",
          }),
        })
      );
    });
  });

  describe("clearAuthToken", () => {
    it("should remove authorization header", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
      });

      client.setAuthToken("token");
      client.clearAuthToken();

      await client.transport.request({ method: "GET", path: "/public" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("error callbacks", () => {
    it("should call onError for offline mutation failures", async () => {
      const onError = vi.fn();
      const client = createClient({
        baseUrl: "http://localhost:3000",
        offline: { enabled: true },
        onError,
      });

      // access offline manager internals to trigger failure
      const offlineManager = client.offline!;
      const failHandler = (offlineManager as any).onMutationFailed;

      failHandler(
        { id: "1", type: "create", resource: "/users" },
        new Error("Sync failed")
      );

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe("offline sync", () => {
    it("should sync create mutation to server", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
        offline: { enabled: true },
      });

      const offlineManager = client.offline!;
      const syncHandler = (offlineManager as any).onMutationSync;

      await syncHandler({
        id: "1",
        type: "create",
        resource: "/users",
        data: { name: "Test User" }
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/users",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Test User" }),
        })
      );
    });

    it("should sync update mutation to server", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
        offline: { enabled: true },
      });

      const offlineManager = client.offline!;
      const syncHandler = (offlineManager as any).onMutationSync;

      await syncHandler({
        id: "1",
        type: "update",
        resource: "/users",
        objectId: "123",
        data: { name: "Updated User" }
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/users/123",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ name: "Updated User" }),
        })
      );
    });

    it("should sync delete mutation to server", async () => {
      const client = createClient({
        baseUrl: "http://localhost:3000",
        offline: { enabled: true },
      });

      const offlineManager = client.offline!;
      const syncHandler = (offlineManager as any).onMutationSync;

      await syncHandler({
        id: "1",
        type: "delete",
        resource: "/users",
        objectId: "123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/users/123",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });

    it("should log mutation failure", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const client = createClient({
        baseUrl: "http://localhost:3000",
        offline: { enabled: true },
      });

      const offlineManager = client.offline!;
      const failHandler = (offlineManager as any).onMutationFailed;

      failHandler(
        { id: "1", type: "create", resource: "/users" },
        new Error("Network error")
      );

      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });
  });
});

describe("exports", () => {
  it("should export all types and classes", async () => {
    const exports = await import("../../src/client/index");

    // transport exports
    expect(exports.FetchTransport).toBeDefined();
    expect(exports.TransportError).toBeDefined();
    expect(exports.createTransport).toBeDefined();

    // repository exports
    expect(exports.Repository).toBeDefined();
    expect(exports.createRepository).toBeDefined();

    // offline exports
    expect(exports.OfflineManager).toBeDefined();
    expect(exports.InMemoryOfflineStorage).toBeDefined();
    expect(exports.LocalStorageOfflineStorage).toBeDefined();
    expect(exports.createOfflineManager).toBeDefined();

    // subscription exports
    expect(exports.SubscriptionManager).toBeDefined();
    expect(exports.createSubscription).toBeDefined();
  });
});
