import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { cookieSession } from "@/auth/session";
import { BaseAuthAdapter } from "@/auth/adapter";
import { InMemorySessionStore, type AuthResult } from "@/auth/types";
import { beginShutdown, resetLifecycle } from "@/server/lifecycle";

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = async () => {
  const store = new InMemorySessionStore();
  await store.set(
    "s1",
    { id: "s1", userId: "u1", createdAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
    600_000
  );
  const write = store.set.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const set = vi.spyOn(store, "set").mockImplementation(async (...args) => {
    await gate;
    await write(...args);
  });
  const session = cookieSession({ store, getUserById: async (id) => ({ id }) });
  const app = new Hono();
  app.get("/me", async (c) => c.json({ ok: (await session.authenticate(c)).success }));
  app.post("/logout", async (c) => {
    await session.logout(c);
    return c.body(null, 204);
  });
  app.post("/revoke", async (c) => {
    await session.invalidateUserSessions!("u1");
    return c.body(null, 204);
  });
  const call = (path: string, method = "GET") => app.request(path, { method, headers: { cookie: "session=s1" } });
  return { store, set, call, release };
};

describe("session activity writes", () => {
  afterEach(() => resetLifecycle());

  it("do not delay authentication", async () => {
    const { call, release } = await setup();
    expect(await (await call("/me")).json()).toEqual({ ok: true });
    release();
  });

  it("are awaited by beginShutdown", async () => {
    const { call, release } = await setup();
    await call("/me");
    let done = false;
    const shutdown = beginShutdown().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await shutdown;
    expect(done).toBe(true);
  });

  it("are awaited by every concurrent beginShutdown caller", async () => {
    const { call, release } = await setup();
    await call("/me");
    const first = beginShutdown();
    let done = false;
    const second = beginShutdown().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await Promise.all([first, second]);
  });

  it("are not started once shutdown has begun", async () => {
    const { call, set, release } = await setup();
    release();
    await beginShutdown();
    expect(await (await call("/me")).json()).toEqual({ ok: true });
    expect(set).not.toHaveBeenCalled();
  });

  it("a failing write does not fail shutdown", async () => {
    const { call, set } = await setup();
    set.mockRejectedValueOnce(new Error("store down"));
    await call("/me");
    await expect(beginShutdown()).resolves.toBeUndefined();
  });

  it.each(["/logout", "/revoke"])("cannot resurrect a session removed by %s", async (path) => {
    const { call, store, release } = await setup();
    await call("/me");
    const removal = call(path, "POST");
    await tick();
    release();
    await removal;
    await tick();
    expect(await store.get("s1")).toBeNull();
  });

  it.each(["/logout", "/revoke"])(
    "a write that never settles (orphaned on Workers) cannot hang %s",
    async (path) => {
      const { call, store, set } = await setup();
      set.mockImplementation(() => new Promise<void>(() => {}));
      await call("/me");
      expect((await call(path, "POST")).status).toBe(204);
      expect(await store.get("s1")).toBeNull();
    },
    8000
  );

  it("from a legacy adapter are awaited too", async () => {
    const { store, release } = await setup();
    class Adapter extends BaseAuthAdapter {
      name = "test";
      async validateCredentials(): Promise<AuthResult> {
        return { success: false };
      }
    }
    await new Adapter({ sessionStore: store }).getSession("s1");
    let done = false;
    const shutdown = beginShutdown().then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    release();
    await shutdown;
  });
});
