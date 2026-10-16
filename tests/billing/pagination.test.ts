import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStripeAdapter } from "@/billing/stripe";
import { createPaddleAdapter } from "@/billing/paddle";
import { createPolarAdapter } from "@/billing/polar";
import { createLemonSqueezyAdapter } from "@/billing/lemonsqueezy";
import { BillingError } from "@/billing/types";

const calls: string[] = [];
let responses: Array<{ status: number; body: unknown }> = [];

const mockFetch = vi.fn(async (url: string) => {
  calls.push(url);
  const next = responses.shift() ?? { status: 200, body: {} };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    text: async () => JSON.stringify(next.body),
  } as Response;
});

const queue = (body: unknown, status = 200): void => {
  responses.push({ status, body });
};

beforeEach(() => {
  calls.length = 0;
  responses = [];
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockClear();
});

const stripeSub = (id: string, customer = "cus_1") => ({ id, customer, status: "active", items: { data: [] } });
const paddleSub = (id: string) => ({ id, customer_id: "ctm_1", status: "active", items: [] });
const polarSub = (id: string) => ({ id, customer_id: "cus_1", status: "active" });
const lsSub = (id: string) => ({
  type: "subscriptions",
  id,
  attributes: { customer_id: 7, variant_id: 1, status: "active" },
});

describe("Stripe pagination", () => {
  const adapter = createStripeAdapter({ apiKey: "sk" });

  it("listSubscriptions follows has_more with starting_after", async () => {
    queue({ data: [stripeSub("sub_1"), stripeSub("sub_2")], has_more: true });
    queue({ data: [stripeSub("sub_3")], has_more: false });
    const subs = await adapter.listSubscriptions("cus_1");
    expect(subs.map((s) => s.id)).toEqual(["sub_1", "sub_2", "sub_3"]);
    expect(calls[0]).toContain("customer=cus_1");
    expect(calls[0]).toContain("status=all");
    expect(calls[0]).not.toContain("starting_after");
    expect(calls[1]).toContain("starting_after=sub_2");
  });

  it("listAllSubscriptions returns one page with a cursor", async () => {
    queue({ data: [stripeSub("sub_1", "a"), stripeSub("sub_2", "b")], has_more: true });
    const page = await adapter.listAllSubscriptions!({ limit: 2 });
    expect(page.subscriptions).toHaveLength(2);
    expect(page.nextCursor).toBe("sub_2");
    expect(calls[0]).toContain("limit=2");
    expect(calls[0]).not.toContain("customer=");

    queue({ data: [stripeSub("sub_3")], has_more: false });
    const last = await adapter.listAllSubscriptions!({ cursor: page.nextCursor });
    expect(last.nextCursor).toBeUndefined();
    expect(calls[1]).toContain("starting_after=sub_2");
  });

  it("an empty page with has_more does not loop forever", async () => {
    queue({ data: [], has_more: true });
    expect(await adapter.listSubscriptions("cus_1")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("propagates rate-limit errors with their status", async () => {
    queue({ error: { message: "Too many requests" } }, 429);
    await expect(adapter.listSubscriptions("cus_1")).rejects.toMatchObject({ status: 429 });
    queue({ error: { message: "Too many requests" } }, 429);
    await expect(adapter.listSubscriptions("cus_1")).rejects.toBeInstanceOf(BillingError);
  });
});

describe("Paddle pagination", () => {
  const adapter = createPaddleAdapter({ apiKey: "pdl" });

  it("listSubscriptions follows meta.pagination.has_more with after=", async () => {
    queue({ data: [paddleSub("sub_1")], meta: { pagination: { has_more: true } } });
    queue({ data: [paddleSub("sub_2")], meta: { pagination: { has_more: false } } });
    const subs = await adapter.listSubscriptions("ctm_1");
    expect(subs.map((s) => s.id)).toEqual(["sub_1", "sub_2"]);
    expect(calls[0]).toContain("customer_id=ctm_1");
    expect(calls[1]).toContain("after=sub_1");
  });

  it("listAllSubscriptions pages without a customer filter", async () => {
    queue({ data: [paddleSub("sub_1")], meta: { pagination: { has_more: true } } });
    const page = await adapter.listAllSubscriptions!();
    expect(page.nextCursor).toBe("sub_1");
    expect(calls[0]).not.toContain("customer_id");
  });
});

describe("Polar pagination", () => {
  const adapter = createPolarAdapter({ accessToken: "pat" });

  it("listSubscriptions walks page numbers up to max_page", async () => {
    queue({ items: [polarSub("sub_1")], pagination: { total_count: 3, max_page: 3 } });
    queue({ items: [polarSub("sub_2")], pagination: { total_count: 3, max_page: 3 } });
    queue({ items: [polarSub("sub_3")], pagination: { total_count: 3, max_page: 3 } });
    const subs = await adapter.listSubscriptions("cus_1");
    expect(subs.map((s) => s.id)).toEqual(["sub_1", "sub_2", "sub_3"]);
    expect(calls[0]).toContain("customer_id=cus_1");
    expect(calls[0]).toContain("page=1");
    expect(calls[2]).toContain("page=3");
  });

  it("listAllSubscriptions returns a numeric page cursor", async () => {
    queue({ items: [polarSub("sub_1")], pagination: { max_page: 2 } });
    const page = await adapter.listAllSubscriptions!();
    expect(page.nextCursor).toBe("2");
  });
});

describe("Lemon Squeezy pagination", () => {
  const adapter = createLemonSqueezyAdapter({ apiKey: "ls", storeId: 42 });

  it("listSubscriptions walks page[number] up to lastPage", async () => {
    queue({ data: [lsSub("sub_1")], meta: { page: { currentPage: 1, lastPage: 2 } } });
    queue({ data: [lsSub("sub_2")], meta: { page: { currentPage: 2, lastPage: 2 } } });
    const subs = await adapter.listSubscriptions("7");
    expect(subs.map((s) => s.id)).toEqual(["sub_1", "sub_2"]);
    expect(calls[0]).toContain("filter[customer_id]=7");
    expect(calls[1]).toContain("page[number]=2");
  });

  it("listAllSubscriptions scopes to the store", async () => {
    queue({ data: [lsSub("sub_1")], meta: { page: { currentPage: 1, lastPage: 1 } } });
    const page = await adapter.listAllSubscriptions!();
    expect(page.nextCursor).toBeUndefined();
    expect(calls[0]).toContain("filter[store_id]=42");
  });
});
