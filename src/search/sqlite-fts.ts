import { sql, SQL } from "drizzle-orm";
import {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  IndexMappings,
} from "./types";

interface SqliteRunner {
  run(query: SQL): Promise<unknown> | unknown;
  all(query: SQL): Promise<unknown[]> | unknown[];
}

export interface SqliteFtsConfig {
  db: SqliteRunner;
  tablePrefix?: string;
  columns?: string[];
}

interface IndexState {
  columns: string[];
  ready: boolean;
}

const identifier = (name: string): string => {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid identifier for FTS table/column: ${name}`);
  }
  return name;
};

const escapeFtsQuery = (input: string): string => {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(" ");
};

const toIndexableString = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => toIndexableString(v)).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((v) => toIndexableString(v))
      .join(" ");
  }
  return String(value);
};

export const createSqliteFtsAdapter = (
  config: SqliteFtsConfig
): SearchAdapter => {
  const { db } = config;
  const prefix = config.tablePrefix ?? "concave_fts_";
  const states: Map<string, IndexState> = new Map();

  const ftsTable = (indexName: string) => identifier(`${prefix}${indexName}`);
  const docTable = (indexName: string) =>
    identifier(`${prefix}${indexName}_docs`);

  const run = async (query: SQL): Promise<void> => {
    await db.run(query);
  };

  const all = async <R>(query: SQL): Promise<R[]> => {
    const rows = await db.all(query);
    return rows as R[];
  };

  const ensureColumns = (indexName: string, columns: string[]): IndexState => {
    let state = states.get(indexName);
    if (!state) {
      state = { columns: columns.map(identifier), ready: false };
      states.set(indexName, state);
    }
    return state;
  };

  const createFtsTable = async (indexName: string, columns: string[]) => {
    const columnDefs = columns.join(", ");
    const fts = ftsTable(indexName);
    const docs = docTable(indexName);
    await run(
      sql.raw(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(doc_id UNINDEXED, ${columnDefs}, tokenize = 'porter unicode61')`
      )
    );
    await run(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${docs} (doc_id TEXT PRIMARY KEY, source TEXT NOT NULL)`
      )
    );
  };

  const initIndex = async (
    indexName: string,
    columns: string[]
  ): Promise<IndexState> => {
    const state = ensureColumns(indexName, columns);
    if (!state.ready) {
      await createFtsTable(indexName, state.columns);
      state.ready = true;
    }
    return state;
  };

  const detectColumns = (document: Record<string, unknown>): string[] => {
    if (config.columns && config.columns.length > 0) {
      return config.columns;
    }
    return Object.keys(document).filter((k) => k !== "id");
  };

  return {
    async index(indexName, id, document) {
      const columns = detectColumns(document);
      const state = await initIndex(indexName, columns);

      const fts = ftsTable(indexName);
      const docs = docTable(indexName);

      await run(sql`DELETE FROM ${sql.raw(fts)} WHERE doc_id = ${id}`);

      const valueExprs: SQL[] = [sql`${id}`];
      for (const col of state.columns) {
        valueExprs.push(sql`${toIndexableString(document[col])}`);
      }
      const colList = `doc_id, ${state.columns.join(", ")}`;
      await run(
        sql`INSERT INTO ${sql.raw(fts)} (${sql.raw(colList)}) VALUES (${sql.join(
          valueExprs,
          sql`, `
        )})`
      );

      await run(
        sql`INSERT INTO ${sql.raw(
          docs
        )} (doc_id, source) VALUES (${id}, ${JSON.stringify(
          document
        )}) ON CONFLICT(doc_id) DO UPDATE SET source = excluded.source`
      );
    },

    async delete(indexName, id) {
      const state = states.get(indexName);
      if (!state || !state.ready) {
        return;
      }
      const fts = ftsTable(indexName);
      const docs = docTable(indexName);
      await run(sql`DELETE FROM ${sql.raw(fts)} WHERE doc_id = ${id}`);
      await run(sql`DELETE FROM ${sql.raw(docs)} WHERE doc_id = ${id}`);
    },

    async search<T = Record<string, unknown>>(
      indexName: string,
      query: SearchQuery
    ): Promise<SearchResult<T>> {
      const state = states.get(indexName);
      if (!state || !state.ready) {
        return { hits: [], total: 0 };
      }

      const fts = ftsTable(indexName);
      const docs = docTable(indexName);
      const from = query.from ?? 0;
      const size = query.size ?? 20;

      const matchExpr = escapeFtsQuery(query.query);
      if (matchExpr.length === 0) {
        return { hits: [], total: 0 };
      }

      const searchFields =
        query.fields && query.fields.length > 0
          ? query.fields
              .map((f) => identifier(f))
              .filter((f) => state.columns.includes(f))
          : state.columns;

      if (query.fields && searchFields.length === 0) {
        return { hits: [], total: 0 };
      }

      const useColumnFilter =
        Boolean(query.fields) && searchFields.length < state.columns.length;
      const columnFilter = useColumnFilter
        ? `{${searchFields.join(" ")}} : `
        : "";
      const fullMatch = `${columnFilter}${matchExpr}`;

      const countRows = await all<{ cnt: number }>(
        sql`SELECT COUNT(*) as cnt FROM ${sql.raw(fts)} WHERE ${sql.raw(
          fts
        )} MATCH ${fullMatch}`
      );
      const total = Number(countRows[0]?.cnt ?? 0);

      const rows = await all<{
        doc_id: string;
        source: string;
        rank: number;
      }>(
        sql`SELECT f.doc_id as doc_id, d.source as source, bm25(${sql.raw(
          fts
        )}) as rank
            FROM ${sql.raw(fts)} f
            JOIN ${sql.raw(docs)} d ON d.doc_id = f.doc_id
            WHERE ${sql.raw(fts)} MATCH ${fullMatch}
            ORDER BY rank ASC
            LIMIT ${size} OFFSET ${from}`
      );

      const hits = rows.map((row) => {
        const source = JSON.parse(row.source) as Record<string, unknown>;
        const score = row.rank === 0 ? 0 : -row.rank;
        const hit: {
          id: string;
          score: number;
          source: T;
          highlights?: Record<string, string[]>;
        } = {
          id: row.doc_id,
          score,
          source: source as T,
        };
        if (query.highlight) {
          const lowered = query.query.toLowerCase();
          hit.highlights = Object.fromEntries(
            Object.entries(source)
              .filter(
                ([, v]) =>
                  typeof v === "string" && v.toLowerCase().includes(lowered)
              )
              .map(([k, v]) => [k, [String(v)]])
          );
        }
        return hit;
      });

      return { hits, total };
    },

    async createIndex(indexName: string, mappings: IndexMappings) {
      const columns =
        config.columns && config.columns.length > 0
          ? config.columns
          : Object.entries(mappings.properties)
              .filter(
                ([name, m]) =>
                  name !== "id" &&
                  (m.type === "text" || m.type === "keyword") &&
                  m.index !== false
              )
              .map(([name]) => name);
      await initIndex(indexName, columns.length > 0 ? columns : ["content"]);
    },

    async deleteIndex(indexName: string) {
      const fts = ftsTable(indexName);
      const docs = docTable(indexName);
      await run(sql.raw(`DROP TABLE IF EXISTS ${fts}`));
      await run(sql.raw(`DROP TABLE IF EXISTS ${docs}`));
      states.delete(indexName);
    },

    async indexExists(indexName: string) {
      const rows = await all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${ftsTable(
          indexName
        )}`
      );
      const exists = rows.length > 0;
      if (exists && !states.has(indexName)) {
        states.set(indexName, {
          columns: (config.columns ?? []).map(identifier),
          ready: true,
        });
      }
      return exists;
    },
  };
};
