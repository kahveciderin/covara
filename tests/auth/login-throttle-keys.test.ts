import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { LoginThrottle } from "@/auth/login-throttle";
import { useAuth } from "@/auth/routes";
import { cookieSession } from "@/auth/session";
import { errorHandler } from "@/middleware/error";

const IP = "203.0.113.5";

const fail = async (t: LoginThrottle, id: string, n: number, ip = IP) => {
  for (let i = 0; i < n; i++) await t.recordFailure(id, ip);
};

describe("LoginThrottle limits per key", () => {
  it("by default both keys share maxAttempts, as before", async () => {
    const t = new LoginThrottle({ maxAttempts: 3 });
    await fail(t, "a@x", 1);
    await fail(t, "b@x", 1);
    await fail(t, "c@x", 1);
    expect((await t.check("d@x", IP)).locked).toBe(true);
  });

  it("perIp: false never locks an address, the identifier still locks", async () => {
    const t = new LoginThrottle({ maxAttempts: 3, perIp: false });
    for (let i = 0; i < 20; i++) await fail(t, `user${i}@x`, 1);
    expect((await t.check("someone@x", IP)).locked).toBe(false);
    await fail(t, "a@x", 3);
    expect((await t.check("a@x", "198.51.100.1")).locked).toBe(true);
  });

  it("separate limits: an identifier locks at its own, the address at its own", async () => {
    const t = new LoginThrottle({ perIdentifier: 2, perIp: 5 });
    await fail(t, "a@x", 2);
    expect((await t.check("a@x", IP)).locked).toBe(true);
    expect((await t.check("b@x", IP)).locked).toBe(false);
    await fail(t, "b@x", 1);
    await fail(t, "c@x", 1);
    await fail(t, "d@x", 1);
    expect((await t.check("e@x", IP)).locked).toBe(true);
    expect((await t.check("e@x", "198.51.100.1")).locked).toBe(false);
  });

  it("perIdentifier: false keys on the address only", async () => {
    const t = new LoginThrottle({ maxAttempts: 2, perIdentifier: false });
    await fail(t, "a@x", 1, "198.51.100.1");
    await fail(t, "a@x", 1, "198.51.100.2");
    expect((await t.check("a@x", "198.51.100.3")).locked).toBe(false);
    await fail(t, "b@x", 2);
    expect((await t.check("z@x", IP)).locked).toBe(true);
  });

  it("recordFailure reports locked from the key that crossed its limit", async () => {
    const t = new LoginThrottle({ perIdentifier: 10, perIp: 2 });
    expect((await t.recordFailure("a@x", IP)).locked).toBe(false);
    const result = await t.recordFailure("b@x", IP);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a keys hook chooses the keys and their limits, and gets the context", async () => {
    const seen: unknown[] = [];
    const t = new LoginThrottle({
      maxAttempts: 2,
      keys: (identifier, ip, c) => {
        seen.push(c);
        return [`tenant:${identifier.split("@")[1]}`, { key: `id:${identifier}`, maxAttempts: 5 }];
      },
    });
    await fail(t, "a@acme", 1);
    await fail(t, "b@acme", 1);
    expect((await t.check("c@acme", "198.51.100.9")).locked).toBe(true);
    expect((await t.check("c@other", IP)).locked).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("reset clears the hook's keys", async () => {
    const t = new LoginThrottle({ maxAttempts: 1, keys: (identifier) => [`k:${identifier}`] });
    await fail(t, "a@x", 1);
    expect((await t.check("a@x", IP)).locked).toBe(true);
    await t.reset("a@x", IP);
    expect((await t.check("a@x", IP)).locked).toBe(false);
  });

  it("rejects limits that are not positive integers", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => new LoginThrottle({ perIp: bad })).toThrow(/perIp/);
      expect(() => new LoginThrottle({ perIdentifier: bad })).toThrow(/perIdentifier/);
      expect(() => new LoginThrottle({ maxAttempts: bad })).toThrow(/maxAttempts/);
    }
  });

  it("through useAuth: an office behind one address isn't locked out by its staff's typos", async () => {
    const { router } = useAuth({
      session: cookieSession({ getUserById: async (id) => ({ id, email: "ok@office" }) }),
      login: {
        validateCredentials: async (email, password) => (password === "right" ? { id: "u1", email } : null),
      },
      throttle: { maxAttempts: 3, perIp: false },
    });
    const app = new Hono();
    app.onError(errorHandler);
    app.route("/auth", router);
    const login = (email: string, password: string) =>
      app.request(
        "/auth/login",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) },
        { incoming: { socket: { remoteAddress: IP } } }
      );
    for (let i = 0; i < 10; i++) expect((await login(`staff${i}@office`, "typo")).status).toBe(401);
    expect((await login("ok@office", "right")).status).toBe(200);
  });
});
