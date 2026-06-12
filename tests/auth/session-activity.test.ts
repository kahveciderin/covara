import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createPassportAdapter } from "@/auth/adapters/passport";
import { useAuth } from "@/auth/routes";
import { InMemorySessionStore } from "@/auth/types";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("session activity tracking", () => {
  it("stamps lastActiveAt in session.data when the session is used", async () => {
    const store = new InMemorySessionStore();
    const adapter = createPassportAdapter({
      getUserById: async (id) => ({ id, email: `${id}@test.com` }),
      sessionStore: store,
    });

    const session = await adapter.createSession("u1");
    expect(session.data?.lastActiveAt).toBeUndefined();

    await adapter.getSession(session.id);
    await flush();

    const stored = await store.get(session.id);
    expect(typeof stored?.data?.lastActiveAt).toBe("number");
  });

  it("throttles activity writes (no re-stamp within a minute)", async () => {
    const store = new InMemorySessionStore();
    const adapter = createPassportAdapter({
      getUserById: async (id) => ({ id, email: `${id}@test.com` }),
      sessionStore: store,
    });

    const session = await adapter.createSession("u1");
    await adapter.getSession(session.id);
    await flush();
    const first = (await store.get(session.id))?.data?.lastActiveAt;

    await adapter.getSession(session.id);
    await flush();
    const second = (await store.get(session.id))?.data?.lastActiveAt;

    expect(second).toBe(first);
  });

  it("captures IP and user agent on login", async () => {
    const store = new InMemorySessionStore();
    const adapter = createPassportAdapter({
      getUserById: async (id) => ({ id, email: `${id}@test.com` }),
      sessionStore: store,
    });
    const { router } = useAuth({
      adapter,
      login: {
        validateCredentials: async (email) => ({ id: "u1", email }),
      },
    });
    const app = new Hono();
    app.route("/auth", router);

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "covara-test-browser/1.0",
      },
      body: JSON.stringify({ email: "a@b.com", password: "x" }),
    });
    expect(res.status).toBe(200);

    const sessions = await store.getAll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].data?.ipAddress).toBe("203.0.113.7");
    expect(sessions[0].data?.userAgent).toBe("covara-test-browser/1.0");
  });
});
