import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { useAuth, type UseAuthOptions } from "@/auth/routes";
import { cookieSession } from "@/auth/session";
import { InMemoryVerificationTokenStore } from "@/auth/verification";
import { createDurableEmailAdapter } from "@/email/durable";
import { EmailDeliveryError } from "@/email/errors";
import { setGlobalEmail, clearGlobalEmail } from "@/email";
import type { EmailAdapter, EmailMessage, SendEmailOptions } from "@/email/types";
import { createMemoryKV, type KVAdapter } from "@/kv";
import { createTaskRegistry, createTaskScheduler } from "@/tasks/scheduler";
import { createTestApp, post } from "../helpers/hono";

const KNOWN = "known@example.com";
const UNKNOWN = "nobody@example.com";

const findUserByEmail = async (email: string) =>
  email === KNOWN ? { id: "u1", email: KNOWN, name: "K" } : null;

const recordingAdapter = (fail?: () => Error) => {
  const calls: { message: EmailMessage; options?: SendEmailOptions }[] = [];
  const adapter: EmailAdapter = {
    provider: "recording",
    async send(message, options) {
      calls.push({ message, options });
      if (fail) throw fail();
      return { id: `m${calls.length}`, provider: "recording" };
    },
  };
  return { adapter, calls };
};

const compose = ({ identifier, token }: { identifier: string; token: string }): EmailMessage => ({
  from: "noreply@acme.com",
  to: identifier,
  subject: "Your link",
  text: `token=${token}`,
});

const buildApp = (options: Partial<UseAuthOptions>) => {
  const app = createTestApp();
  const { router } = useAuth({
    session: cookieSession({ getUserById: async () => null }),
    ...options,
  });
  app.route("/api/auth", router);
  return app;
};

const transient = () =>
  new EmailDeliveryError("provider unavailable", { provider: "recording", status: 503 });

describe("auth email delivery", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    clearGlobalEmail();
  });

  describe("password reset (enumeration-sensitive)", () => {
    it("returns the same success response when the sendToken callback throws", async () => {
      const onDeliveryError = vi.fn();
      const app = buildApp({
        email: { onDeliveryError },
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          sendToken: async () => {
            throw new Error("smtp down");
          },
          resetPassword: async () => {},
          findUserByEmail,
        },
      });

      const known = await post(app, "/api/auth/password/forgot", { email: KNOWN });
      const unknown = await post(app, "/api/auth/password/forgot", { email: UNKNOWN });

      expect(known.status).toBe(200);
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
      expect(onDeliveryError.mock.calls[0][0].message).toBe("smtp down");
      expect(onDeliveryError.mock.calls[0][1]).toEqual({ flow: "passwordReset", identifier: KNOWN });
    });

    it("logs delivery failures without the identifier or token by default", async () => {
      const app = buildApp({
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          sendToken: async () => {
            throw new Error("smtp down");
          },
          resetPassword: async () => {},
          findUserByEmail,
        },
      });
      const res = await post(app, "/api/auth/password/forgot", { email: KNOWN });
      expect(res.status).toBe(200);
      expect(consoleError).toHaveBeenCalledTimes(1);
      const logged = consoleError.mock.calls[0].map(String).join(" ");
      expect(logged).toMatch(/passwordReset/);
      expect(logged).not.toContain(KNOWN);
    });

    it("survives an onDeliveryError hook that throws", async () => {
      const app = buildApp({
        email: {
          onDeliveryError: () => {
            throw new Error("hook broke");
          },
        },
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          sendToken: async () => {
            throw new Error("smtp down");
          },
          resetPassword: async () => {},
          findUserByEmail,
        },
      });
      const res = await post(app, "/api/auth/password/forgot", { email: KNOWN });
      expect(res.status).toBe(200);
    });

    it("sends a composed email through the configured adapter with a token-derived idempotency key", async () => {
      const { adapter, calls } = recordingAdapter();
      const app = buildApp({
        email: { adapter },
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          composeEmail: compose,
          resetPassword: async () => {},
          findUserByEmail,
        },
      });

      const res = await post(app, "/api/auth/password/forgot", { email: KNOWN });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].message.to).toBe(KNOWN);
      const token = String(calls[0].message.text).replace("token=", "");
      const digest = createHash("sha256").update(token).digest("hex");
      expect(calls[0].options?.idempotencyKey).toBe(`auth:passwordReset:${digest}`);
      expect(calls[0].options?.idempotencyKey).not.toContain(token);

      await post(app, "/api/auth/password/forgot", { email: UNKNOWN });
      expect(calls).toHaveLength(1);
    });

    it("falls back to the global email adapter", async () => {
      const { adapter, calls } = recordingAdapter();
      setGlobalEmail(adapter);
      const app = buildApp({
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          composeEmail: compose,
          resetPassword: async () => {},
          findUserByEmail,
        },
      });
      await post(app, "/api/auth/password/forgot", { email: KNOWN });
      expect(calls).toHaveLength(1);
    });

    it("does not fail or leak when no email adapter is configured", async () => {
      const onDeliveryError = vi.fn();
      const app = buildApp({
        email: { onDeliveryError },
        passwordReset: {
          store: new InMemoryVerificationTokenStore(),
          composeEmail: compose,
          resetPassword: async () => {},
          findUserByEmail,
        },
      });
      const res = await post(app, "/api/auth/password/forgot", { email: KNOWN });
      expect(res.status).toBe(200);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
    });

    describe("with a durable adapter", () => {
      let kv: KVAdapter;

      beforeEach(async () => {
        kv = createMemoryKV(`auth-durable-${Math.random()}`);
        await kv.connect();
      });

      afterEach(async () => {
        await kv.disconnect();
      });

      it("enqueues instead of calling the provider, so a provider outage cannot affect the response", async () => {
        const { adapter: inner, calls } = recordingAdapter(transient);
        const scheduler = createTaskScheduler(kv, createTaskRegistry());
        const durable = createDurableEmailAdapter(inner, { queue: scheduler, kv });
        const onDeliveryError = vi.fn();
        const app = buildApp({
          email: { adapter: durable, onDeliveryError },
          passwordReset: {
            store: new InMemoryVerificationTokenStore(),
            composeEmail: compose,
            resetPassword: async () => {},
            findUserByEmail,
          },
        });

        const known = await post(app, "/api/auth/password/forgot", { email: KNOWN });
        const unknown = await post(app, "/api/auth/password/forgot", { email: UNKNOWN });

        expect(known.status).toBe(200);
        expect(known.body).toEqual(unknown.body);
        expect(calls).toHaveLength(0);
        expect(onDeliveryError).not.toHaveBeenCalled();
        expect(await scheduler.getQueueDepth()).toBe(1);
      });
    });
  });

  describe("magic link (enumeration-sensitive)", () => {
    it("returns success for a known user even when sendLink throws", async () => {
      const onDeliveryError = vi.fn();
      const app = buildApp({
        email: { onDeliveryError },
        magicLink: {
          store: new InMemoryVerificationTokenStore(),
          sendLink: async () => {
            throw new Error("smtp down");
          },
          findUserByEmail,
        },
      });

      const known = await post(app, "/api/auth/magic-link/request", { email: KNOWN });
      const unknown = await post(app, "/api/auth/magic-link/request", { email: UNKNOWN });
      expect(known.status).toBe(200);
      expect(known.body).toEqual(unknown.body);
      expect(onDeliveryError.mock.calls[0][1]).toEqual({ flow: "magicLink", identifier: KNOWN });
    });

    it("sends a composed email", async () => {
      const { adapter, calls } = recordingAdapter();
      const app = buildApp({
        email: { adapter },
        magicLink: { store: new InMemoryVerificationTokenStore(), composeEmail: compose, findUserByEmail },
      });
      await post(app, "/api/auth/magic-link/request", { email: KNOWN });
      expect(calls).toHaveLength(1);
      expect(calls[0].options?.idempotencyKey).toMatch(/^auth:magicLink:[0-9a-f]{64}$/);
    });
  });

  describe("verification", () => {
    it("still surfaces send failures (not enumeration-sensitive)", async () => {
      const app = buildApp({
        verification: {
          store: new InMemoryVerificationTokenStore(),
          sendToken: async () => {
            throw new Error("smtp down");
          },
          markVerified: async () => {},
        },
      });
      const res = await post(app, "/api/auth/verify/request", { email: KNOWN });
      expect(res.status).toBe(500);
    });

    it("sends a composed email", async () => {
      const { adapter, calls } = recordingAdapter();
      const app = buildApp({
        email: { adapter },
        verification: {
          store: new InMemoryVerificationTokenStore(),
          composeEmail: compose,
          markVerified: async () => {},
        },
      });
      const res = await post(app, "/api/auth/verify/request", { email: KNOWN });
      expect(res.status).toBe(200);
      expect(calls[0].options?.idempotencyKey).toMatch(/^auth:verification:[0-9a-f]{64}$/);
    });
  });

  describe("configuration", () => {
    it("rejects a flow with neither a callback nor composeEmail", () => {
      expect(() =>
        useAuth({
          session: cookieSession({ getUserById: async () => null }),
          passwordReset: {
            store: new InMemoryVerificationTokenStore(),
            resetPassword: async () => {},
          },
        })
      ).toThrow(/passwordReset.*sendToken.*composeEmail/);

      expect(() =>
        useAuth({
          session: cookieSession({ getUserById: async () => null }),
          magicLink: { store: new InMemoryVerificationTokenStore(), findUserByEmail },
        })
      ).toThrow(/magicLink.*sendLink.*composeEmail/);

      expect(() =>
        useAuth({
          session: cookieSession({ getUserById: async () => null }),
          verification: { store: new InMemoryVerificationTokenStore(), markVerified: async () => {} },
        })
      ).toThrow(/verification.*sendToken.*composeEmail/);
    });
  });
});
