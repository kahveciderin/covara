const DRIZZLE_NAME = Symbol.for("drizzle:Name");

export const COVARA_INTERNAL_TABLES = [
  "auth_sessions",
  "auth_accounts",
  "auth_api_keys",
  "auth_verification_tokens",
  "auth_passkeys",
  "billing_credit_entries",
  "billing_credit_balances",
  "billing_subscriptions",
] as const;

const BUNDLE_KEYS = [
  "sessions",
  "accounts",
  "apiKeys",
  "verificationTokens",
  "passkeys",
  "creditEntries",
  "creditBalances",
  "billingSubscriptions",
] as const;

const tableName = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const name = (value as Record<symbol, unknown>)[DRIZZLE_NAME];
  return typeof name === "string" ? name : undefined;
};

const bundleTableNames = (value: unknown): string[] => {
  if (!value || typeof value !== "object") return [];
  const bundle = value as Record<string, unknown>;
  if (typeof bundle.managedExternally !== "boolean") return [];
  return BUNDLE_KEYS.flatMap((key) => {
    const name = tableName((bundle[key] as { table?: unknown } | undefined)?.table);
    return name ? [name] : [];
  });
};

export const unmanagedInternalTables = (imports: Record<string, unknown>): string[] => {
  const exported = new Set<string>();
  const internal = new Set<string>(COVARA_INTERNAL_TABLES);
  for (const value of Object.values(imports)) {
    const name = tableName(value);
    if (name) exported.add(name);
    for (const bundled of bundleTableNames(value)) internal.add(bundled);
  }
  return [...internal].filter((name) => !exported.has(name)).sort();
};

const TABLE_FIELDS = ["tableName", "tbl_name", "tableFrom"] as const;

// drizzle-kit's SQLite push API takes no table filter, so its schema
// introspection (the sqlite_master reads) is served with the hidden tables'
// rows removed.
export const hideSqliteTables = <D extends object>(db: D, hidden: readonly string[]): D => {
  if (hidden.length === 0) return db;
  const names = new Set(hidden);
  const visible = (row: unknown): boolean =>
    !row ||
    typeof row !== "object" ||
    !TABLE_FIELDS.some((field) => names.has((row as Record<string, unknown>)[field] as string));
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "all" || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const rows = await (value as (...a: unknown[]) => unknown).apply(target, args);
        return Array.isArray(rows) ? rows.filter(visible) : rows;
      };
    },
  });
};

export const postgresTablesFilter = (hidden: readonly string[]): string[] | undefined =>
  hidden.length === 0 ? undefined : hidden.map((name) => `!${name}`);
