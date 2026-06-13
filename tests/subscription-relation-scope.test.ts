import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createCovara } from "@/server/app";
import { rsql } from "@/auth/rsql";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { clearAllSubscriptions } from "@/resource/subscription";
import { changelog } from "@/resource/changelog";

// Posts are public; comments are read-scoped to their owner. A post hasMany
// comments. When comments are embedded in a posts subscription event, each
// subscriber must only see THEIR OWN comments — the included relation honors
// the target resource's read scope per-subscriber.
const posts = sqliteTable("posts", { id: text("id").primaryKey(), title: text("title").notNull() });
const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  postId: text("postId").notNull(),
  userId: text("userId").notNull(),
  body: text("body").notNull(),
});

let sqlite: Database.Database;
let app: ReturnType<typeof createCovara>;
let kv: KVAdapter;

const pump = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const dec = new TextDecoder();
  const state = { text: "" };
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.text += dec.decode(value, { stream: true });
      }
    } catch {
      /* cancelled */
    }
  })();
  return state;
};
const waitFor = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};
// Parse all `data: {json}` SSE frames and return the post event for `postId`.
const postEvent = (buf: string, postId: string, type: string) =>
  buf
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .find((e) => e && e.type === type && e.object && e.object.id === postId);

describe("subscription relation scope (per-subscriber)", () => {
  beforeAll(async () => {
    kv = createMemoryKV("rel-scope");
    await kv.connect();
    setGlobalKV(kv);
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE comments (id TEXT PRIMARY KEY, postId TEXT NOT NULL, userId TEXT NOT NULL, body TEXT NOT NULL);
    `);
    const db = drizzle(sqlite);

    app = createCovara({
      middleware: [
        async (c, next) => {
          const uid = c.req.header("x-user");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (uid) (c as any).set("user", { id: uid, sessionExpiresAt: new Date(Date.now() + 1e6) });
          await next();
        },
      ],
    })
      .resource("/posts", posts, {
        id: posts.id,
        db,
        auth: { public: { read: true, subscribe: true } },
        relations: {
          comments: {
            resource: "comments",
            schema: comments,
            type: "hasMany",
            foreignKey: comments.postId,
            references: posts.id,
          },
        },
      })
      .resource("/comments", comments, {
        id: comments.id,
        db,
        auth: {
          read: async (u) => rsql`userId==${u?.id}`,
          subscribe: async (u) => rsql`userId==${u?.id}`,
        },
      });
  });

  afterAll(async () => {
    await kv.disconnect();
    sqlite.close();
  });

  beforeEach(async () => {
    sqlite.exec("DELETE FROM posts; DELETE FROM comments;");
    await clearAllSubscriptions();
    await changelog.clear();
    sqlite.prepare("INSERT INTO posts (id,title) VALUES (?,?)").run("p1", "hello");
    sqlite.prepare("INSERT INTO comments (id,postId,userId,body) VALUES (?,?,?,?)").run("c-a", "p1", "alice", "from alice");
    sqlite.prepare("INSERT INTO comments (id,postId,userId,body) VALUES (?,?,?,?)").run("c-b", "p1", "bob", "from bob");
  });

  const subscribe = (user: string) =>
    app.request("/api/posts/subscribe?include=comments", { headers: { "x-user": user } });

  it("embeds only the subscriber's own comments in subscription events", async () => {
    const subA = await subscribe("alice");
    const subB = await subscribe("bob");
    expect(subA.status).toBe(200);
    expect(subB.status).toBe(200);
    const a = pump(subA.body!.getReader());
    const b = pump(subB.body!.getReader());
    await waitFor(() => a.text.includes("event: connected") && b.text.includes("event: connected"), 500);

    // Mutate the post -> both subscribers get a `changed` event whose embedded
    // `comments` is scoped to each subscriber.
    await app.request("/api/posts/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": "alice" },
      body: JSON.stringify({ title: "hello!" }),
    });

    await waitFor(() => !!postEvent(a.text, "p1", "changed") && !!postEvent(b.text, "p1", "changed"), 1500);

    const aEvent = postEvent(a.text, "p1", "changed");
    const bEvent = postEvent(b.text, "p1", "changed");
    const aComments = (aEvent.object.comments as { id: string }[]).map((c) => c.id);
    const bComments = (bEvent.object.comments as { id: string }[]).map((c) => c.id);

    expect(aComments).toEqual(["c-a"]); // alice sees only her comment
    expect(bComments).toEqual(["c-b"]); // bob sees only his
    expect(aComments).not.toContain("c-b");
    expect(bComments).not.toContain("c-a");
  });

  it("yields no comments to a subscriber denied read on the target", async () => {
    // 'carol' owns no comments -> her embedded relation is empty (deny semantics).
    const sub = await subscribe("carol");
    const c = pump(sub.body!.getReader());
    await waitFor(() => c.text.includes("event: connected"), 500);
    await app.request("/api/posts/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-user": "carol" },
      body: JSON.stringify({ title: "again" }),
    });
    await waitFor(() => !!postEvent(c.text, "p1", "changed"), 1500);
    const ev = postEvent(c.text, "p1", "changed");
    expect(ev.object.comments).toEqual([]);
  });
});
