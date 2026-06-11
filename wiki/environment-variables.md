# Environment Variables

Covara provides a type-safe environment variable system with Zod validation, automatic separation of public/private variables, and client-side support for accessing public environment variables.

## Server-Side Usage

### Basic Setup

Use `createEnv` to define your environment schema with Zod validation:

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

// Access values with full type safety
console.log(env.PORT); // number
console.log(env.DATABASE_URL); // string
```

Environment variables are read from `process.env` using the schema key path joined with underscores. For example, a nested schema:

```typescript
const env = createEnv({
  SERVER: {
    PORT: z.string().transform(Number),
    HOST: z.string(),
  },
  DB: {
    URL: z.string(),
    POOL_SIZE: z.string().transform(Number),
  },
});

// Reads from:
// - SERVER_PORT
// - SERVER_HOST
// - DB_URL
// - DB_POOL_SIZE
```

### Public vs Private Variables

Variables can be marked as public in two ways:

1. **PUBLIC_ prefix**: Any variable with a key path starting with `PUBLIC_` is automatically public:

```typescript
const env = createEnv({
  PUBLIC_API_URL: z.string(), // Automatically public
  SECRET_KEY: z.string(),     // Private
});
```

2. **Explicit config**: Use `envVariable` for explicit control:

```typescript
import { createEnv, envVariable } from "covara";

const env = createEnv({
  API_URL: envVariable(process.env.API_URL, z.string(), { public: true }),
  SECRET: envVariable(process.env.SECRET, z.string()), // Private by default
});
```

### Accessing Public Variables

Use `getPublicEnvironmentVariables()` to get only the public variables:

```typescript
const publicEnv = env.getPublicEnvironmentVariables();
// Returns only PUBLIC_* prefixed or explicitly marked public variables
```

### Serving Public Variables via HTTP

Use `usePublicEnv` to expose public environment variables through an HTTP endpoint:

```typescript
import { Hono } from "hono";
import { createEnv, usePublicEnv } from "covara";

const app = new Hono();

const env = createEnv({
  PUBLIC_API_URL: z.string(),
  PUBLIC_VERSION: z.string(),
  SECRET_KEY: z.string(),
});

// Serves public env vars at /api/env
app.route("/api/env", usePublicEnv(env));
```

This creates two endpoints:
- `GET /api/env` - Returns public environment variables as JSON
- `GET /api/env/schema` - Returns the schema for typegen

#### Configuration Options

```typescript
app.route("/api/env", usePublicEnv(env, {
  cacheControl: "public, max-age=3600", // Default cache header
  headers: {
    "X-Custom-Header": "value",
  },
  exposeSchema: true, // Default: true, set false to hide /schema endpoint
}));
```

#### ETag Support

The endpoint automatically includes ETag support for cache validation:

- An ETag is computed from the hash of the public env values at server startup
- Clients can send `If-None-Match` header with the ETag
- Server returns `304 Not Modified` if the values haven't changed
- When the server restarts with new values, the ETag changes, invalidating client caches

```
# First request
GET /api/env
→ 200 OK
→ ETag: "a1b2c3d4e5f6g7h8"
→ Cache-Control: public, max-age=3600

# Subsequent request with cache validation
GET /api/env
If-None-Match: "a1b2c3d4e5f6g7h8"
→ 304 Not Modified (if unchanged)
→ 200 OK with new ETag (if server restarted with new values)
```

## Client-Side Usage

### Fetching Public Environment Variables

Use the client library to fetch public environment variables:

```typescript
import { fetchPublicEnv, createEnvClient } from "covara/client";

// Simple one-time fetch
const env = await fetchPublicEnv<{ PUBLIC_API_URL: string }>("http://localhost:3000");

// Or create a client for more control
const envClient = createEnvClient<{ PUBLIC_API_URL: string }>({
  baseUrl: "http://localhost:3000",
  envPath: "/api/env", // Optional, default: /api/env
});

const env = await envClient.get();
const schema = await envClient.getSchema();

// Subscribe to changes (polling)
const unsubscribe = envClient.subscribe((env) => {
  console.log("Env updated:", env);
}, 60000); // Poll every 60 seconds
```

### React Hook

Use the `usePublicEnv` hook in React components:

```typescript
import { usePublicEnv } from "covara/client/react";

interface MyPublicEnv {
  PUBLIC_API_URL: string;
  PUBLIC_VERSION: string;
}

function App() {
  const { env, isLoading, error, refetch } = usePublicEnv<MyPublicEnv>();

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>API URL: {env?.PUBLIC_API_URL}</p>
      <p>Version: {env?.PUBLIC_VERSION}</p>
      <button onClick={refetch}>Refresh</button>
    </div>
  );
}
```

#### Hook Options

```typescript
const { env, isLoading, error, refetch } = usePublicEnv<MyPublicEnv>({
  baseUrl: "http://localhost:3000", // Default: window.location.origin
  envPath: "/api/env",              // Default: /api/env
  refreshInterval: 60000,           // Optional: auto-refresh interval in ms
  enabled: true,                    // Default: true, set false to disable fetching
});
```

## Type Generation

The typegen tool automatically generates TypeScript types for your public environment variables:

```typescript
// scripts/typegen.ts
import { createTypegenCLI } from "covara/client";

await createTypegenCLI(process.argv.slice(2));
```

```bash
tsx scripts/typegen.ts http://localhost:3000
```

This generates types including:

```typescript
// Public Environment Variables
export type PublicEnv = {
  PUBLIC_API_URL: string;
  PUBLIC_VERSION: string;
};
```

### Typegen Options

```typescript
import { generateTypes } from "covara/client";

const result = await generateTypes({
  serverUrl: "http://localhost:3000",
  output: "typescript",
  includeEnv: true,           // Default: true
  envPath: "/api/env",        // Default: /api/env
});

console.log(result.code);
console.log(result.envSchema); // Raw schema from server
```

## Best Practices

1. **Use `PUBLIC_` prefix consistently** for variables intended to be exposed to the client.

2. **Never expose secrets**: The `PUBLIC_` prefix and `{ public: true }` flag are the only ways to expose variables. All others are private by default.

3. **Validate strictly**: Use Zod's full validation capabilities:

```typescript
const env = createEnv({
  PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)),
  NODE_ENV: z.enum(["development", "production", "test"]),
  API_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().transform((s) => s.split(",")),
});
```

4. **Use defaults for optional values**:

```typescript
const env = createEnv({
  PORT: z.string().default("3000").transform(Number),
  DEBUG: z.string().default("false").transform((v) => v === "true"),
});
```

5. **Cache on the client**: Use the `cacheControl` option to enable browser caching of public env vars:

```typescript
app.route("/api/env", usePublicEnv(env, {
  cacheControl: "public, max-age=86400", // Cache for 24 hours
}));
```

## API Reference

### Server-Side

#### `createEnv(schema)`

Creates a typed environment object from a schema.

```typescript
const env = createEnv({
  VAR_NAME: z.string(), // Reads from process.env.VAR_NAME
});
```

#### `envVariable(source, zodType, config?)`

Creates an environment variable with explicit configuration.

```typescript
envVariable(process.env.MY_VAR, z.string(), { public: true })
```

#### `usePublicEnv(env, config?)`

Creates a Hono router that serves public environment variables.

### Client-Side

#### `createEnvClient(config)`

Creates a client for fetching environment variables.

#### `fetchPublicEnv(serverUrl, envPath?)`

One-time fetch of public environment variables.

#### `fetchEnvSchema(serverUrl, envPath?)`

Fetches the schema for public environment variables.

#### `usePublicEnv(options?)` (React hook)

React hook for fetching and subscribing to public environment variables.
