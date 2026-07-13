import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import { eq, inArray, Table, TableConfig, InferSelectModel, getTableName, getTableColumns } from "drizzle-orm";
import {
  StorageAdapter,
  getGlobalStorage,
  hasGlobalStorage,
  PresignedUrlOptions,
} from "./types";
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} from "@/resource/error";
import { createResourceFilter } from "@/resource/filter";
import { validateUpload, type UploadValidationOptions } from "./validation";
import type { ResourceConfig, LifecycleHooks, ProcedureContext } from "@/resource/types";
import { normalizeResourceConfig, columnPropertyKey, type ResourceConfigInput } from "@/resource/column-ref";
import { useResource } from "@/resource/hook";
import { createScopeResolver } from "@/auth/scope";
import { executeBeforeCreate, executeAfterCreate } from "@/resource/procedures";
import { recordCreate } from "@/resource/changelog";
import { pushInsertsToSubscriptions } from "@/resource/subscription";
import { isAdminBypassRequest } from "@/server/admin-bypass";
import { getUser } from "@/server/context";
import { readJsonBody } from "@/server/request";
import { setResourceFileFlag } from "@/ui/schema-registry";

type DrizzleColumn = SQLiteColumn | PgColumn;

export interface FileRecord {
  id: string;
  userId?: string | null;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url?: string | null;
  status: "pending" | "completed";
  createdAt: Date;
}

export interface FileTableSchema {
  id: DrizzleColumn;
  userId?: DrizzleColumn;
  filename: DrizzleColumn;
  mimeType: DrizzleColumn;
  size: DrizzleColumn;
  storagePath: DrizzleColumn;
  url?: DrizzleColumn;
  status: DrizzleColumn;
  createdAt: DrizzleColumn;
}

// A file resource is a regular resource (full CRUD, hooks, procedures,
// relations, subscriptions, scopes, field policies) plus an upload/download
// layer. FileResourceConfig is therefore a superset of ResourceConfig with the
// storage-specific options added.
interface FileResourceExtras {
  storage?: StorageAdapter;
  allowedMimeTypes?: string[];
  maxFileSize?: number;
  validation?: UploadValidationOptions;
  generateKey?: (filename: string, userId?: string) => string;
  usePresignedUrls?: boolean;
  presignedUrlExpiry?: number;
  /** @deprecated columns are read from the table; kept for back-compat. */
  schema?: FileTableSchema;
}

// Public config: a superset of the resource config (so column-name fields accept
// Drizzle columns, preferred, or names, deprecated) plus the storage options.
export interface FileResourceConfig<TConfig extends TableConfig = TableConfig>
  extends ResourceConfigInput<TConfig, Table<TConfig>>,
    FileResourceExtras {}

// Internal config after column references are normalized to names.
type NormalizedFileResourceConfig<TConfig extends TableConfig> =
  ResourceConfig<TConfig, Table<TConfig>> & FileResourceExtras;

const defaultGenerateKey = (filename: string, userId?: string): string => {
  const timestamp = Date.now();
  const uuid = randomUUID().slice(0, 8);
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  if (userId) {
    return `${userId}/${timestamp}-${uuid}-${sanitized}`;
  }
  return `${timestamp}-${uuid}-${sanitized}`;
};

const parseMultipartFormData = async (
  c: Context
): Promise<{ file: Buffer; filename: string; mimeType: string } | null> => {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) return null;

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return null;
  }

  for (const value of Object.values(body)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (candidate instanceof File) {
        const file = Buffer.from(await candidate.arrayBuffer());
        const mimeType = candidate.type || "application/octet-stream";
        return { file, filename: candidate.name, mimeType };
      }
    }
  }
  return null;
};

export const useFileResource = <TConfig extends TableConfig>(
  table: Table<TConfig> & FileTableSchema,
  rawConfig: FileResourceConfig<TConfig>
): Hono => {
  // Normalize column-reference fields to JS property keys before reading
  // generatedFields/fields here and before passing through to useResource.
  const config = normalizeResourceConfig(
    rawConfig,
    table as unknown as Table<TConfig>
  ) as NormalizedFileResourceConfig<TConfig>;
  const storage =
    config.storage ?? (hasGlobalStorage() ? getGlobalStorage() : null);
  if (!storage) {
    throw new Error(
      "Storage not configured. Either pass storage in config or call initializeStorage() first."
    );
  }

  const {
    db,
    id: idColumn,
    allowedMimeTypes,
    maxFileSize,
    validation,
    generateKey = defaultGenerateKey,
    usePresignedUrls = false,
    presignedUrlExpiry = 3600,
  } = config;

  const resourceName = getTableName(table);
  // Property key (not DB name) since it indexes rows returned by drizzle.
  const idColumnName = columnPropertyKey(table as unknown as Table<TConfig>, idColumn as DrizzleColumn);
  const hasUserId = "userId" in getTableColumns(table);
  const filterer = createResourceFilter(table, config.customOperators ?? {});
  const scopeResolver = createScopeResolver(config.auth, resourceName);

  // Storage-managed columns are server-generated; the client never writes them.
  const generatedFields = Array.from(
    new Set([
      "id",
      "storagePath",
      "status",
      "url",
      "size",
      "mimeType",
      "createdAt",
      ...(config.generatedFields ?? []),
    ])
  );

  // Compose storage cleanup into onAfterDelete so deleting a record (via the
  // generic resource DELETE) also removes the stored object.
  const userHooks: LifecycleHooks<TConfig> = config.hooks ?? {};
  const hooks: LifecycleHooks<TConfig> = {
    ...userHooks,
    onAfterDelete: async (ctx, deleted) => {
      const storagePath = (deleted as Record<string, unknown>).storagePath as
        | string
        | undefined;
      if (storagePath) {
        try {
          await storage.delete(storagePath);
        } catch {
          // Best-effort: the row is already gone; don't fail the request.
        }
      }
      if (userHooks.onAfterDelete) await userHooks.onAfterDelete(ctx, deleted);
    },
  };

  const dbAny = db as {
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } };
    select: () => { from: (t: unknown) => { where: (c: unknown) => { limit: (n: number) => Promise<unknown[]> } } };
    update: (t: unknown) => { set: (v: unknown) => { where: (c: unknown) => { returning: () => Promise<unknown[]> } } };
    delete: (t: unknown) => { where: (c: unknown) => Promise<void> };
  };

  const readable = config.fields?.readable;
  const mask = (record: Record<string, unknown>): Record<string, unknown> => {
    if (!readable) return record;
    const out: Record<string, unknown> = {};
    for (const key of readable) if (key in record) out[key] = record[key];
    return out;
  };

  // Mirrors the resource hook's scope gate: impersonation/bypass aware.
  const requireCreate = async (c: Context): Promise<void> => {
    if (c.get("impersonatedId")) {
      await scopeResolver.requirePermission("create", getUser(c));
      return;
    }
    if (await isAdminBypassRequest(c)) return;
    await scopeResolver.requirePermission("create", getUser(c));
  };

  const requireReadAccess = async (
    c: Context,
    record: Record<string, unknown>
  ): Promise<void> => {
    if (!c.get("impersonatedId") && (await isAdminBypassRequest(c))) return;
    const scope = await scopeResolver.resolve("read", getUser(c));
    const expr = scope.toString();
    if (expr === "*") return;
    if (scope.isEmpty() || !filterer.execute(expr, record as InferSelectModel<typeof table>)) {
      throw new ForbiddenError("Not authorized to access this file");
    }
  };

  const router = new Hono();

  // --- Upload (custom create): multipart -> storage -> tracked create ---
  router.post("/", async (c) => {
    await requireCreate(c);

    const parsed = await parseMultipartFormData(c);
    if (!parsed) {
      throw new ValidationError("No file provided or invalid multipart form data");
    }
    const { file, filename, mimeType } = parsed;

    if (allowedMimeTypes && !allowedMimeTypes.includes(mimeType)) {
      throw new ValidationError(
        `File type not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`
      );
    }
    if (maxFileSize && file.length > maxFileSize) {
      throw new ValidationError(
        `File too large. Maximum size: ${Math.round(maxFileSize / 1024 / 1024)}MB`
      );
    }
    if (validation) {
      validateUpload({ contentType: mimeType, size: file.length }, validation);
    }

    const user = getUser(c);
    const userId = user?.id;
    const key = generateKey(filename, userId);
    const result = await storage.upload(key, file, { filename, mimeType });
    const url = storage.getUrl(key);

    let record: Record<string, unknown> = {
      id: randomUUID(),
      filename,
      mimeType,
      size: result.size,
      storagePath: key,
      url,
      status: "completed",
      createdAt: new Date(),
    };
    if (hasUserId) record.userId = userId ?? null;

    const ctx: ProcedureContext<TConfig> = {
      db,
      schema: table,
      user,
      req: c.req.raw,
      context: c,
    };
    record =
      ((await executeBeforeCreate(hooks, ctx, record as never)) as
        | Record<string, unknown>
        | undefined) ?? record;

    const [created] = (await dbAny.insert(table).values(record).returning()) as Record<
      string,
      unknown
    >[];

    await executeAfterCreate(hooks, ctx, created as never);
    recordCreate(resourceName, String(created[idColumnName]), created, userId);
    await pushInsertsToSubscriptions(
      resourceName,
      filterer as never,
      [created],
      idColumnName,
      undefined,
      undefined
    );

    return c.json(mask(created), 201);
  });

  // --- Presigned upload URL ---
  router.get("/upload-url", async (c) => {
    await requireCreate(c);

    if (!storage.supportsPresignedUrls()) {
      throw new ValidationError("This storage adapter does not support presigned URLs");
    }
    const filename = c.req.query("filename");
    const contentType = c.req.query("contentType");
    if (!filename) {
      throw new ValidationError("filename query parameter is required");
    }
    if (allowedMimeTypes && contentType && !allowedMimeTypes.includes(contentType)) {
      throw new ValidationError(
        `File type not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`
      );
    }
    if (validation) validateUpload({ contentType }, validation);

    const user = getUser(c);
    const userId = user?.id;
    const key = generateKey(filename, userId);

    const presignedOptions: PresignedUrlOptions = { expiresIn: presignedUrlExpiry, contentType };
    if (maxFileSize) presignedOptions.contentLength = maxFileSize;

    const uploadUrl = await storage.getUploadUrl(key, presignedOptions);
    if (!uploadUrl) throw new ValidationError("Failed to generate upload URL");

    const id = randomUUID();
    const record: Record<string, unknown> = {
      id,
      filename,
      mimeType: contentType || "application/octet-stream",
      size: 0,
      storagePath: key,
      url: null,
      status: "pending",
      createdAt: new Date(),
    };
    if (hasUserId) record.userId = userId ?? null;
    await dbAny.insert(table).values(record).returning();

    return c.json({
      fileId: id,
      uploadUrl: uploadUrl.url,
      fields: uploadUrl.fields,
      key,
      expiresAt: uploadUrl.expiresAt,
    });
  });

  // --- Confirm a presigned upload ---
  router.post("/:id/confirm", async (c) => {
    const fileId = c.req.param("id");
    const [file] = (await dbAny
      .select()
      .from(table)
      .where(eq(idColumn, fileId))
      .limit(1)) as Record<string, unknown>[];
    if (!file) throw new NotFoundError("File", fileId);
    await requireReadAccess(c, file);

    if (file.status === "completed") return c.json(file);

    const metadata = await storage.getMetadata(file.storagePath as string);
    if (!metadata) throw new NotFoundError("File", file.storagePath as string);

    const url = storage.getUrl(file.storagePath as string);
    const [updated] = (await dbAny
      .update(table)
      .set({ size: metadata.size, mimeType: metadata.mimeType, url, status: "completed" })
      .where(eq(idColumn, fileId))
      .returning()) as Record<string, unknown>[];

    return c.json(updated);
  });

  // --- Download (stream or presigned redirect) ---
  router.get("/:id/download", async (c) => {
    const fileId = c.req.param("id");
    const [file] = (await dbAny
      .select()
      .from(table)
      .where(eq(idColumn, fileId))
      .limit(1)) as Record<string, unknown>[];
    if (!file) throw new NotFoundError("File", fileId);
    await requireReadAccess(c, file);

    if (file.status !== "completed") {
      throw new ValidationError("File upload not completed");
    }

    if (usePresignedUrls && storage.supportsPresignedUrls()) {
      const downloadUrl = await storage.getDownloadUrl(file.storagePath as string, {
        expiresIn: presignedUrlExpiry,
      });
      if (downloadUrl) return c.redirect(downloadUrl, 302);
    }

    const stream = await storage.downloadStream(file.storagePath as string);
    c.header("Content-Type", file.mimeType as string);
    c.header("Content-Disposition", `attachment; filename="${file.filename as string}"`);
    c.header("Content-Length", String(file.size));
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
  });

  // --- Batch delete by ids (preserves the {ids} contract) ---
  router.delete("/batch", async (c) => {
    const { ids } = (await readJsonBody(c)) as { ids: string[] };
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError("ids array is required");
    }
    const files = (await dbAny
      .select()
      .from(table)
      .where(inArray(idColumn, ids))
      .limit(ids.length)) as Record<string, unknown>[];

    for (const file of files) {
      if (!c.get("impersonatedId") && (await isAdminBypassRequest(c))) break;
      const scope = await scopeResolver.resolve("delete", getUser(c));
      const expr = scope.toString();
      if (expr === "*") continue;
      if (scope.isEmpty() || !filterer.execute(expr, file as InferSelectModel<typeof table>)) {
        throw new ForbiddenError(`Not authorized to delete file ${String(file.id)}`);
      }
    }

    const storagePaths = files.map((f) => f.storagePath as string);
    await storage.deleteMany(storagePaths);
    for (const file of files) {
      await dbAny.delete(table).where(eq(idColumn, file.id));
    }
    return c.json({ deleted: files.length });
  });

  // --- Everything else (list, get, patch, delete, subscribe, count,
  // aggregate, rpc, relations, hooks, field policies, full auth scopes) is a
  // regular resource. ---
  router.route("/", useResource(table, { ...config, hooks, generatedFields } as ResourceConfig<TConfig, Table<TConfig>>));

  // Mark for the admin data explorer (download action).
  setResourceFileFlag(resourceName, true);

  return router;
};
