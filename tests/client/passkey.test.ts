import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

await vi.hoisted(async () => {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "http://localhost:3000" });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const globals: Record<string, unknown> = {
    window: win,
    document: w.document,
    HTMLElement: w.HTMLElement,
    Node: w.Node,
    Element: w.Element,
    Text: w.Text,
    MutationObserver: w.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  cleanup();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
  for (const key of ["window", "document", "HTMLElement", "Node", "Element", "Text", "MutationObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

import { createElement } from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { Hono } from "hono";
import { useAuth as useAuthServer, type AuthUser } from "@/auth/routes";
import { cookieSession } from "@/auth/session";
import { InMemorySessionStore } from "@/auth/types";
import { InMemoryPasskeyStore } from "@/auth/passkey";
import { errorHandler } from "@/middleware/error";
import { useAuth, type UseAuthResult } from "@/client/react";
import { createClient } from "@/client";
import {
  base64urlToBuffer,
  bufferToBase64url,
  isPasskeySupported,
  isConditionalMediationAvailable,
} from "@/client/passkey";
import { createCookieFetch } from "../helpers/cookie-fetch";
import { createFakeAuthenticator, type FakeAuthenticator } from "../helpers/webauthn";

const BASE = "http://localhost:3000";

const users = new Map<string, AuthUser & { password: string }>([
  ["u-1", { id: "u-1", email: "a@b.com", name: "Ada", password: "pw" }],
]);

const buildServer = () => {
  const { router, middleware } = useAuthServer({
    session: cookieSession({
      getUserById: async (id) => users.get(id) ?? null,
      store: new InMemorySessionStore(),
    }),
    login: {
      validateCredentials: async (email, password) => {
        const user = [...users.values()].find((u) => u.email === email);
        return user && user.password === password ? { id: user.id, email: user.email, name: user.name } : null;
      },
    },
    passkey: {
      rpId: "localhost",
      rpName: "Test",
      origin: BASE,
      store: new InMemoryPasskeyStore(),
      findUserByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
    },
    csrf: true,
  });
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/api/auth", router);
  app.use("*", middleware);
  return app;
};

type Json = Record<string, any>;

const b64 = (v: ArrayBuffer | ArrayBufferView) => bufferToBase64url(v);
const buf = (s: string) => base64urlToBuffer(s);

const installAuthenticator = (authenticator: FakeAuthenticator) => {
  const calls: { create: Json[]; get: Json[] } = { create: [], get: [] };
  const credentials = {
    create: vi.fn(async ({ publicKey }: { publicKey: Json }) => {
      const json = {
        ...publicKey,
        challenge: b64(publicKey.challenge),
        user: { ...publicKey.user, id: b64(publicKey.user.id) },
        excludeCredentials: (publicKey.excludeCredentials ?? []).map((d: Json) => ({ ...d, id: b64(d.id) })),
      };
      calls.create.push(json);
      const r = authenticator.register(json as never);
      return {
        id: r.id,
        rawId: buf(r.rawId),
        type: r.type,
        authenticatorAttachment: r.authenticatorAttachment,
        response: {
          clientDataJSON: buf(r.response.clientDataJSON),
          attestationObject: buf(r.response.attestationObject),
          getTransports: () => r.response.transports,
        },
        getClientExtensionResults: () => ({}),
      };
    }),
    get: vi.fn(async (init: { publicKey: Json; mediation?: string }) => {
      const { publicKey } = init;
      const json = {
        ...publicKey,
        challenge: b64(publicKey.challenge),
        allowCredentials: (publicKey.allowCredentials ?? []).map((d: Json) => ({ ...d, id: b64(d.id) })),
        mediation: init.mediation,
      };
      calls.get.push(json);
      const r = authenticator.authenticate(json as never);
      return {
        id: r.id,
        rawId: buf(r.rawId),
        type: r.type,
        authenticatorAttachment: r.authenticatorAttachment,
        response: {
          clientDataJSON: buf(r.response.clientDataJSON),
          authenticatorData: buf(r.response.authenticatorData),
          signature: buf(r.response.signature),
          userHandle: r.response.userHandle ? buf(r.response.userHandle) : null,
        },
        getClientExtensionResults: () => ({}),
      };
    }),
  };
  vi.stubGlobal("navigator", { credentials });
  vi.stubGlobal(
    "PublicKeyCredential",
    class {
      static isConditionalMediationAvailable = async () => true;
    }
  );
  return calls;
};

describe("base64url helpers", () => {
  it("round-trips every length and matches Node's encoder", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 0xff);
      const encoded = bufferToBase64url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
      expect(new Uint8Array(base64urlToBuffer(encoded))).toEqual(bytes);
    }
  });

  it("accepts padded / standard base64 input and encodes views at an offset", () => {
    expect(new Uint8Array(base64urlToBuffer("+/8="))).toEqual(Uint8Array.of(0xfb, 0xff));
    const view = new Uint8Array([9, 1, 2, 3]).subarray(1);
    expect(bufferToBase64url(view)).toBe(Buffer.from([1, 2, 3]).toString("base64url"));
  });

  it("rejects invalid characters", () => {
    expect(() => base64urlToBuffer("ab$c")).toThrow(/base64url/);
  });
});

describe("feature detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports unsupported without WebAuthn, and the client says so", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(isPasskeySupported()).toBe(false);
    expect(await isConditionalMediationAvailable()).toBe(false);

    const app = buildServer();
    const browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await expect(client.session.loginWithPasskey()).rejects.toThrow(/not supported/);
    browser.reset();
  });

  it("reports support and conditional mediation when available", async () => {
    installAuthenticator(createFakeAuthenticator({ origin: BASE, rpId: "localhost" }));
    expect(isPasskeySupported()).toBe(true);
    expect(await isConditionalMediationAvailable()).toBe(true);
  });
});

describe("client.session passkeys against a real server", () => {
  let app: Hono;
  let browser: ReturnType<typeof createCookieFetch>;
  let authenticator: FakeAuthenticator;
  let calls: ReturnType<typeof installAuthenticator>;

  beforeEach(() => {
    app = buildServer();
    browser = createCookieFetch(app);
    vi.stubGlobal("fetch", browser.fetch);
    authenticator = createFakeAuthenticator({ origin: BASE, rpId: "localhost" });
    calls = installAuthenticator(authenticator);
  });

  afterEach(() => {
    browser.reset();
    vi.unstubAllGlobals();
  });

  it("registers, logs out, and logs back in usernameless", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await client.session.login("a@b.com", "pw");

    const passkey = await client.session.registerPasskey({ name: "Laptop" });
    expect(passkey).toMatchObject({ id: authenticator.id, name: "Laptop" });
    expect(calls.create[0].rp).toEqual({ id: "localhost", name: "Test" });

    await client.session.logout();
    expect(await client.session.me()).toBeNull();

    const result = await client.session.loginWithPasskey();
    expect((result.user as { id: string }).id).toBe("u-1");
    expect(calls.get[0].allowCredentials).toEqual([]);
    expect(await client.session.me<{ id: string }>()).toMatchObject({ id: "u-1" });
  });

  it("converts excludeCredentials and allowCredentials ids to buffers", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await client.session.login("a@b.com", "pw");
    await client.session.registerPasskey();

    const second = createFakeAuthenticator({ origin: BASE, rpId: "localhost" });
    calls = installAuthenticator(second);
    await client.session.registerPasskey();
    expect(calls.create[0].excludeCredentials.map((d: Json) => d.id)).toEqual([authenticator.id]);

    await client.session.logout();
    await client.session.loginWithPasskey({ email: "a@b.com", mediation: "conditional" });
    expect(calls.get[0].allowCredentials.map((d: Json) => d.id).sort()).toEqual(
      [authenticator.id, second.id].sort()
    );
    expect(calls.get[0].mediation).toBe("conditional");
  });

  it("lists, renames and deletes passkeys", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await client.session.login("a@b.com", "pw");
    await client.session.registerPasskey({ name: "Laptop" });

    const list = await client.session.listPasskeys();
    expect(list.map((p) => p.name)).toEqual(["Laptop"]);

    const renamed = await client.session.renamePasskey(authenticator.id, "Phone");
    expect(renamed.name).toBe("Phone");

    await client.session.deletePasskey(authenticator.id);
    expect(await client.session.listPasskeys()).toEqual([]);
  });

  it("surfaces the server's error when the passkey is unknown", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await expect(client.session.loginWithPasskey()).rejects.toThrow(/Passkey authentication failed/);
  });

  it("requires a session to register", async () => {
    const client = createClient({ baseUrl: BASE, credentials: "include" });
    await expect(client.session.registerPasskey()).rejects.toThrow(/Authentication required/);
    expect(calls.create).toHaveLength(0);
  });
});

let storeKey = 0;

describe("React useAuth() passkeys", () => {
  let browser: ReturnType<typeof createCookieFetch>;
  let authenticator: FakeAuthenticator;

  beforeEach(() => {
    browser = createCookieFetch(buildServer());
    vi.stubGlobal("fetch", browser.fetch);
    authenticator = createFakeAuthenticator({ origin: BASE, rpId: "localhost" });
    installAuthenticator(authenticator);
  });

  afterEach(() => {
    cleanup();
    browser.reset();
    vi.unstubAllGlobals();
  });

  const renderAuth = () => {
    const result: { current: UseAuthResult<{ id: string }> | null } = { current: null };
    const checkUrl = `/api/auth/me?t=${++storeKey}`;
    const Probe = () => {
      result.current = useAuth<{ id: string }>({ baseUrl: BASE, checkUrl });
      return null;
    };
    render(createElement(Probe));
    return result;
  };

  it("registers a passkey and logs in with it", async () => {
    const auth = renderAuth();
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));
    await act(() => auth.current!.login("a@b.com", "pw"));

    let passkey: { id: string } | undefined;
    await act(async () => {
      passkey = await auth.current!.registerPasskey({ name: "Laptop" });
    });
    expect(passkey?.id).toBe(authenticator.id);

    await act(() => auth.current!.logout());
    expect(auth.current!.status).toBe("unauthenticated");

    await act(() => auth.current!.loginWithPasskey());
    await waitFor(() => expect(auth.current!.user?.id).toBe("u-1"));
    const verify = browser.requests.find((r) => r.path === "/api/auth/passkey/login/verify")!;
    expect(verify.headers.get("x-csrf-token")).toBeTruthy();
  });

  it("rejects with the server's message on failure", async () => {
    const auth = renderAuth();
    await waitFor(() => expect(auth.current!.status).toBe("unauthenticated"));
    await expect(auth.current!.loginWithPasskey()).rejects.toThrow(/Passkey authentication failed/);
    expect(auth.current!.status).toBe("unauthenticated");
  });
});
