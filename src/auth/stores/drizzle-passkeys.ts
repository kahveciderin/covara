import { asc, eq } from "drizzle-orm";
import type { DrizzleDatabase } from "@/resource/types";
import {
  PASSKEY_REQUIRED,
  internalSchema,
  makeIdentityResolver,
  type PasskeyKey,
  type TableResolver,
} from "@/db/internal-schema";
import { detectDialect } from "@/db/migrate";
import type {
  PasskeyDeviceType,
  PasskeyStore,
  PasskeyUpdate,
  StoredPasskey,
} from "../passkey-store";

export interface DrizzlePasskeyStoreOptions {
  db: DrizzleDatabase;
  // A `defineInternalSchema(...).passkeys` resolver (custom table / remapped
  // columns). Defaults to the built-in `auth_passkeys` table for the db dialect.
  resolver?: TableResolver<PasskeyKey>;
  table?: Record<string, unknown>;
}

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string | number);
};

const toTransports = (value: unknown): string[] | null => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      return null;
    }
  }
  return null;
};

const toBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 || value === "1" || value === "true";
};

export class DrizzlePasskeyStore implements PasskeyStore {
  private db: DrizzleDatabase;
  private resolver: TableResolver<PasskeyKey>;

  constructor(options: DrizzlePasskeyStoreOptions) {
    this.db = options.db;
    this.resolver =
      options.resolver ??
      makeIdentityResolver(
        options.table ??
          (internalSchema(detectDialect(options.db)).authPasskeys as unknown as Record<
            string,
            unknown
          >),
        PASSKEY_REQUIRED,
        "passkeys"
      );
  }

  private get table(): never {
    return this.resolver.table as never;
  }

  private optional(row: Record<string, unknown>, key: PasskeyKey): unknown {
    return this.resolver.has(key) ? row[this.resolver.prop(key)] : undefined;
  }

  private toPasskey(row: Record<string, unknown>): StoredPasskey {
    const r = this.resolver;
    return {
      id: row[r.prop("id")] as string,
      userId: row[r.prop("userId")] as string,
      webauthnUserId: row[r.prop("webauthnUserId")] as string,
      publicKey: row[r.prop("publicKey")] as string,
      counter: Number(row[r.prop("counter")] ?? 0),
      transports: toTransports(this.optional(row, "transports")),
      deviceType: (this.optional(row, "deviceType") as PasskeyDeviceType | null) ?? null,
      backedUp: toBoolean(this.optional(row, "backedUp")),
      name: (this.optional(row, "name") as string | null) ?? null,
      createdAt: toDate(row[r.prop("createdAt")]) ?? new Date(0),
      lastUsedAt: toDate(this.optional(row, "lastUsedAt")),
    };
  }

  private assign(target: Record<string, unknown>, key: PasskeyKey, value: unknown): void {
    if (this.resolver.has(key)) target[this.resolver.prop(key)] = value;
  }

  async create(passkey: StoredPasskey): Promise<void> {
    const values: Record<string, unknown> = {};
    this.assign(values, "id", passkey.id);
    this.assign(values, "userId", passkey.userId);
    this.assign(values, "webauthnUserId", passkey.webauthnUserId);
    this.assign(values, "publicKey", passkey.publicKey);
    this.assign(values, "counter", passkey.counter);
    this.assign(values, "transports", passkey.transports ?? null);
    this.assign(values, "deviceType", passkey.deviceType ?? null);
    this.assign(values, "backedUp", passkey.backedUp ?? null);
    this.assign(values, "name", passkey.name ?? null);
    this.assign(values, "createdAt", passkey.createdAt);
    this.assign(values, "lastUsedAt", passkey.lastUsedAt ?? null);
    await this.db.insert(this.table).values(values as never);
  }

  async findById(id: string): Promise<StoredPasskey | null> {
    const rows = (await this.db
      .select()
      .from(this.table)
      .where(eq(this.resolver.col("id") as never, id))
      .limit(1)) as Record<string, unknown>[];
    return rows[0] ? this.toPasskey(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<StoredPasskey[]> {
    const rows = (await this.db
      .select()
      .from(this.table)
      .where(eq(this.resolver.col("userId") as never, userId))
      .orderBy(asc(this.resolver.col("createdAt") as never))) as Record<string, unknown>[];
    return rows.map((row) => this.toPasskey(row));
  }

  async update(id: string, patch: PasskeyUpdate): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const key of ["counter", "lastUsedAt", "backedUp", "name"] as const) {
      if (patch[key] !== undefined) this.assign(set, key, patch[key]);
    }
    if (Object.keys(set).length === 0) return;
    await this.db
      .update(this.table)
      .set(set as never)
      .where(eq(this.resolver.col("id") as never, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(this.table).where(eq(this.resolver.col("id") as never, id));
  }
}

export const createDrizzlePasskeyStore = (
  options: DrizzlePasskeyStoreOptions
): DrizzlePasskeyStore => new DrizzlePasskeyStore(options);
