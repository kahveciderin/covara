---
id: search
title: Full-text search
sidebar_label: Search
description: Built-in full-text search via SQLite FTS5, Postgres tsvector, OpenSearch, or in-memory adapters, with auto-indexing, field weights, RSQL post-filtering, and an at-least-once transactional outbox.
---

# Full-text search

When a search adapter is registered, every resource gains a `GET /search` endpoint. By default all fields are searchable with zero configuration, and documents are auto-indexed on create/update/delete.

## Choosing an adapter

| Adapter | Factory | Best for |
|---------|---------|----------|
| **SQLite FTS5** | `createSqliteFtsAdapter` | Most apps on SQLite/libsql/D1 — no extra service |
| **Postgres `tsvector`** | `createPostgresFtsAdapter` | Apps on PostgreSQL — no extra service |
| **OpenSearch / Elasticsearch** | `createOpenSearchAdapter` | Large-scale / advanced relevance |
| **In-memory** | `createMemorySearchAdapter` | Development & tests |

Register one globally with `setGlobalSearch`. The database-backed FTS adapters are the recommended default — search works against your primary database with no extra infrastructure.

```typescript
import { setGlobalSearch } from "covara";
import { createSqliteFtsAdapter, createPostgresFtsAdapter } from "covara/search";

// SQLite (libsql / better-sqlite3 / D1) — FTS5 virtual tables
setGlobalSearch(createSqliteFtsAdapter({
  db,                          // your Drizzle db (a runner with run()/all())
  tablePrefix: "covara_fts_",  // optional
  columns: ["title", "body"],  // optional; defaults to all string fields
}));

// PostgreSQL — tsvector / to_tsquery
setGlobalSearch(createPostgresFtsAdapter({
  db,                  // a runner with execute()
  language: "english", // optional
  tablePrefix: "covara_fts_",
}));
```

Both FTS adapters create and manage their own backing tables lazily on first index, implement the full `SearchAdapter` interface, validate identifiers against injection, and flatten nested object/array values to text.

### OpenSearch

```typescript
import { setGlobalSearch, createOpenSearchAdapter } from "covara";

setGlobalSearch(createOpenSearchAdapter({
  node: "http://localhost:9200",         // or string[]
  auth: { username: "admin", password: "admin" },
  ssl: { rejectUnauthorized: false },
  indexPrefix: "myapp_",                  // default "covara_"
}));
```

Uses `multi_match` (`best_fields`), `AUTO` fuzziness, field boosting, and refreshes after each write.

### In-memory

```typescript
import { setGlobalSearch, createMemorySearchAdapter } from "covara";
setGlobalSearch(createMemorySearchAdapter()); // case-insensitive substring, not persisted
```

## The search endpoint

```bash
GET /api/todos/search?q=important&filter=completed==false&limit=10&offset=0&highlight=true
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `q` | Search query (required) | — |
| `filter` | [RSQL filter](./filtering.md) applied after the query | — |
| `limit` | Max results | 20 |
| `offset` | Results to skip | 0 |
| `highlight` | Include highlighted matches | false |

```json
{
  "items": [{ "id": 1, "title": "Important Task", "status": "active" }],
  "total": 15,
  "highlights": { "1": { "title": ["<em>Important</em> Task"] } }
}
```

Search results are subject to the same [auth scopes](../auth/scopes.md) and [field masking](./fields.md) as regular reads.

## Resource configuration

```typescript
useResource(todos, {
  db,
  id: todos.id,
  search: {
    enabled: true,                 // default true when an adapter is registered
    indexName: "custom_index",     // default: table name
    fields: {
      title: { weight: 2.0 },      // boost
      description: { weight: 1.0 },
      internalNotes: { searchable: false }, // exclude
    },
    autoIndex: true,               // index on create/update/delete (default true)
    outbox: false,                 // durable index queue (see below)
    onIndexError: (info) => { /* observe inline index failures */ },
  },
});
```

`fields` also accepts a plain array — `fields: [posts.title, posts.description]` — to restrict searchable columns without weights. Array entries take the Drizzle column (preferred) or a column-name string (deprecated). The record/weights form is keyed by column name.

## Transactional outbox (at-least-once indexing)

By default, indexing runs inline after a mutation commits with one immediate retry. If the search backend is down, the op is dropped (the DB write still succeeds), leaving the index stale until the row is touched again.

Enable `outbox: true` for at-least-once DB → index convergence. Index/delete ops are written to a durable [KV](../platform/kv.md)-backed queue at mutation time and drained in the background with exponential backoff; exhausted ops are parked in a dead set, not lost.

```typescript
useResource(todos, { db, id: todos.id, search: { outbox: true } });
```

- Requires a global KV (`setGlobalKV(...)`); without one, `outbox` has no effect.
- **On Node**, enabling `outbox` starts a background drainer (a `.unref()`'d `setInterval`, default every 2s, up to 100 ops/tick).
- Retries use exponential backoff `base * 2^attempts` capped at 5 min (default base 1s, 10 attempts), then move to the dead set.
- **On Cloudflare Workers** there is no long-lived process — drain it yourself from a scheduled handler or queue consumer:

```typescript
import { drainSearchOutbox } from "covara";

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainSearchOutbox());
  },
};
```

### Outbox API

```typescript
import {
  enqueueSearchOp, drainSearchOutbox, startSearchOutboxDrainer, getSearchOutboxStats,
} from "covara";

await enqueueSearchOp({ index: "todos", type: "index", docId: "1", document: { id: 1, title: "Hi" } });
const result = await drainSearchOutbox({ maxAttempts: 10, backoffBaseMs: 1000, batchSize: 100 });
const stop = startSearchOutboxDrainer({ intervalMs: 2000 }); // Node
const { pending, dead } = await getSearchOutboxStats();
```

See the [search contract](../contracts/search.md) for the indexing guarantees.

## Manual index management

```typescript
import { getGlobalSearch, hasGlobalSearch } from "covara";

const search = getGlobalSearch();
await search.index("todos", "123", { id: 123, title: "Important Task" });
await search.delete("todos", "123");
const results = await search.search("todos", {
  query: "important", fields: ["title"], fieldWeights: { title: 2 }, from: 0, size: 20, highlight: true,
});
await search.createIndex("todos", { properties: { title: { type: "text" }, status: { type: "keyword" } } });
```

Global helpers: `setGlobalSearch`, `getGlobalSearch`, `hasGlobalSearch`, `clearGlobalSearch`.

## Client

```tsx
import { useSearch } from "covara/client/react";

const { items, isSearching, search, clear } = useSearch(client.resources.todos, { enabled: true });
search("important"); // debounced query
```

See [React hooks](../client/react-hooks.md).

## Related

- [Filtering](./filtering.md) · [KV store](../platform/kv.md) · [Search contract](../contracts/search.md)
- [Workers deployment](../deployment/workers.md) — draining the outbox on the edge
