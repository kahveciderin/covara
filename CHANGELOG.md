# Changelog

Every release of the `covara` package. **Security** marks fixes for vulnerabilities; **Breaking** marks changes that can need action when you upgrade. Versions before 0.17.0 are only in the git history.

## 0.18.2

**Security**
- `createEnv` and `envVariable` errors could contain the variable's value: a Zod 3 enum or literal message, a refinement message that quotes the input, or a transform that throws (e.g. `JSON.parse`). Messages now name the key and the rule only; the value is replaced by `[redacted]`.

**Fixed**
- `createEnv` reported only the first bad variable. It now checks all of them and throws one `EnvValidationError` listing each `KEY: message` (`error.issues`). A missing variable reads `required (not set)`.

## 0.18.1

**Docs**
- The `trustProxy` type and the `createCovara`/`configureClientIp` options now document, in the editor hint, that `"cloudflare"` is safe only when the origin can't be reached except through Cloudflare.

## 0.18.0

**Breaking**
- **The client IP no longer trusts forwarding headers by default.** On Node, `getClientIP` (and so every per-IP limit: rate limits, the login throttle, the abuse budget, admin and OIDC limits, SSE subscription caps) uses the socket address; `X-Forwarded-For`, `X-Real-IP` and `CF-Connecting-IP` are ignored, with one warning. On Cloudflare Workers it uses `CF-Connecting-IP`. **Behind a proxy or load balancer, set `createCovara({ trustProxy })`**, or every client shares the proxy's address: `["loopback"]` for nginx/Caddy on the same host, a list of addresses/CIDR ranges, a hop count, or `"cloudflare"`. See [Behind a proxy](https://kahveciderin.github.io/covara/deployment/node#behind-a-proxy-the-client-ip).

**Security**
- A client could evade every per-IP limit by sending a different `X-Forwarded-For` on each request, since the first entry was trusted. With `trustProxy`, `X-Forwarded-For` is read from the right and only through trusted hops.

**Added**
- `trustProxy` and `clientIp(c)` on `createCovara`; `configureClientIp` for apps that don't use it.
- Login throttle: `perIdentifier` and `perIp` limits (a number, or `false` to drop the key), and a `keys(identifier, ip, c)` hook.
- Abuse budget: `classify` and `keyGenerator` receive `{ operation, resource }`, so one client can have separate buckets per operation.
- Client proof of work: the solve runs in a Web Worker (`crypto.subtle`) when available, otherwise on the main thread in slices that yield; `pow.solver` replaces it, `pow.worker: false` skips the worker.
- This changelog, shipped in the package.

## 0.17.7

**Fixed**
- `autoMigrate` failed at startup when the app already had its own table named like an internal table (e.g. `billing_subscriptions`, added in 0.17.1): `no such column: customerId`. Such a table is now left alone, with a warning and `summary.conflicts`, and the other tables are still created.
- `defineInternalSchema` overrides and `DrizzlePasskeyStore` accept plain Drizzle `sqliteTable`/`pgTable` objects without a cast.

## 0.17.6

**Fixed**
- With Redis down, opening the first live subscription ended the process (unhandled rejection). The fan-out is retried while streams are open, and local subscribers are told to refetch once it is back.
- `onConflictDoNothing()` / `onConflictDoUpdate()` without `.returning()` were recorded as an anonymous `"*"`; they are now recorded per row, upserts as creates or as updates with the previous row.
- With Redis frozen, every command waited its full `commandTimeoutMs`. After a timeout, commands now fail at once for `failFastMs` (default 2000, `0` turns it off) until a probe succeeds.
- A KV outage logged one error per committed write and one stack trace per task worker poll; both now log once per outage, and the worker backs off.

## 0.17.5

**Fixed**
- A committed write no longer rejects when the changelog, subscription push or cache invalidation fails afterwards (e.g. Redis down); the failure is logged. The REST routes answer with the committed result.
- An insert without `.returning()` whose key comes from `$defaultFn` records the stored row.
- `startRecurringScheduler` logs failed ticks instead of an unhandled rejection, and never overlaps them.
- Completed and failed task records expire (`resultTtlMs`, default 24 h).
- Subscription records of a process that died are leased and removed about two minutes later.

**Behavior changes**
- Redis: commands time out after `commandTimeoutMs` (default 5000), and the client reconnects for as long as the process runs (`maxRetries` now bounds each command, not the connection). `offlineQueue` option added.

## 0.17.4

**Fixed**
- The process can exit after `worker.stop()`: task timeout and heartbeat timers are cleared.

## 0.17.3

**Fixed**
- Redis KV: no "already connecting" errors at boot; `maxRetries`/`retryDelay`/`tls` apply to URLs.
- `trackMutations` on postgres-js recorded nothing; entries are keyed by the real primary key, rows that can't be identified invalidate subscribers, and raw SQL invalidates them too.
- Task queue: concurrency slots and locks expire with a dead worker, lost tasks are reclaimed (spending an attempt), a poll error no longer ends the worker.

## 0.17.2

**Security**
- `capabilities` are enforced on every route (405), including file routes and multiplexed subscriptions.
- `fields.writable` applies to `PATCH /batch`; the primary key is stripped from updates unless it is writable.
- The `/:id` segment is bound as a value, not parsed as filter syntax.
- Includes never reach unregistered tables through `autoRelations`, honor the target's `defaultSelect`, `fields.readable` and scope, and reject relation paths in include filters.
- Batch upsert stays inside the caller's update scope.

**Fixed**
- ISO strings are accepted for date columns; live events are delivered under relation-path scopes; session activity writes settle on shutdown and logout.

**Breaking**
- Requests that relied on the holes above (an operation outside `capabilities`, writing the primary key, filter syntax in `/:id`) are now rejected.

## 0.17.1

**Security**
- Hidden columns (outside `fields.readable`) can no longer be filtered, sorted, aggregated or searched by clients, which let them be probed as an oracle (e.g. whether an email exists). `filterable`/`sortable`/`aggregatable` now default to the readable columns.

**Added**
- Passkeys (WebAuthn), resumable uploads, durable email delivery, a credits ledger, billing reconciliation.

**Breaking**
- Clients that filtered or sorted on a column that isn't readable get an error; list it in `fields.filterable` / `sortable` to allow it again.
- `autoMigrate` creates new internal tables: `auth_passkeys`, `billing_credit_entries`, `billing_credit_balances`, `billing_subscriptions`. Until 0.17.7, an app table with one of these names made startup fail.

## 0.17.0

**Added**
- The client sends the CSRF header automatically, and errors carry the server's problem details.

**Fixed**
- Multiplexed subscription streams on Cloudflare Workers.
