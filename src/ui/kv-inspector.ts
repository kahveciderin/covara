import { Hono } from "hono";
import { KVAdapter } from "@/kv/types";
import { readJsonBody } from "@/server/request";
import {
  logAdminAction,
  getAdminUser,
  requireAdminUser,
  AdminSecurityConfig,
  detectEnvironment,
} from "./admin-auth";

export interface KVInspectorConfig {
  enabled?: boolean;
  kv?: KVAdapter;
  readOnly?: boolean;
  allowedPatterns?: string[];
}

const matchPattern = (pattern: string, key: string): boolean => {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$"
  );
  return regex.test(key);
};

export const createKVInspectorRoutes = (
  config: KVInspectorConfig = {},
  securityConfig: AdminSecurityConfig = {}
): Hono => {
  const router = new Hono();
  const mode = securityConfig.mode ?? detectEnvironment();

  const defaultEnabled = mode === "development";
  const enabled = config.enabled ?? defaultEnabled;

  const defaultReadOnly = mode !== "development";
  const isReadOnly = config.readOnly ?? defaultReadOnly;

  if (!enabled || !config.kv) {
    router.all("*", (c) => c.json({ enabled: false }));
    return router;
  }

  const kv = config.kv;

  const isPatternAllowed = (pattern: string): boolean => {
    if (!config.allowedPatterns || config.allowedPatterns.length === 0) {
      return true;
    }
    return config.allowedPatterns.some((allowed) =>
      matchPattern(allowed, pattern)
    );
  };

  const isKeyAllowed = (key: string): boolean => {
    if (!config.allowedPatterns || config.allowedPatterns.length === 0) {
      return true;
    }
    return config.allowedPatterns.some((allowed) => matchPattern(allowed, key));
  };

  router.get("/keys", async (c) => {
    const adminUser = getAdminUser(c);
    const pattern = c.req.query("pattern") ?? "*";
    const limit = parseInt(c.req.query("limit") ?? "100", 10);

    if (!isPatternAllowed(pattern)) {
      return c.json(
        {
          type: "/__concave/problems/forbidden",
          title: "Pattern not allowed",
          status: 403,
          detail: "This key pattern is not in the allowed list",
        },
        403
      );
    }

    try {
      let keys = await kv.keys(pattern);

      if (config.allowedPatterns && config.allowedPatterns.length > 0) {
        keys = keys.filter(isKeyAllowed);
      }

      keys = keys.slice(0, limit);

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_list_keys",
          reason: `Admin list keys: pattern=${pattern}`,
        });
      }

      return c.json({
        enabled: true,
        readOnly: isReadOnly,
        keys,
        mode,
      });
    } catch (error) {
      return c.json(
        {
          type: "/__concave/problems/internal-error",
          title: "Failed to list keys",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/key/:key", async (c) => {
    const adminUser = getAdminUser(c);
    const key = decodeURIComponent(c.req.param("key"));

    if (!isKeyAllowed(key)) {
      return c.json(
        {
          type: "/__concave/problems/forbidden",
          title: "Key not allowed",
          status: 403,
          detail: "This key is not in the allowed patterns",
        },
        403
      );
    }

    try {
      const value = await kv.get(key);
      const ttl = await kv.ttl(key);

      if (value === null) {
        const hashValue = await kv.hgetall(key);
        if (Object.keys(hashValue).length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV hash value",
            });
          }

          return c.json({
            key,
            type: "hash",
            value: hashValue,
            ttl,
          });
        }

        const listLength = await kv.llen(key);
        if (listLength > 0) {
          const listValue = await kv.lrange(key, 0, 99);
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV list value",
            });
          }

          return c.json({
            key,
            type: "list",
            value: listValue,
            length: listLength,
            ttl,
          });
        }

        const setMembers = await kv.smembers(key);
        if (setMembers.length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV set value",
            });
          }

          return c.json({
            key,
            type: "set",
            value: setMembers,
            ttl,
          });
        }

        const zsetMembers = await kv.zrange(key, 0, 99);
        if (zsetMembers.length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV sorted set value",
            });
          }

          return c.json({
            key,
            type: "zset",
            value: zsetMembers,
            ttl,
          });
        }

        return c.json(
          {
            type: "/__concave/problems/not-found",
            title: "Key not found",
            status: 404,
          },
          404
        );
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_get",
          resourceId: key,
          reason: "Admin get KV string value",
        });
      }

      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }

      return c.json({
        key,
        type: "string",
        value: parsedValue,
        rawValue: value,
        ttl,
      });
    } catch (error) {
      return c.json(
        {
          type: "/__concave/problems/internal-error",
          title: "Failed to get key",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  router.get("/key/:key/ttl", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));

    if (!isKeyAllowed(key)) {
      return c.json(
        {
          type: "/__concave/problems/forbidden",
          title: "Key not allowed",
          status: 403,
        },
        403
      );
    }

    try {
      const ttl = await kv.ttl(key);
      return c.json({ key, ttl });
    } catch (error) {
      return c.json(
        {
          type: "/__concave/problems/internal-error",
          title: "Failed to get TTL",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  if (!isReadOnly) {
    router.put("/key/:key", async (c) => {
      const adminUser = requireAdminUser(c);

      const key = decodeURIComponent(c.req.param("key"));
      const { value, ttl } = (await readJsonBody(c)) as {
        value?: unknown;
        ttl?: number;
      };

      if (!isKeyAllowed(key)) {
        return c.json(
          {
            type: "/__concave/problems/forbidden",
            title: "Key not allowed",
            status: 403,
          },
          403
        );
      }

      try {
        const stringValue =
          typeof value === "string" ? value : JSON.stringify(value);

        if (ttl && ttl > 0) {
          await kv.set(key, stringValue, { ex: ttl });
        } else {
          await kv.set(key, stringValue);
        }

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_set",
          resourceId: key,
          reason: "Admin set KV value",
          afterValue: { value, ttl },
        });

        return c.json({ success: true, key });
      } catch (error) {
        return c.json(
          {
            type: "/__concave/problems/internal-error",
            title: "Failed to set key",
            status: 500,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          500
        );
      }
    });

    router.post("/key/:key/expire", async (c) => {
      const adminUser = requireAdminUser(c);

      const key = decodeURIComponent(c.req.param("key"));
      const { ttl } = (await readJsonBody(c)) as { ttl?: number };

      if (!isKeyAllowed(key)) {
        return c.json(
          {
            type: "/__concave/problems/forbidden",
            title: "Key not allowed",
            status: 403,
          },
          403
        );
      }

      try {
        const success = await kv.expire(key, ttl as number);

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_expire",
          resourceId: key,
          reason: `Admin set TTL: ${ttl}s`,
        });

        return c.json({ success, key, ttl });
      } catch (error) {
        return c.json(
          {
            type: "/__concave/problems/internal-error",
            title: "Failed to set expiry",
            status: 500,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          500
        );
      }
    });

    router.delete("/key/:key", async (c) => {
      const adminUser = requireAdminUser(c);

      const key = decodeURIComponent(c.req.param("key"));

      if (!isKeyAllowed(key)) {
        return c.json(
          {
            type: "/__concave/problems/forbidden",
            title: "Key not allowed",
            status: 403,
          },
          403
        );
      }

      try {
        const deleted = await kv.del(key);

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_delete",
          resourceId: key,
          reason: "Admin delete KV key",
        });

        return c.json({ success: deleted > 0, deleted });
      } catch (error) {
        return c.json(
          {
            type: "/__concave/problems/internal-error",
            title: "Failed to delete key",
            status: 500,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          500
        );
      }
    });
  }

  return router;
};
