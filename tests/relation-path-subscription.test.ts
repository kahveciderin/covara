import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { createCovara } from "@/server/app";
import { rsql } from "@/auth/rsql";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { clearAllSubscriptions } from "@/resource/subscription";
import { changelog } from "@/resource/changelog";

// Same org/member/machine shape as the read-path tests, but exercised over SSE.
// A relation-path subscribe scope can't be matched against changelog rows in
// memory, so live matching is skipped and the periodic scope recheck (running the
// join as SQL) reconciles the subscriber's view.
const organizations = sqliteTable("rps_organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const organizationMembers = sqliteTable("rps_organization_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
});
const machines = sqliteTable("rps_machines", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
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

const events = (buf: string) =>
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
    .filter(Boolean) as Array<{ type: string; object?: { id: string } }>;

const idsOfType = (buf: string, type: string) =>
  events(buf)
    .filter((e) => e.type === type && e.object)
    .map((e) => e.object!.id)
    .sort();

describe("relation-path subscribe scopes", () => {
  beforeAll(async () => {
    kv = createMemoryKV("rel-path-sub");
    await kv.connect();
    setGlobalKV(kv);
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE rps_organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE rps_organization_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL);
      CREATE TABLE rps_machines (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    `);
    const db = drizzle(sqlite);

    app = createCovara({
      middleware: [
        async (c, next) => {
          const uid = c.req.header("x-user");
          if (uid)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c as any).set("user", {
              id: uid,
              sessionExpiresAt: new Date(Date.now() + 1e6),
            });
          await next();
        },
      ],
    })
      .resource("/organizations", organizations, {
        id: organizations.id,
        db,
        auth: { public: { read: true, subscribe: true } },
        relations: {
          members: {
            resource: "rps_organization_members",
            schema: organizationMembers,
            type: "hasMany",
            foreignKey: organizationMembers.organizationId,
            references: organizations.id,
          },
        },
      })
      .resource("/machines", machines, {
        id: machines.id,
        db,
        // Short recheck so the eventual reconciliation is observable in-test.
        sse: { scopeRecheckMs: 80 },
        auth: {
          read: async (u) => rsql`organization.members.userId==${u?.id}`,
          subscribe: async (u) => rsql`organization.members.userId==${u?.id}`,
        },
        relations: {
          organization: {
            resource: "rps_organizations",
            schema: organizations,
            type: "belongsTo",
            foreignKey: machines.organizationId,
            references: organizations.id,
          },
        },
      });
  });

  afterAll(async () => {
    await kv.disconnect();
    sqlite.close();
  });

  beforeEach(async () => {
    sqlite.exec(
      "DELETE FROM rps_organizations; DELETE FROM rps_organization_members; DELETE FROM rps_machines;"
    );
    await clearAllSubscriptions();
    await changelog.clear();
    sqlite
      .prepare("INSERT INTO rps_organizations (id,name) VALUES (?,?)")
      .run("org1", "Org One");
    sqlite
      .prepare("INSERT INTO rps_organizations (id,name) VALUES (?,?)")
      .run("org2", "Org Two");
    sqlite
      .prepare(
        "INSERT INTO rps_organization_members (id,organization_id,user_id) VALUES (?,?,?)"
      )
      .run("m-alice", "org1", "alice");
    for (const [id, org] of [
      ["mac1", "org1"],
      ["mac2", "org1"],
      ["mac3", "org2"],
    ]) {
      sqlite
        .prepare("INSERT INTO rps_machines (id,organization_id,name) VALUES (?,?,?)")
        .run(id, org, id);
    }
  });

  it("delivers only the member's org machines as existing events", async () => {
    const sub = await app.request("/api/machines/subscribe", {
      headers: { "x-user": "alice" },
    });
    expect(sub.status).toBe(200);
    const a = pump(sub.body!.getReader());
    await waitFor(() => idsOfType(a.text, "existing").length >= 2, 1000);
    expect(idsOfType(a.text, "existing")).toEqual(["mac1", "mac2"]);
    expect(a.text).not.toContain("mac3");
  });

  it("gives a non-member nothing, then reconciles after they join (rescan)", async () => {
    const sub = await app.request("/api/machines/subscribe", {
      headers: { "x-user": "carol" },
    });
    expect(sub.status).toBe(200);
    const c = pump(sub.body!.getReader());
    await waitFor(() => c.text.includes("event: connected"), 500);
    // Carol is a member of nothing -> no existing machines.
    expect(idsOfType(c.text, "existing")).toEqual([]);

    // She joins org1 out of band. The live insert path is skipped for join
    // scopes; the scope recheck must surface mac1/mac2 as `added`.
    sqlite
      .prepare(
        "INSERT INTO rps_organization_members (id,organization_id,user_id) VALUES (?,?,?)"
      )
      .run("m-carol", "org1", "carol");

    await waitFor(() => idsOfType(c.text, "added").length >= 2, 2000);
    expect(idsOfType(c.text, "added")).toEqual(["mac1", "mac2"]);
  });

  it("rejects a join subscribe scope when the scope recheck is disabled", async () => {
    const sqlite2 = new Database(":memory:");
    sqlite2.exec(`
      CREATE TABLE rps_organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE rps_organization_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL);
      CREATE TABLE rps_machines (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    `);
    const db2 = drizzle(sqlite2);
    const app2 = createCovara({
      middleware: [
        async (c, next) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (c as any).set("user", {
            id: "alice",
            sessionExpiresAt: new Date(Date.now() + 1e6),
          });
          await next();
        },
      ],
    })
      .resource("/orgs2", organizations, {
        id: organizations.id,
        db: db2,
        auth: { public: { read: true, subscribe: true } },
        relations: {
          members: {
            resource: "rps_organization_members",
            schema: organizationMembers,
            type: "hasMany",
            foreignKey: organizationMembers.organizationId,
            references: organizations.id,
          },
        },
      })
      .resource("/machines2", machines, {
        id: machines.id,
        db: db2,
        sse: { scopeRecheckMs: 0 },
        auth: {
          subscribe: async (u) => rsql`organization.members.userId==${u?.id}`,
        },
        relations: {
          organization: {
            resource: "rps_organizations",
            schema: organizations,
            type: "belongsTo",
            foreignKey: machines.organizationId,
            references: organizations.id,
          },
        },
      });

    const res = await app2.request("/api/machines2/subscribe");
    expect(res.status).toBe(400);
    sqlite2.close();
  });
});
