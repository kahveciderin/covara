---
id: cli
title: CLI
sidebar_label: CLI
description: The covara CLI — scaffold projects, run a watch-and-auto-push dev loop, manage database profiles, push schema, browse/import/export data, and generate types.
---

# CLI

The `covara` CLI scaffolds projects, runs a dev loop that streams schema changes to your database, manages database connection profiles, and browses/imports/exports data.

## `covara create`

```bash
npx covara create my-app                          # Node + SQLite (default), backend only
npx covara create my-app --frontend react         # + a live React SPA, served by the backend
npx covara create my-app --template cloudflare    # Cloudflare Workers + D1
npx covara create my-app --db postgres            # PostgreSQL
```

| Flag | Values | Default |
|------|--------|---------|
| `--template` | `node`, `cloudflare` | `node` |
| `--db` | `sqlite`, `postgres` | `sqlite` |
| `--frontend` | `react`, `none` | `none` |
| `--no-install` | skip dependency install | — |

Generated projects are deploy-ready. Alongside your source and schema, the scaffolder writes:

- **Node:** a `Dockerfile` and `docker-compose.yml` (app + Redis, plus a Postgres service when `--db postgres`) and a `.dockerignore`.
- **Cloudflare:** a complete `wrangler.toml` — `nodejs_compat`, a `[[d1_databases]]` binding, a commented `[[kv_namespaces]]` block, and the `CovaraKVDurableObject` [Durable Object KV](../deployment/durable-object-kv.md) binding + migration.
- A GitHub Actions CI workflow (`.github/workflows/ci.yml`) that installs, lints, tests, and builds.
- **Node:** a typed [`createEnv`](../deployment/environment-variables.md) schema in `src/env.ts` — the generated server reads config via `env.X`, never `process.env`.
- `.env.example` documenting the expected [environment variables](../deployment/environment-variables.md).
- An `AGENTS.md` orienting AI coding agents — project layout, how resources map to endpoints, the commands, and links to these docs plus the machine-readable [`llms.txt`](https://kahveciderin.github.io/covara/llms.txt) / [`llms-full.txt`](https://kahveciderin.github.io/covara/llms-full.txt).

```bash
cd my-app
npm run dev       # start the server — covara dev creates/updates tables automatically
```

`npm run dev` (which runs [`covara dev`](#covara-dev)) auto-applies additive schema changes on start, so it creates your tables on first run — there's no separate `npm run db:push`. Run `db:push` yourself only for destructive changes or in CI.

### `--frontend react`

Scaffolds a [live React SPA](../client/react-hooks.md) (under `frontend/`) wired to the generated `todos` resource with `useLiveList`, served by the backend itself — **one process, one port, no separate build step**:

- **`npm run dev`** runs a single process that serves the SPA with **Vite HMR** *and* the API (`/api`) and admin UI (`/__covara`) on the same origin (no proxy), while [`covara dev`](#covara-dev) live-applies schema changes and regenerates the typed client into `frontend/src/generated/api-types.ts`.
- **`npm run build`** builds the SPA into `dist/public/` and compiles the backend into `dist/`, so `dist/` is a self-contained deployable; **`npm start`** serves the built SPA with an SPA fallback that excludes `/api` and `/__covara`.
- On **Cloudflare**, the SPA is served via Wrangler [`[assets]`](https://developers.cloudflare.com/workers/static-assets/) with `run_worker_first` for `/api` + `/__covara`; run `npm run dev:web` for Vite HMR alongside `wrangler dev`.

The starter uses the generic typed hook with a hand-written `Todo` interface so it compiles before any codegen; run `npm run types` (or just `npm run dev`) to generate the full typed client and switch to `createTypedClient`.

## `covara generate`

Scaffold incrementally inside an existing project.

```bash
npx covara generate resource invoices   # writes a Drizzle table + a registration snippet
npx covara generate migration           # runs drizzle-kit generate (pass -- to forward args)
```

| Command | What it does |
|---------|--------------|
| `generate resource <name>` | Adds a Drizzle table and a `.resource(...)` registration snippet. |
| `generate migration` | Runs [`drizzle-kit generate`](https://orm.drizzle.team/kit-docs/overview) (forward args after `--`). |

## `covara dev`

The continuous development loop. It runs your server under `tsx watch`, watches your Drizzle schema, and on every save **auto-applies additive changes** to the database (new tables, columns, indexes) so you never push by hand. Destructive changes (dropping/renaming a column, narrowing a type) are **not** auto-applied — they're printed with a hint to run `covara push --force`. With `--types-out`, it also regenerates the [typed client](../client/typegen.md) after each successful change.

```bash
npx covara dev                                   # auto-detects the server entry
npx covara dev src/main.ts --types-out frontend/src/api-types.ts
npx covara dev --no-server                       # only watch + push schema
```

| Flag | Default |
|------|---------|
| `[entry]` / `--entry` | auto-detected (`src/main.ts`, `src/index.ts`, …) |
| `--types-out <path>` | off (skip type regen) |
| `--server-url <url>` | `http://localhost:$PORT` |
| `--profile <name>` | active profile |
| `--no-server` | run only the schema watcher |

> Loading TypeScript: schema-aware commands (`dev`, `push`, `studio`, `data`, `import`/`export`) run a worker via your project's `tsx`, so the framework stays dependency-light and your `.ts` schema/config load natively. `tsx` ships in scaffolded projects.

## Schema & database

```bash
npx covara push                 # apply schema (additive auto; prompts on destructive)
npx covara push --force         # apply even destructive changes (non-interactive)
npx covara migrate              # apply migration files (drizzle-kit migrate)
npx covara studio               # open Drizzle Studio for the active profile
```

`push` computes the diff with [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview) and classifies it: additive diffs apply immediately; destructive diffs (with possible data loss) require confirmation or `--force`.

### Connection profiles — `covara db`

Named profiles let you switch between local, staging, and remote databases (libsql/Turso URL + token, or a Postgres URL). Profiles live in `.covara/config.json`; the active one (or `DATABASE_URL`/`DB_FILE_NAME`) is used by every schema/data command, and an explicit `--profile <name>` or `--url <url>` overrides it.

:::note The CLI resolves the database connection itself
Schema and data commands (`push`, `data`, `export`, `import`, …) need a database connection resolved from a profile, `DATABASE_URL`/`DB_FILE_NAME` (read from your `.env`), or `--url`. This resolution is the CLI's own — it does **not** run your app's `createEnv`, so a default you set there (e.g. `DB_FILE_NAME` defaulting to `dev.db`) does not help the CLI. If none is set the command errors instead of guessing; set a profile with `covara db use <name>` or export `DATABASE_URL`/`DB_FILE_NAME`.
:::

```bash
npx covara db add local --url 'file:./dev.db'
npx covara db add prod  --url 'libsql://app.turso.io' --token "$TURSO_TOKEN"
npx covara db use prod
npx covara db list        # * marks the active profile
npx covara db current
npx covara push --profile local
```

## Data

```bash
npx covara data todos --limit 20                 # browse rows (JSON)
npx covara export todos --out todos.csv --format csv
npx covara import todos --file todos.jsonl       # json | jsonl | csv
npx covara seed                                  # run src/db/seed.ts via tsx
```

## Other

```bash
npx covara run todos.markDone '{"id":"abc"}'     # invoke an RPC on a running server
npx covara types --out src/generated/api-types.ts --server-url http://localhost:3000
npx covara env set DB_FILE_NAME dev.db           # manage the project .env
npx covara env list
```

| Command | What it does |
|---------|--------------|
| `run <resource>.<rpc> [json]` | POSTs to a running server's RPC route (`--base`/`--server-url` to override). |
| `types [--out <path>]` | Generates the [TypeScript client types](../client/typegen.md) from a running API. |
| `env <list\|get\|set\|remove>` | Reads/writes the project `.env`. |

## Related

- [Quick Start](../quick-start.md) · [Type generation](../client/typegen.md)
- [Node deployment](../deployment/node.md) · [Cloudflare Workers](../deployment/workers.md) · [Databases](../deployment/databases.md)
