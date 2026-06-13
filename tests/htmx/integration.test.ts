import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { jsx } from "hono/jsx";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createCovara } from "@/server/app";
import { Live, LiveAggregate } from "@/htmx/live";
import type { RegionContext } from "@/htmx/context";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { clearAllSubscriptions } from "@/resource/subscription";
import { changelog } from "@/resource/changelog";

const todos = sqliteTable("todos", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => globalThis.crypto.randomUUID()),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
});

type Todo = { id: string; title: string; done: boolean };

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let app: ReturnType<typeof createCovara>;
let kv: KVAdapter;

const todoRow = (t: Todo, c: RegionContext) =>
  jsx("li", c.row(t.id), [
    t.title,
    jsx("button", c.delete(t.id), "x"),
  ]);

const todoPage = () =>
  jsx("div", null, [
    jsx("h1", null, "Todos"),
    jsx(Live, {
      resource: todos,
      query: { orderBy: "title" },
      create: (c: RegionContext) =>
        jsx("form", c.create(), [jsx("input", { name: "title" }), jsx("button", null, "Add")]),
      container: (rows: unknown, c: RegionContext) => jsx("ul", c.container(), rows),
      render: todoRow,
    }),
  ]);

const activePage = () =>
  jsx(Live, {
    resource: todos,
    query: { filter: "done==false" },
    container: (rows: unknown, c: RegionContext) => jsx("ul", c.container(), rows),
    render: todoRow,
  });

const statsPage = () =>
  jsx(LiveAggregate, {
    resource: todos,
    groupBy: ["done"],
    render: (data: unknown) => {
      const groups = (data as { groups?: unknown[] })?.groups ?? [];
      return jsx("span", null, `${groups.length} groups`);
    },
  });

// Continuously pump an SSE stream into a buffer. A racing read+timeout would
// leave a dangling read() that swallows the next chunk, so use one read loop.
const pumpSSE = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const decoder = new TextDecoder();
  const state = { text: "" };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.text += decoder.decode(value, { stream: true });
      }
    } catch {
      // stream cancelled
    }
  })();
  return state;
};

const waitFor = async (predicate: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

const seed = async (id: string, title: string, done = false) => {
  const res = await app.request("/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, title, done }),
  });
  expect(res.status).toBe(201);
};

describe("htmx page integration", () => {
  beforeAll(async () => {
    kv = createMemoryKV("htmx-integration");
    await kv.connect();
    setGlobalKV(kv);

    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0
      );
    `);

    app = createCovara({
      middleware: [
        async (c, next) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c as any).set("user", { id: "tester", email: null, name: null });
          await next();
        },
      ],
    })
      .resource("/todos", todos, { id: todos.id, db })
      .page("/todos", todoPage)
      .page("/active", activePage)
      .page("/stats", statsPage);
  });

  afterAll(async () => {
    await kv.disconnect();
    sqlite.close();
  });

  beforeEach(async () => {
    sqlite.exec("DELETE FROM todos;");
    await clearAllSubscriptions();
    await changelog.clear();
  });

  it("SSRs the page shell + rows via the page's own closures", async () => {
    await seed("1", "alpha");
    await seed("2", "beta");

    const res = await app.request("/todos");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("<h1>Todos</h1>");
    expect(html).toContain('hx-post="/__covara/live/todos-0"');
    expect(html).toContain('id="cv-todos-0-list"');
    expect(html).toContain('<li id="cv-todos-0-1" data-covara-id="1">alpha');
    expect(html).toContain('<li id="cv-todos-0-2" data-covara-id="2">beta');
    // delete button wired to the generated endpoint
    expect(html).toContain('hx-delete="/__covara/live/todos-0/1"');
    // runtime script injected
    expect(html).toContain('/__covara/live/_runtime.js');
    expect(html).not.toContain("cv-region:");
  });

  it("serves the generated list fragment", async () => {
    await seed("1", "alpha");
    const res = await app.request("/__covara/live/todos-0");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<li id="cv-todos-0-1" data-covara-id="1">alpha');
    expect(html).not.toContain("<h1>"); // fragment only, no shell
  });

  it("creates via the generated endpoint and returns the rendered row", async () => {
    const res = await app.request("/__covara/live/todos-0", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=gamma",
    });
    expect(res.status).toBe(201);
    const html = await res.text();
    expect(html).toMatch(/<li id="cv-todos-0-[^"]+" data-covara-id="[^"]+">gamma/);
    // actually persisted
    const list = await (await app.request("/api/todos")).json();
    expect(list.items.map((t: Todo) => t.title)).toContain("gamma");
  });

  it("updates and returns the row, or removes it when it leaves the region filter", async () => {
    await seed("1", "alpha", false);

    // /active region filters done==false. Mark done -> should leave the filter
    // -> endpoint returns empty (the outerHTML swap removes the row).
    const res = await app.request("/__covara/live/active-0/1", {
      method: "PATCH",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "done=on",
    });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");

    // The same update through an unfiltered region returns the rendered row.
    await app.request("/__covara/live/todos-0/1", {
      method: "PATCH",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=alpha2",
    });
    const row = await (await app.request("/__covara/live/todos-0/1", {
      method: "PATCH",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "title=alpha3",
    })).text();
    expect(row).toContain("alpha3");
  });

  it("deletes via the generated endpoint", async () => {
    await seed("1", "alpha");
    const res = await app.request("/__covara/live/todos-0/1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
    const list = await (await app.request("/api/todos")).json();
    expect(list.items).toHaveLength(0);
  });

  it("serves the client runtime bundle", async () => {
    const res = await app.request("/__covara/live/_runtime.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js).toContain("data-cv-sse");
    expect(js).toContain("EventSource");
    expect(js).toContain("var htmx"); // vendored core included
  });

  it("404s an unknown region", async () => {
    const res = await app.request("/__covara/live/nope-9");
    expect(res.status).toBe(404);
  });

  it("SSRs a LiveAggregate region and serves its fragment", async () => {
    await seed("1", "alpha", true);
    await seed("2", "beta", false);

    const page = await (await app.request("/stats")).text();
    expect(page).toContain('data-cv-sse="/__covara/live/stats-0/subscribe"');
    expect(page).toContain("2 groups"); // grouped by done -> {true,false}

    const fragment = await (await app.request("/__covara/live/stats-0")).text();
    expect(fragment).toContain("2 groups");
  });

  it("invalidates an aggregate region's SSE when the resource changes", async () => {
    const subRes = await app.request("/__covara/live/stats-0/subscribe");
    expect(subRes.status).toBe(200);
    const buf = pumpSSE(subRes.body!.getReader());
    await waitFor(() => buf.text.includes("event: connected"), 500);

    await app.request("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    await waitFor(() => buf.text.includes("event: invalidate"), 1500);
    expect(buf.text).toContain("event: invalidate");
  });

  it("streams server-rendered HTML fragments over the generated SSE endpoint", async () => {
    const subRes = await app.request("/__covara/live/todos-0/subscribe");
    expect(subRes.status).toBe(200);
    expect(subRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = subRes.body!.getReader();
    const buf = pumpSSE(reader);

    await waitFor(() => buf.text.includes("event: connected"), 500);
    expect(buf.text).toContain("event: connected");

    // A mutation on the resource pushes a server-rendered row over the stream.
    const created = await app.request("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "live-row" }),
    });
    const createdId = (await created.json()).id as string;

    await waitFor(() => buf.text.includes("event: added"), 1500);
    expect(buf.text).toContain("event: added");
    expect(buf.text).toContain("live-row");
    expect(buf.text).toContain(`data-covara-id="${createdId}"`);

    // Deleting it pushes a "removed" frame carrying the row's DOM id.
    await app.request(`/api/todos/${createdId}`, { method: "DELETE" });
    await waitFor(() => buf.text.includes("event: removed"), 1500);
    expect(buf.text).toContain("event: removed");
    expect(buf.text).toContain(`cv-todos-0-${createdId}`);

    await reader.cancel();
  });
});
