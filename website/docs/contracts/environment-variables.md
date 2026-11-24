# Environment Variables Contracts

## Guarantees

### Parsing
- **Validation at startup**: All environment variables are validated when `createEnv` is called
- **Fail-fast behavior**: Invalid or missing required variables throw immediately with clear error messages
- **Every problem at once**: `createEnv` validates every variable before throwing, and throws one `EnvValidationError` whose `issues` list each `{ key, message }`
- **Values are never echoed**: error messages name the key and the rule, never the value; a value quoted in a Zod or custom message is replaced by `[redacted]` (values shorter than 4 characters are left as is), and a transform that throws is reported by its error name only
- **Zod integration**: Full Zod schema support including transforms, defaults, enums, and coercion
- **Key path joining**: Nested schema keys are joined with underscores (e.g., `SERVER.PORT` reads `SERVER_PORT`)

### Public/Private Separation
- **Private by default**: Variables without `PUBLIC_` prefix or `{ public: true }` are never exposed
- **PUBLIC_ prefix detection**: Top-level variables starting with `PUBLIC_` are automatically public
- **Explicit override**: `envVariable(val, schema, { public: false })` prevents exposure even with `PUBLIC_` prefix
- **No server secrets in client**: `getPublicEnvironmentVariables()` and HTTP endpoints never return private variables

### HTTP Endpoint
- **Consistent responses**: `GET /` returns the same JSON for a given server deployment
- **ETag support**: Response includes ETag header; `If-None-Match` returns 304 when unchanged
- **Cache-Control header**: Default `public, max-age=3600` (configurable)
- **Schema endpoint**: `GET /schema` returns field paths and inferred types

### ETag Behavior
- **Computed once**: ETag is computed at router creation from hash of public env values
- **304 response**: Matching `If-None-Match` returns 304 Not Modified with empty body
- **Cache invalidation**: ETag changes when server restarts with different values
- **Deterministic**: Same values always produce the same ETag

## Non-Guarantees

### Parsing (What We Don't Promise)
- ❌ **Import-time validation**: Variables are only validated when `createEnv` is called
- ❌ **Partial success**: If any variable fails, the entire `createEnv` call fails
- ❌ **Live reload**: Changes to `process.env` after `createEnv` are not reflected

### Schema Endpoint (What We Don't Promise)
- ❌ **Zod schema introspection**: Types are inferred from runtime values, not Zod schemas
- ❌ **Transform accuracy**: Complex transforms may not reflect the final type accurately
- ❌ **Union types**: Union types are represented as the runtime type

### Client (What We Don't Promise)
- ❌ **Automatic refresh**: Client must explicitly refetch or use polling
- ❌ **Offline support**: Fetching requires network connectivity
- ❌ **Type validation**: Client trusts the JSON matches the expected type

## Failure Modes

### Missing Required Variable
- Application fails to start with error: `Environment variable validation error for KEY: required (not set)`
- Clear error message identifies the missing variable

### Invalid Variable Value
- Application fails to start with an `EnvValidationError`
- Error message indicates the validation failure and expected type, without the value

### Several Bad Variables
- One `EnvValidationError` lists them all: `Environment variable validation error for A, B:` followed by one `KEY: message` line each

### Schema Endpoint Disabled
- `GET /schema` returns 404
- Typegen skips env types (no error, just omitted)

### Client Fetch Error
- Network errors propagate as exceptions
- React hook sets `error` state; `env` remains `null`

## Test Coverage

- `tests/env/env.test.ts` - Server-side parsing, public/private separation, ETag
- `tests/env/env-errors.test.ts` - Collected issues, no values in messages
- `tests/env/client-env.test.ts` - Client fetching, schema endpoint, type generation
