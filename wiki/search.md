# Search

Covara provides built-in search integration that automatically adds `/search` endpoints to resources when a search adapter is configured. By default, all fields are searchable with zero configuration required.

## Quick Start

```typescript
import { Hono } from "hono";
import { useResource, setGlobalSearch, createOpenSearchAdapter } from "covara";

const app = new Hono();

// Configure the global search adapter
setGlobalSearch(createOpenSearchAdapter({
  node: "http://localhost:9200",
}));

// Resources automatically get a /search endpoint
app.route("/api/todos", useResource(todos, { db, id: todos.id }));

// GET /api/todos/search?q=important
// Returns: { items: [...], total: 10 }
```

## Search Adapters

### Built-in Full-Text Search (Recommended)

You don't need OpenSearch to get full-text search. Covara ships adapters that index into
your **primary database** — SQLite (FTS5) or PostgreSQL (`tsvector`) — so search works with
zero extra infrastructure. These are the recommended default for most deployments.

```typescript
import { setGlobalSearch } from "covara";
import { createSqliteFtsAdapter, createPostgresFtsAdapter } from "covara/search";
// (the same factories are re-exported from the search module)

// SQLite (libsql / better-sqlite3 / D1) — uses FTS5 virtual tables
setGlobalSearch(createSqliteFtsAdapter({
  db,                         // a runner with run(sql)/all(sql); your Drizzle db works
  tablePrefix: "covara_fts_", // optional, default "covara_fts_"
  columns: ["title", "body"], // optional; defaults to all string fields in the document
}));

// PostgreSQL — uses tsvector / to_tsquery
setGlobalSearch(createPostgresFtsAdapter({
  db,                         // a runner with execute(sql)
  language: "english",        // optional text-search config, default "english"
  tablePrefix: "covara_fts_",
}));
```

Both adapters:

- Create and manage their own backing tables (an FTS5 virtual table on SQLite, a tsvector
  table on Postgres) lazily on first index.
- Implement the full `SearchAdapter` interface, so they work with the automatic `/search`
  endpoint, auto-indexing, and RSQL post-filtering exactly like the OpenSearch adapter.
- Validate table/column identifiers to avoid injection, and index nested object/array
  values by flattening them to text.

### OpenSearch Adapter

For production use with OpenSearch or Elasticsearch:

```typescript
import { setGlobalSearch, createOpenSearchAdapter } from "covara";

setGlobalSearch(createOpenSearchAdapter({
  node: "http://localhost:9200",
  // Or multiple nodes:
  // node: ["http://node1:9200", "http://node2:9200"],
  auth: {
    username: "admin",
    password: "admin",
  },
  ssl: {
    rejectUnauthorized: false,
  },
  indexPrefix: "myapp_",  // Default: "covara_"
}));
```

The OpenSearch adapter:
- Uses `multi_match` queries with `best_fields` type
- Enables fuzzy matching with `AUTO` fuzziness
- Supports field boosting (weights)
- Refreshes after each index/delete operation

### Memory Adapter

For development and testing without external dependencies:

```typescript
import { setGlobalSearch, createMemorySearchAdapter } from "covara";

setGlobalSearch(createMemorySearchAdapter());
```

The memory adapter:
- Stores documents in memory
- Performs case-insensitive substring matching
- Supports all the same operations as OpenSearch
- Does not persist between restarts

## Search Endpoint

When search is enabled, resources get a `GET /search` endpoint:

```
GET /api/todos/search?q=important&filter=completed==false&limit=10&offset=0&highlight=true
```

### Query Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `q` | Search query (required) | - |
| `filter` | RSQL filter to apply to results | - |
| `limit` | Maximum results to return | 20 |
| `offset` | Number of results to skip | 0 |
| `highlight` | Include highlighted matches | false |

### Response Format

```json
{
  "items": [
    {
      "id": 1,
      "title": "Important Task",
      "description": "Do this first",
      "status": "active"
    }
  ],
  "total": 15,
  "highlights": {
    "1": {
      "title": ["<em>Important</em> Task"]
    }
  }
}
```

## Resource Configuration

### Enable/Disable Search

Search is enabled automatically when a global search adapter is configured. To explicitly control it:

```typescript
// Disable search for a resource
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: { enabled: false }
}));

// Explicitly enable (default when adapter is configured)
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: { enabled: true }
}));
```

### Custom Index Name

By default, the resource table name is used as the index name. Override it:

```typescript
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: {
    indexName: "custom_todos_index"
  }
}));
```

### Searchable Fields

By default, all fields are searchable. Restrict to specific fields:

```typescript
// Array syntax: only search these fields
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: {
    fields: ["title", "description"]
  }
}));

// Object syntax: configure weights and searchability
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: {
    fields: {
      title: { weight: 2.0 },           // Boost title matches
      description: { weight: 1.0 },     // Normal weight
      internalNotes: { searchable: false }  // Exclude from search
    }
  }
}));
```

### Auto-Indexing

By default, documents are automatically indexed when created, updated, or deleted. Disable this for manual control:

```typescript
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: {
    autoIndex: false  // Disable auto-indexing
  }
}));
```

### Transactional Outbox

By default, indexing happens inline after a mutation commits, with one immediate retry. If the search
backend is unavailable, the operation is dropped (the DB mutation still succeeds), which can leave the
index permanently out of sync until the row is touched again.

Enable the **transactional outbox** to get at-least-once DB → index convergence. Index/delete
operations are written to a durable KV-backed queue at mutation time and drained in the background
with exponential backoff. Operations that exhaust their retries are parked in a dead set rather than
lost.

```typescript
app.route("/api/todos", useResource(todos, {
  db,
  id: todos.id,
  search: {
    outbox: true,  // durable KV-backed index queue (requires a global KV)
  },
}));
```

Requirements and behavior:

- A global KV must be registered (`setGlobalKV(...)`); the outbox stores its queue, in-flight ops,
  and dead set there. Without a global KV, enabling `outbox` has no effect.
- On Node, enabling `outbox` on any resource starts a background drainer (a `setInterval`, default
  every 2s, draining up to 100 ops per tick, `.unref()`'d so it never holds the process open).
- Retries use exponential backoff: `base * 2^attempts` capped at 5 minutes (default base 1s, default
  10 attempts). After `maxAttempts`, an op is moved to the dead set and logged.
- **On Cloudflare Workers** there is no long-lived process, so you must drain the outbox yourself by
  calling `drainSearchOutbox()` from a scheduled (cron) handler or a queue consumer. Do not rely on
  `startSearchOutboxDrainer()` on Workers.

```typescript
import { drainSearchOutbox } from "covara";

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainSearchOutbox());
  },
};
```

#### Outbox API

```typescript
import {
  enqueueSearchOp,
  drainSearchOutbox,
  startSearchOutboxDrainer,
  getSearchOutboxStats,
} from "covara";

// Enqueue an index/delete op (returns false if no global KV is registered)
await enqueueSearchOp({ index: "todos", type: "index", docId: "1", document: { id: 1, title: "Hi" } });
await enqueueSearchOp({ index: "todos", type: "delete", docId: "1" });

// Drain pending ops once (use this on Workers); options override retry tuning
const result = await drainSearchOutbox({ maxAttempts: 10, backoffBaseMs: 1000, batchSize: 100 });
// result: { processed, succeeded, failed, dead }

// Start/stop the Node background drainer
const stop = startSearchOutboxDrainer({ intervalMs: 2000 });
stop();  // stopSearchOutboxDrainer()

// Inspect queue health
const { pending, dead } = await getSearchOutboxStats();
```

## Manual Index Management

For manual index control or bulk operations:

```typescript
import { getGlobalSearch } from "covara";

const search = getGlobalSearch();

// Index a document
await search.index("todos", "123", {
  id: 123,
  title: "Important Task",
  description: "Do this first"
});

// Delete from index
await search.delete("todos", "123");

// Search directly
const results = await search.search("todos", {
  query: "important",
  fields: ["title", "description"],
  fieldWeights: { title: 2.0 },
  from: 0,
  size: 20,
  highlight: true
});

// Index management
await search.createIndex("todos", {
  properties: {
    title: { type: "text" },
    description: { type: "text" },
    status: { type: "keyword" }
  }
});

await search.deleteIndex("todos");
const exists = await search.indexExists("todos");
```

## RSQL Filter Integration

Search results can be further filtered using RSQL:

```
GET /api/todos/search?q=task&filter=status==active;priority>=5
```

The filter is applied after the search query, allowing you to combine full-text search with structured filtering. All standard RSQL operators are supported.

## API Reference

### Global Functions

#### `setGlobalSearch(adapter)`

Registers the global search adapter.

```typescript
setGlobalSearch(createOpenSearchAdapter({ node: "http://localhost:9200" }));
```

#### `getGlobalSearch()`

Returns the registered search adapter. Throws if none registered.

```typescript
const search = getGlobalSearch();
await search.index("items", "1", { title: "Hello" });
```

#### `hasGlobalSearch()`

Returns `true` if a search adapter is registered.

```typescript
if (hasGlobalSearch()) {
  // Search is available
}
```

#### `clearGlobalSearch()`

Removes the registered search adapter. Useful for testing.

```typescript
clearGlobalSearch();
```

### Adapters

#### `createOpenSearchAdapter(config)`

Creates an adapter for OpenSearch/Elasticsearch.

```typescript
interface OpenSearchConfig {
  node: string | string[];
  auth?: { username: string; password: string };
  ssl?: { rejectUnauthorized?: boolean; ca?: string };
  indexPrefix?: string;  // Default: "covara_"
}
```

#### `createSqliteFtsAdapter(config)` / `createPostgresFtsAdapter(config)`

Create database-backed full-text adapters (no external service required).

```typescript
interface SqliteFtsConfig {
  db: { run(sql): unknown; all(sql): unknown[] };
  tablePrefix?: string;  // Default: "covara_fts_"
  columns?: string[];    // Default: all string fields in the indexed document
}

interface PostgresFtsConfig {
  db: { execute(sql): Promise<unknown> };
  tablePrefix?: string;  // Default: "covara_fts_"
  columns?: string[];
  language?: string;     // Default: "english"
}
```

#### `createMemorySearchAdapter()`

Creates an in-memory adapter for development/testing.

### SearchAdapter Interface

All adapters implement this interface:

```typescript
interface SearchAdapter {
  index(indexName: string, id: string, document: Record<string, unknown>): Promise<void>;
  delete(indexName: string, id: string): Promise<void>;
  search<T>(indexName: string, query: SearchQuery): Promise<SearchResult<T>>;
  createIndex(indexName: string, mappings: IndexMappings): Promise<void>;
  deleteIndex(indexName: string): Promise<void>;
  indexExists(indexName: string): Promise<boolean>;
}
```

### Configuration Types

```typescript
interface ResourceSearchConfig {
  enabled?: boolean;        // Default: true if adapter configured
  indexName?: string;       // Default: table name
  fields?: string[] | Record<string, SearchFieldConfig>;
  autoIndex?: boolean;      // Default: true
  outbox?: boolean;         // Durable KV-backed index queue (default: false)
  onIndexError?: (info: {   // Called when an inline index/delete op fails
    operation: "index" | "delete";
    id: string;
    index: string;
    error: unknown;
  }) => void | Promise<void>;
}

interface SearchFieldConfig {
  weight?: number;          // Boost factor (default: 1.0)
  searchable?: boolean;     // Default: true
  analyzer?: string;        // OpenSearch analyzer
}
```
