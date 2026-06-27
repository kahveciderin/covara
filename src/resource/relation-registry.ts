import type { Table, TableConfig, AnyColumn } from "drizzle-orm";

// Minimal structural view of a relation, enough to build a correlated EXISTS in
// the filter converter. Mirrors the relevant fields of RelationConfig in
// relations.ts without importing it (kept a leaf module to avoid an import cycle
// with filter.ts, which relations.ts depends on).
export interface RegisteredRelation {
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  schema: Table<TableConfig>;
  foreignKey: AnyColumn;
  references: AnyColumn;
  through?: {
    schema: Table<TableConfig>;
    sourceKey: AnyColumn;
    targetKey: AnyColumn;
  };
  // Whether this relation may be traversed by UNTRUSTED user-supplied filters.
  // Auth scopes are trusted and ignore this; user `?filter=` traversal is gated.
  filterable?: boolean;
}

export type RegisteredRelations = Record<string, RegisteredRelation>;

// A resource registers a thunk that resolves its relations lazily — discovery
// depends on every resource being registered first, which only holds after the
// app has finished mounting (i.e. at request time, not construction time).
type RelationsProvider = () => RegisteredRelations;

const providers = new Map<string, RelationsProvider>();

export const registerResourceRelations = (
  tableName: string,
  provider: RelationsProvider
): void => {
  providers.set(tableName, provider);
};

export const getResourceRelations = (
  tableName: string
): RegisteredRelations | undefined => {
  const provider = providers.get(tableName);
  return provider ? provider() : undefined;
};

export const clearResourceRelations = (): void => {
  providers.clear();
};
