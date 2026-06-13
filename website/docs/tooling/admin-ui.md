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
| **Data explorer** | Browse/filter/edit rows per resource (read-only or read-write), with excluded fields. |
| **API explorer** | Try endpoints interactively. |
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

## Wiring live data

The UI reads from the same [metrics collector](./middleware.md) and [KV](../platform/kv.md) your app uses. Pass a `metricsCollector` (from `createMetricsCollector`) so the Requests/Dashboard panels show real traffic, and `getGlobalKV()` to the KV inspector. The `userManager`/`sessionManager` callbacks bridge the Users/Sessions panels to your tables and auth adapter — see the [example app](https://github.com/kahveciderin/covara/tree/master/example) for a complete wiring.

## Health endpoints

`createCovara` also mounts `/healthz` and `/readyz` (configurable via the `health` option). See [Health checks](../platform/health.md).

## Related

- [Middleware](./middleware.md) · [OpenAPI](./openapi.md) · [Health checks](../platform/health.md) · [KV store](../platform/kv.md)
