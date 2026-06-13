import { Hono } from "hono";
import { Readable } from "node:stream";
import { SQL, getTableColumns, eq, and, count } from "drizzle-orm";
import { hasGlobalStorage, getGlobalStorage } from "@/storage/types";
import {
  getResourceSchema,
  getResourceScopeResolver,
  getSchemaInfo,
  getAllSchemaInfos,
} from "./schema-registry";
import { createResourceFilter } from "@/resource/filter";
import { combineScopes } from "@/auth/scope";
import { resolveImpersonatedUser } from "@/server/impersonation";
import {
  createPagination,
  decodeCursorLegacy,
  parseOrderBy,
} from "@/resource/pagination";
import { readJsonBody } from "@/server/request";
import {
  logAdminAction,
  getAdminUser,
  requireAdminUser,
  AdminSecurityConfig,
  detectEnvironment,
} from "./admin-auth";

export interface DataExplorerConfig {
  enabled?: boolean;
  resources?: string[];
  excludeFields?: Record<string, string[]>;
  maxLimit?: number;
  readOnly?: boolean;
}

const DEFAULT_MAX_LIMIT = 100;

const applyFieldExclusion = (
  item: Record<string, unknown>,
  excludeFields?: string[]
): Record<string, unknown> => {
  if (!excludeFields || excludeFields.length === 0) return item;
  const result = { ...item };
  for (const field of excludeFields) {
    if (field in result) {
      result[field] = "[REDACTED]";
    }
  }
  return result;
};

export const createDataExplorerRoutes = (
  config: DataExplorerConfig = {},
  securityConfig: AdminSecurityConfig = {}
): Hono => {
  const router = new Hono();
  const maxLimit = config.maxLimit ?? DEFAULT_MAX_LIMIT;
  const mode = securityConfig.mode ?? detectEnvironment();

  const isReadOnly =
    config.readOnly ?? (mode === "production" ? true : false);

  const isResourceAllowed = (name: string): boolean => {
    if (!config.resources || config.resources.length === 0) return true;
    return config.resources.includes(name);
  };

  router.get("/schemas", (c) => {
    let schemas = getAllSchemaInfos();
    if (config.resources && config.resources.length > 0) {
      schemas = schemas.filter((s) => config.resources!.includes(s.name));
    }
    return c.json({ schemas, mode, readOnly: isReadOnly });
  });

  router.get("/schemas/:resource", (c) => {
    const resource = c.req.param("resource");

    if (!isResourceAllowed(resource)) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
          detail: `Resource '${resource}' is not available in the data explorer`,
        },
        404
      );
    }

    const schema = getSchemaInfo(resource);
    if (!schema) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
          detail: `Resource '${resource}' not found`,
        },
        404
      );
    }

    return c.json({ schema });
  });

  router.get("/data/:resource", async (c) => {
    const resource = c.req.param("resource");
    const adminUser = getAdminUser(c);

    if (!isResourceAllowed(resource)) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
        },
        404
      );
    }

    const entry = getResourceSchema(resource);
    if (!entry) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
        },
        404
      );
    }

    const db = entry.db;
    const schema = entry.schema;
    const idColumnName = entry.idColumn.name;

    const filterStr = c.req.query("filter") ?? "";
    const limitNum = Math.min(
      parseInt(c.req.query("limit") ?? "20", 10),
      maxLimit
    );
    const cursor = c.req.query("cursor");
    const orderByStr = c.req.query("orderBy") ?? idColumnName;
    const selectStr = c.req.query("select");
    const includeTotalCount = c.req.query("totalCount") === "true";

    try {
      const filterer = createResourceFilter(schema, {});
      const pagination = createPagination(schema, entry.idColumn, {
        defaultLimit: 20,
        maxLimit,
      });

      const orderByFields = parseOrderBy(orderByStr);

      // When impersonating (verified: the real caller is an admin), AND the
      // impersonated user's read scope into the browse filter so the explorer
      // shows exactly what that user could read. Otherwise admin bypass applies.
      let effectiveFilterStr = filterStr;
      let impersonatingId: string | null = null;
      let scopeDenied = false;
      const impersonated = await resolveImpersonatedUser(c);
      if (impersonated) {
        impersonatingId = impersonated.id;
        const resolver = getResourceScopeResolver(resource);
        if (resolver && !resolver.isPublic("read")) {
          const scope = await resolver.resolve("read", impersonated);
          if (scope.isEmpty()) scopeDenied = true;
          else effectiveFilterStr = combineScopes(scope, filterStr);
        }
      }

      if (scopeDenied) {
        if (adminUser) {
          logAdminAction({
            userId: adminUser.id,
            userEmail: adminUser.email,
            operation: "data_explorer_list",
            resource,
            reason: `Impersonating ${impersonatingId}: read denied by scope`,
            details: { impersonatedUserId: impersonatingId },
          });
        }
        return c.json({ items: [], nextCursor: null, impersonating: impersonatingId, denied: true });
      }

      let filter: SQL<unknown> | undefined;
      if (effectiveFilterStr) {
        filter = filterer.convert(effectiveFilterStr) as SQL<unknown>;
      }

      let query = db.select().from(schema);

      if (filter) {
        query = query.where(filter);
      }

      if (cursor) {
        const cursorData = decodeCursorLegacy(cursor);
        if (cursorData) {
          const cursorCondition = pagination.buildCursorCondition(
            cursorData,
            orderByFields
          );
          if (cursorCondition) {
            query = query.where(
              filter ? and(filter, cursorCondition) : cursorCondition
            );
          }
        }
      }

      const orderByClauses = pagination.buildOrderBy(orderByFields);
      if (orderByClauses.length > 0) {
        query = query.orderBy(...orderByClauses);
      }

      query = query.limit(limitNum + 1);

      const items = await query;

      let totalCount: number | undefined;
      if (includeTotalCount) {
        const [countResult] = await db
          .select({ count: count() })
          .from(schema)
          .where(filter);
        totalCount = countResult?.count ?? 0;
      }

      const result = pagination.processResults(
        items as Record<string, unknown>[],
        limitNum,
        idColumnName,
        orderByFields,
        totalCount
      );

      const excludeFields = config.excludeFields?.[resource];
      if (excludeFields) {
        result.items = result.items.map((item) =>
          applyFieldExclusion(item, excludeFields)
        );
      }

      if (selectStr) {
        const fields = selectStr.split(",").map((f) => f.trim());
        result.items = result.items.map((item) => {
          const filtered: Record<string, unknown> = {};
          for (const field of fields) {
            if (field in item) {
              filtered[field] = item[field];
            }
          }
          return filtered;
        });
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_list",
          resource,
          reason: impersonatingId
            ? `Impersonating ${impersonatingId}: filter=${filterStr || "none"}, limit=${limitNum}`
            : `Admin browse: filter=${filterStr || "none"}, limit=${limitNum}`,
          details: impersonatingId ? { impersonatedUserId: impersonatingId } : undefined,
        });
      }

      if (impersonatingId) {
        return c.json({ ...result, impersonating: impersonatingId });
      }
      return c.json({
        ...result,
        adminBypass: true,
        warning: "Admin bypass active - all scopes bypassed",
      });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/filter-parse-error",
          title: "Invalid query",
          status: 400,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        400
      );
    }
  });

  // Admin-gated file download: streams the stored object for a file-resource
  // row via the storage adapter (admin already authorized by adminAuth), so the
  // data explorer can download files regardless of the resource's own scopes.
  router.get("/data/:resource/:id/file", async (c) => {
    const resource = c.req.param("resource");
    const id = c.req.param("id");
    const adminUser = getAdminUser(c);

    const notFound = () =>
      c.json({ type: "/__covara/problems/not-found", title: "Not found", status: 404 }, 404);

    if (!isResourceAllowed(resource)) return notFound();
    const entry = getResourceSchema(resource);
    if (!entry || !hasGlobalStorage()) return notFound();

    const [row] = (await (entry.db as {
      select: () => { from: (t: unknown) => { where: (c: unknown) => { limit: (n: number) => Promise<unknown[]> } } };
    })
      .select()
      .from(entry.schema)
      .where(eq(entry.idColumn, id))
      .limit(1)) as Record<string, unknown>[];
    if (!row) return notFound();

    const storagePath = row.storagePath as string | undefined;
    if (!storagePath) return notFound();

    if (adminUser) {
      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "data_explorer_download",
        resource,
        resourceId: id,
        reason: `Admin file download: ${storagePath}`,
      });
    }

    const storage = getGlobalStorage();
    if (storage.supportsPresignedUrls()) {
      const url = await storage.getDownloadUrl(storagePath, {});
      if (url) return c.redirect(url, 302);
    }
    const stream = await storage.downloadStream(storagePath);
    c.header("Content-Type", (row.mimeType as string) || "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${(row.filename as string) || id}"`);
    if (typeof row.size === "number") c.header("Content-Length", String(row.size));
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
  });

  router.get("/data/:resource/:id", async (c) => {
    const resource = c.req.param("resource");
    const id = c.req.param("id");
    const adminUser = getAdminUser(c);

    if (!isResourceAllowed(resource)) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
        },
        404
      );
    }

    const entry = getResourceSchema(resource);
    if (!entry) {
      return c.json(
        {
          type: "/__covara/problems/not-found",
          title: "Resource not found",
          status: 404,
        },
        404
      );
    }

    const db = entry.db;
    const schema = entry.schema;
    const columns = getTableColumns(schema);
    const idColumn = columns[entry.idColumn.name];

    if (!idColumn) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Internal error",
          status: 500,
          detail: "ID column not found",
        },
        500
      );
    }

    try {
      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Record not found",
            status: 404,
            detail: `Record with id '${id}' not found in '${resource}'`,
          },
          404
        );
      }

      let result = item as Record<string, unknown>;
      const excludeFields = config.excludeFields?.[resource];
      if (excludeFields) {
        result = applyFieldExclusion(result, excludeFields);
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_get",
          resource,
          resourceId: id,
          reason: "Admin view record",
        });
      }

      return c.json({
        item: result,
        adminBypass: true,
        warning: "Admin bypass active - all scopes bypassed",
      });
    } catch (error) {
      return c.json(
        {
          type: "/__covara/problems/internal-error",
          title: "Internal error",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  });

  if (!isReadOnly) {
    router.post("/data/:resource", async (c) => {
      const resource = c.req.param("resource");
      const adminUser = requireAdminUser(c);

      if (!isResourceAllowed(resource)) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const db = entry.db;
      const schema = entry.schema;
      const data = (await readJsonBody(c)) as Record<string, unknown>;

      try {
        const [created] = await db.insert(schema).values(data).returning();

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_create",
          resource,
          resourceId: String((created as Record<string, unknown>)[entry.idColumn.name]),
          reason: "Admin create record",
          afterValue: created as Record<string, unknown>,
        });

        return c.json(
          {
            item: created,
            adminBypass: true,
          },
          201
        );
      } catch (error) {
        return c.json(
          {
            type: "/__covara/problems/validation-error",
            title: "Create failed",
            status: 400,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          400
        );
      }
    });

    router.patch("/data/:resource/:id", async (c) => {
      const resource = c.req.param("resource");
      const id = c.req.param("id");
      const adminUser = requireAdminUser(c);

      if (!isResourceAllowed(resource)) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];
      const data = (await readJsonBody(c)) as Record<string, unknown>;

      if (!idColumn) {
        return c.json(
          {
            type: "/__covara/problems/internal-error",
            title: "Internal error",
            status: 500,
          },
          500
        );
      }

      try {
        const [existing] = await db.select().from(schema).where(eq(idColumn, id));
        if (!existing) {
          return c.json(
            {
              type: "/__covara/problems/not-found",
              title: "Record not found",
              status: 404,
            },
            404
          );
        }

        const [updated] = await db
          .update(schema)
          .set(data)
          .where(eq(idColumn, id))
          .returning();

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_update",
          resource,
          resourceId: id,
          reason: "Admin update record",
          beforeValue: existing as Record<string, unknown>,
          afterValue: updated as Record<string, unknown>,
        });

        return c.json({
          item: updated,
          adminBypass: true,
        });
      } catch (error) {
        return c.json(
          {
            type: "/__covara/problems/validation-error",
            title: "Update failed",
            status: 400,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          400
        );
      }
    });

    router.delete("/data/:resource/:id", async (c) => {
      const resource = c.req.param("resource");
      const id = c.req.param("id");
      const adminUser = requireAdminUser(c);

      if (!isResourceAllowed(resource)) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        return c.json(
          {
            type: "/__covara/problems/not-found",
            title: "Resource not found",
            status: 404,
          },
          404
        );
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      if (!idColumn) {
        return c.json(
          {
            type: "/__covara/problems/internal-error",
            title: "Internal error",
            status: 500,
          },
          500
        );
      }

      try {
        const [existing] = await db.select().from(schema).where(eq(idColumn, id));
        if (!existing) {
          return c.json(
            {
              type: "/__covara/problems/not-found",
              title: "Record not found",
              status: 404,
            },
            404
          );
        }

        await db.delete(schema).where(eq(idColumn, id));

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_delete",
          resource,
          resourceId: id,
          reason: "Admin delete record",
          beforeValue: existing as Record<string, unknown>,
        });

        return c.body(null, 204);
      } catch (error) {
        return c.json(
          {
            type: "/__covara/problems/validation-error",
            title: "Delete failed",
            status: 400,
            detail: error instanceof Error ? error.message : "Unknown error",
          },
          400
        );
      }
    });
  }

  return router;
};
