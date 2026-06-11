import type { ScaffoldOptions } from "../options.js";

export const renderReadme = (options: ScaffoldOptions): string =>
  options.template === "node" ? renderNodeReadme(options) : renderCloudflareReadme(options);

const renderNodeReadme = (options: ScaffoldOptions): string => {
  const dbSetup =
    options.db === "sqlite"
      ? `The app uses SQLite via \`@libsql/client\`. The database file defaults to \`./dev.db\` (override with \`DB_FILE_NAME\`).`
      : `The app uses PostgreSQL via \`postgres\`. Set \`DATABASE_URL\` in \`.env\` before running.`;

  return `# ${options.name}

A real-time resource API built with [Covara](https://github.com/covara/covara) on Hono.

## Setup

\`\`\`bash
cp .env.example .env
npm install
npm run db:push
\`\`\`

${dbSetup}

## Development

\`\`\`bash
npm run dev
\`\`\`

The API is served at \`http://localhost:3000\`:

- \`GET /api/todos\` — list todos (filtering, pagination, projections)
- \`POST /api/todos\` — create a todo
- \`GET /api/todos/subscribe\` — real-time SSE subscription
- \`GET /__covara/ui\` — admin UI

## Production

\`\`\`bash
npm run build
npm start
\`\`\`
`;
};

const renderCloudflareReadme = (options: ScaffoldOptions): string => {
  const dbSetup =
    options.db === "sqlite"
      ? `## Database (D1)

\`\`\`bash
wrangler d1 create ${options.name}-db
\`\`\`

Copy the generated \`database_id\` into \`wrangler.toml\`, then generate and apply migrations:

\`\`\`bash
npm run db:generate
wrangler d1 migrations apply ${options.name}-db --local
wrangler d1 migrations apply ${options.name}-db --remote
\`\`\`

\`npm run db:push\` uses the drizzle-kit D1 HTTP driver and needs \`CLOUDFLARE_ACCOUNT_ID\`, \`CLOUDFLARE_DATABASE_ID\` and \`CLOUDFLARE_D1_TOKEN\` set in your environment.`
      : `## Database (PostgreSQL)

Set the connection string as a Worker secret (and in \`.dev.vars\` for local development):

\`\`\`bash
wrangler secret put DATABASE_URL
echo 'DATABASE_URL=postgres://user:password@host:5432/db' > .dev.vars
npm run db:push
\`\`\`

For production, consider [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/) for connection pooling.`;

  return `# ${options.name}

A real-time resource API built with [Covara](https://github.com/covara/covara) on Hono, deployed to Cloudflare Workers.

## Setup

\`\`\`bash
npm install
\`\`\`

${dbSetup}

## Development

\`\`\`bash
npm run dev
\`\`\`

The API is served by \`wrangler dev\`:

- \`GET /api/todos\` — list todos (filtering, pagination, projections)
- \`POST /api/todos\` — create a todo
- \`GET /api/todos/subscribe\` — real-time SSE subscription
- \`GET /__covara/ui\` — admin UI

## Deploy

\`\`\`bash
npm run deploy
\`\`\`

## A note on SSE subscriptions

Covara subscriptions use long-lived SSE connections. On Cloudflare Workers this is cheap: Workers are billed on CPU time, not wall-clock time, so an idle open connection costs essentially nothing while it waits for changes.

## The COVARA_KV Durable Object

\`src/worker.ts\` re-exports \`CovaraKVDurableObject\` and binds it as \`COVARA_KV\` in \`wrangler.toml\`. This Durable Object backs Covara's KV store — cross-isolate pub/sub for subscriptions (so a mutation handled by one isolate reaches SSE clients connected to another), rate limiting, sessions, and the changelog. It uses WebSocket hibernation, so idle subscriber connections don't accrue Durable Object duration charges. The migration is applied automatically on first \`wrangler dev\`/\`deploy\`.
`;
};
