import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  versioningMiddleware,
  addFieldDeprecationWarnings,
  wrapWithVersion,
  checkMinimumVersion,
  createVersionChecker,
  schemaVersionMiddleware,
  formatSchemaVersionEvent,
  COVARA_VERSION,
  CURSOR_VERSION_HEADER,
  SCHEMA_VERSION_HEADER,
  VersioningConfig,
  DeprecationWarning,
} from "@/middleware/versioning";

describe("Versioning Middleware", () => {
  const buildApp = (middleware: MiddlewareHandler, handler?: () => void): Hono => {
    const app = new Hono();
    app.use("*", middleware);
    app.all("*", (c) => {
      handler?.();
      return c.json({ ok: true });
    });
    return app;
  };

  describe("COVARA_VERSION", () => {
    it("should be a valid semver string", () => {
      expect(COVARA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
      expect(COVARA_VERSION).toBe("1.0.0");
    });
  });

  describe("versioningMiddleware", () => {
    it("should set version header on response", async () => {
      const app = buildApp(versioningMiddleware());

      const res = await app.request("/users");

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Covara-Version")).toBe(COVARA_VERSION);
    });

    it("should add deprecation warning header for affected paths", async () => {
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/users"],
            message: "Use /v2/users instead",
            sunsetDate: new Date("2025-06-01"),
          },
        ],
      };
      const app = buildApp(versioningMiddleware(config));

      const res = await app.request("/users");

      expect(res.headers.get("X-Covara-Warn")).toBe("Use /v2/users instead");
      expect(res.headers.get("Deprecation")).toBe("2025-06-01");
      expect(res.headers.get("Sunset")).toEqual(expect.any(String));
    });

    it("should set Sunset header when sunsetDate is provided", async () => {
      const sunsetDate = new Date("2025-12-31");
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/old-endpoint"],
            message: "Deprecated",
            sunsetDate,
          },
        ],
      };
      const app = buildApp(versioningMiddleware(config));

      const res = await app.request("/old-endpoint");

      expect(res.headers.get("Sunset")).toBe(sunsetDate.toUTCString());
    });

    it("should not add warnings for unaffected paths", async () => {
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/old-api"],
            message: "Deprecated",
          },
        ],
      };
      const app = buildApp(versioningMiddleware(config));

      const res = await app.request("/users");

      // Should only have version header, not deprecation
      expect(res.headers.get("X-Covara-Version")).toBe(COVARA_VERSION);
      expect(res.headers.get("X-Covara-Warn")).toBeNull();
      expect(res.headers.get("Deprecation")).toBeNull();
      expect(res.headers.get("Sunset")).toBeNull();
    });
  });

  describe("addFieldDeprecationWarnings", () => {
    it("should add warnings for deprecated fields", () => {
      const items = [
        { id: "1", legacyField: "old", newField: "new" },
        { id: "2", legacyField: "old2", newField: "new2" },
      ];
      const deprecatedFields = [
        {
          field: "legacyField",
          replacement: "newField",
          message: "legacyField is deprecated",
        },
      ];

      const result = addFieldDeprecationWarnings(items, deprecatedFields);

      expect(result[0]._warnings).toContainEqual(
        expect.objectContaining({
          field: "legacyField",
          replacement: "newField",
        })
      );
    });

    it("should not add warnings if field not present", () => {
      const items = [{ id: "1", newField: "value" }];
      const deprecatedFields = [
        {
          field: "legacyField",
          replacement: "newField",
          message: "deprecated",
        },
      ];

      const result = addFieldDeprecationWarnings(items, deprecatedFields);

      expect(result[0]._warnings).toBeUndefined();
    });
  });

  describe("wrapWithVersion", () => {
    it("should wrap data with version info", () => {
      const data = { users: [{ id: "1" }] };

      const result = wrapWithVersion(data);

      expect(result.version).toBe(COVARA_VERSION);
      expect(result.data).toEqual(data);
      expect(result.timestamp).toBeDefined();
    });

    it("should include warnings when provided", () => {
      const data = { users: [] };
      const warnings = [{ type: "deprecation", message: "Test warning" }];

      const result = wrapWithVersion(data, warnings);

      expect(result.warnings).toEqual(warnings);
    });
  });

  describe("checkMinimumVersion", () => {
    it("should return true for version >= minimum", () => {
      expect(checkMinimumVersion("2.0.0", "1.0.0").supported).toBe(true);
      expect(checkMinimumVersion("1.0.0", "1.0.0").supported).toBe(true);
      expect(checkMinimumVersion("1.1.0", "1.0.0").supported).toBe(true);
    });

    it("should return false for version < minimum", () => {
      expect(checkMinimumVersion("0.9.0", "1.0.0").supported).toBe(false);
      expect(checkMinimumVersion("1.0.0", "2.0.0").supported).toBe(false);
    });

    it("should handle pre-release versions", () => {
      expect(checkMinimumVersion("1.0.0-beta", "1.0.0").supported).toBe(false);
    });
  });

  describe("createVersionChecker", () => {
    it("should pass requests with valid version", async () => {
      const handler = vi.fn();
      const app = buildApp(createVersionChecker("1.0.0"), handler);

      const res = await app.request("/users", {
        headers: { "x-covara-client-version": "2.0.0" },
      });

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });

    it("should reject requests with old version", async () => {
      const handler = vi.fn();
      const app = buildApp(createVersionChecker("2.0.0"), handler);

      const res = await app.request("/users", {
        headers: { "x-covara-client-version": "1.0.0" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          type: "/__covara/problems/unsupported-version",
          status: 400,
        })
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it("should pass requests without version header", async () => {
      const handler = vi.fn();
      const app = buildApp(createVersionChecker("1.0.0"), handler);

      const res = await app.request("/users");

      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe("schemaVersionMiddleware", () => {
    it("should set schema version header", async () => {
      const app = buildApp(schemaVersionMiddleware(5));

      const res = await app.request("/users");

      expect(res.status).toBe(200);
      expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBe("5");
    });

    it("should accept string version", async () => {
      const app = buildApp(schemaVersionMiddleware("10"));

      const res = await app.request("/users");

      expect(res.headers.get(SCHEMA_VERSION_HEADER)).toBe("10");
    });
  });

  describe("formatSchemaVersionEvent", () => {
    it("should format schema version SSE event", () => {
      const event = formatSchemaVersionEvent(3, "users", ["added email field"]);

      expect(event).toContain("event: schemaVersion");
      expect(event).toContain('"resource":"users"');
      expect(event).toContain('"version":3');
      expect(event).toContain('"changes":["added email field"]');
    });
  });

  describe("Header constants", () => {
    it("should have correct header names", () => {
      expect(CURSOR_VERSION_HEADER).toBe("X-Covara-Cursor-Version");
      expect(SCHEMA_VERSION_HEADER).toBe("X-Covara-Schema-Version");
    });
  });
});
