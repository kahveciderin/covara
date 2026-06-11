import { sql, SQL } from "drizzle-orm";
import {
  SearchAdapter,
  SearchQuery,
  SearchResult,
  IndexMappings,
} from "./types";

interface PgRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] } | unknown>;
}

export interface PostgresFtsConfig {
  db: PgRunner;
  tablePrefix?: string;
  columns?: string[];
  language?: string;
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

const extractRows = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { rows?: unknown }).rows)
  ) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
};

export const createPostgresFtsAdapter = (
  config: PostgresFtsConfig
): SearchAdapter => {
  const { db } = config;
  const prefix = config.tablePrefix ?? "covara_fts_";
  const language = config.language ?? "english";
  const states: Map<string, IndexState> = new Map();

  const tableName = (indexName: string) => identifier(`${prefix}${indexName}`);

  const exec = async (query: SQL): Promise<Record<string, unknown>[]> => {
    const result = await db.execute(query);
    return extractRows(result);
  };

  const buildSearchText = (
    document: Record<string, unknown>,
    columns: string[]
  ): string =>
    columns
      .map((col) => toIndexableString(document[col]))
      .filter((v) => v.length > 0)
      .join(" ");

  const detectColumns = (document: Record<string, unknown>): string[] => {
    if (config.columns && config.columns.length > 0) {
      return config.columns;
    }
    return Object.keys(document).filter((k) => k !== "id");
  };

  const ensureColumns = (indexName: string, columns: string[]): IndexState => {
    let state = states.get(indexName);
    if (!state) {
      state = { columns: columns.map(identifier), ready: false };
      states.set(indexName, state);
    }
    return state;
  };

  const createTable = async (indexName: string) => {
    const table = tableName(indexName);
    await exec(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${table} (
          doc_id TEXT PRIMARY KEY,
          source JSONB NOT NULL,
          search_vector tsvector
        )`
      )
    );
    await exec(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS ${table}_search_idx ON ${table} USING GIN (search_vector)`
      )
    );
  };

  const initIndex = async (
    indexName: string,
    columns: string[]
  ): Promise<IndexState> => {
    const state = ensureColumns(indexName, columns);
    if (!state.ready) {
      await createTable(indexName);
      state.ready = true;
    }
    return state;
  };

  return {
    async index(indexName, id, document) {
      const columns = detectColumns(document);
      const state = await initIndex(indexName, columns);
      const table = tableName(indexName);
      const text = buildSearchText(document, state.columns);

      await exec(
        sql`INSERT INTO ${sql.raw(table)} (doc_id, source, search_vector)
            VALUES (${id}, ${JSON.stringify(document)}::jsonb, to_tsvector(${language}::regconfig, ${text}))
            ON CONFLICT (doc_id) DO UPDATE
            SET source = excluded.source, search_vector = excluded.search_vector`
      );
    },

    async delete(indexName, id) {
      const state = states.get(indexName);
      if (!state || !state.ready) {
        return;
      }
      const table = tableName(indexName);
      await exec(sql`DELETE FROM ${sql.raw(table)} WHERE doc_id = ${id}`);
    },

    async search<T = Record<string, unknown>>(
      indexName: string,
      query: SearchQuery
    ): Promise<SearchResult<T>> {
      const state = states.get(indexName);
      if (!state || !state.ready) {
        return { hits: [], total: 0 };
      }

      const table = tableName(indexName);
      const from = query.from ?? 0;
      const size = query.size ?? 20;

      if (query.query.trim().length === 0) {
        return { hits: [], total: 0 };
      }

      const tsquery = sql`plainto_tsquery(${language}::regconfig, ${query.query})`;

      const countRows = await exec(
        sql`SELECT COUNT(*)::int as cnt FROM ${sql.raw(
          table
        )} WHERE search_vector @@ ${tsquery}`
      );
      const total = Number(countRows[0]?.cnt ?? 0);

      if (total === 0) {
        return { hits: [], total: 0 };
      }

      const rows = await exec(
        sql`SELECT doc_id, source, ts_rank(search_vector, ${tsquery}) as rank
            FROM ${sql.raw(table)}
            WHERE search_vector @@ ${tsquery}
            ORDER BY rank DESC
            LIMIT ${size} OFFSET ${from}`
      );

      const hits = rows.map((row) => {
        const rawSource = row.source;
        const source = (
          typeof rawSource === "string" ? JSON.parse(rawSource) : rawSource
        ) as Record<string, unknown>;
        const hit: {
          id: string;
          score: number;
          source: T;
          highlights?: Record<string, string[]>;
        } = {
          id: String(row.doc_id),
          score: Number(row.rank ?? 0),
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
      const table = tableName(indexName);
      await exec(sql.raw(`DROP TABLE IF EXISTS ${table}`));
      states.delete(indexName);
    },

    async indexExists(indexName: string) {
      const rows = await exec(
        sql`SELECT to_regclass(${tableName(indexName)}) as reg`
      );
      const exists = rows.length > 0 && rows[0]?.reg != null;
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
