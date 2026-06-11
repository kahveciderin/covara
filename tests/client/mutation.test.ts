import { describe, it, expect, vi } from "vitest";
import { createMutation, resourceMutationFn } from "../../src/client/mutation";
import { OfflineManager, InMemoryOfflineStorage } from "../../src/client/offline";
import { Repository } from "../../src/client/repository";
import type { ResourceClient } from "../../src/client/types";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

const makeMockResource = (overrides: Partial<ResourceClient<Todo>> = {}): ResourceClient<Todo> =>
  ({
    list: vi.fn(),
    get: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    search: vi.fn(),
    create: vi.fn(async (data) => ({ ...data, id: "srv-1" }) as Todo),
    update: vi.fn(async (id, data) => ({ ...data, id }) as Todo),
    replace: vi.fn(async (id, data) => ({ ...data, id }) as Todo),
    delete: vi.fn(async () => {}),
    batchCreate: vi.fn(),
    batchUpdate: vi.fn(),
    batchDelete: vi.fn(),
    subscribe: vi.fn(),
    rpc: vi.fn(),
    query: vi.fn(),
    ...overrides,
  }) as unknown as ResourceClient<Todo>;

describe("createMutation (standalone)", () => {
  it("tracks status through success and exposes data", async () => {
    const resource = makeMockResource();
    const invalidate = vi.fn();
    const controller = createMutation({
      resource,
      fn: resourceMutationFn<Todo>(),
      invalidate,
    });

    expect(controller.getSnapshot().status).toBe("idle");

    const promise = controller.mutateAsync({ kind: "create", data: { title: "New", completed: false } });
    expect(controller.getSnapshot().status).toBe("loading");

    const result = await promise;
    expect((result as Todo).id).toBe("srv-1");
    expect(controller.getSnapshot().status).toBe("success");
    expect(controller.getSnapshot().data).toEqual({ id: "srv-1", title: "New", completed: false });
  });

  it("fires onSuccess and invalidates after success", async () => {
    const resource = makeMockResource();
    const invalidate = vi.fn();
    const onSuccess = vi.fn();

    const controller = createMutation({
      resource,
      fn: resourceMutationFn<Todo>(),
      invalidate,
      options: { onSuccess, invalidates: ["/api/todos", "/api/stats"] },
    });

    await controller.mutateAsync({ kind: "update", id: "1", data: { completed: true } });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith("/api/todos");
    expect(invalidate).toHaveBeenCalledWith("/api/stats");
  });

  it("captures errors, fires onError, and does not invalidate", async () => {
    const resource = makeMockResource({
      update: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const invalidate = vi.fn();
    const onError = vi.fn();

    const controller = createMutation({
      resource,
      fn: resourceMutationFn<Todo>(),
      invalidate,
      options: { onError, invalidates: ["/api/todos"] },
    });

    await expect(
      controller.mutateAsync({ kind: "update", id: "1", data: { completed: true } })
    ).rejects.toThrow("boom");

    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().error?.message).toBe("boom");
    expect(onError).toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reset returns to idle", async () => {
    const resource = makeMockResource();
    const controller = createMutation({
      resource,
      fn: resourceMutationFn<Todo>(),
      invalidate: vi.fn(),
    });

    await controller.mutateAsync({ kind: "create", data: { title: "X", completed: false } });
    expect(controller.getSnapshot().status).toBe("success");

    controller.reset();
    expect(controller.getSnapshot().status).toBe("idle");
    expect(controller.getSnapshot().data).toBeUndefined();
  });

  it("integrates with optimistic updates + offline queue (rollback on failure)", async () => {
    // Transport that always fails the background create so the mutation queues offline.
    const mockTransport = {
      request: vi.fn().mockRejectedValue(new Error("network")),
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };
    const offline = new OfflineManager({
      config: { enabled: true, storage: new InMemoryOfflineStorage() },
    });
    const repository = new Repository<Todo>({
      transport: mockTransport as any,
      resourcePath: "/todos",
      offline,
    });

    const invalidate = vi.fn();
    const controller = createMutation({
      resource: repository,
      fn: resourceMutationFn<Todo>(),
      invalidate,
      options: { invalidates: ["/todos"] },
    });

    // Optimistic create returns immediately with an optimistic id
    const result = (await controller.mutateAsync({
      kind: "create",
      data: { title: "Offline Todo", completed: false },
    })) as Todo;

    expect(result.id).toContain("optimistic_");
    expect(controller.getSnapshot().status).toBe("success");
    // Invalidation still fires on the optimistic success path
    expect(invalidate).toHaveBeenCalledWith("/todos");

    // Background sync failed -> mutation rolled into the offline queue for retry
    await new Promise((r) => setTimeout(r, 10));
    const pending = await offline.getPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe("create");
    expect(pending[0].optimisticId).toBe(result.id);
  });
});
