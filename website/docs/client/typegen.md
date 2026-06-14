---
id: typegen
title: Type generation
sidebar_label: Type generation
description: Generate TypeScript types from your running API — resource interfaces, input/update types, field-metadata helpers, public env types, and a typed client factory.
---

# Type generation

Covara generates TypeScript types from your running API, giving you end-to-end type safety: resource interfaces, input/update types, field-metadata helpers for the [query builder](./queries.md), [public env](../deployment/environment-variables.md) types, and a typed client factory.

## CLI

```bash
npx covara types --url http://localhost:3000 --out src/generated/api-types.ts
```

Or a script entry point:

```typescript
// scripts/typegen.ts
import { createTypegenCLI } from "covara/client";
await createTypegenCLI(process.argv.slice(2));
```

```bash
tsx scripts/typegen.ts http://localhost:3000 typescript > src/generated/api-types.ts
```

## Programmatic

```typescript
import { generateTypes } from "covara/client";
import { writeFileSync } from "fs";

const result = await generateTypes({
  serverUrl: "http://localhost:3000",
  output: "typescript",
  includeClient: true,
  includeEnv: true,   // default true
  envPath: "/api/env",
});
writeFileSync("./src/generated/api-types.ts", result.code);
```

## What's generated

```typescript
// Resource interfaces
export interface Todo { id: string; title: string; completed: boolean; /* ... */ }

// Input / update types (auto-increment excluded; PKs, nullable, and default fields optional)
export type TodoInput = { title: string; note?: string | null };
export type TodoUpdate = Partial<TodoInput>;

// Field metadata (for type-safe queries)
export type TodoFields = "id" | "title" | "completed";
export type TodoNumericFields = "position";
export type TodoComparableFields = "id" | "title" | "createdAt";

// Path constants
export const ResourcePaths = { todo: "/api/todos", user: "/api/users" } as const;

// Public env type
export type PublicEnv = { PUBLIC_API_URL: string; PUBLIC_VERSION: string };

// Typed client factory
export function createTypedClient(baseClient): TypedCovaraClient;
```

Date columns are emitted as the branded `ISODateString` so the compiler nudges you toward [`toDate(...)`](./overview.md#working-with-dates).

## Typed client factory

```typescript
import { getOrCreateClient } from "covara/client";
import { createTypedClient } from "./generated/api-types";

const client = createTypedClient(getOrCreateClient({ baseUrl: location.origin, credentials: "include" }));

const todos = await client.resources.todos.list();      // Todo[] — no type parameter needed
const result = await client.resources.todos.query().select("id", "title").filter("completed==false").list();
const stats = await client.resources.users.query().groupBy("role").withCount().avg("age").aggregate();
```

With React hooks, types are inferred from the typed resource:

```tsx
import { useLiveList } from "covara/client/react";
const { items, mutate } = useLiveList(client.resources.todos, { orderBy: "position" }); // items: Todo[]
```

## Related

- [Queries & repository](./queries.md) · [Client overview](./overview.md) · [Environment variables](../deployment/environment-variables.md)
- [CLI](../tooling/cli.md) · [OpenAPI](../tooling/openapi.md)
