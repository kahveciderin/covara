import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createEnv, EnvValidationError } from "@/env";

const thrown = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    return error as EnvValidationError;
  }
  throw new Error("expected a throw");
};

describe("createEnv options", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ["FOO", "BAR", "AI_API_KEY", "AI_MODEL", "SESSION_SECRET", "NODE_ENV", "DB_URL"]) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("emptyAsUnset", () => {
    it("keeps an empty value by default", () => {
      process.env.FOO = "";
      expect(createEnv({ FOO: z.string().default("x") }).FOO).toBe("");
    });

    it("applies the default to an empty value", () => {
      process.env.FOO = "";
      expect(createEnv({ FOO: z.string().default("x") }, { emptyAsUnset: true }).FOO).toBe("x");
    });

    it("makes an empty optional value undefined", () => {
      process.env.FOO = "";
      expect(createEnv({ FOO: z.string().optional() }, { emptyAsUnset: true }).FOO).toBeUndefined();
    });

    it("reports an empty required value as not set", () => {
      process.env.FOO = "";
      const error = thrown(() => createEnv({ FOO: z.string() }, { emptyAsUnset: true }));
      expect(error.issues).toEqual([{ key: "FOO", message: "required (not set)" }]);
    });

    it("applies to nested keys and leaves whitespace and other values alone", () => {
      process.env.DB_URL = "";
      process.env.BAR = " ";
      const env = createEnv(
        { DB: { URL: z.string().default("sqlite://x") }, BAR: z.string() },
        { emptyAsUnset: true }
      );
      expect(env.DB.URL).toBe("sqlite://x");
      expect(env.BAR).toBe(" ");
    });
  });

  describe("check", () => {
    const schema = {
      AI_API_KEY: z.string().optional(),
      AI_MODEL: z.string().optional(),
      SESSION_SECRET: z.string().default("dev-secret"),
    };

    it("passes the parsed env and whether this is production", () => {
      process.env.NODE_ENV = "production";
      process.env.SESSION_SECRET = "a".repeat(40);
      let seen: unknown;
      createEnv(schema, {
        check: (env, ctx) => {
          seen = { secret: env.SESSION_SECRET.length, ...ctx };
          return [];
        },
      });
      expect(seen).toEqual({ secret: 40, production: true });
    });

    it("returning nothing passes", () => {
      expect(createEnv(schema, { check: () => undefined }).SESSION_SECRET).toBe("dev-secret");
    });

    it("throws every problem in one error, as plain strings or keyed issues", () => {
      process.env.NODE_ENV = "production";
      process.env.AI_API_KEY = "k";
      const error = thrown(() =>
        createEnv(schema, {
          check: (env, { production }) => [
            ...(env.AI_API_KEY && !env.AI_MODEL ? [{ key: "AI_MODEL", message: "required when AI_API_KEY is set" }] : []),
            ...(production && env.SESSION_SECRET === "dev-secret" ? ["SESSION_SECRET must be set in production"] : []),
          ],
        })
      );
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(error.issues).toEqual([
        { key: "AI_MODEL", message: "required when AI_API_KEY is set" },
        { key: "", message: "SESSION_SECRET must be set in production" },
      ]);
      expect(error.message).toContain("  AI_MODEL: required when AI_API_KEY is set");
      expect(error.message).toContain("\n  SESSION_SECRET must be set in production");
      expect(error.message).not.toContain(": SESSION_SECRET");
    });

    it("is skipped when the schema already failed", () => {
      let called = false;
      const error = thrown(() =>
        createEnv({ FOO: z.string() }, {
          check: () => {
            called = true;
            return ["x"];
          },
        })
      );
      expect(called).toBe(false);
      expect(error.issues.map((i) => i.key)).toEqual(["FOO"]);
    });

    it("a check that throws is reported without its message", () => {
      process.env.AI_API_KEY = "sk-secret-value";
      const error = thrown(() =>
        createEnv(schema, {
          check: (env) => {
            throw new TypeError(`bad ${env.AI_API_KEY}`);
          },
        })
      );
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(error.message).toContain("TypeError");
      expect(error.message).not.toContain("sk-secret-value");
    });

    it("the returned env has no extra keys", () => {
      const env = createEnv(schema, { emptyAsUnset: true, check: () => [] });
      expect(Object.keys(env).sort()).toEqual(["AI_API_KEY", "AI_MODEL", "SESSION_SECRET", "getPublicEnvironmentVariables"]);
    });
  });
});
