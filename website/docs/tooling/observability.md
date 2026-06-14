---
id: observability
title: Observability storage
sidebar_label: Observability storage
description: Pluggable persistence for the admin audit log, request/error logs, and metrics — in-memory by default, KV-backed automatically, or bring your own durable adapter.
---

# Observability storage

The admin dashboard's **audit log**, **request/error logs**, and **metrics** are append-only logs. By default they live in a per-process ring buffer (exactly as before), but they're now backed by a pluggable `ObservabilityLogAdapter` so you can make them durable and shared across instances.

## Three layers

1. **Zero-config (default).** Each log uses a self-falling-back hybrid adapter. With no [KV store](../platform/kv.md) configured it behaves identically to the old in-memory ring buffer. If you `setGlobalKV(...)` before `createCovara`, audit/request/error logs are persisted to KV automatically (shared across instances) — no extra wiring.
2. **Per-store injection.** Pass your own adapters (e.g. one backed by your database) via `AdminUIConfig.observability`:

   ```typescript
   createCovara({
     adminUI: {
       observability: {
         auditAdapter: myDbAuditAdapter,   // implements ObservabilityLogAdapter
         requestAdapter,
         errorAdapter,
       },
     },
   });
   ```
   Metrics storage is selected with `createMetricsCollector({ storage: "kv" })` (default `"memory"`, to keep the hot request path cheap).
3. **Write-only tap.** `setAdminAuditSink(fn)` still works for fire-and-forget forwarding (e.g. ship every admin action to your SIEM). It runs *alongside* the adapter; it is write-only — for read/query/export persistence, implement `ObservabilityLogAdapter`.

## The adapter interface

```typescript
interface ObservabilityLogAdapter<TEntry> {
  append(entry: TEntry): void | Promise<void>;   // never throws into the audited action
  querySync(query?: LogQuery): TEntry[];          // sync local-mirror read
  query(query?: LogQuery): Promise<TEntry[]>;     // authoritative (consults KV)
  export(opts?: { limit?: number }): Promise<TEntry[]>;
  count(): Promise<number>;
  countSync(): number;
  clear(): void | Promise<void>;
}
```

Built-ins: `createInMemoryLogAdapter({ maxEntries, order })` and `createKVLogAdapter({ keyPrefix, maxEntries, order })` (modeled on the [changelog](../realtime/changelog.md): a monotonic-seq sorted set, capped via `zrem`, wrapping an in-memory mirror).

## Cross-process behavior

In KV mode the adapter keeps a local mirror so the synchronous reads the dashboard uses on render (`querySync`, counters, metric aggregates) always work — but that mirror only reflects entries written by **this** process. Authoritative cross-instance reads go through the async `query()`/`export()` path; the audit export endpoints use it. This is the same tradeoff the changelog makes.

## What is and isn't covered

These previously memory-only stores are now KV-pluggable: the **admin audit log**, **request/error logs**, **metrics**, the **admin auth rate-limit** counter, and the **API-key** and **verification-token** stores (`createKVApiKeyStore` / `createKVVerificationTokenStore`).

Intentionally left per-process: the **SSE subscription counters** (they account for *this* instance's live connections — KV would leak counts on a crash) and the **OIDC discovery/JWKS caches** (self-healing performance caches; a lost entry just triggers a re-fetch). The in-memory KV and storage backends are, of course, the intended in-memory implementations.

## Related

- [Admin UI](./admin-ui.md) · [KV store](../platform/kv.md) · [Changelog](../realtime/changelog.md)
