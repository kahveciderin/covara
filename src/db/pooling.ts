export type PoolDriver =
  | "postgres-js"
  | "neon"
  | "pglite"
  | "libsql"
  | "d1"
  | "hyperdrive";

export interface PoolConfig {
  max: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
  notes: string;
}

const CONFIGS: Record<PoolDriver, PoolConfig> = {
  "postgres-js": {
    max: 10,
    idleTimeoutMs: 20_000,
    connectTimeoutMs: 10_000,
    notes:
      "Long-lived Node process: cap `max` below your Postgres connection limit divided by instance count. Use a pgbouncer/pooler URL for serverless.",
  },
  neon: {
    max: 1,
    idleTimeoutMs: 0,
    connectTimeoutMs: 10_000,
    notes:
      "Serverless HTTP driver is connectionless per request; keep `max` at 1 and rely on Neon's pooled endpoint (`-pooler` host).",
  },
  pglite: {
    max: 1,
    idleTimeoutMs: 0,
    connectTimeoutMs: 0,
    notes: "Embedded single-connection engine; pooling does not apply.",
  },
  libsql: {
    max: 1,
    idleTimeoutMs: 0,
    connectTimeoutMs: 10_000,
    notes:
      "HTTP/WebSocket client multiplexes requests over one connection; no client-side pool needed.",
  },
  d1: {
    max: 1,
    idleTimeoutMs: 0,
    connectTimeoutMs: 0,
    notes:
      "Cloudflare D1 is request-scoped via binding; no pool. Avoid long-running transactions.",
  },
  hyperdrive: {
    max: 5,
    idleTimeoutMs: 10_000,
    connectTimeoutMs: 10_000,
    notes:
      "Cloudflare Hyperdrive pools on the edge; keep the Worker-side `max` small and let Hyperdrive manage the origin pool.",
  },
};

export const recommendedPoolConfig = (driver: PoolDriver): PoolConfig => ({
  ...CONFIGS[driver],
});
