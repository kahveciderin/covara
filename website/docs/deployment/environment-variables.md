---
id: environment-variables
title: Environment variables
sidebar_label: Environment variables
description: Type-safe env config with Zod validation, automatic public/private separation, an HTTP endpoint to expose public vars with ETag caching, and a client hook plus type generation.
---

# Environment variables

`createEnv` defines a Zod-validated environment schema with automatic public/private separation, an HTTP endpoint to expose public variables (with ETag caching), a React hook, and type generation. Covara itself never reads `process.env` directly — it uses runtime-safe helpers (`readEnv`, `isProduction`, `isDebugEnabled`) so it works on Workers too.

## Define a schema

```typescript
import { createEnv } from "covara";
import { z } from "zod";

export const env = createEnv({
  NODE_ENV: z.enum(["development", "production", "test"]),
  PORT: z.string().transform(Number),
  DATABASE_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url(),
  PUBLIC_VERSION: z.string(),
});

env.PORT;         // number
env.DATABASE_URL; // string
```

Values are read from `process.env` using the key path joined with underscores. Nested schemas map accordingly:

```typescript
const env = createEnv({
  SERVER: { PORT: z.string().transform(Number), HOST: z.string() },
  DB: { URL: z.string(), POOL_SIZE: z.string().transform(Number) },
});
// reads SERVER_PORT, SERVER_HOST, DB_URL, DB_POOL_SIZE
```

Use Zod defaults and transforms for optional/parsed values:

```typescript
createEnv({
  PORT: z.string().default("3000").transform(Number),
  DEBUG: z.string().default("false").transform((v) => v === "true"),
  ALLOWED_ORIGINS: z.string().transform((s) => s.split(",")),
});
```

## Public vs private

A variable is **public** (exposable to the client) in two ways:

```typescript
import { createEnv, envVariable } from "covara";

createEnv({
  PUBLIC_API_URL: z.string(), // PUBLIC_ prefix → automatically public
  SECRET_KEY: z.string(),     // private by default
  API_URL: envVariable(process.env.API_URL, z.string(), { public: true }), // explicit
});
```

Everything else is private. `env.getPublicEnvironmentVariables()` returns only the public set.

## Serving public vars over HTTP

```typescript
import { usePublicEnv } from "covara";

app.route("/api/env", usePublicEnv(env, {
  cacheControl: "public, max-age=3600",
  exposeSchema: true, // also serve /api/env/schema for typegen
}));
```

This mounts `GET /api/env` (public vars as JSON) and `GET /api/env/schema` (schema for [typegen](../client/typegen.md)). The endpoint computes an **ETag** from the public values at startup, so `If-None-Match` returns `304` until the server restarts with new values.

## Client

```typescript
import { fetchPublicEnv, createEnvClient } from "covara/client";

const env = await fetchPublicEnv<{ PUBLIC_API_URL: string }>("http://localhost:3000");

const envClient = createEnvClient<{ PUBLIC_API_URL: string }>({ baseUrl: "http://localhost:3000" });
const unsubscribe = envClient.subscribe((env) => console.log(env), 60000); // poll
```

```tsx
import { usePublicEnv } from "covara/client/react";

function App() {
  const { env, isLoading, error, refetch } = usePublicEnv<{ PUBLIC_API_URL: string; PUBLIC_VERSION: string }>();
  if (isLoading) return <div>Loading…</div>;
  return <p>{env?.PUBLIC_API_URL} v{env?.PUBLIC_VERSION}</p>;
}
```

Hook options: `baseUrl`, `envPath` (default `/api/env`), `refreshInterval`, `enabled`.

## Type generation

The [typegen](../client/typegen.md) tool emits a `PublicEnv` type from the schema endpoint:

```typescript
export type PublicEnv = { PUBLIC_API_URL: string; PUBLIC_VERSION: string };
```

```bash
npx covara generate types --url http://localhost:3000 --out src/generated/api-types.ts
```

## Best practices

- Use the `PUBLIC_` prefix consistently; never expose secrets (only `PUBLIC_`/`{ public: true }` are exposed).
- Validate strictly with Zod (`.url()`, `.min()`, `.pipe()`).
- Cache aggressively on the client with `cacheControl`.

See the [environment-variables contract](../contracts/environment-variables.md) for the public-exposure guarantee.

## Related

- [Type generation](../client/typegen.md) · [Client overview](../client/overview.md) · [Env vars contract](../contracts/environment-variables.md)
