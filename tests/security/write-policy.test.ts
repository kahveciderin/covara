import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { createTestApp, request } from "../helpers/hono";
import { openTempDb, type TempDb } from "../helpers/temp-db";

const members = sqliteTable("wp_members", {
  key: text("member_key").primaryKey(),
  name: text("name"),
  role: text("role"),
  ownerId: text("ownerId"),
});

describe("write policy", () => {
  let t: TempDb;

  beforeEach(async () => {
    t = await openTempDb(`
      CREATE TABLE wp_members (member_key TEXT PRIMARY KEY, name TEXT, role TEXT, ownerId TEXT);
      INSERT INTO wp_members VALUES ('mine', 'Ann', 'user', 'u1'), ('theirs', 'Bob', 'user', 'u2');
    `);
  });
  afterEach(() => t.close());

  const build = (extra: Record<string, unknown> = {}) => {
    const app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/members",
      useResource(members, { id: members.key, db: t.db, fields: { writable: [members.name] }, ...extra } as any)
    );
    return app;
  };
  const row = async (key: string) =>
    (await t.client.execute({ sql: "SELECT * FROM wp_members WHERE member_key = ?", args: [key] })).rows[0];
  const only = `?filter=${encodeURIComponent('key=="mine"')}`;

  describe("PATCH /batch honors fields.writable", () => {
    it("strips a protected column next to a writable one", async () => {
      const res = await request(build(), "PATCH", `/members/batch${only}`, { name: "New", role: "admin" });
      expect(res.status).toBe(200);
      expect(await row("mine")).toMatchObject({ name: "New", role: "user" });
    });

    it("writes nothing when every column is stripped", async () => {
      const res = await request(build(), "PATCH", `/members/batch${only}`, { role: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 0 });
      expect(await row("mine")).toMatchObject({ role: "user" });
    });

    it("still lets a hook set a protected column", async () => {
      const hooks = { onBeforeUpdate: async (_: unknown, __: string, data: object) => ({ ...data, role: "reviewed" }) };
      await request(build({ hooks }), "PATCH", `/members/batch${only}`, { role: "admin" });
      expect(await row("mine")).toMatchObject({ role: "reviewed" });
    });
  });

  describe("primary key on update", () => {
    it("is stripped on PATCH /:id", async () => {
      const res = await request(build(), "PATCH", "/members/mine", { key: "chosen", name: "Z" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: "mine", name: "Z" });
      expect(await row("chosen")).toBeUndefined();
    });

    it("is stripped on PUT /:id", async () => {
      const res = await request(build(), "PUT", "/members/mine", { key: "chosen", name: "Z" });
      expect(res.status).toBe(200);
      expect(await row("chosen")).toBeUndefined();
      expect(await row("mine")).toMatchObject({ name: "Z" });
    });

    it("is stripped on PATCH /batch", async () => {
      await request(build(), "PATCH", `/members/batch${only}`, { key: "chosen", name: "Z" });
      expect(await row("chosen")).toBeUndefined();
      expect(await row("mine")).toMatchObject({ name: "Z" });
    });

    it("is stripped even when it is a generated field", async () => {
      await request(build({ generatedFields: [members.key] }), "PATCH", "/members/mine", { key: "chosen", name: "Z" });
      expect(await row("chosen")).toBeUndefined();
    });

    it.each(["PATCH", "PUT"])("%s carrying only stripped columns returns the unchanged row", async (method) => {
      const res = await request(build(), method, "/members/mine", { key: "mine", role: "admin" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: "mine", role: "user" });
    });

    it("can change when explicitly writable", async () => {
      const app = build({ fields: { writable: [members.key, members.name] } });
      expect((await request(app, "PATCH", "/members/mine", { key: "renamed" })).status).toBe(200);
      expect(await row("renamed")).toBeDefined();
    });

    it("can still be supplied on create", async () => {
      const res = await request(build(), "POST", "/members", { key: "fresh", name: "C" });
      expect(res.status).toBe(201);
      expect(res.body.key).toBe("fresh");
    });
  });

  describe("POST /batch/upsert honors the update scope", () => {
    const scoped = () =>
      build({ auth: { create: async () => rsql`ownerId=="u1"`, update: async (u: any) => rsql`ownerId==${u.id}` } });

    it("cannot overwrite a row outside the scope", async () => {
      const res = await request(scoped(), "POST", "/members/batch/upsert", { items: [{ key: "theirs", name: "Owned" }] });
      expect(res.status).toBe(404);
      expect(await row("theirs")).toMatchObject({ name: "Bob" });
    });

    it("applies none of a mixed batch", async () => {
      const res = await request(scoped(), "POST", "/members/batch/upsert", {
        items: [{ key: "mine", name: "Changed" }, { key: "theirs", name: "Owned" }],
      });
      expect(res.status).toBe(404);
      expect(await row("mine")).toMatchObject({ name: "Ann" });
    });

    it("cannot be redirected to another row by a hook", async () => {
      const app = build({
        auth: { create: async () => rsql`ownerId=="u1"`, update: async () => rsql`ownerId=="u1"` },
        hooks: { onBeforeCreate: async (_: unknown, data: object) => ({ ...data, key: "theirs" }) },
      });
      const res = await request(app, "POST", "/members/batch/upsert", { items: [{ key: "unused", name: "Owned" }] });
      expect(res.status).toBe(404);
      expect(await row("theirs")).toMatchObject({ name: "Bob" });
    });

    it("updates rows in scope and inserts new ones", async () => {
      const res = await request(scoped(), "POST", "/members/batch/upsert", {
        items: [{ key: "mine", name: "Changed" }, { key: "new", name: "New" }],
      });
      expect(res.status).toBe(200);
      expect(await row("mine")).toMatchObject({ name: "Changed" });
      expect(await row("new")).toMatchObject({ name: "New" });
    });
  });
});
