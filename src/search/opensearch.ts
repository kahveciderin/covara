import { SearchAdapter, SearchQuery, SearchResult, IndexMappings } from "./types";

export interface OpenSearchConfig {
  node: string | string[];
  auth?: { username: string; password: string };
  ssl?: { rejectUnauthorized?: boolean; ca?: string };
  indexPrefix?: string;
}

interface OpenSearchClient {
  index(params: {
    index: string;
    id: string;
    body: Record<string, unknown>;
    refresh?: boolean | "wait_for";
  }): Promise<unknown>;
  delete(params: {
    index: string;
    id: string;
    refresh?: boolean | "wait_for";
  }): Promise<unknown>;
   
  search(params: { index: string; body: Record<string, unknown> }): Promise<any>;
  indices: {
     
    exists(params: { index: string }): Promise<any>;
    create(params: {
      index: string;
      body: { mappings: IndexMappings };
    }): Promise<unknown>;
    delete(params: { index: string }): Promise<unknown>;
  };
}

export const createOpenSearchAdapter = async (
  config: OpenSearchConfig,
  clientFactory?: (config: OpenSearchConfig) => OpenSearchClient
): Promise<SearchAdapter> => {
  let client: OpenSearchClient;

  if (clientFactory) {
    client = clientFactory(config);
  } else {
    try {
      const { Client } = await import("@opensearch-project/opensearch");
      client = new Client({
        node: config.node,
        auth: config.auth,
        ssl: config.ssl,
      });
    } catch {
      throw new Error(
        "OpenSearch client not found. Install @opensearch-project/opensearch package."
      );
    }
  }

  const prefix = config.indexPrefix ?? "concave_";
  const prefixedName = (name: string) => `${prefix}${name}`;

  return {
    async index(indexName, id, document) {
      await client.index({
        index: prefixedName(indexName),
        id,
        body: document,
        refresh: true,
      });
    },

    async delete(indexName, id) {
      try {
        await client.delete({
          index: prefixedName(indexName),
          id,
          refresh: true,
        });
      } catch (err: unknown) {
        const error = err as { meta?: { statusCode?: number } };
        if (error.meta?.statusCode === 404) {
          return;
        }
        throw err;
      }
    },

    async search<T = Record<string, unknown>>(
      indexName: string,
      query: SearchQuery
    ): Promise<SearchResult<T>> {
      const fields =
        query.fields?.map((f) =>
          query.fieldWeights?.[f] ? `${f}^${query.fieldWeights[f]}` : f
        ) ?? ["*"];

      const body: Record<string, unknown> = {
        query: {
          multi_match: {
            query: query.query,
            fields,
            type: "best_fields",
            fuzziness: "AUTO",
          },
        },
        from: query.from ?? 0,
        size: query.size ?? 20,
      };

      if (query.highlight) {
        body.highlight = {
          fields: Object.fromEntries(
            (query.fields ?? ["*"]).map((f) => [f, {}])
          ),
        };
      }

      if (query.sort) {
        body.sort = query.sort.map((s) => ({ [s.field]: s.order }));
      }

      let response;
      try {
        response = await client.search({
          index: prefixedName(indexName),
          body,
        });
      } catch (err: unknown) {
        const error = err as { body?: { error?: { type?: string } } };
        if (error.body?.error?.type === "index_not_found_exception") {
          return { hits: [], total: 0 };
        }
        throw err;
      }

      const total =
        typeof response.body.hits.total === "number"
          ? response.body.hits.total
          : response.body.hits.total.value;

      return {
        hits: response.body.hits.hits.map((hit: {
          _id: string;
          _score?: number | string;
          _source?: Record<string, unknown>;
          highlight?: Record<string, string[]>;
        }) => ({
          id: hit._id,
          score: typeof hit._score === "number" ? hit._score : Number(hit._score) || 0,
          source: (hit._source ?? {}) as T,
          highlights: hit.highlight,
        })),
        total,
      };
    },

    async createIndex(indexName, mappings) {
      const exists = await client.indices.exists({
        index: prefixedName(indexName),
      });
      if (!exists.body) {
        await client.indices.create({
          index: prefixedName(indexName),
          body: { mappings },
        });
      }
    },

    async deleteIndex(indexName) {
      try {
        await client.indices.delete({ index: prefixedName(indexName) });
      } catch (err: unknown) {
        const error = err as { meta?: { statusCode?: number } };
        if (error.meta?.statusCode === 404) {
          return;
        }
        throw err;
      }
    },

    async indexExists(indexName) {
      const response = await client.indices.exists({
        index: prefixedName(indexName),
      });
      return response.body;
    },
  };
};
