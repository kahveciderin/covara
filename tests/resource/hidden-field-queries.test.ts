import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import type { ResourceConfig } from "@/resource/types";
import { rsql } from "@/auth/rsql";
import { setGlobalSearch, clearGlobalSearch, createMemorySearchAdapter } from "@/search";
import { createTestApp, get, post, patch, del } from "../helpers/hono";

const users = sqliteTable("hq_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("passwordHash").notNull(),
  ownerId: text("ownerId"),
  score: integer("score").notNull().default(0),
});

const listings = sqliteTable("hq_listings", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  sellerId: text("sellerId").notNull(),
});

const enc = encodeURIComponent;

describe("Hidden (non-readable) columns cannot be queried", () => {
  let tempDir: string;
  let client: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-hq-"));
    client = createLibsqlClient({ url: `file:${join(tempDir, "t.db")}` });
    db = drizzle(client);
    await client.execute(
      `CREATE TABLE hq_users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, passwordHash TEXT NOT NULL, ownerId TEXT, score INTEGER NOT NULL DEFAULT 0)`
    );
    await client.execute(
      `CREATE TABLE hq_listings (id TEXT PRIMARY KEY, title TEXT NOT NULL, sellerId TEXT NOT NULL)`
    );
    await client.execute(
      `INSERT INTO hq_users VALUES ('1','kahve','kahve@market.test','$argon2$hash','u',10), ('2','bob','bob@market.test','$argon2$other','u',20)`
    );
    await client.execute(`INSERT INTO hq_listings VALUES ('l1','Coffee','1')`);
  });

  afterEach(() => {
    client.close();
    clearGlobalSearch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const mount = (overrides: Partial<ResourceConfig<any>> = {}) => {
    const app = createTestApp({ user: { id: "u" } });
    app.route(
      "/users",
      useResource(users, {
        id: users.id,
        db,
        batch: { update: 10, delete: 10 },
        fields: { readable: ["id", "name", "score"] },
        ...overrides,
      } as any)
    );
    return app;
  };

  describe("filter", () => {
    it("rejects filtering the list on a hidden column (email oracle)", async () => {
      const app = mount();
      const res = await get(app, `/users?filter=${enc('email=="kahve@market.test"')}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("kahve");
    });

    it("rejects filtering on the password hash", async () => {
      const app = mount();
      const res = await get(app, `/users?filter=${enc('passwordHash=="x"')}`);
      expect(res.status).toBe(400);
    });

    it("rejects a hidden column nested inside OR / parentheses", async () => {
      const app = mount();
      const res = await get(
        app,
        `/users?filter=${enc('name=="x",(score>0;email=="kahve@market.test")')}`
      );
      expect(res.status).toBe(400);
    });

    it("rejects hidden columns on count, aggregate, batch update and batch delete", async () => {
      const app = mount();
      const f = enc('email=="kahve@market.test"');
      expect((await get(app, `/users/count?filter=${f}`)).status).toBe(400);
      expect((await get(app, `/users/aggregate?count=true&filter=${f}`)).status).toBe(400);
      expect((await patch(app, `/users/batch?filter=${f}`, { name: "x" })).status).toBe(400);
      expect((await del(app, `/users/batch?filter=${f}`)).status).toBe(400);
      const still = await get(app, "/users/1");
      expect(still.body.name).toBe("kahve");
    });

    it("rejects hidden columns on subscribe and aggregate subscribe before streaming", async () => {
      const app = mount();
      const f = enc('email=="kahve@market.test"');
      expect((await get(app, `/users/subscribe?filter=${f}`)).status).toBe(400);
      expect((await get(app, `/users/aggregate/subscribe?count=true&filter=${f}`)).status).toBe(
        400
      );
    });

    it("still allows filtering on readable columns", async () => {
      const app = mount();
      const res = await get(app, `/users?filter=${enc('name=="kahve"')}`);
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: any) => i.id)).toEqual(["1"]);
      const count = await get(app, `/users/count?filter=${enc("score>15")}`);
      expect(count.body.count).toBe(1);
    });

    it("lets an explicit fields.filterable opt a hidden column back in", async () => {
      const app = mount({ fields: { readable: ["id", "name"], filterable: ["name", "email"] } });
      const res = await get(app, `/users?filter=${enc('email=="kahve@market.test"')}`);
      expect(res.status).toBe(200);
      expect(res.body.items[0]).not.toHaveProperty("email");
    });

    it("explicit fields.filterable can also narrow below readable", async () => {
      const app = mount({ fields: { readable: ["id", "name", "score"], filterable: ["name"] } });
      expect((await get(app, `/users?filter=${enc("score>1")}`)).status).toBe(400);
    });

    it("honors filter.allowedFields as an additional restriction", async () => {
      const app = mount({ filter: { allowedFields: ["name"] } });
      expect((await get(app, `/users?filter=${enc("score>1")}`)).status).toBe(400);
      expect((await get(app, `/users?filter=${enc('name=="bob"')}`)).status).toBe(200);
    });

    it("trusted auth scopes may still reference hidden columns", async () => {
      const app = mount({
        auth: { read: async (user: any) => rsql`ownerId==${user.id}` },
      });
      const res = await get(app, `/users?filter=${enc('name=="kahve"')}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      const byId = await get(app, "/users/1");
      expect(byId.status).toBe(200);
    });

    it("leaves resources without field policies unrestricted", async () => {
      const app = mount({ fields: undefined });
      const res = await get(app, `/users?filter=${enc('email=="kahve@market.test"')}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("sort", () => {
    it("rejects ordering by a hidden column", async () => {
      const app = mount();
      expect((await get(app, "/users?orderBy=passwordHash")).status).toBe(400);
      expect((await get(app, "/users?orderBy=-email")).status).toBe(400);
      expect((await get(app, "/users?orderBy=name:asc,email:desc")).status).toBe(400);
    });

    it("allows ordering by readable columns and honors explicit sortable", async () => {
      const app = mount();
      const res = await get(app, "/users?orderBy=-score");
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: any) => i.id)).toEqual(["2", "1"]);

      const narrowed = mount({ fields: { readable: ["id", "name", "score"], sortable: ["name"] } });
      expect((await get(narrowed, "/users?orderBy=score")).status).toBe(400);
    });
  });

  describe("aggregate", () => {
    it("rejects grouping by or aggregating a hidden column", async () => {
      const app = mount();
      expect((await get(app, "/users/aggregate?groupBy=email&count=true")).status).toBe(400);
      expect((await get(app, "/users/aggregate?min=passwordHash")).status).toBe(400);
      expect((await get(app, "/users/aggregate?max=email")).status).toBe(400);
      expect(
        (await get(app, "/users/aggregate/subscribe?groupBy=email&count=true")).status
      ).toBe(400);
    });

    it("allows aggregating readable columns", async () => {
      const app = mount();
      const res = await get(app, "/users/aggregate?sum=score&groupBy=name");
      expect(res.status).toBe(200);
    });
  });

  describe("search", () => {
    it("does not match, filter on, or highlight hidden columns", async () => {
      setGlobalSearch(createMemorySearchAdapter());
      const app = mount({ search: { enabled: true } });
      await post(app, "/users", {
        id: "3",
        name: "carol",
        email: "carol@market.test",
        passwordHash: "zzz",
        score: 1,
      });

      const byEmail = await get(app, `/users/search?q=${enc("carol@market.test")}&highlight=true`);
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.items).toHaveLength(0);

      const byName = await get(app, "/users/search?q=carol&highlight=true");
      expect(byName.body.items).toHaveLength(1);
      expect(JSON.stringify(byName.body)).not.toContain("carol@market.test");

      const filtered = await get(
        app,
        `/users/search?q=carol&filter=${enc('email=="carol@market.test"')}`
      );
      expect(filtered.status).toBe(400);
    });
  });

  describe("relation include filters", () => {
    it("rejects an include filter on the target resource's hidden column", async () => {
      const app = mount();
      app.route(
        "/listings",
        useResource(listings, {
          id: listings.id,
          db,
          relations: {
            seller: {
              resource: "hq_users",
              schema: users,
              type: "belongsTo",
              foreignKey: listings.sellerId,
              references: users.id,
            },
          },
        })
      );
      const hidden = await get(
        app,
        `/listings?include=${enc('seller(filter:email=="kahve@market.test")')}`
      );
      expect(hidden.status).toBe(400);

      const ok = await get(app, `/listings?include=${enc('seller(filter:name=="kahve")')}`);
      expect(ok.status).toBe(200);
      expect(ok.body.items[0].seller?.name).toBe("kahve");
    });
  });
});
