// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { render, act, cleanup } from "@testing-library/react";

// Fake client whose queryCache returns a distinct live query per filter, so we
// can assert the hook re-binds to the new query when `filter` changes at runtime.
const h = vi.hoisted(() => {
  interface LQState {
    items: { id: string }[];
    status: string;
    error: null;
    pendingCount: number;
    lastSeq: number;
    hasMore: boolean;
    totalCount: undefined;
    isLoadingMore: boolean;
  }
  const makeLQ = (items: { id: string }[]) => {
    const state: LQState = {
      items,
      status: "live",
      error: null,
      pendingCount: 0,
      lastSeq: 0,
      hasMore: false,
      totalCount: undefined,
      isLoadingMore: false,
    };
    const listeners = new Set<() => void>();
    return {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getSnapshot: () => state,
      destroy: () => {},
      refresh: async () => {},
      loadMore: async () => {},
      mutate: { create: () => {}, update: () => {}, delete: () => {} },
    };
  };

  const queries: Record<string, ReturnType<typeof makeLQ>> = {
    "": makeLQ([{ id: "1" }, { id: "2" }, { id: "3" }]),
    'status=="active"': makeLQ([{ id: "2" }]),
  };

  const client = {
    resource: () => ({}),
    getPendingCount: async () => 0,
    queryCache: {
      acquire: (_path: string, opts: { filter?: string }) =>
        queries[opts.filter ?? ""] ?? makeLQ([]),
      release: () => {},
    },
  };

  return { client };
});

vi.mock("@/client/globals", () => ({
  getClient: () => h.client,
  getAuthErrorHandler: () => null,
}));

import { useLiveList } from "@/client/react";

const List = ({ filter }: { filter: string }) => {
  const { items } = useLiveList<{ id: string }>("/api/things", { filter });
  return createElement("div", { "data-testid": "ids" }, items.map((i) => i.id).join(","));
};

describe("useLiveList runtime option changes", () => {
  it("re-binds to the new query when filter changes (does not freeze on the old one)", () => {
    const { container, rerender } = render(createElement(List, { filter: "" }));
    const read = () => container.querySelector('[data-testid="ids"]')?.textContent;

    expect(read()).toBe("1,2,3");

    // Change the filter at runtime — the returned items must reflect the new query.
    act(() => {
      rerender(createElement(List, { filter: 'status=="active"' }));
    });
    expect(read()).toBe("2");

    // And back to the default → all rows again (not stuck blank).
    act(() => {
      rerender(createElement(List, { filter: "" }));
    });
    expect(read()).toBe("1,2,3");

    cleanup();
  });
});
