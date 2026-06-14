import type { ScaffoldOptions } from "../options.js";

const DOCS_URL = "https://kahveciderin.github.io/covara/";
const LLMS_TXT_URL = "https://kahveciderin.github.io/covara/llms.txt";
const LLMS_FULL_TXT_URL = "https://kahveciderin.github.io/covara/llms-full.txt";

export const renderAgents = (options: ScaffoldOptions): string => {
  const react = options.frontend === "react";
  const cloudflare = options.template === "cloudflare";

  const entry = cloudflare ? "src/worker.ts" : "src/index.ts";
  const runtime = cloudflare
    ? "Cloudflare Workers (via `wrangler`)"
    : "Node (via `@hono/node-server`)";

  const dbLine =
    options.db === "sqlite"
      ? cloudflare
        ? "SQLite on Cloudflare D1 (Drizzle `drizzle-orm/d1`)."
        : "SQLite via `@libsql/client` — defaults to `./dev.db` (`DB_FILE_NAME`)."
      : "PostgreSQL via `postgres` (`DATABASE_URL`).";

  const structure = [
    `- \`src/schema.ts\` — Drizzle table definitions. **This is the source of truth.** Adding or changing a column here changes the API.`,
    `- \`${entry}\` — app entry. Builds the Covara app with \`createCovara(...)\` and mounts each table with \`.resource(table, { ... })\`.`,
    react
      ? `- \`frontend/\` — the React SPA. \`frontend/src/generated/api-types.ts\` is generated from the running API — do not edit it by hand.`
      : undefined,
    `- \`drizzle.config.ts\` — Drizzle Kit config used by \`db:generate\` / \`db:push\`.`,
    cloudflare
      ? `- \`wrangler.toml\` — Workers bindings (${options.db === "sqlite" ? "the `DB` D1 database, " : ""}the \`COVARA_KV\` Durable Object).`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const commands = renderCommands(options);

  const devNote = cloudflare
    ? `\`npm run dev\` runs \`wrangler dev\`. Apply schema changes with \`npm run db:push\`${options.db === "sqlite" ? " (or generate + apply D1 migrations)" : ""}.`
    : `\`npm run dev\` runs \`covara dev\` — a single dev loop that handles everything: it **live-reloads the server** on code changes${react ? ", **hot-reloads the frontend** (Vite HMR) and regenerates the typed client" : ""}, and watches \`src/schema.ts\` to keep the database in sync. **Additive schema changes are applied automatically** (tables are created on first run). Destructive changes — dropping or narrowing columns, etc. — are detected but *not* applied automatically: the loop prints the SQL it would run and waits for you to apply it deliberately with \`covara push --force\` (or \`npm run db:push\`).`;

  const reactSection = react
    ? `

## Frontend

The React app lives in \`frontend/\`. It talks to the API with the Covara client (\`covara/client\`, hooks in \`covara/client/react\` such as \`useLiveList\`). Types come from \`npm run types\`, which introspects the running API into \`frontend/src/generated/api-types.ts\`. Regenerate them after changing \`src/schema.ts\` or resource config.`
    : "";

  return `# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

\`${options.name}\` is a real-time resource API built with [Covara](https://github.com/kahveciderin/covara) on [Hono](https://hono.dev). Covara auto-generates REST + real-time (SSE) endpoints from [Drizzle ORM](https://orm.drizzle.team) table schemas, so you mostly describe data and access rules rather than write route handlers.

Runtime: ${runtime}.
Database: ${dbLine}

## Project layout

${structure}

## How it works

Every table mounted with \`.resource(table, config)\` automatically exposes (under \`/api/<resource>\`):

- \`GET /\`, \`GET /:id\` — list (filtering, cursor pagination, projections) and read.
- \`POST /\`, \`PATCH /:id\`, \`PUT /:id\`, \`DELETE /:id\` — write.
- \`GET /subscribe\` — real-time SSE subscription to the filtered set.
- \`POST /batch\`, \`GET /count\`, \`GET /aggregate\`, \`POST /rpc/:name\`, and more.

So the workflow for a new feature is usually: edit \`src/schema.ts\`, then add or adjust the \`.resource(...)\` call in \`${entry}\`. Reach for filters, relations, hooks, procedures, and auth scopes via resource config before writing custom routes.

Admin UI is served at \`/__covara/ui\`.

## Auth

The starter mounts the \`todos\` resource with **fully public CRUD** so it works out of the box. This is not safe for production — lock resources down with auth scopes (e.g. \`ownerOnly()\`, RSQL scopes) before deploying. See the auth docs below.

## Commands

\`\`\`bash
${commands}
\`\`\`

${devNote}${reactSection}

## Conventions

- TypeScript, strict. Prefer self-explanatory code over comments.
- The Drizzle schema drives everything — keep \`src/schema.ts\` the single source of truth and let Covara generate the surface area.
- Don't hand-edit generated files${react ? " (e.g. `frontend/src/generated/api-types.ts`)" : ""}.

## Documentation

When you need to know how a Covara feature works, consult the docs rather than guessing:

- Docs site: ${DOCS_URL}
- LLM-readable index (links to every page as Markdown): ${LLMS_TXT_URL}
- LLM-readable full text (all docs concatenated): ${LLMS_FULL_TXT_URL}
- Source & README: https://github.com/kahveciderin/covara

For agents, start from \`llms.txt\` to find the relevant page, then fetch that page's \`.md\`, or pull \`llms-full.txt\` for the complete corpus (around 500KB).
`;
};

const renderCommands = (options: ScaffoldOptions): string => {
  const react = options.frontend === "react";
  const lines: string[] = [];

  if (options.template === "node") {
    lines.push(
      react
        ? "npm run dev          # server + frontend HMR + schema sync (covara dev)"
        : "npm run dev          # server live-reload + schema sync (covara dev)"
    );
    lines.push("npm run build        # build for production");
    lines.push("npm start            # run the production build");
    lines.push("npm test             # run tests (vitest)");
    lines.push("npm run lint         # typecheck");
    if (react) {
      lines.push("npm run types        # regenerate frontend API types");
    }
    lines.push("npm run db:push      # apply schema to the database");
    lines.push("npm run db:generate  # generate SQL migrations");
  } else {
    lines.push("npm run dev          # wrangler dev");
    if (react) {
      lines.push("npm run dev:web      # Vite dev server (HMR) for the frontend");
      lines.push("npm run types        # regenerate frontend API types");
    }
    lines.push("npm run deploy       # deploy to Cloudflare Workers");
    lines.push("npm run typecheck    # typecheck");
    lines.push("npm run cf-typegen   # generate Worker binding types");
    lines.push("npm run db:push      # apply schema to the database");
    lines.push("npm run db:generate  # generate SQL migrations");
  }

  return lines.join("\n");
};
