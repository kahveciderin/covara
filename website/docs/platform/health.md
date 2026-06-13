---
id: health
title: Health checks
sidebar_label: Health checks
description: Liveness and readiness endpoints (/healthz, /readyz) with dependency checks and runtime thresholds, wired into graceful shutdown for zero-downtime deploys.
---

# Health checks

`createCovara` mounts two endpoints by default:

| Endpoint | Probe | Meaning |
|----------|-------|---------|
| `GET /healthz` | Liveness | The process is up. Stays `200` even during graceful shutdown. |
| `GET /readyz` | Readiness | The instance is ready to serve traffic. Flips to `503` during shutdown so load balancers drain it. |

Both support `HEAD` for cheap probes. Wire them into your orchestrator (Kubernetes `livenessProbe`/`readinessProbe`, load-balancer health checks).

## Configuration

```typescript
const app = createCovara({
  health: {
    version: "1.0.0",
    checks: {
      kv: getGlobalKV(),         // dependency checks — included in the readiness result
    },
    thresholds: {
      eventLoopLagMs: 100,        // mark unhealthy above this lag
      memoryPercent: 90,          // mark unhealthy above this memory usage
    },
  },
});
```

Pass `health: false` to disable the endpoints, or `health: true` for defaults.

`checks` accepts dependency objects (e.g. the [KV store](./kv.md), a database) that the readiness endpoint probes; a failing dependency makes `/readyz` report unhealthy. `thresholds` add runtime guards (event-loop lag, memory) on Node.

## Response shape

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "checks": { "kv": { "status": "ok" } }
}
```

## Graceful shutdown

On Node, [`startServer`](../deployment/node.md) installs `SIGTERM`/`SIGINT` handlers that, on shutdown:

1. flip readiness so `/readyz` returns `503` (new traffic stops routing here),
2. close long-lived [SSE subscriptions](../realtime/subscriptions.md) cleanly so clients reconnect elsewhere,
3. wait a bounded drain window (`drainTimeoutMs`, default 10s) before closing the listener.

`/healthz` stays `200` throughout — only `/readyz` flips — so the orchestrator distinguishes "draining" from "dead". See [Node deployment](../deployment/node.md#graceful-shutdown).

## Related

- [Node deployment](../deployment/node.md) · [KV store](./kv.md) · [Admin UI](../tooling/admin-ui.md)
