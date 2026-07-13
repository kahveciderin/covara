import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FetchTransport,
  TransportError,
  createTransport,
} from "../../src/client/transport";

describe("FetchTransport", () => {
  let transport: FetchTransport;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    transport = new FetchTransport({
      baseUrl: "http://localhost:3000",
      headers: { "X-Custom": "header" },
      timeout: 5000,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("request", () => {
    it("should make GET request with correct url and headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ data: "test" }),
      });

      const result = await transport.request({
        method: "GET",
        path: "/users",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/users",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Custom": "header",
          }),
        })
      );
      expect(result.data).toEqual({ data: "test" });
      expect(result.status).toBe(200);
    });

    it("should make POST request with body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ id: "1", name: "Test" }),
      });

      const result = await transport.request({
        method: "POST",
        path: "/users",
        body: { name: "Test" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/users",
        expect.objectContaining({
          method: "POST",
          body: '{"name":"Test"}',
        })
      );
      expect(result.data).toEqual({ id: "1", name: "Test" });
    });

    it("should handle query parameters", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve([]),
      });

      await transport.request({
        method: "GET",
        path: "/users",
        params: { filter: "age>=18", limit: 10, active: true },
      });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("filter=age%3E%3D18");
      expect(calledUrl).toContain("limit=10");
      expect(calledUrl).toContain("active=true");
    });

    it("should handle array parameters", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve([]),
      });

      await transport.request({
        method: "GET",
        path: "/users",
        params: { select: ["id", "name", "email"] },
      });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain("select=id%2Cname%2Cemail");
    });

    it("should skip null/undefined params", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve([]),
      });

      await transport.request({
        method: "GET",
        path: "/users",
        params: { filter: undefined, limit: null as any, active: true },
      });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).not.toContain("filter");
      expect(calledUrl).not.toContain("limit");
      expect(calledUrl).toContain("active=true");
    });

    it("should throw TransportError on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          Promise.resolve({
            error: { code: "NOT_FOUND", message: "User not found" },
          }),
      });

      await expect(
        transport.request({ method: "GET", path: "/users/999" })
      ).rejects.toThrow(TransportError);

      try {
        await transport.request({ method: "GET", path: "/users/999" });
      } catch (e) {
        expect(e).toBeInstanceOf(TransportError);
        expect((e as TransportError).status).toBe(404);
        expect((e as TransportError).code).toBe("NOT_FOUND");
        expect((e as TransportError).message).toBe("User not found");
      }
    });

    it("should handle generic HTTP error without error body", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("Internal Server Error"),
      });

      try {
        await transport.request({ method: "GET", path: "/users" });
      } catch (e) {
        expect(e).toBeInstanceOf(TransportError);
        expect((e as TransportError).status).toBe(500);
        expect((e as TransportError).code).toBe("HTTP_ERROR");
      }
    });

    it("should handle 204 No Content response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers(),
        text: () => Promise.resolve(""),
      });

      const result = await transport.request({
        method: "DELETE",
        path: "/users/1",
      });

      expect(result.status).toBe(204);
      expect(result.data).toBeUndefined();
    });

    it("should parse text response as JSON if possible", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve('{"parsed": true}'),
      });

      const result = await transport.request({
        method: "GET",
        path: "/raw",
      });

      expect(result.data).toEqual({ parsed: true });
    });

    it("should return raw text if not valid JSON", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("plain text response"),
      });

      const result = await transport.request({
        method: "GET",
        path: "/raw",
      });

      expect(result.data).toBe("plain text response");
    });

    it("should merge request-specific headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      });

      await transport.request({
        method: "GET",
        path: "/users",
        headers: { "X-Request-Id": "123" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Custom": "header",
            "X-Request-Id": "123",
          }),
        })
      );
    });
  });

  describe("header management", () => {
    it("should set header", async () => {
      transport.setHeader("Authorization", "Bearer token123");

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      });

      await transport.request({ method: "GET", path: "/protected" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer token123",
          }),
        })
      );
    });

    it("should remove header", async () => {
      transport.setHeader("Authorization", "Bearer token123");
      transport.removeHeader("Authorization");

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      });

      await transport.request({ method: "GET", path: "/public" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("credentials", () => {
    it("should include credentials when configured", async () => {
      const transportWithCreds = new FetchTransport({
        baseUrl: "http://localhost:3000",
        credentials: "include",
      });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      });

      await transportWithCreds.request({ method: "GET", path: "/session" });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: "include",
        })
      );
    });
  });

  describe("createEventSource", () => {
    // multiplex:false exercises the direct per-subscription EventSource path.
    it("should create EventSource with correct url", () => {
      const nativeTransport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        multiplex: false,
      });
      const mockEventSource = vi.fn();
      global.EventSource = mockEventSource as any;

      nativeTransport.createEventSource("/subscribe", { filter: "active==true" });

      expect(mockEventSource).toHaveBeenCalledWith(
        expect.stringContaining("/subscribe"),
        expect.objectContaining({ withCredentials: false })
      );
    });

    it("should set withCredentials for include credentials", () => {
      const transportWithCreds = new FetchTransport({
        baseUrl: "http://localhost:3000",
        credentials: "include",
        multiplex: false,
      });

      const mockEventSource = vi.fn();
      global.EventSource = mockEventSource as any;

      transportWithCreds.createEventSource("/subscribe");

      expect(mockEventSource).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ withCredentials: true })
      );
    });
  });
});

describe("TransportError", () => {
  describe("construction", () => {
    it("should create error with all properties", () => {
      const error = new TransportError(
        "Not found",
        404,
        "NOT_FOUND",
        { field: "id" }
      );

      expect(error.message).toBe("Not found");
      expect(error.status).toBe(404);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.details).toEqual({ field: "id" });
      expect(error.name).toBe("TransportError");
    });
  });

  describe("status checks", () => {
    it("isNotFound returns true for 404", () => {
      const error = new TransportError("", 404, "");
      expect(error.isNotFound()).toBe(true);
      expect(error.isUnauthorized()).toBe(false);
    });

    it("isUnauthorized returns true for 401", () => {
      const error = new TransportError("", 401, "");
      expect(error.isUnauthorized()).toBe(true);
      expect(error.isNotFound()).toBe(false);
    });

    it("isForbidden returns true for 403", () => {
      const error = new TransportError("", 403, "");
      expect(error.isForbidden()).toBe(true);
    });

    it("isValidationError returns true for 400", () => {
      const error = new TransportError("", 400, "");
      expect(error.isValidationError()).toBe(true);
    });

    it("isRateLimited returns true for 429", () => {
      const error = new TransportError("", 429, "");
      expect(error.isRateLimited()).toBe(true);
    });

    it("isServerError returns true for 5xx", () => {
      expect(new TransportError("", 500, "").isServerError()).toBe(true);
      expect(new TransportError("", 502, "").isServerError()).toBe(true);
      expect(new TransportError("", 503, "").isServerError()).toBe(true);
      expect(new TransportError("", 499, "").isServerError()).toBe(false);
    });
  });
});

describe("createTransport", () => {
  it("should create FetchTransport instance", () => {
    const transport = createTransport({
      baseUrl: "http://localhost:3000",
    });

    expect(transport).toBeDefined();
    expect(typeof transport.request).toBe("function");
    expect(typeof transport.createEventSource).toBe("function");
    expect(typeof transport.setHeader).toBe("function");
    expect(typeof transport.removeHeader).toBe("function");
  });
});
