import { describe, it, expect, vi, afterEach } from "vitest";
import { Repository } from "../../src/client/repository";
import { FetchTransport } from "../../src/client/transport";
import { OfflineManager, InMemoryOfflineStorage } from "../../src/client/offline";
import { createMutation, resourceMutationFn } from "../../src/client/mutation";
import type { Transport } from "../../src/client/transport";

interface Todo {
  id: string;
  title: string;
}

const mockTransport = () => {
  const request = vi.fn(async (req: { method: string }) => ({
    data: req.method === "POST" ? { id: "1", title: "t", data: { ok: true } } : { id: "1", title: "t" },
    status: 200,
    headers: new Headers(),
  }));
  const transport = {
    request,
    createEventSource: vi.fn(),
    setHeader: vi.fn(),
    removeHeader: vi.fn(),
  } as unknown as Transport;
  return { transport, request };
};

const slowFetch = (delayMs: number) =>
  vi.fn(
    (_url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ data: { done: true } }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            ),
          delayMs
        );
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason ?? new DOMException("Aborted", "AbortError"));
        });
      })
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("per-call request options", () => {
  it("rpc passes timeoutMs and signal to the transport", async () => {
    const { transport, request } = mockTransport();
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    const signal = new AbortController().signal;
    await repo.rpc("generate", { id: "e1" }, { timeoutMs: 180_000, signal });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/exams/rpc/generate", body: { id: "e1" }, timeoutMs: 180_000, signal })
    );
  });

  it("rpc without options sends no timeout or signal", async () => {
    const { transport, request } = mockTransport();
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    await repo.rpc("generate", {});
    const sent = request.mock.calls[0]![0] as Record<string, unknown>;
    expect("timeoutMs" in sent).toBe(false);
    expect("signal" in sent).toBe(false);
  });

  it("an rpc slower than the client timeout resolves with a longer timeoutMs", async () => {
    vi.stubGlobal("fetch", slowFetch(80));
    const transport = new FetchTransport({ baseUrl: "http://localhost", timeout: 20 });
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    await expect(repo.rpc("generate", {})).rejects.toBeDefined();
    await expect(repo.rpc("generate", {}, { timeoutMs: 1000 })).resolves.toEqual({ done: true });
  });

  it("a shorter timeoutMs overrides the client timeout too", async () => {
    vi.stubGlobal("fetch", slowFetch(80));
    const transport = new FetchTransport({ baseUrl: "http://localhost", timeout: 5000 });
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    await expect(repo.rpc("generate", {}, { timeoutMs: 10 })).rejects.toBeDefined();
  });

  it("an aborted signal cancels the rpc", async () => {
    vi.stubGlobal("fetch", slowFetch(1000));
    const transport = new FetchTransport({ baseUrl: "http://localhost", timeout: 0 });
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    const controller = new AbortController();
    const pending = repo.rpc("generate", {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it.each([
    ["create", (r: Repository<Todo>, o: object) => r.create({ title: "a" }, o), "POST"],
    ["update", (r: Repository<Todo>, o: object) => r.update("1", { title: "a" }, o), "PATCH"],
    ["replace", (r: Repository<Todo>, o: object) => r.replace("1", { title: "a" }, o), "PUT"],
    ["delete", (r: Repository<Todo>, o: object) => r.delete("1", o), "DELETE"],
  ] as const)("%s passes timeoutMs and signal", async (_name, call, method) => {
    const { transport, request } = mockTransport();
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/todos" });
    const signal = new AbortController().signal;
    await call(repo, { timeoutMs: 60_000, signal });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method, timeoutMs: 60_000, signal }));
  });

  it("an optimistic write sends timeoutMs but not the signal in the background", async () => {
    const { transport, request } = mockTransport();
    const offline = new OfflineManager({ config: { enabled: true, storage: new InMemoryOfflineStorage() } });
    const repo = new Repository<Todo>({ transport, resourcePath: "/api/todos", offline });
    const signal = new AbortController().signal;
    await repo.update("1", { title: "a" }, { timeoutMs: 60_000, signal });
    const sent = request.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.timeoutMs).toBe(60_000);
    expect("signal" in sent).toBe(false);
  });
});

describe("mutation request options", () => {
  const setup = () => {
    const { transport, request } = mockTransport();
    const resource = new Repository<Todo>({ transport, resourcePath: "/api/todos" });
    return { request, resource };
  };

  it("applies timeoutMs and signal to the resource-form operations", async () => {
    const signal = new AbortController().signal;
    const { request, resource } = setup();
    const controller = createMutation({
      resource,
      fn: resourceMutationFn<Todo>(),
      invalidate: vi.fn(),
      options: { timeoutMs: 120_000, signal },
    });
    await controller.mutateAsync({ kind: "create", data: { title: "x" } });
    await controller.mutateAsync({ kind: "delete", id: "1" });
    for (const [req] of request.mock.calls) {
      expect(req).toEqual(expect.objectContaining({ timeoutMs: 120_000, signal }));
    }
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("applies timeoutMs to rpc calls from a custom function", async () => {
    const { request, resource } = setup();
    const controller = createMutation({
      resource,
      fn: async (vars: { id: string }, ctx) => ctx.resource.rpc("generate", vars),
      invalidate: vi.fn(),
      options: { timeoutMs: 180_000 },
    });
    await controller.mutateAsync({ id: "e1" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/todos/rpc/generate", timeoutMs: 180_000 })
    );
  });

  it("a per-call option wins over the mutation's", async () => {
    const { request, resource } = setup();
    const controller = createMutation({
      resource,
      fn: async (_vars: void, ctx) => ctx.resource.rpc("generate", {}, { timeoutMs: 5_000 }),
      invalidate: vi.fn(),
      options: { timeoutMs: 180_000 },
    });
    await controller.mutateAsync();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
  });

  it("reads the options at call time", async () => {
    const { request, resource } = setup();
    const options: { timeoutMs?: number } = {};
    const controller = createMutation({
      resource,
      fn: async (_vars: void, ctx) => ctx.resource.rpc("generate", {}),
      invalidate: vi.fn(),
      options,
    });
    await controller.mutateAsync();
    options.timeoutMs = 90_000;
    await controller.mutateAsync();
    expect("timeoutMs" in (request.mock.calls[0]![0] as object)).toBe(false);
    expect(request.mock.calls[1]![0]).toEqual(expect.objectContaining({ timeoutMs: 90_000 }));
  });

  it("other resource methods still work through the context", async () => {
    const { request, resource } = setup();
    const controller = createMutation({
      resource,
      fn: async (_vars: void, ctx) => ctx.resource.get("1"),
      invalidate: vi.fn(),
      options: { timeoutMs: 90_000 },
    });
    await expect(controller.mutateAsync()).resolves.toEqual({ id: "1", title: "t" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/api/todos/1" }));
  });

  it("a timeout surfaces as the mutation error", async () => {
    vi.stubGlobal("fetch", slowFetch(80));
    const transport = new FetchTransport({ baseUrl: "http://localhost", timeout: 5000 });
    const resource = new Repository<Todo>({ transport, resourcePath: "/api/exams" });
    const onError = vi.fn();
    const controller = createMutation({
      resource,
      fn: async (_vars: void, ctx) => ctx.resource.rpc("generate", {}),
      invalidate: vi.fn(),
      options: { timeoutMs: 10, onError },
    });
    await expect(controller.mutateAsync()).rejects.toBeDefined();
    expect(controller.getSnapshot().status).toBe("error");
    expect(onError).toHaveBeenCalled();
  });
});
