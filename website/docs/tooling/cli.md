---
id: cli
title: CLI
sidebar_label: CLI
description: The covara CLI — scaffold deploy-ready Node or Cloudflare Workers projects with create, and add resources, migrations, and types with generate.
---

# CLI

The `covara` CLI scaffolds new projects and generates code in existing ones.

## `covara create`

```bash
npx covara create my-app                          # Node + SQLite (default)
npx covara create my-app --template cloudflare    # Cloudflare Workers + D1
npx covara create my-app --db postgres            # PostgreSQL
```

| Flag | Values | Default |
|------|--------|---------|
| `--template` | `node`, `cloudflare` | `node` |
| `--db` | `sqlite`, `postgres` | `sqlite` |
| `--no-install` | skip dependency install | — |

Generated projects are deploy-ready. Alongside your source and schema, the scaffolder writes:

- **Node:** a `Dockerfile` and `docker-compose.yml` (app + Redis, plus a Postgres service when `--db postgres`) and a `.dockerignore`.
- **Cloudflare:** a complete `wrangler.toml` — `nodejs_compat`, a `[[d1_databases]]` binding, a commented `[[kv_namespaces]]` block, and the `CovaraKVDurableObject` [Durable Object KV](../deployment/durable-object-kv.md) binding + migration.
- A GitHub Actions CI workflow (`.github/workflows/ci.yml`) that installs, lints, tests, and builds.
- `.env.example` documenting the expected [environment variables](../deployment/environment-variables.md).

```bash
cd my-app
npm run db:push   # create tables
npm run dev       # start the server
```

## `covara generate`

Scaffold incrementally inside an existing project.

```bash
npx covara generate resource invoices   # writes a Drizzle table + a registration snippet
npx covara generate migration           # runs drizzle-kit generate (pass -- to forward args)
npx covara generate types --url http://localhost:3000 --out src/generated/api-types.ts
```

| Command | What it does |
|---------|--------------|
| `generate resource <name>` | Adds a Drizzle table and a `.resource(...)` registration snippet. |
| `generate migration` | Runs [`drizzle-kit generate`](https://orm.drizzle.team/kit-docs/overview) (forward args after `--`). |
| `generate types` | Generates the [TypeScript client types](../client/typegen.md) from a running API. |

## Related

- [Quick Start](../quick-start.md) · [Type generation](../client/typegen.md)
- [Node deployment](../deployment/node.md) · [Cloudflare Workers](../deployment/workers.md) · [Databases](../deployment/databases.md)
