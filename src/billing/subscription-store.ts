import { eq } from "drizzle-orm";
import { getGlobalKV, hasGlobalKV, KVAdapter } from "@/kv";
import type { DrizzleDatabase } from "@/resource/types";
import {
  defineInternalSchema,
  type BillingSubscriptionKey,
  type InternalSchemaBundle,
  type TableResolver,
} from "@/db/internal-schema";
import { detectDialect } from "@/db/migrate";
import type { BillingProviderName, BillingSubscription, SubscriptionStatus } from "./types";

export interface StoredSubscription {
  subscription: BillingSubscription;
  account?: string;
  updatedAt: number;
  source: "webhook" | "reconcile";
}

// Local mirror of provider subscription state, written by the webhook path and
// by reconciliation. Reconciliation diffs this against the provider.
export interface BillingSubscriptionStore {
  readonly durable?: boolean;
  get(id: string): Promise<StoredSubscription | null>;
  put(record: StoredSubscription): Promise<void>;
  listByCustomer(customerId: string): Promise<StoredSubscription[]>;
  listCustomers(): Promise<string[]>;
}

const SUBS_HASH = "covara:billing:subs";
const CUSTOMER_PREFIX = "covara:billing:subs:cust:";
const CUSTOMERS_SET = "covara:billing:subs:customers";

const DATE_FIELDS = ["currentPeriodStart", "currentPeriodEnd", "trialEndsAt"] as const;

const reviveRecord = (raw: string): StoredSubscription => {
  const record = JSON.parse(raw) as StoredSubscription;
  const sub = record.subscription as unknown as Record<string, unknown>;
  for (const field of DATE_FIELDS) {
    if (typeof sub[field] === "string" || typeof sub[field] === "number") {
      sub[field] = new Date(sub[field] as string | number);
    }
  }
  return record;
};

export const createKVSubscriptionStore = (kv?: KVAdapter): BillingSubscriptionStore => {
  const resolveKv = (): KVAdapter => {
    if (kv) return kv;
    if (!hasGlobalKV()) {
      throw new Error("KV subscription store requires a KV store. Configure a global KV or pass one in.");
    }
    return getGlobalKV();
  };

  const get = async (id: string): Promise<StoredSubscription | null> => {
    const raw = await resolveKv().hget(SUBS_HASH, id);
    return raw ? reviveRecord(raw) : null;
  };

  return {
    durable: false,
    get,

    async put(record) {
      const store = resolveKv();
      const previous = await get(record.subscription.id);
      const customerId = record.subscription.customerId;
      if (previous && previous.subscription.customerId !== customerId) {
        await store.srem(`${CUSTOMER_PREFIX}${previous.subscription.customerId}`, record.subscription.id);
      }
      await store.hset(SUBS_HASH, record.subscription.id, JSON.stringify(record));
      await store.sadd(`${CUSTOMER_PREFIX}${customerId}`, record.subscription.id);
      await store.sadd(CUSTOMERS_SET, customerId);
    },

    async listByCustomer(customerId) {
      const store = resolveKv();
      const ids = await store.smembers(`${CUSTOMER_PREFIX}${customerId}`);
      const out: StoredSubscription[] = [];
      for (const id of ids) {
        const record = await get(id);
        if (record && record.subscription.customerId === customerId) out.push(record);
      }
      return out;
    },

    async listCustomers() {
      return resolveKv().smembers(CUSTOMERS_SET);
    },
  };
};

export interface DrizzleSubscriptionStoreOptions {
  db: DrizzleDatabase;
  schema?: InternalSchemaBundle;
}

type Row = Record<string, unknown>;

interface SubscriptionExecutor {
  select(fields?: Row): {
    from(table: unknown): { where(cond: unknown): PromiseLike<Row[]> & { limit(n: number): PromiseLike<Row[]> } } & PromiseLike<Row[]>;
  };
  selectDistinct(fields: Row): { from(table: unknown): PromiseLike<Row[]> };
  insert(table: unknown): {
    values(v: Row): { onConflictDoUpdate(config: { target: unknown; set: Row }): PromiseLike<unknown> };
  };
}

const toDate = (value: unknown): Date | undefined => {
  if (value == null) return undefined;
  if (value instanceof Date) return value;
  return new Date(value as string | number);
};

const toMillis = (value: unknown): number => toDate(value)?.getTime() ?? 0;

export const createDrizzleSubscriptionStore = (
  options: DrizzleSubscriptionStoreOptions
): BillingSubscriptionStore => {
  const db = options.db as unknown as SubscriptionExecutor;
  const schema = options.schema ?? defineInternalSchema({ dialect: detectDialect(options.db) });
  const r: TableResolver<BillingSubscriptionKey> = schema.billingSubscriptions;
  const col = (key: BillingSubscriptionKey) => r.col(key) as never;

  const read = (row: Row, key: BillingSubscriptionKey): unknown =>
    r.has(key) ? row[r.prop(key)] : undefined;

  const toRecord = (row: Row): StoredSubscription => {
    const optional = <T>(key: BillingSubscriptionKey, map: (v: unknown) => T): T | undefined => {
      const value = read(row, key);
      return value == null ? undefined : map(value);
    };
    const metadata = read(row, "metadata");
    const subscription: BillingSubscription = {
      id: String(read(row, "id")),
      customerId: String(read(row, "customerId")),
      status: read(row, "status") as SubscriptionStatus,
      provider: read(row, "provider") as BillingProviderName,
      priceId: optional("priceId", String),
      productId: optional("productId", String),
      quantity: optional("quantity", Number),
      currentPeriodStart: optional("currentPeriodStart", toDate),
      currentPeriodEnd: optional("currentPeriodEnd", toDate),
      cancelAtPeriodEnd: optional("cancelAtPeriodEnd", Boolean),
      trialEndsAt: optional("trialEndsAt", toDate),
      metadata:
        metadata == null
          ? undefined
          : typeof metadata === "string"
            ? (JSON.parse(metadata) as Record<string, unknown>)
            : (metadata as Record<string, unknown>),
    };
    for (const key of Object.keys(subscription) as (keyof BillingSubscription)[]) {
      if (subscription[key] === undefined) delete subscription[key];
    }
    return {
      subscription,
      account: optional("account", String),
      updatedAt: toMillis(read(row, "updatedAt")),
      source: (optional("source", String) as StoredSubscription["source"]) ?? "webhook",
    };
  };

  const toRow = (record: StoredSubscription): Row => {
    const sub = record.subscription;
    const values: Partial<Record<BillingSubscriptionKey, unknown>> = {
      id: sub.id,
      provider: sub.provider,
      customerId: sub.customerId,
      account: record.account ?? null,
      status: sub.status,
      priceId: sub.priceId ?? null,
      productId: sub.productId ?? null,
      quantity: sub.quantity ?? null,
      currentPeriodStart: sub.currentPeriodStart ?? null,
      currentPeriodEnd: sub.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? null,
      trialEndsAt: sub.trialEndsAt ?? null,
      metadata: sub.metadata ?? null,
      source: record.source,
      updatedAt: new Date(record.updatedAt),
    };
    const row: Row = {};
    for (const [key, value] of Object.entries(values)) {
      const k = key as BillingSubscriptionKey;
      if (r.has(k)) row[r.prop(k)] = value;
    }
    return row;
  };

  return {
    durable: true,

    async get(id) {
      const rows = await db.select().from(r.table).where(eq(col("id"), id)).limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async put(record) {
      const row = toRow(record);
      const set = { ...row };
      delete set[r.prop("id")];
      await db.insert(r.table).values(row).onConflictDoUpdate({ target: col("id"), set });
    },

    async listByCustomer(customerId) {
      const rows = await db.select().from(r.table).where(eq(col("customerId"), customerId));
      return rows.map(toRecord);
    },

    async listCustomers() {
      const rows = await db.selectDistinct({ customerId: col("customerId") }).from(r.table);
      return rows.map((row) => String(row.customerId));
    },
  };
};
