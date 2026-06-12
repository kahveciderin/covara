import { describe, it, expect, beforeEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createCovara } from "@/server/app";
import { recordCreate } from "@/resource/changelog";
import { clearSchemaRegistry, getAllResourcesForDisplay } from "@/ui/schema-registry";
import {
  createSubscription,
  registerHandler,
  disconnectSubscription,
  getSubscription,
  listActiveSubscriptions,
  pushInsertsToSubscriptions,
  clearAllSubscriptions,
} from "@/resource/subscription";
import { createResourceFilter } from "@/resource/filter";
import type { SSEWriter } from "@/server/sse";

const makeWriter = (): SSEWriter & { wasClosed: () => boolean } => {
  let closed = false;
  const closeCallbacks: (() => void)[] = [];
  const writer = {
    write: () => true,
    get closed() {
      return closed;
    },
    bufferedBytes: 0,
    backpressured: false,
    close: () => {
      closed = true;
      for (const cb of closeCallbacks.splice(0)) cb();
    },
    onClose: (cb: () => void) => {
      closeCallbacks.push(cb);
    },
    wasClosed: () => closed,
  };
  return writer as unknown as SSEWriter & { wasClosed: () => boolean };
};

// Regression: createCovara must auto-feed the admin dashboard from real traffic
// (requests/errors) and wire the live subscription/changelog data sources, so
// the dashboard isn't empty out of the box.
describe("Admin dashboard auto-wiring", () => {
  it("logs real (non-admin) requests for the dashboard", async () => {
    const app = createCovara({ adminUI: true });
    app.get("/api/ping", (c) => c.json({ ok: true }));
    app.get("/api/boom", () => {
      throw new Error("kaboom");
    });

    await app.request("http://localhost/api/ping");
    await app.request("http://localhost/api/ping?x=1");
    await app.request("http://localhost/api/boom");

    const res = await app.request("http://localhost/__covara/api/requests");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<{ path: string; status: number }> };

    expect(body.requests.length).toBeGreaterThanOrEqual(3);
    expect(body.requests.some((r) => r.path === "/api/ping")).toBe(true);
    // The admin UI's own routes are not logged (no self-noise).
    expect(body.requests.some((r) => r.path.startsWith("/__covara"))).toBe(false);

    // The 500 was captured as an error too.
    const errs = await app.request("http://localhost/__covara/api/errors");
    const errBody = (await errs.json()) as { errors: Array<{ path: string }> };
    expect(errBody.errors.some((e) => e.path === "/api/boom")).toBe(true);
  });

  it("renders the dashboard with auto-wired subscriptions + changelog (no 500)", async () => {
    const app = createCovara({ adminUI: true });
    const res = await app.request("http://localhost/__covara/ui");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Dashboard");
  });

  it("renders changelog entries with operation and record ID (shape normalization)", async () => {
    const app = createCovara({ adminUI: true });
    await recordCreate("wiring_todos", "record-123", { id: "record-123", title: "x" });

    const res = await app.request("http://localhost/__covara/ui/changelog");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("record-123");
    expect(html).toContain("create");
    // Stats must classify the entry, not leave creates at 0.
    expect(html).not.toContain("badge-undefined");
  });

  it("records and renders the acting user on changelog entries", async () => {
    const app = createCovara({ adminUI: true });
    const entry = await recordCreate(
      "wiring_todos",
      "record-456",
      { id: "record-456" },
      "acting-user-789"
    );
    expect(entry.userId).toBe("acting-user-789");

    const res = await app.request(
      `http://localhost/__covara/ui/changelog/${entry.seq}`,
      { headers: { "hx-request": "true" } }
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("acting-user-789");
  });
});

describe("Admin subscription disconnect", () => {
  beforeEach(async () => {
    await clearAllSubscriptions();
  });

  it("DELETE /api/subscriptions/:id disconnects a locally-connected subscription", async () => {
    const app = createCovara({ adminUI: true });
    const writer = makeWriter();
    registerHandler("wiring-handler", writer);
    const subId = await createSubscription({
      resource: "wiring_res",
      filter: "",
      handlerId: "wiring-handler",
      authId: null,
    });

    // The new subscription ID embeds the resource after a colon.
    expect(subId).toContain(":wiring_res");

    const res = await app.request(
      `http://localhost/__covara/api/subscriptions/${subId}`,
      { method: "DELETE" }
    );
    expect(res.status).toBe(204);
    expect(writer.wasClosed()).toBe(true);
  });

  it("404s for an unknown subscription", async () => {
    const app = createCovara({ adminUI: true });
    const res = await app.request(
      "http://localhost/__covara/api/subscriptions/00000000-0000-0000-0000-000000000000:nope",
      { method: "DELETE" }
    );
    expect(res.status).toBe(404);
  });

  it("disconnectSubscription removes the record when the handler is not local", async () => {
    const subId = await createSubscription({
      resource: "wiring_remote",
      filter: "",
      handlerId: "not-a-local-handler",
      authId: null,
    });

    expect(await disconnectSubscription(subId)).toBe(true);
    expect(await getSubscription(subId)).toBeUndefined();
  });
});

describe("Subscription event counters", () => {
  beforeEach(async () => {
    await clearAllSubscriptions();
  });

  it("listActiveSubscriptions reports delivered event count and last event time", async () => {
    registerHandler("counter-handler", makeWriter());
    await createSubscription({
      resource: "counter_res",
      filter: "",
      handlerId: "counter-handler",
      authId: null,
    });

    const filterer = createResourceFilter(
      sqliteTable("counter_res", { id: text("id").primaryKey() }),
      {}
    );
    await pushInsertsToSubscriptions("counter_res", filterer, [{ id: "1" }], "id");
    await pushInsertsToSubscriptions("counter_res", filterer, [{ id: "2" }], "id");

    const [info] = await listActiveSubscriptions();
    expect(info.eventCount).toBe(2);
    expect(info.lastEventAt).toBeDefined();
    await clearAllSubscriptions();
  });
});

describe("Eager mount path registration", () => {
  beforeEach(() => {
    clearSchemaRegistry();
  });

  it("createCovara().resource() registers the full mount path before any request", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const table = sqliteTable("eager_items", { id: text("id").primaryKey() });

    createCovara().resource("/eager_items", table, { id: table.id, db });

    const display = getAllResourcesForDisplay().find((r) => r.name === "eager_items");
    expect(display?.mountPath).toBe("/api/eager_items");
    sqlite.close();
    clearSchemaRegistry();
  });
});
