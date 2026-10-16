import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { useAuth, type AuthUser, type UseAuthOptions } from "@/auth/routes";
import { cookieSession, jwtSession } from "@/auth/session";
import { InMemorySessionStore } from "@/auth/types";
import { errorHandler } from "@/middleware/error";
import {
  InMemoryPasskeyStore,
  InMemoryPasskeyChallengeStore,
  type PasskeyAuthOptions,
  type PasskeyStore,
} from "@/auth/passkey";
import { abuseProtection, clearGlobalAbuseProtection } from "@/abuse/config";
import { clearBudgetMemoryForTests } from "@/abuse/budget";
import { clearReplayCacheForTests } from "@/pow/server";
import { clearGlobalKV } from "@/kv";
import { createFakeAuthenticator, type FakeAlg } from "../helpers/webauthn";

const ORIGIN = "https://app.example.com";
const RP_ID = "app.example.com";

interface DbUser extends AuthUser {
  password: string;
}

let users: Map<string, DbUser>;
let store: PasskeyStore;

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

type Json = Record<string, any>;

const buildApp = (
  passkey: Partial<PasskeyAuthOptions> = {},
  extra: Partial<UseAuthOptions> = {}
) => {
  const getUserById = async (id: string) => {
    const u = users.get(id);
    return u ? { id: u.id, email: u.email, name: u.name } : null;
  };
  const { router, middleware } = useAuth({
    session: cookieSession({ getUserById, store: new InMemorySessionStore() }),
    login: {
      validateCredentials: async (email, password) => {
        const u = [...users.values()].find((x) => x.email === email && x.password === password);
        return u ? { id: u.id, email: u.email, name: u.name } : null;
      },
    },
    passkey: {
      rpId: RP_ID,
      rpName: "Example",
      origin: ORIGIN,
      store,
      findUserByEmail: async (email) =>
        [...users.values()].find((u) => u.email === email) ?? null,
      ...passkey,
    },
    ...extra,
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/auth", router);
  app.use("*", middleware);
  return app;
};

const post = (app: Hono, path: string, body: unknown = {}, cookie = "") =>
  app.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const loginWithPassword = async (app: Hono, email = "a@b.com", password = "pw") => {
  const res = await post(app, "/login", { email, password });
  expect(res.status).toBe(200);
  return cookieOf(res, "session");
};

const registerPasskey = async (
  app: Hono,
  cookie: string,
  alg: FakeAlg = "ES256",
  name?: string
) => {
  const authenticator = createFakeAuthenticator({ alg, origin: ORIGIN, rpId: RP_ID });
  const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
  const res = await post(
    app,
    "/passkey/register/verify",
    { response: authenticator.register(options as never), name },
    cookie
  );
  expect(res.status).toBe(200);
  return authenticator;
};

const loginOptions = async (app: Hono, body: Json = {}) => {
  const res = await post(app, "/passkey/login/options", body);
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
};

beforeEach(() => {
  users = new Map([
    ["u-1", { id: "u-1", email: "a@b.com", name: "Ada", password: "pw" }],
    ["u-2", { id: "u-2", email: "c@d.com", name: "Cy", password: "pw2" }],
  ]);
  store = new InMemoryPasskeyStore();
  clearGlobalAbuseProtection();
  clearGlobalKV();
  clearBudgetMemoryForTests();
  clearReplayCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  clearGlobalAbuseProtection();
});

describe("passkey configuration", () => {
  it("rejects a missing rpId or origin at setup time", () => {
    expect(() => buildApp({ rpId: "" })).toThrow(/rpId/);
    expect(() => buildApp({ origin: [] })).toThrow(/origin/);
  });
});

describe("passkey registration", () => {
  it("requires an authenticated user for options and verify", async () => {
    const app = buildApp();
    expect((await post(app, "/passkey/register/options")).status).toBe(401);
    expect((await post(app, "/passkey/register/verify", { response: {} })).status).toBe(401);
  });

  it("returns creation options bound to the rp and user", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    expect(options.rp).toEqual({ id: RP_ID, name: "Example" });
    expect(options.user.name).toBe("a@b.com");
    expect(options.user.displayName).toBe("Ada");
    expect(options.user.id).not.toContain("u-1");
    expect(typeof options.challenge).toBe("string");
    expect(options.excludeCredentials).toEqual([]);
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: "preferred",
      userVerification: "preferred",
    });
    expect(options.pubKeyCredParams.map((p: Json) => p.alg)).toEqual(
      expect.arrayContaining([-7, -257])
    );
  });

  it.each<FakeAlg>(["ES256", "RS256"])("registers an %s credential and lists it", async (alg) => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie, alg, "Laptop");

    const stored = await store.findById(authenticator.id);
    expect(stored?.userId).toBe("u-1");
    expect(stored?.counter).toBe(0);
    expect(stored?.transports).toEqual(["internal"]);

    const list = await app.request("/api/auth/passkey/credentials", { headers: { cookie } });
    const body = (await list.json()) as Json;
    expect(body.passkeys).toHaveLength(1);
    expect(body.passkeys[0]).toMatchObject({ id: authenticator.id, name: "Laptop" });
    expect(body.passkeys[0].publicKey).toBeUndefined();
  });

  it("reuses one stable user handle for every passkey of a user and excludes existing credentials", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const first = await registerPasskey(app, cookie);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    expect(options.user.id).toBe(first.userHandle);
    expect(options.excludeCredentials.map((c: Json) => c.id)).toEqual([first.id]);
  });

  it("rejects registering the same credential id twice (409)", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const o1 = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    expect(
      (await post(app, "/passkey/register/verify", { response: authenticator.register(o1 as never) }, cookie)).status
    ).toBe(200);
    const o2 = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const dup = await post(app, "/passkey/register/verify", { response: authenticator.register(o2 as never) }, cookie);
    expect(dup.status).toBe(409);
  });

  it("refuses to register a credential id already owned by another user", async () => {
    const app = buildApp();
    const cookieA = await loginWithPassword(app);
    const cookieB = await loginWithPassword(app, "c@d.com", "pw2");
    const authenticator = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const o1 = (await (await post(app, "/passkey/register/options", {}, cookieA)).json()) as Json;
    await post(app, "/passkey/register/verify", { response: authenticator.register(o1 as never) }, cookieA);
    const o2 = (await (await post(app, "/passkey/register/options", {}, cookieB)).json()) as Json;
    const res = await post(app, "/passkey/register/verify", { response: authenticator.register(o2 as never) }, cookieB);
    expect(res.status).toBe(409);
    expect((await store.findById(authenticator.id))?.userId).toBe("u-1");
  });

  it("rejects a challenge issued to a different user", async () => {
    const app = buildApp();
    const cookieA = await loginWithPassword(app);
    const cookieB = await loginWithPassword(app, "c@d.com", "pw2");
    const authenticator = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const optionsForA = (await (await post(app, "/passkey/register/options", {}, cookieA)).json()) as Json;
    const res = await post(
      app,
      "/passkey/register/verify",
      { response: authenticator.register(optionsForA as never) },
      cookieB
    );
    expect(res.status).toBe(400);
    expect(await store.listByUser("u-2")).toHaveLength(0);
  });

  it("rejects a replayed registration challenge", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const b = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    expect((await post(app, "/passkey/register/verify", { response: a.register(options as never) }, cookie)).status).toBe(200);
    expect((await post(app, "/passkey/register/verify", { response: b.register(options as never) }, cookie)).status).toBe(400);
  });

  it("rejects an expired registration challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = buildApp({ challengeTtlMs: 1000 });
    const cookie = await loginWithPassword(app);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    vi.setSystemTime(Date.now() + 2000);
    const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const res = await post(app, "/passkey/register/verify", { response: a.register(options as never) }, cookie);
    expect(res.status).toBe(400);
  });

  it("rejects a challenge that was never issued", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const res = await post(
      app,
      "/passkey/register/verify",
      { response: a.register(options as never, { challenge: "bm90LWlzc3VlZA" }) },
      cookie
    );
    expect(res.status).toBe(400);
  });

  it("rejects an authentication challenge used for registration", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const creation = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const request = await loginOptions(app);
    const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const res = await post(
      app,
      "/passkey/register/verify",
      { response: a.register(creation as never, { challenge: request.challenge }) },
      cookie
    );
    expect(res.status).toBe(400);
  });

  it("rejects a wrong origin, wrong rpId and wrong clientData type", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    for (const overrides of [
      { origin: "https://evil.example.com" },
      { rpId: "evil.example.com" },
      { type: "webauthn.get" },
    ]) {
      const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
      const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
      const res = await post(
        app,
        "/passkey/register/verify",
        { response: a.register(options as never, overrides) },
        cookie
      );
      expect(res.status).toBe(400);
    }
    expect(await store.listByUser("u-1")).toHaveLength(0);
  });

  it("accepts any of several configured origins", async () => {
    const app = buildApp({ origin: ["https://other.example.com", ORIGIN] });
    const cookie = await loginWithPassword(app);
    await registerPasskey(app, cookie);
  });

  it("requires user verification only when configured as required", async () => {
    const preferred = buildApp();
    const c1 = await loginWithPassword(preferred);
    const o1 = (await (await post(preferred, "/passkey/register/options", {}, c1)).json()) as Json;
    const a1 = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    expect((await post(preferred, "/passkey/register/verify", { response: a1.register(o1 as never, { uv: false }) }, c1)).status).toBe(200);

    const required = buildApp({ userVerification: "required" });
    const c2 = await loginWithPassword(required);
    const o2 = (await (await post(required, "/passkey/register/options", {}, c2)).json()) as Json;
    expect(o2.authenticatorSelection.userVerification).toBe("required");
    const a2 = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    expect((await post(required, "/passkey/register/verify", { response: a2.register(o2 as never, { uv: false }) }, c2)).status).toBe(400);
  });

  it("rejects a response without user presence", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const options = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const a = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const res = await post(app, "/passkey/register/verify", { response: a.register(options as never, { up: false }) }, cookie);
    expect(res.status).toBe(400);
  });

  it("rejects malformed verify bodies with 400", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    for (const body of [{}, { response: null }, { response: { id: "x" } }, { response: { id: "x", response: { clientDataJSON: "!!" } } }]) {
      expect((await post(app, "/passkey/register/verify", body, cookie)).status).toBe(400);
    }
  });

  it("enforces maxPerUser", async () => {
    const app = buildApp({ maxPerUser: 1 });
    const cookie = await loginWithPassword(app);
    await registerPasskey(app, cookie);
    expect((await post(app, "/passkey/register/options", {}, cookie)).status).toBe(409);
  });

  it("fires onRegister with the stored passkey", async () => {
    const onRegister = vi.fn();
    const app = buildApp({ onRegister });
    const cookie = await loginWithPassword(app);
    const a = await registerPasskey(app, cookie);
    expect(onRegister).toHaveBeenCalledTimes(1);
    expect(onRegister.mock.calls[0][0]).toMatchObject({ id: a.id, userId: "u-1" });
  });
});

describe("passkey authentication", () => {
  const setup = async (passkey: Partial<PasskeyAuthOptions> = {}, extra: Partial<UseAuthOptions> = {}) => {
    const app = buildApp(passkey, extra);
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie);
    return { app, authenticator };
  };

  it("logs in with a discoverable credential (usernameless) and issues a cookie session", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.rpId).toBe(RP_ID);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.user.id).toBe("u-1");
    expect(body.sessionId).toBeTruthy();
    const me = await app.request("/api/auth/me", { headers: { cookie: cookieOf(res, "session") } });
    expect(((await me.json()) as Json).user.id).toBe("u-1");
  });

  it.each<FakeAlg>(["ES256", "RS256"])("verifies %s assertions and advances the stored counter", async (alg) => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie, alg);
    for (let i = 1; i <= 2; i++) {
      const options = await loginOptions(app);
      const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
      expect(res.status).toBe(200);
      const stored = await store.findById(authenticator.id);
      expect(stored?.counter).toBe(i);
      expect(stored?.lastUsedAt).toBeInstanceOf(Date);
    }
  });

  it("issues a JWT with jwtSession", async () => {
    const getUserById = async (id: string) => users.get(id) ?? null;
    const app = buildApp({}, {
      session: jwtSession({ getUserById, secret: "passkey-secret-0123456789", refreshStore: new InMemorySessionStore() }),
    });
    const login = (await (await post(app, "/login", { email: "a@b.com", password: "pw" })).json()) as Json;
    const auth = `Bearer ${login.accessToken}`;
    const authenticator = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const creation = (await (
      await app.request("/api/auth/passkey/register/options", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as Json;
    const reg = await app.request("/api/auth/passkey/register/verify", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ response: authenticator.register(creation as never) }),
    });
    expect(reg.status).toBe(200);

    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.accessToken).toBeTruthy();
    expect(body.tokenType).toBe("Bearer");
  });

  it("fires onLogin like a password login", async () => {
    const onLogin = vi.fn();
    const { app, authenticator } = await setup({}, { onLogin });
    onLogin.mockClear();
    const options = await loginOptions(app);
    await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(onLogin.mock.calls[0][0].id).toBe("u-1");
  });

  it("scopes allowCredentials to the user when an email is given", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app, { email: "a@b.com" });
    expect(options.allowCredentials.map((c: Json) => c.id)).toEqual([authenticator.id]);
    expect(options.allowCredentials[0].transports).toEqual(["internal"]);
  });

  it("returns usernameless options for an unknown email (no account enumeration)", async () => {
    const { app } = await setup();
    const options = await loginOptions(app, { email: "nobody@x.com" });
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it("an unknown-email challenge cannot be completed with someone else's discoverable passkey", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app, { email: "nobody@x.com" });
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("rejects a credential owned by a different user than the email-scoped challenge", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app, { email: "c@d.com" });
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown credential", async () => {
    const { app } = await setup();
    const stranger = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", { response: stranger.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("rejects a forged signature", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(options as never, { tamperSignature: true }),
    });
    expect(res.status).toBe(401);
    expect((await store.findById(authenticator.id))?.counter).toBe(0);
  });

  it("rejects a replayed assertion and a replayed challenge", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    const assertion = authenticator.authenticate(options as never);
    expect((await post(app, "/passkey/login/verify", { response: assertion })).status).toBe(200);
    expect((await post(app, "/passkey/login/verify", { response: assertion })).status).toBe(401);
    const second = authenticator.authenticate(options as never);
    expect((await post(app, "/passkey/login/verify", { response: second })).status).toBe(401);
  });

  it("consumes the challenge even when verification fails", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(options as never, { origin: "https://evil.example.com" }),
    });
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("rejects an expired challenge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, authenticator } = await setup({ challengeTtlMs: 1000 });
    const options = await loginOptions(app);
    vi.setSystemTime(Date.now() + 1500);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("rejects wrong origin, wrong rpId, wrong type and cross-origin iframes", async () => {
    const { app, authenticator } = await setup();
    for (const overrides of [
      { origin: "https://evil.example.com" },
      { rpId: "evil.example.com" },
      { type: "webauthn.create" },
      { origin: "http://app.example.com" },
    ]) {
      const options = await loginOptions(app);
      const res = await post(app, "/passkey/login/verify", {
        response: authenticator.authenticate(options as never, overrides),
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects a registration challenge used for authentication", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie);
    const creation = (await (await post(app, "/passkey/register/options", {}, cookie)).json()) as Json;
    const res = await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate({ challenge: creation.challenge, rpId: RP_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a userHandle that does not match the credential's user", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(options as never, { userHandle: "b3RoZXItdXNlcg" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts an assertion without a userHandle (non-discoverable credential)", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app, { email: "a@b.com" });
    const res = await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(options as never, { userHandle: null }),
    });
    expect(res.status).toBe(200);
  });

  it("detects signCount regression, rejects it and reports it", async () => {
    const onCounterRegression = vi.fn();
    const { app, authenticator } = await setup({ onCounterRegression });
    const o1 = await loginOptions(app);
    expect((await post(app, "/passkey/login/verify", { response: authenticator.authenticate(o1 as never, { counter: 5 }) })).status).toBe(200);
    for (const counter of [5, 3]) {
      const options = await loginOptions(app);
      const res = await post(app, "/passkey/login/verify", {
        response: authenticator.authenticate(options as never, { counter }),
      });
      expect(res.status).toBe(401);
    }
    expect(onCounterRegression).toHaveBeenCalledTimes(2);
    expect(onCounterRegression.mock.calls[0][0]).toMatchObject({ id: authenticator.id, storedCounter: 5, receivedCounter: 5 });
    expect((await store.findById(authenticator.id))?.counter).toBe(5);
  });

  it("does not report counter regression for a forged signature", async () => {
    const onCounterRegression = vi.fn();
    const { app, authenticator } = await setup({ onCounterRegression });
    const o1 = await loginOptions(app);
    await post(app, "/passkey/login/verify", { response: authenticator.authenticate(o1 as never, { counter: 5 }) });
    const o2 = await loginOptions(app);
    await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(o2 as never, { counter: 1, tamperSignature: true }),
    });
    expect(onCounterRegression).not.toHaveBeenCalled();
  });

  it("allows authenticators that never increment the counter (always 0)", async () => {
    const { app, authenticator } = await setup();
    for (let i = 0; i < 2; i++) {
      const options = await loginOptions(app);
      const res = await post(app, "/passkey/login/verify", {
        response: authenticator.authenticate(options as never, { counter: 0 }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects login when the user no longer exists", async () => {
    const { app, authenticator } = await setup();
    users.delete("u-1");
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
    expect(cookieOf(res, "session")).toBe("");
  });

  it("enforces user verification when required, and not when preferred", async () => {
    const { app, authenticator } = await setup();
    const o1 = await loginOptions(app);
    expect((await post(app, "/passkey/login/verify", { response: authenticator.authenticate(o1 as never, { uv: false }) })).status).toBe(200);

    const strict = buildApp({ userVerification: "required" });
    const o2 = await loginOptions(strict);
    expect(o2.userVerification).toBe("required");
    const res = await post(strict, "/passkey/login/verify", { response: authenticator.authenticate(o2 as never, { uv: false }) });
    expect(res.status).toBe(401);
  });

  it("rejects an assertion without user presence", async () => {
    const { app, authenticator } = await setup();
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", {
      response: authenticator.authenticate(options as never, { up: false }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects malformed login bodies", async () => {
    const { app } = await setup();
    for (const body of [{}, { response: "x" }, { response: { id: "a", response: {} } }]) {
      const res = await post(app, "/passkey/login/verify", body);
      expect([400, 401]).toContain(res.status);
    }
  });

  it("locks out a credential after repeated failures when throttling is on", async () => {
    const { app, authenticator } = await setup({}, { throttle: { maxAttempts: 2 } });
    for (let i = 0; i < 2; i++) {
      const options = await loginOptions(app);
      await post(app, "/passkey/login/verify", {
        response: authenticator.authenticate(options as never, { tamperSignature: true }),
      });
    }
    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(429);
  });
});

describe("passkey management", () => {
  it("lists only the caller's passkeys and requires auth", async () => {
    const app = buildApp();
    const a = await loginWithPassword(app);
    const b = await loginWithPassword(app, "c@d.com", "pw2");
    await registerPasskey(app, a);
    await registerPasskey(app, b);
    const list = (await (await app.request("/api/auth/passkey/credentials", { headers: { cookie: a } })).json()) as Json;
    expect(list.passkeys).toHaveLength(1);
    expect((await app.request("/api/auth/passkey/credentials")).status).toBe(401);
  });

  it("renames and deletes own passkeys; a deleted passkey can no longer log in", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie);
    const path = `/api/auth/passkey/credentials/${authenticator.id}`;

    const renamed = await app.request(path, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Phone" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Json).passkey.name).toBe("Phone");

    expect((await app.request(path, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await store.findById(authenticator.id)).toBeNull();

    const options = await loginOptions(app);
    const res = await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when renaming or deleting another user's passkey", async () => {
    const app = buildApp();
    const a = await loginWithPassword(app);
    const b = await loginWithPassword(app, "c@d.com", "pw2");
    const authenticator = await registerPasskey(app, a);
    const path = `/api/auth/passkey/credentials/${authenticator.id}`;
    expect((await app.request(path, { method: "DELETE", headers: { cookie: b } })).status).toBe(404);
    expect(
      (await app.request(path, {
        method: "PATCH",
        headers: { cookie: b, "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      })).status
    ).toBe(404);
    expect(await store.findById(authenticator.id)).not.toBeNull();
  });

  it("validates the rename body", async () => {
    const app = buildApp();
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie);
    const res = await app.request(`/api/auth/passkey/credentials/${authenticator.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("passkey abuse protection", () => {
  beforeEach(() => {
    process.env.COVARA_POW_SECRET = "passkey-test-secret";
  });
  afterEach(() => {
    delete process.env.COVARA_POW_SECRET;
  });

  it("charges failed passkey logins and challenges with PoW once exhausted", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 } } },
    });
    const app = buildApp({ cost: { failed: 20 } });
    const stranger = createFakeAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const o1 = await loginOptions(app);
    expect((await post(app, "/passkey/login/verify", { response: stranger.authenticate(o1 as never) })).status).toBe(401);
    const o2 = await loginOptions(app);
    expect((await post(app, "/passkey/login/verify", { response: stranger.authenticate(o2 as never) })).status).toBe(428);
  });

  it("does not charge successful passkey logins", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 30, refillPerMinute: 0 }, authenticated: { capacity: 1000, refillPerMinute: 0 } } },
    });
    const app = buildApp({ cost: { failed: 20 } });
    const cookie = await loginWithPassword(app);
    const authenticator = await registerPasskey(app, cookie);
    for (let i = 0; i < 3; i++) {
      const options = await loginOptions(app);
      expect((await post(app, "/passkey/login/verify", { response: authenticator.authenticate(options as never) })).status).toBe(200);
    }
  });

  it("charges the unauthenticated options endpoint", async () => {
    abuseProtection({
      budget: { enabled: true, classes: { anonymous: { capacity: 10, refillPerMinute: 0 } } },
      pow: { enabled: false },
    });
    const app = buildApp({ cost: { options: 6 } });
    expect((await post(app, "/passkey/login/options")).status).toBe(200);
    expect((await post(app, "/passkey/login/options")).status).toBe(429);
  });
});

describe("passkey challenge store", () => {
  it("defaults to a KV-backed challenge store when a global KV is set", async () => {
    const { setGlobalKV, createMemoryKV } = await import("@/kv");
    const kv = createMemoryKV();
    await kv.connect();
    setGlobalKV(kv);
    const app = buildApp();
    const options = await loginOptions(app);
    const keys = await kv.keys("covara:passkey:challenge:*");
    expect(keys.some((k) => k.endsWith(options.challenge))).toBe(true);
    clearGlobalKV();
  });

  it("an explicit challenge store is used and consumed once", async () => {
    const challengeStore = new InMemoryPasskeyChallengeStore();
    const app = buildApp({ challengeStore });
    const options = await loginOptions(app);
    expect(await challengeStore.consume(options.challenge)).toMatchObject({ purpose: "authentication" });
    expect(await challengeStore.consume(options.challenge)).toBeNull();
  });
});
