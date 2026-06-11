import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { sql } from "drizzle-orm";
import { createTestApp, get, post, patch, put, del } from "../helpers/hono";

const testUsersTable = sqliteTable("test_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  age: integer("age").notNull(),
  status: text("status").default("active"),
  role: text("role").default("user"),
});

describe("useResource Integration Tests", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-integration-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_users`);
    await libsqlClient.execute(`
      CREATE TABLE test_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        age INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        role TEXT DEFAULT 'user'
      )
    `);

    vi.doMock("@/db/db", () => ({ db }));

    app = createTestApp({ user: {} });
  });

  afterEach(() => {
    libsqlClient.close();
    vi.clearAllMocks();
  });

  describe("Basic CRUD Operations", () => {
    beforeEach(() => {
      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
        })
      );
    });

    describe("POST / - Create", () => {
      it("should create a new resource", async () => {
        const response = await post(app, "/users", {
          name: "John Doe",
          email: "john@test.com",
          age: 30,
        });
        expect(response.status).toBe(201);

        expect(response.body).toMatchObject({
          name: "John Doe",
          email: "john@test.com",
          age: 30,
        });
        expect(response.body.id).toBeDefined();
      });

      it("should return 400 for invalid data", async () => {
        const response = await post(app, "/users", { name: "John Doe" });
        expect(response.status).toBe(400);

        expect(response.body.code).toBeDefined();
        expect(response.body.detail).toBeDefined();
      });

      it("should create multiple resources sequentially", async () => {
        const users = [
          { name: "User 1", email: "user1@test.com", age: 25 },
          { name: "User 2", email: "user2@test.com", age: 30 },
          { name: "User 3", email: "user3@test.com", age: 35 },
        ];

        for (const user of users) {
          const response = await post(app, "/users", user);
          expect(response.status).toBe(201);

          expect(response.body.name).toBe(user.name);
        }
      });
    });

    describe("GET / - List", () => {
      beforeEach(async () => {
        const users = [
          { name: "Alice", email: "alice@test.com", age: 25, status: "active" },
          { name: "Bob", email: "bob@test.com", age: 30, status: "active" },
          { name: "Charlie", email: "charlie@test.com", age: 35, status: "inactive" },
          { name: "Diana", email: "diana@test.com", age: 28, status: "active" },
          { name: "Eve", email: "eve@test.com", age: 32, status: "pending" },
        ];

        for (const user of users) {
          await post(app, "/users", user);
        }
      });

      it("should list all resources", async () => {
        const response = await get(app, "/users");
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(5);
        expect(response.body.hasMore).toBe(false);
      });

      it("should filter resources with == operator", async () => {
        const response = await get(app, '/users?filter=status=="active"');
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(3);
        expect(
          response.body.items.every((u: any) => u.status === "active")
        ).toBe(true);
      });

      it("should filter resources with > operator", async () => {
        const response = await get(app, "/users?filter=age>30");
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(2);
        expect(response.body.items.every((u: any) => u.age > 30)).toBe(true);
      });

      it("should filter resources with complex AND expression", async () => {
        const response = await get(app, '/users?filter=status=="active";age>=28');
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(2);
      });

      it("should filter resources with OR expression", async () => {
        const response = await get(
          app,
          '/users?filter=status=="active",status=="pending"'
        );
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(4);
      });

      it("should apply pagination with limit", async () => {
        const response = await get(app, "/users?limit=2");
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(2);
        expect(response.body.hasMore).toBe(true);
        expect(response.body.nextCursor).toBeDefined();
      });

      it("should apply cursor-based pagination", async () => {
        const page1 = await get(app, "/users?limit=2");
        expect(page1.status).toBe(200);

        expect(page1.body.items).toHaveLength(2);

        const page2 = await get(
          app,
          `/users?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`
        );
        expect(page2.status).toBe(200);

        expect(page2.body.items).toHaveLength(2);
        expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
      });

      it("should return total count when requested", async () => {
        const response = await get(app, "/users?totalCount=true&limit=2");
        expect(response.status).toBe(200);

        expect(response.body.totalCount).toBe(5);
        expect(response.body.items).toHaveLength(2);
      });

      it("should apply field selection", async () => {
        const response = await get(app, "/users?select=id,name");
        expect(response.status).toBe(200);

        const firstItem = response.body.items[0];
        expect(firstItem.id).toBeDefined();
        expect(firstItem.name).toBeDefined();
        expect(firstItem.email).toBeUndefined();
        expect(firstItem.age).toBeUndefined();
      });

      it("should apply ordering", async () => {
        const response = await get(app, "/users?orderBy=age:desc");
        expect(response.status).toBe(200);

        const ages = response.body.items.map((u: any) => u.age);
        expect(ages).toEqual([...ages].sort((a, b) => b - a));
      });
    });

    describe("GET /:id - Get Single", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await post(app, "/users", {
          name: "Test User",
          email: "test@test.com",
          age: 25,
        });
        createdId = response.body.id;
      });

      it("should return a single resource by id", async () => {
        const response = await get(app, `/users/${createdId}`);
        expect(response.status).toBe(200);

        expect(response.body.id).toBe(createdId);
        expect(response.body.name).toBe("Test User");
      });

      it("should return 404 for non-existent resource", async () => {
        const response = await get(app, "/users/99999");
        expect(response.status).toBe(404);

        expect(response.body.code).toBe("NOT_FOUND");
      });

      it("should apply field selection to single resource", async () => {
        const response = await get(app, `/users/${createdId}?select=id,name`);
        expect(response.status).toBe(200);

        expect(response.body.id).toBeDefined();
        expect(response.body.name).toBeDefined();
        expect(response.body.email).toBeUndefined();
      });
    });

    describe("PATCH /:id - Update", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await post(app, "/users", {
          name: "Original Name",
          email: "original@test.com",
          age: 25,
        });
        createdId = response.body.id;
      });

      it("should update a resource partially", async () => {
        const response = await patch(app, `/users/${createdId}`, {
          name: "Updated Name",
        });
        expect(response.status).toBe(200);

        expect(response.body.name).toBe("Updated Name");
        expect(response.body.email).toBe("original@test.com");
      });

      it("should update multiple fields", async () => {
        const response = await patch(app, `/users/${createdId}`, {
          name: "New Name",
          age: 30,
        });
        expect(response.status).toBe(200);

        expect(response.body.name).toBe("New Name");
        expect(response.body.age).toBe(30);
      });

      it("should return 404 for non-existent resource", async () => {
        const response = await patch(app, "/users/99999", { name: "Updated" });
        expect(response.status).toBe(404);
      });
    });

    describe("PUT /:id - Replace", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await post(app, "/users", {
          name: "Original",
          email: "original@test.com",
          age: 25,
        });
        createdId = response.body.id;
      });

      it("should replace a resource completely", async () => {
        const response = await put(app, `/users/${createdId}`, {
          name: "Replaced",
          email: "replaced@test.com",
          age: 35,
        });
        expect(response.status).toBe(200);

        expect(response.body.name).toBe("Replaced");
        expect(response.body.email).toBe("replaced@test.com");
        expect(response.body.age).toBe(35);
      });

      it("should return 404 for non-existent resource", async () => {
        const response = await put(app, "/users/99999", {
          name: "Test",
          email: "test@test.com",
          age: 30,
        });
        expect(response.status).toBe(404);
      });
    });

    describe("DELETE /:id - Delete", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await post(app, "/users", {
          name: "To Delete",
          email: "delete@test.com",
          age: 25,
        });
        createdId = response.body.id;
      });

      it("should delete a resource", async () => {
        const deleteResponse = await del(app, `/users/${createdId}`);
        expect(deleteResponse.status).toBe(204);

        const getResponse = await get(app, `/users/${createdId}`);
        expect(getResponse.status).toBe(404);
      });

      it("should return 404 for non-existent resource", async () => {
        const response = await del(app, "/users/99999");
        expect(response.status).toBe(404);
      });
    });

    describe("GET /count - Count", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await post(app, "/users", user);
        }
      });

      it("should return total count", async () => {
        const response = await get(app, "/users/count");
        expect(response.status).toBe(200);

        expect(response.body.count).toBe(3);
      });

      it("should return filtered count", async () => {
        const response = await get(app, '/users/count?filter=status=="active"');
        expect(response.status).toBe(200);

        expect(response.body.count).toBe(2);
      });
    });

    describe("GET /aggregate - Aggregations", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, role: "admin" },
          { name: "User 2", email: "u2@test.com", age: 30, role: "admin" },
          { name: "User 3", email: "u3@test.com", age: 35, role: "user" },
          { name: "User 4", email: "u4@test.com", age: 28, role: "user" },
          { name: "User 5", email: "u5@test.com", age: 32, role: "user" },
        ];

        for (const user of users) {
          await post(app, "/users", user);
        }
      });

      it("should return count aggregation", async () => {
        const response = await get(app, "/users/aggregate?count=true");
        expect(response.status).toBe(200);

        expect(response.body.groups).toHaveLength(1);
        expect(response.body.groups[0].count).toBe(5);
      });

      it("should return grouped count", async () => {
        const response = await get(app, "/users/aggregate?groupBy=role&count=true");
        expect(response.status).toBe(200);

        expect(response.body.groups).toHaveLength(2);
      });

      it("should return sum aggregation", async () => {
        const response = await get(app, "/users/aggregate?sum=age");
        expect(response.status).toBe(200);

        expect(response.body.groups[0].sum.age).toBe(150);
      });

      it("should return avg aggregation", async () => {
        const response = await get(app, "/users/aggregate?avg=age");
        expect(response.status).toBe(200);

        expect(response.body.groups[0].avg.age).toBe(30);
      });

      it("should return min/max aggregation", async () => {
        const response = await get(app, "/users/aggregate?min=age&max=age");
        expect(response.status).toBe(200);

        expect(response.body.groups[0].min.age).toBe(25);
        expect(response.body.groups[0].max.age).toBe(35);
      });

      it("should combine multiple aggregations", async () => {
        const response = await get(
          app,
          "/users/aggregate?groupBy=role&count=true&avg=age&sum=age"
        );
        expect(response.status).toBe(200);

        expect(response.body.groups).toHaveLength(2);
        for (const group of response.body.groups) {
          expect(group.count).toBeDefined();
          expect(group.avg.age).toBeDefined();
          expect(group.sum.age).toBeDefined();
        }
      });
    });
  });

  describe("Batch Operations", () => {
    beforeEach(() => {
      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          batch: {
            create: 10,
            update: 10,
            delete: 10,
          },
        })
      );
    });

    describe("POST /batch - Batch Create", () => {
      it("should create multiple resources", async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25 },
          { name: "User 2", email: "u2@test.com", age: 30 },
          { name: "User 3", email: "u3@test.com", age: 35 },
        ];

        const response = await post(app, "/users/batch", { items: users });
        expect(response.status).toBe(200);

        expect(response.body.items).toHaveLength(3);
      });

      it("should reject batch exceeding limit", async () => {
        const users = Array.from({ length: 15 }, (_, i) => ({
          name: `User ${i}`,
          email: `u${i}@test.com`,
          age: 20 + i,
        }));

        const response = await post(app, "/users/batch", { items: users });
        expect(response.status).toBe(400);
      });
    });

    describe("PATCH /batch - Batch Update", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await post(app, "/users", user);
        }
      });

      it("should update multiple resources", async () => {
        const response = await patch(app, '/users/batch?filter=status=="active"', {
          status: "updated",
        });
        expect(response.status).toBe(200);

        expect(response.body.count).toBe(2);
      });
    });

    describe("DELETE /batch - Batch Delete", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await post(app, "/users", user);
        }
      });

      it("should delete multiple resources", async () => {
        const response = await del(app, '/users/batch?filter=status=="active"');
        expect(response.status).toBe(200);

        expect(response.body.count).toBe(2);

        const remaining = await get(app, "/users");
        expect(remaining.body.items).toHaveLength(1);
      });
    });
  });

  describe("Lifecycle Hooks", () => {
    let beforeCreateCalled: boolean;
    let afterCreateCalled: boolean;
    let beforeUpdateCalled: boolean;
    let afterUpdateCalled: boolean;
    let beforeDeleteCalled: boolean;
    let afterDeleteCalled: boolean;

    beforeEach(() => {
      beforeCreateCalled = false;
      afterCreateCalled = false;
      beforeUpdateCalled = false;
      afterUpdateCalled = false;
      beforeDeleteCalled = false;
      afterDeleteCalled = false;

      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          hooks: {
            onBeforeCreate: async (ctx, data) => {
              beforeCreateCalled = true;
              return { ...data, status: "new" };
            },
            onAfterCreate: async (ctx, created) => {
              afterCreateCalled = true;
            },
            onBeforeUpdate: async (ctx, id, data) => {
              beforeUpdateCalled = true;
              return { ...data, status: "modified" };
            },
            onAfterUpdate: async (ctx, updated) => {
              afterUpdateCalled = true;
            },
            onBeforeDelete: async (ctx, id) => {
              beforeDeleteCalled = true;
            },
            onAfterDelete: async (ctx, deleted) => {
              afterDeleteCalled = true;
            },
          },
        })
      );
    });

    it("should call create hooks", async () => {
      const response = await post(app, "/users", {
        name: "Test",
        email: "test@test.com",
        age: 25,
      });

      expect(beforeCreateCalled).toBe(true);
      expect(afterCreateCalled).toBe(true);
      expect(response.body.status).toBe("new");
    });

    it("should call update hooks", async () => {
      const created = await post(app, "/users", {
        name: "Test",
        email: "test@test.com",
        age: 25,
      });

      beforeCreateCalled = false;
      afterCreateCalled = false;

      const response = await patch(app, `/users/${created.body.id}`, {
        name: "Updated",
      });

      expect(beforeUpdateCalled).toBe(true);
      expect(afterUpdateCalled).toBe(true);
      expect(response.body.status).toBe("modified");
    });

    it("should call delete hooks", async () => {
      const created = await post(app, "/users", {
        name: "Test",
        email: "test@test.com",
        age: 25,
      });

      await del(app, `/users/${created.body.id}`);

      expect(beforeDeleteCalled).toBe(true);
      expect(afterDeleteCalled).toBe(true);
    });
  });

  describe("Pagination Configuration", () => {
    beforeEach(async () => {
      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          pagination: {
            defaultLimit: 5,
            maxLimit: 10,
          },
        })
      );

      for (let i = 0; i < 20; i++) {
        await post(app, "/users", {
          name: `User ${i}`,
          email: `u${i}@test.com`,
          age: 20 + i,
        });
      }
    });

    it("should use default limit", async () => {
      const response = await get(app, "/users");
      expect(response.status).toBe(200);

      expect(response.body.items).toHaveLength(5);
    });

    it("should respect max limit", async () => {
      const response = await get(app, "/users?limit=100");
      expect(response.status).toBe(200);

      expect(response.body.items).toHaveLength(10);
    });

    it("should allow limit within bounds", async () => {
      const response = await get(app, "/users?limit=8");
      expect(response.status).toBe(200);

      expect(response.body.items).toHaveLength(8);
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
        })
      );
    });

    it("should return proper error format for validation errors", async () => {
      const response = await post(app, "/users", { invalid: "data" });
      expect(response.status).toBe(400);

      expect(response.body.detail).toBeDefined();
      expect(response.body.code).toBe("VALIDATION_ERROR");
    });

    it("should return proper error format for not found", async () => {
      const response = await get(app, "/users/99999");
      expect(response.status).toBe(404);

      expect(response.body.detail).toBeDefined();
      expect(response.body.code).toBe("NOT_FOUND");
    });

    it("should handle invalid filter expressions", async () => {
      const response = await get(app, "/users?filter=invalid===syntax");
      expect(response.status).toBe(400);

      expect(response.body.code).toBeDefined();
      expect(response.body.detail).toBeDefined();
    });
  });

  describe("Custom Operators", () => {
    beforeEach(async () => {
      app.route(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          customOperators: {
            "=contains=": {
              convert: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
              execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
            },
          },
        })
      );

      await post(app, "/users", {
        name: "John Doe",
        email: "john@test.com",
        age: 30,
      });
      await post(app, "/users", {
        name: "Jane Smith",
        email: "jane@test.com",
        age: 25,
      });
    });

    it("should use custom operator in filter", async () => {
      const response = await get(app, '/users?filter=name=contains="Doe"');
      expect(response.status).toBe(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].name).toBe("John Doe");
    });
  });
});
