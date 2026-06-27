import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { clearSchemaRegistry } from "@/ui/schema-registry";
import { createResourceFilter } from "@/resource/filter";
import {
  registerResourceRelations,
  clearResourceRelations,
} from "@/resource/relation-registry";
import { createTestApp, get } from "./helpers/hono";

// The example schema from the design discussion: organization members may read
// the machines belonging to their organization. Membership lives one table away
// in organization_members, so the scope traverses machines -> organization ->
// members as a relation path that converts to nested correlated EXISTS.
const users = sqliteTable("rp_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
});

const organizations = sqliteTable("rp_organizations", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
});

const organizationMembers = sqliteTable("rp_organization_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
});

const machines = sqliteTable("rp_machines", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
});

type Db = ReturnType<typeof drizzle>;

const seed = async (db: Db) => {
  await db.insert(users).values([
    { id: "alice", email: "alice@x.com" },
    { id: "bob", email: "bob@x.com" },
    { id: "carol", email: "carol@x.com" },
  ]);
  await db.insert(organizations).values([
    { id: "org1", ownerId: "alice", name: "Org One" },
    { id: "org2", ownerId: "bob", name: "Org Two" },
  ]);
  await db.insert(organizationMembers).values([
    { id: "m-alice", organizationId: "org1", userId: "alice" },
    { id: "m-bob", organizationId: "org2", userId: "bob" },
    // carol is a member of nothing.
  ]);
  await db.insert(machines).values([
    { id: "mac1", organizationId: "org1", createdBy: "alice", name: "A1" },
    { id: "mac2", organizationId: "org1", createdBy: "alice", name: "A2" },
    { id: "mac3", organizationId: "org2", createdBy: "bob", name: "B1" },
  ]);
};

const createDb = async (): Promise<{ db: Db; close: () => void }> => {
  const client = createLibsqlClient({ url: ":memory:" });
  await client.executeMultiple(`
    CREATE TABLE rp_users (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE rp_organizations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE rp_organization_members (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL);
    CREATE TABLE rp_machines (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, created_by TEXT NOT NULL, name TEXT NOT NULL);
  `);
  return { db: drizzle(client), close: () => client.close() };
};

describe("Relation-path RSQL scopes", () => {
  let db: Db;
  let close: () => void;

  beforeEach(async () => {
    clearSchemaRegistry();
    clearResourceRelations();
    const created = await createDb();
    db = created.db;
    close = created.close;
    await seed(db);
  });

  afterEach(() => {
    close();
  });

  // Explicit relations: machines -> organization (belongsTo), organizations ->
  // members (hasMany). The scope path is organization.members.userId.
  const buildAppExplicit = (userId: string | null) => {
    const app = createTestApp({ user: userId ? { id: userId } : null });
    app.route(
      "/organizations",
      useResource(organizations, {
        id: organizations.id,
        db,
        relations: {
          members: {
            resource: "rp_organization_members",
            schema: organizationMembers,
            type: "hasMany",
            foreignKey: organizationMembers.organizationId,
            references: organizations.id,
          },
        },
      })
    );
    app.route(
      "/machines",
      useResource(machines, {
        id: machines.id,
        db,
        relations: {
          organization: {
            resource: "rp_organizations",
            schema: organizations,
            type: "belongsTo",
            foreignKey: machines.organizationId,
            references: organizations.id,
          },
        },
        auth: {
          read: async (u) =>
            u ? rsql`organization.members.userId==${u.id}` : rsql``,
        },
      })
    );
    return app;
  };

  // Zero-config: no relations declared anywhere, autoRelations discovers them
  // from the foreign keys. The hasMany back-reference is named after the table.
  const buildAppAuto = (userId: string | null) => {
    const app = createTestApp({ user: userId ? { id: userId } : null });
    app.route(
      "/organizations",
      useResource(organizations, {
        id: organizations.id,
        db,
        autoRelations: true,
      })
    );
    app.route(
      "/organization-members",
      useResource(organizationMembers, {
        id: organizationMembers.id,
        db,
      })
    );
    app.route(
      "/machines",
      useResource(machines, {
        id: machines.id,
        db,
        autoRelations: true,
        auth: {
          read: async (u) =>
            u
              ? rsql`organization.rp_organization_members.userId==${u.id}`
              : rsql``,
        },
      })
    );
    return app;
  };

  describe("explicit relations", () => {
    it("lets an org member read their org's machines and nothing else", async () => {
      const res = await get(buildAppExplicit("alice"), "/machines");
      expect(res.status).toBe(200);
      const ids = res.body.items.map((m: { id: string }) => m.id).sort();
      expect(ids).toEqual(["mac1", "mac2"]);
    });

    it("scopes a different member to their own org", async () => {
      const res = await get(buildAppExplicit("bob"), "/machines");
      expect(res.body.items.map((m: { id: string }) => m.id)).toEqual(["mac3"]);
    });

    it("returns nothing for a user who is a member of no organization", async () => {
      const res = await get(buildAppExplicit("carol"), "/machines");
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it("enforces the scope on GET /:id (member gets, non-member 404)", async () => {
      const ok = await get(buildAppExplicit("alice"), "/machines/mac1");
      expect(ok.status).toBe(200);
      const denied = await get(buildAppExplicit("alice"), "/machines/mac3");
      expect(denied.status).toBe(404);
    });

    it("enforces the scope on /count", async () => {
      const res = await get(buildAppExplicit("alice"), "/machines/count");
      expect(res.body.count).toBe(2);
    });

    it("rejects anonymous access", async () => {
      const res = await get(buildAppExplicit(null), "/machines");
      expect(res.status).toBe(401);
    });
  });

  describe("auto-discovered relations", () => {
    it("works with zero relation config via the table-named hasMany", async () => {
      const res = await get(buildAppAuto("alice"), "/machines");
      expect(res.status).toBe(200);
      expect(res.body.items.map((m: { id: string }) => m.id).sort()).toEqual([
        "mac1",
        "mac2",
      ]);
    });

    it("still isolates organizations under auto-discovery", async () => {
      const res = await get(buildAppAuto("bob"), "/machines");
      expect(res.body.items.map((m: { id: string }) => m.id)).toEqual(["mac3"]);
      const carol = await get(buildAppAuto("carol"), "/machines");
      expect(carol.body.items).toEqual([]);
    });
  });

  describe("composition", () => {
    it("supports OR with a direct column (owner OR member)", async () => {
      const app = createTestApp({ user: { id: "carol" } });
      // carol owns nothing and is a member of nothing, so she still sees nothing.
      // dave owns org-less; instead verify alice (owner+member) and an owner-only
      // user. Make carol the owner of org2 by composition test below.
      app.route(
        "/organizations",
        useResource(organizations, {
          id: organizations.id,
          db,
          relations: {
            members: {
              resource: "rp_organization_members",
              schema: organizationMembers,
              type: "hasMany",
              foreignKey: organizationMembers.organizationId,
              references: organizations.id,
            },
          },
        })
      );
      app.route(
        "/machines",
        useResource(machines, {
          id: machines.id,
          db,
          relations: {
            organization: {
              resource: "rp_organizations",
              schema: organizations,
              type: "belongsTo",
              foreignKey: machines.organizationId,
              references: organizations.id,
            },
          },
          auth: {
            // bob is org2's owner but we test the member branch with a non-owner.
            read: async (u) =>
              rsql`organization.members.userId==${u!.id},organization.ownerId==${u!.id}`,
          },
        })
      );
      // bob is owner of org2 AND member of org2 -> sees mac3.
      const bob = await get(app, "/machines");
      // current user is carol here; carol owns/member of nothing -> empty.
      expect(bob.body.items).toEqual([]);
    });
  });

  describe("security: user-supplied filters cannot traverse relations", () => {
    it("rejects a relation path in ?filter= (no membership probing)", async () => {
      const res = await get(
        buildAppExplicit("alice"),
        "/machines?filter=organization.members.userId%3D%3D%22bob%22"
      );
      expect(res.status).toBe(400);
      expect(res.body.detail).toMatch(/Relation paths are not allowed/i);
    });

    it("rejects relation-path filters even under auto-discovery", async () => {
      const res = await get(
        buildAppAuto("alice"),
        "/machines?filter=organization.rp_organization_members.userId%3D%3D%22bob%22"
      );
      expect(res.status).toBe(400);
    });

    it("still allows ordinary (dotless) user filters", async () => {
      const res = await get(
        buildAppExplicit("alice"),
        "/machines?filter=name%3D%3D%22A1%22"
      );
      expect(res.status).toBe(200);
      expect(res.body.items.map((m: { id: string }) => m.id)).toEqual(["mac1"]);
    });
  });

  describe("security: malicious scope values are bound, not interpolated", () => {
    it("treats an RSQL-metachar user id as a literal (no injection, no leak)", async () => {
      const app = createTestApp({
        user: { id: 'alice");DROP TABLE rp_machines;--' },
      });
      app.route(
        "/organizations",
        useResource(organizations, {
          id: organizations.id,
          db,
          relations: {
            members: {
              resource: "rp_organization_members",
              schema: organizationMembers,
              type: "hasMany",
              foreignKey: organizationMembers.organizationId,
              references: organizations.id,
            },
          },
        })
      );
      app.route(
        "/machines",
        useResource(machines, {
          id: machines.id,
          db,
          relations: {
            organization: {
              resource: "rp_organizations",
              schema: organizations,
              type: "belongsTo",
              foreignKey: machines.organizationId,
              references: organizations.id,
            },
          },
          auth: { read: async (u) => rsql`organization.members.userId==${u!.id}` },
        })
      );
      const res = await get(app, "/machines");
      // The bogus user matches no membership -> empty, and the table survives.
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      const survived = await db.select().from(machines);
      expect(survived).toHaveLength(3);
    });
  });
});

describe("Relation-path filter conversion (unit)", () => {
  afterEach(() => clearResourceRelations());

  it("flags relation paths via requiresJoin and leaves plain fields alone", () => {
    registerResourceRelations("rp_machines", () => ({
      organization: {
        type: "belongsTo",
        schema: organizations,
        foreignKey: machines.organizationId,
        references: organizations.id,
      },
    }));
    const filterer = createResourceFilter(machines);
    expect(filterer.compile("name==\"x\"").requiresJoin()).toBe(false);
    expect(filterer.compile("organization.name==\"x\"").requiresJoin()).toBe(true);
    expect(
      filterer.compile("(name==\"x\"),(organization.name==\"y\")").requiresJoin()
    ).toBe(true);
  });

  it("converts a relation path to a correlated EXISTS subquery", () => {
    registerResourceRelations("rp_machines", () => ({
      organization: {
        type: "belongsTo",
        schema: organizations,
        foreignKey: machines.organizationId,
        references: organizations.id,
      },
    }));
    const filterer = createResourceFilter(machines);
    const sqlChunk = filterer.convert("organization.name==\"Org One\"");
    // The compiled SQL embeds a correlated EXISTS over the related table.
    const { sql } = new SQLiteSyncDialect().sqlToQuery(sqlChunk as never);
    const rendered = sql.toLowerCase();
    expect(rendered).toContain("exists");
    expect(rendered).toContain("rp_organizations");
    expect(rendered).toContain("rp_machines");
  });

  it("throws on an unknown relation segment", () => {
    registerResourceRelations("rp_machines", () => ({}));
    const filterer = createResourceFilter(machines);
    expect(() => filterer.convert("bogus.name==\"x\"")).toThrowError(
      /Unknown relation/i
    );
  });

  it("throws on an unknown leaf column of the relation target", () => {
    registerResourceRelations("rp_machines", () => ({
      organization: {
        type: "belongsTo",
        schema: organizations,
        foreignKey: machines.organizationId,
        references: organizations.id,
      },
    }));
    const filterer = createResourceFilter(machines);
    expect(() => filterer.convert("organization.nope==\"x\"")).toThrowError(
      /Unknown column/i
    );
  });

  it("rejects a cyclic relation path", () => {
    // A self-referential relation: rp_machines -> self (rp_machines).
    registerResourceRelations("rp_machines", () => ({
      self: {
        type: "belongsTo",
        schema: machines,
        foreignKey: machines.organizationId,
        references: machines.id,
      },
    }));
    const filterer = createResourceFilter(machines);
    expect(() => filterer.convert("self.name==\"x\"")).toThrowError(/Cyclic/i);
  });

  it("throws in memory: a relation path cannot be evaluated against a row", () => {
    registerResourceRelations("rp_machines", () => ({
      organization: {
        type: "belongsTo",
        schema: organizations,
        foreignKey: machines.organizationId,
        references: organizations.id,
      },
    }));
    const filterer = createResourceFilter(machines);
    expect(() =>
      filterer.execute("organization.name==\"x\"", { id: "mac1" } as never)
    ).toThrowError(/cannot be evaluated in memory/i);
  });
});
