---
id: admin-ui
title: Admin UI
sidebar_label: Admin UI
description: A built-in dashboard at /__covara/ui — resource introspection, a data explorer, live requests/subscriptions/changelog, task and session management, a KV inspector, and a filter tester.
---

# Admin UI

Covara ships a built-in admin dashboard served at `/__covara/ui`. It's **disabled by default** — enable it by passing `adminUI` to [`createCovara`](../core/resources-and-app.md).

```typescript
const app = createCovara({
  adminUI: {
    title: "My App Admin",
    metricsCollector,
    security: {
      mode: process.env.NODE_ENV ?? "development",
      auth: { disabled: process.env.NODE_ENV !== "production" },
    },
    dataExplorer: { enabled: true, readOnly: false, maxLimit: 100, excludeFields: { users: ["passwordHash"] } },
    kvInspector: { enabled: true, kv: getGlobalKV(), readOnly: false },
    userManager: { /* listUsers, getUser, createUser, updateUser, deleteUser */ },
    sessionManager: { /* listSessions, revokeSession, ... */ },
  },
});
```

`adminUI: true` enables it with defaults; an object configures the panels below.

## Panels

| Panel | What it shows |
|-------|---------------|
| **Dashboard** | Overview: request/error stats, subscription counts, health. |
| **Resources** | Every registered resource, its columns, config, and generated endpoints. |
| **Data explorer** | Browse/filter/edit rows per resource (read-only or read-write), with excluded fields. Bypasses resource auth scopes. |
| **API explorer** | Try endpoints interactively. Runs as the verified admin and bypasses resource auth scopes. |
| **Filter tester** | Build and validate [RSQL filters](../core/filtering.md) against a resource. |
| **Requests** | Live request [metrics](./middleware.md) (recent, slow, by path). |
| **Subscriptions** | Active SSE [subscriptions](../realtime/subscriptions.md). |
| **Changelog** | Recent [changelog](../realtime/changelog.md) entries. |
| **Tasks** | [Background task](../platform/tasks.md) queue, status, DLQ. |
| **Users** | Manage users (via `userManager` callbacks). |
| **Sessions** | List and revoke [sessions](../auth/sessions.md) (via `sessionManager`). |
| **KV inspector** | Inspect the [KV store](../platform/kv.md). |
| **Errors / audit** | Error log and admin audit entries. |

## Security

```typescript
security: {
  mode: "development" | "staging" | "production",
  auth: { disabled: process.env.NODE_ENV !== "production" },
}
```

In development you can leave auth disabled for convenience; in **production, protect it** (the UI gates on the configured auth and serves its own self-only CSP regardless of your global [security headers](../auth/security-headers.md)). `dataExplorer.readOnly` and `kvInspector.readOnly` let you expose a safe read-only view in staging/production.

### Scope bypass

Both the Data explorer and the API explorer **bypass the per-resource [auth scopes](../auth/scopes.md)** so an admin sees and edits every row, not just their own. The Data explorer queries the database directly. The API explorer forwards the request to the real resource endpoints with a non-secret marker header (`x-covara-admin-bypass`); the resource layer then **re-verifies that the forwarded request's authenticated user is an admin** before honoring it. "Admin" is decided by the same `security` config that gates the UI (`requireRole` / `authorization` / `authorize`, or the admin `apiKey`) — no separate credential.

Because the marker carries no secret, a leaked or guessed marker is useless to a non-admin: the request still runs under normal scope enforcement. Bypass also requires that an admin predicate is registered (it is, whenever you mount the admin UI via `createCovara`); standalone `useResource` mounts never bypass. Every bypassed API-explorer request is recorded in the admin **audit** log (`api_explorer_execute`). Locking down the UI's auth in production therefore also locks down scope bypass.

> An admin can also opt into the bypass on a direct API call by sending the `x-covara-admin-bypass: 1` header — it only takes effect for users the admin predicate accepts, and is audited. With `apiKey` admin auth the marker is honored when the request carries that key; with role/`authorize`-based auth it is honored when the authenticated user passes the same check.

## Wiring live data

The UI reads from the same [metrics collector](./middleware.md) and [KV](../platform/kv.md) your app uses. Pass a `metricsCollector` (from `createMetricsCollector`) so the Requests/Dashboard panels show real traffic, and `getGlobalKV()` to the KV inspector. The `userManager`/`sessionManager` callbacks bridge the Users/Sessions panels to your tables and auth adapter — see the [example app](https://github.com/kahveciderin/covara/tree/master/example) for a complete wiring.

## Health endpoints

`createCovara` also mounts `/healthz` and `/readyz` (configurable via the `health` option). See [Health checks](../platform/health.md).

## Related

- [Middleware](./middleware.md) · [OpenAPI](./openapi.md) · [Health checks](../platform/health.md) · [KV store](../platform/kv.md)
