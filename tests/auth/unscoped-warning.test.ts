import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  createScopeResolver,
  resetUnscopedWarnings,
  warnUnscopedOperations,
} from "@/auth/scope";
import { allScope, rsql } from "@/auth/rsql";

describe("unscoped operation warning", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    resetUnscopedWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it("lists every operation when no auth config is given", () => {
    warnUnscopedOperations(createScopeResolver(undefined, "todos"), "todos");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"todos"');
    expect(warn.mock.calls[0][0]).toContain("read, create, update, delete, subscribe");
  });

  it("does not warn when a catch-all scope covers every operation", () => {
    const resolver = createScopeResolver(
      { scope: async (user) => rsql`userId==${user.id}` },
      "todos"
    );
    warnUnscopedOperations(resolver, "todos");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an explicit allScope() as a declared scope", () => {
    warnUnscopedOperations(
      createScopeResolver({ scope: async () => allScope() }, "todos"),
      "todos"
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("lists only the operations missing a scope", () => {
    const resolver = createScopeResolver(
      {
        read: async () => allScope(),
        update: async (user) => rsql`userId==${user.id}`,
      },
      "todos"
    );
    warnUnscopedOperations(resolver, "todos");
    expect(warn.mock.calls[0][0]).toContain("for: create, delete.");
  });

  it("subscribe inherits the read scope", () => {
    const resolver = createScopeResolver({ read: async () => allScope() }, "todos");
    expect(resolver.unscopedOperations()).not.toContain("subscribe");
  });

  it("does not count public operations as unscoped", () => {
    expect(createScopeResolver({ public: true }, "posts").unscopedOperations()).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(
      createScopeResolver(
        { public: { read: true, subscribe: true, create: true, update: true, delete: true } },
        "posts"
      ).unscopedOperations()
    ).toEqual([]);
  });

  it("warns once per resource", () => {
    const resolver = createScopeResolver(undefined, "todos");
    warnUnscopedOperations(resolver, "todos");
    warnUnscopedOperations(resolver, "todos");
    warnUnscopedOperations(createScopeResolver(undefined, "notes"), "notes");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("is silent under NODE_ENV=test", () => {
    vi.stubEnv("NODE_ENV", "test");
    warnUnscopedOperations(createScopeResolver(undefined, "todos"), "todos");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fires from useResource", async () => {
    const { useResource } = await import("@/resource/hook");
    const { drizzle } = await import("drizzle-orm/libsql");
    const { createClient } = await import("@libsql/client");
    const widgets = sqliteTable("widgets_unscoped", { id: text("id").primaryKey() });
    const db = drizzle(createClient({ url: ":memory:" }));
    useResource(widgets, { db, id: widgets.id, auth: { read: async () => allScope() } });
    const call = warn.mock.calls.find((c) => String(c[0]).includes("has no auth scope"));
    expect(call?.[0]).toContain("create, update, delete");
  });
});
