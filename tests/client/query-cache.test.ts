import { describe, it, expect, vi } from "vitest";
import { LiveQueryCache } from "../../src/client/query-cache";
import {
  LiveListResourceClient,
  PaginatedResponse,
  Subscription,
  SubscriptionCallbacks,
} from "../../src/client/types";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

const mockSubscription: Subscription<Todo> = {
  state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
  items: [],
  unsubscribe: vi.fn(),
  reconnect: vi.fn(),
};

const createMockRepo = (
  pages: Todo[][]
): LiveListResourceClient<Todo> & { listCount: () => number } => {
  let listCalls = 0;
  let callbacks: SubscriptionCallbacks<Todo> | undefined;
  return {
    listCount: () => listCalls,
    async list(options): Promise<PaginatedResponse<Todo>> {
      listCalls += 1;
      // Cursor "1" -> page index 1, else page 0
      const idx = options?.cursor ? Number(options.cursor) : 0;
      const items = pages[idx] ?? [];
      const hasMore = idx + 1 < pages.length;
      return {
        items,
        nextCursor: hasMore ? String(idx + 1) : null,
        hasMore,
        totalCount: pages.flat().length,
      };
    },
    async create(data) {
      return { ...data, id: "new" } as Todo;
    },
    async update(id, data) {
      return { ...data, id } as Todo;
    },
    async delete() {},
    subscribe(_options, cbs) {
      callbacks = cbs;
      void callbacks;
      return mockSubscription;
    },
  };
};

const flush = () => new Promise((r) => setTimeout(r, 15));

describe("LiveQueryCache", () => {
  it("dedupes identical queries via ref-counting", async () => {
    const repo = createMockRepo([[{ id: "1", title: "A", completed: false }]]);
    const cache = new LiveQueryCache<Todo>({ resolveRepo: () => repo });

    const q1 = cache.acquire<Todo>("/api/todos", { filter: "completed==false" });
    const q2 = cache.acquire<Todo>("/api/todos", { filter: "completed==false" });

    expect(q1).toBe(q2);
    expect(cache.size()).toBe(1);

    cache.release("/api/todos", { filter: "completed==false" });
    expect(cache.size()).toBe(1); // still one holder
    cache.release("/api/todos", { filter: "completed==false" });
    expect(cache.size()).toBe(0); // destroyed
  });

  it("invalidate triggers refetch of matching stores", async () => {
    const repo = createMockRepo([[{ id: "1", title: "A", completed: false }]]);
    const cache = new LiveQueryCache<Todo>({ resolveRepo: () => repo });

    cache.acquire<Todo>("/api/todos", {});
    cache.acquire<Todo>("/api/users", {});
    await flush();

    const before = repo.listCount();
    const count = cache.invalidate("/api/todos");
    await flush();

    expect(count).toBe(1); // only the todos store matched
    expect(repo.listCount()).toBe(before + 1); // a refetch happened
  });

  it("invalidate by predicate matches on options", async () => {
    const repo = createMockRepo([[]]);
    const cache = new LiveQueryCache<Todo>({ resolveRepo: () => repo });

    cache.acquire<Todo>("/api/todos", { filter: "completed==true" });
    cache.acquire<Todo>("/api/todos", { filter: "completed==false" });
    await flush();

    const count = cache.invalidate((path, options) => options.filter === "completed==true");
    expect(count).toBe(1);
  });

  it("prefetch populates cache so a subsequent acquire reads immediately", async () => {
    const repo = createMockRepo([[{ id: "1", title: "A", completed: false }]]);
    const cache = new LiveQueryCache<Todo>({ resolveRepo: () => repo });

    await cache.prefetch<Todo>("/api/todos", {});
    expect(cache.has("/api/todos", {})).toBe(true);

    // Acquire reuses the warmed query; snapshot already has the data
    const query = cache.acquire<Todo>("/api/todos", {});
    const snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("1");
    expect(snapshot.status).toBe("live");
  });
});

describe("Infinite query accumulation (loadMore)", () => {
  it("accumulates pages and flips hasMore via the shared store", async () => {
    const page0 = [
      { id: "1", title: "T1", completed: false },
      { id: "2", title: "T2", completed: false },
    ];
    const page1 = [
      { id: "3", title: "T3", completed: false },
      { id: "4", title: "T4", completed: false },
    ];
    const repo = createMockRepo([page0, page1]);
    const cache = new LiveQueryCache<Todo>({ resolveRepo: () => repo });

    const query = cache.acquire<Todo>("/api/todos", { limit: 2, subscriptionMode: "strict" });
    await flush();

    let snap = query.getSnapshot();
    expect(snap.items).toHaveLength(2);
    expect(snap.hasMore).toBe(true);

    await query.loadMore();
    snap = query.getSnapshot();

    // Pages accumulated
    expect(snap.items).toHaveLength(4);
    expect(snap.items.map((i) => i.id).sort()).toEqual(["1", "2", "3", "4"]);
    // No more pages
    expect(snap.hasMore).toBe(false);

    query.destroy();
  });
});
