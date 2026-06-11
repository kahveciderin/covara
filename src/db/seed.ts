import type { DrizzleDatabase } from "@/resource/types";

export interface SeedTableSpec<Row extends Record<string, unknown> = Record<string, unknown>> {
  table: unknown;
  rows: Row[];
}

export interface SeedOptions {
  tables: SeedTableSpec[];
}

export interface SeedTableResult {
  attempted: number;
}

export interface SeedSummary {
  tables: number;
  rows: number;
  results: SeedTableResult[];
}

const insertIgnore = async (
  db: DrizzleDatabase,
  table: unknown,
  rows: Record<string, unknown>[]
): Promise<void> => {
  if (rows.length === 0) return;

  const builder = (db as { insert: (t: unknown) => unknown }).insert(table) as {
    values: (v: unknown) => {
      onConflictDoNothing: () => Promise<unknown>;
    };
  };

  await builder.values(rows).onConflictDoNothing();
};

export const seed = async (
  db: DrizzleDatabase,
  options: SeedOptions
): Promise<SeedSummary> => {
  const results: SeedTableResult[] = [];
  let totalRows = 0;

  for (const spec of options.tables) {
    await insertIgnore(db, spec.table, spec.rows as Record<string, unknown>[]);
    results.push({ attempted: spec.rows.length });
    totalRows += spec.rows.length;
  }

  return {
    tables: options.tables.length,
    rows: totalRows,
    results,
  };
};

export class SeedBuilder {
  private specs: SeedTableSpec[] = [];

  table<Row extends Record<string, unknown>>(
    table: unknown,
    rows: Row[]
  ): this {
    this.specs.push({ table, rows });
    return this;
  }

  async run(db: DrizzleDatabase): Promise<SeedSummary> {
    return seed(db, { tables: this.specs });
  }
}

export const createSeed = (): SeedBuilder => new SeedBuilder();
