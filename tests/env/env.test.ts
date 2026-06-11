import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { createEnv, envVariable, usePublicEnv } from "../../src/env";
import { createTestApp, get } from "../helpers/hono";

describe("Environment Variables", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("envVariable", () => {
    it("should parse a string value", () => {
      const result = envVariable("hello", z.string());
      expect(result.value).toBe("hello");
    });

    it("should parse a number value", () => {
      const result = envVariable("42", z.string().transform(Number));
      expect(result.value).toBe(42);
    });

    it("should parse a boolean value", () => {
      const result = envVariable(
        "true",
        z.string().transform((v) => v === "true")
      );
      expect(result.value).toBe(true);
    });

    it("should throw on validation error", () => {
      expect(() => envVariable(undefined, z.string().min(1))).toThrow(
        "Environment variable validation error"
      );
    });

    it("should mark as private by default", () => {
      const result = envVariable("secret", z.string());
      expect(result.config?.public).toBeUndefined();
    });

    it("should mark as public when config.public is true", () => {
      const result = envVariable("value", z.string(), { public: true });
      expect(result.config?.public).toBe(true);
    });

    it("should mark as private when config.public is false", () => {
      const result = envVariable("value", z.string(), { public: false });
      expect(result.config?.public).toBe(false);
    });

    it("should use default values from Zod schema", () => {
      const result = envVariable(undefined, z.string().default("fallback"));
      expect(result.value).toBe("fallback");
    });

    it("should support optional values", () => {
      const result = envVariable(undefined, z.string().optional());
      expect(result.value).toBeUndefined();
    });

    it("should support enum values", () => {
      const result = envVariable(
        "production",
        z.enum(["development", "production"])
      );
      expect(result.value).toBe("production");
    });

    it("should throw on invalid enum value", () => {
      expect(() =>
        envVariable("invalid", z.enum(["development", "production"]))
      ).toThrow("Environment variable validation error");
    });

    it("should support coercion", () => {
      const result = envVariable("123", z.coerce.number());
      expect(result.value).toBe(123);
    });
  });

  describe("createEnv", () => {
    it("should parse flat environment schema", () => {
      process.env.PORT = "3000";
      process.env.HOST = "localhost";

      const env = createEnv({
        PORT: z.string().transform(Number),
        HOST: z.string(),
      });

      expect(env.PORT).toBe(3000);
      expect(env.HOST).toBe("localhost");
    });

    it("should parse nested environment schema", () => {
      process.env.SERVER_PORT = "8080";
      process.env.SERVER_HOST = "0.0.0.0";
      process.env.DB_URL = "postgres://localhost";

      const env = createEnv({
        SERVER: {
          PORT: z.string().transform(Number),
          HOST: z.string(),
        },
        DB: {
          URL: z.string(),
        },
      });

      expect(env.SERVER.PORT).toBe(8080);
      expect(env.SERVER.HOST).toBe("0.0.0.0");
      expect(env.DB.URL).toBe("postgres://localhost");
    });

    it("should handle deeply nested schemas", () => {
      process.env.APP_CONFIG_SERVER_PORT = "9000";

      const env = createEnv({
        APP: {
          CONFIG: {
            SERVER: {
              PORT: z.string().transform(Number),
            },
          },
        },
      });

      expect(env.APP.CONFIG.SERVER.PORT).toBe(9000);
    });

    it("should throw on missing required variable", () => {
      delete process.env.REQUIRED_VAR;

      expect(() =>
        createEnv({
          REQUIRED_VAR: z.string().min(1),
        })
      ).toThrow("Environment variable validation error for REQUIRED_VAR");
    });

    it("should support envVariable for explicit control", () => {
      const env = createEnv({
        API_KEY: envVariable("secret-key", z.string()),
        VERSION: envVariable("1.0.0", z.string(), { public: true }),
      });

      expect(env.API_KEY).toBe("secret-key");
      expect(env.VERSION).toBe("1.0.0");
    });

    it("should add getPublicEnvironmentVariables method", () => {
      process.env.SOME_VAR = "value";

      const env = createEnv({
        SOME_VAR: z.string(),
      });

      expect(typeof env.getPublicEnvironmentVariables).toBe("function");
    });
  });

  describe("getPublicEnvironmentVariables", () => {
    it("should return only PUBLIC_ prefixed variables", () => {
      process.env.PUBLIC_API_URL = "https://api.example.com";
      process.env.SECRET_KEY = "secret";

      const env = createEnv({
        PUBLIC_API_URL: z.string(),
        SECRET_KEY: z.string(),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        PUBLIC_API_URL: "https://api.example.com",
      });
    });

    it("should not detect nested PUBLIC_ variables (only top-level works)", () => {
      process.env.CONFIG_PUBLIC_URL = "https://public.example.com";
      process.env.CONFIG_PRIVATE_KEY = "secret";

      const env = createEnv({
        CONFIG: {
          PUBLIC_URL: z.string(),
          PRIVATE_KEY: z.string(),
        },
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      // Nested PUBLIC_ prefix doesn't work because full key is CONFIG_PUBLIC_URL (doesn't start with PUBLIC_)
      expect(publicEnv).toEqual({});
    });

    it("should detect nested variables with explicit public: true", () => {
      const env = createEnv({
        CONFIG: {
          URL: envVariable("https://public.example.com", z.string(), {
            public: true,
          }),
          SECRET: envVariable("secret", z.string()),
        },
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        CONFIG: {
          URL: "https://public.example.com",
        },
      });
    });

    it("should return variables marked with public: true via envVariable", () => {
      const env = createEnv({
        API_URL: envVariable("https://api.example.com", z.string(), {
          public: true,
        }),
        SECRET: envVariable("secret", z.string()),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        API_URL: "https://api.example.com",
      });
    });

    it("should not include variables marked with public: false even with PUBLIC_ prefix", () => {
      const env = createEnv({
        PUBLIC_BUT_PRIVATE: envVariable("value", z.string(), { public: false }),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({});
    });

    it("should return empty object when no public variables", () => {
      process.env.PRIVATE_VAR = "secret";

      const env = createEnv({
        PRIVATE_VAR: z.string(),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({});
    });

    it("should only detect top-level PUBLIC_ variables, not nested ones", () => {
      process.env.PUBLIC_VERSION = "1.0.0";
      process.env.APP_PUBLIC_NAME = "MyApp";
      process.env.APP_CONFIG_PUBLIC_URL = "https://example.com";
      process.env.SECRET = "hidden";

      const env = createEnv({
        PUBLIC_VERSION: z.string(),
        SECRET: z.string(),
        APP: {
          PUBLIC_NAME: z.string(),
          CONFIG: {
            PUBLIC_URL: z.string(),
          },
        },
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      // Only top-level PUBLIC_ is detected
      expect(publicEnv).toEqual({
        PUBLIC_VERSION: "1.0.0",
      });
    });

    it("should detect nested variables at multiple levels with explicit public: true", () => {
      const env = createEnv({
        PUBLIC_VERSION: envVariable("1.0.0", z.string(), { public: true }),
        SECRET: envVariable("hidden", z.string()),
        APP: {
          NAME: envVariable("MyApp", z.string(), { public: true }),
          CONFIG: {
            URL: envVariable("https://example.com", z.string(), {
              public: true,
            }),
          },
        },
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        PUBLIC_VERSION: "1.0.0",
        APP: {
          NAME: "MyApp",
          CONFIG: {
            URL: "https://example.com",
          },
        },
      });
    });

    it("should combine PUBLIC_ prefix and explicit public: true", () => {
      process.env.PUBLIC_VAR1 = "public1";

      const env = createEnv({
        PUBLIC_VAR1: z.string(),
        VAR2: envVariable("public2", z.string(), { public: true }),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        PUBLIC_VAR1: "public1",
        VAR2: "public2",
      });
    });
  });

  describe("usePublicEnv", () => {
    let app: Hono;

    beforeEach(() => {
      app = createTestApp();
    });

    it("should return public environment variables as JSON", async () => {
      process.env.PUBLIC_API_URL = "https://api.example.com";

      const env = createEnv({
        PUBLIC_API_URL: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.body).toEqual({
        PUBLIC_API_URL: "https://api.example.com",
      });
    });

    it("should set default Cache-Control header", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    });

    it("should allow custom Cache-Control header", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route(
        "/env",
        usePublicEnv(env, {
          cacheControl: "public, max-age=86400",
        })
      );

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    });

    it("should allow custom headers", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route(
        "/env",
        usePublicEnv(env, {
          headers: {
            "X-Custom-Header": "custom-value",
            "X-Another": "another-value",
          },
        })
      );

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.headers.get("x-custom-header")).toBe("custom-value");
      expect(response.headers.get("x-another")).toBe("another-value");
    });

    it("should work with nested public variables using explicit public: true", async () => {
      const env = createEnv({
        CONFIG: {
          URL: envVariable("https://example.com", z.string(), { public: true }),
          VERSION: envVariable("2.0.0", z.string(), { public: true }),
        },
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.body).toEqual({
        CONFIG: {
          URL: "https://example.com",
          VERSION: "2.0.0",
        },
      });
    });

    it("should return empty object when no public variables", async () => {
      process.env.PRIVATE_VAR = "secret";

      const env = createEnv({
        PRIVATE_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.body).toEqual({});
    });

    it("should mount at different paths", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/api/config", usePublicEnv(env));

      const response = await get(app, "/api/config");
      expect(response.status).toBe(200);

      expect(response.body).toEqual({
        PUBLIC_VAR: "value",
      });
    });

    it("should return Content-Type application/json", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.headers.get("content-type")).toMatch(/application\/json/);
    });
  });

  describe("type inference edge cases", () => {
    it("should handle transformed values correctly", () => {
      process.env.PORT = "3000";

      const env = createEnv({
        PORT: z.string().transform(Number),
      });

      expect(typeof env.PORT).toBe("number");
      expect(env.PORT).toBe(3000);
    });

    it("should handle array values via transform", () => {
      process.env.ALLOWED_ORIGINS = "http://localhost,https://example.com";

      const env = createEnv({
        ALLOWED_ORIGINS: z.string().transform((s) => s.split(",")),
      });

      expect(env.ALLOWED_ORIGINS).toEqual([
        "http://localhost",
        "https://example.com",
      ]);
    });

    it("should handle JSON parsing via transform", () => {
      process.env.CONFIG_JSON = '{"key":"value","num":42}';

      const env = createEnv({
        CONFIG_JSON: z.string().transform((s) => JSON.parse(s)),
      });

      expect(env.CONFIG_JSON).toEqual({ key: "value", num: 42 });
    });

    it("should handle URL validation", () => {
      process.env.API_URL = "https://api.example.com/v1";

      const env = createEnv({
        API_URL: z.string().url(),
      });

      expect(env.API_URL).toBe("https://api.example.com/v1");
    });

    it("should throw on invalid URL", () => {
      process.env.API_URL = "not-a-url";

      expect(() =>
        createEnv({
          API_URL: z.string().url(),
        })
      ).toThrow("Environment variable validation error");
    });
  });

  describe("ETag cache validation", () => {
    let app: Hono;

    beforeEach(() => {
      app = createTestApp();
    });

    it("should return ETag header", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env");
      expect(response.status).toBe(200);

      expect(response.headers.get("etag")).toBeDefined();
      expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]+"$/);
    });

    it("should return 304 when If-None-Match matches ETag", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const firstResponse = await get(app, "/env");
      expect(firstResponse.status).toBe(200);
      const etag = firstResponse.headers.get("etag")!;

      const secondResponse = await get(app, "/env", { "If-None-Match": etag });
      expect(secondResponse.status).toBe(304);

      expect(secondResponse.body).toBeUndefined();
    });

    it("should return 200 when If-None-Match does not match", async () => {
      process.env.PUBLIC_VAR = "value";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response = await get(app, "/env", {
        "If-None-Match": '"different-etag"',
      });
      expect(response.status).toBe(200);

      expect(response.body).toEqual({
        PUBLIC_VAR: "value",
      });
    });

    it("should return consistent ETag for same values", async () => {
      process.env.PUBLIC_VAR = "consistent";

      const env = createEnv({
        PUBLIC_VAR: z.string(),
      });

      app.route("/env", usePublicEnv(env));

      const response1 = await get(app, "/env");
      expect(response1.status).toBe(200);
      const response2 = await get(app, "/env");
      expect(response2.status).toBe(200);

      expect(response1.headers.get("etag")).toBe(response2.headers.get("etag"));
    });

    it("should return different ETag for different values", async () => {
      process.env.PUBLIC_VAR1 = "value1";

      const env1 = createEnv({
        PUBLIC_VAR1: z.string(),
      });

      const app1 = createTestApp();
      app1.route("/env", usePublicEnv(env1));

      const response1 = await get(app1, "/env");
      expect(response1.status).toBe(200);

      process.env.PUBLIC_VAR2 = "value2";

      const env2 = createEnv({
        PUBLIC_VAR2: z.string(),
      });

      const app2 = createTestApp();
      app2.route("/env", usePublicEnv(env2));

      const response2 = await get(app2, "/env");
      expect(response2.status).toBe(200);

      expect(response1.headers.get("etag")).not.toBe(response2.headers.get("etag"));
    });
  });

  describe("integration scenarios", () => {
    it("should support a typical app configuration", () => {
      process.env.NODE_ENV = "production";
      process.env.PUBLIC_VERSION = "1.2.3";
      process.env.SERVER_PORT = "8080";
      process.env.SERVER_HOST = "0.0.0.0";
      process.env.DB_URL = "postgres://user:pass@localhost/db";
      process.env.DB_POOL_SIZE = "10";

      const env = createEnv({
        NODE_ENV: z.enum(["development", "production", "test"]),
        PUBLIC_VERSION: z.string(),
        SERVER: {
          PORT: z.string().transform(Number),
          HOST: z.string(),
        },
        DB: {
          URL: z.string(),
          POOL_SIZE: z.string().transform(Number),
        },
      });

      expect(env.NODE_ENV).toBe("production");
      expect(env.PUBLIC_VERSION).toBe("1.2.3");
      expect(env.SERVER.PORT).toBe(8080);
      expect(env.SERVER.HOST).toBe("0.0.0.0");
      expect(env.DB.URL).toBe("postgres://user:pass@localhost/db");
      expect(env.DB.POOL_SIZE).toBe(10);

      const publicEnv = env.getPublicEnvironmentVariables();
      expect(publicEnv).toEqual({
        PUBLIC_VERSION: "1.2.3",
      });
    });

    it("should work with envVariable for mixed configurations", () => {
      process.env.PUBLIC_API_URL = "https://api.example.com";
      process.env.AUTH_SECRET = "super-secret";

      const env = createEnv({
        PUBLIC_API_URL: z.string(),
        AUTH_SECRET: z.string(),
        FEATURES: envVariable(
          JSON.stringify({ darkMode: true, newUI: false }),
          z.string().transform((s) => JSON.parse(s)),
          { public: true }
        ),
        INTERNAL_CONFIG: envVariable(
          JSON.stringify({ debugLevel: 3 }),
          z.string().transform((s) => JSON.parse(s))
        ),
      });

      const publicEnv = env.getPublicEnvironmentVariables();

      expect(publicEnv).toEqual({
        PUBLIC_API_URL: "https://api.example.com",
        FEATURES: { darkMode: true, newUI: false },
      });
    });
  });
});
