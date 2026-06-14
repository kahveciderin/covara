import type { ScaffoldOptions } from "../options.js";

export const SQLITE_SCHEMA = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
`;

export const POSTGRES_SCHEMA = `import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;

export const renderSchema = (options: ScaffoldOptions): string =>
  options.db === "sqlite" ? SQLITE_SCHEMA : POSTGRES_SCHEMA;

export const NODE_SQLITE_INDEX = `import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createCovara } from "covara";
import { startServer } from "covara/node";
import { todos } from "./schema.js";

const client = createClient({
  url: process.env.DB_FILE_NAME ?? "file:./dev.db",
});
const db = drizzle(client);

const app = createCovara({ cors: true, adminUI: true }).resource(todos, {
  db,
  id: todos.id,
  // Public CRUD so the starter works end-to-end. Lock this down with auth
  // scopes before deploying: https://github.com/kahveciderin/covara#auth
  auth: { public: { read: true, create: true, update: true, delete: true } },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
});

console.log(\`Covara running at http://localhost:\${server.port}\`);
console.log(\`Create: curl -X POST http://localhost:\${server.port}/api/todos -H 'content-type: application/json' -d '{"title":"hello"}'\`);
console.log(\`List:   curl http://localhost:\${server.port}/api/todos\`);
`;

export const NODE_POSTGRES_INDEX = `import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createCovara } from "covara";
import { startServer } from "covara/node";
import { todos } from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);

const app = createCovara({ cors: true, adminUI: true }).resource(todos, {
  db,
  id: todos.id,
  // Public CRUD so the starter works end-to-end. Lock this down with auth
  // scopes before deploying: https://github.com/kahveciderin/covara#auth
  auth: { public: { read: true, create: true, update: true, delete: true } },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
});

console.log(\`Covara running at http://localhost:\${server.port}\`);
console.log(\`Create: curl -X POST http://localhost:\${server.port}/api/todos -H 'content-type: application/json' -d '{"title":"hello"}'\`);
console.log(\`List:   curl http://localhost:\${server.port}/api/todos\`);
`;

// Node entry for the React-frontend variant: one process serves the SPA (with
// Vite HMR in dev) AND the API/admin. In dev it embeds Vite in middleware mode
// and routes /api + /__covara to the Hono app; in production it serves the
// built SPA from ../public with an SPA fallback.
const NODE_REACT_DB_SETUP_SQLITE = `import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createCovara } from "covara";
import { todos } from "./schema.js";

const client = createClient({
  url: process.env.DB_FILE_NAME ?? "file:./dev.db",
});
const db = drizzle(client);`;

const NODE_REACT_DB_SETUP_POSTGRES = `import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createCovara } from "covara";
import { todos } from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client);`;

const renderNodeReactIndex = (options: ScaffoldOptions): string => {
  const dbSetup =
    options.db === "sqlite"
      ? NODE_REACT_DB_SETUP_SQLITE
      : NODE_REACT_DB_SETUP_POSTGRES;

  return `${dbSetup}
import { serve, getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = createCovara({ cors: true, adminUI: true }).resource(todos, {
  db,
  id: todos.id,
  // Public CRUD so the starter works end-to-end. Lock this down with auth
  // scopes before deploying: https://github.com/kahveciderin/covara#auth
  auth: { public: { read: true, create: true, update: true, delete: true } },
});

const port = Number(process.env.PORT ?? 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const isApi = (p: string) => p.startsWith("/api") || p.startsWith("/__covara");

if (process.env.NODE_ENV === "development") {
  // Single process: Vite (SPA + HMR) for everything else, Covara for the API.
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: path.join(here, "../frontend"),
    server: { middlewareMode: true },
    appType: "spa",
  });
  const honoListener = getRequestListener(app.fetch);
  createHttpServer((req, res) => {
    if (isApi(req.url ?? "/")) honoListener(req, res);
    else vite.middlewares(req, res);
  }).listen(port, () => {
    console.log(\`Covara dev server (SPA + HMR + API) at http://localhost:\${port}\`);
    console.log(\`Admin UI: http://localhost:\${port}/__covara/ui\`);
  });
} else {
  // Production: serve the built SPA (../public) and fall through to the API.
  const publicDir = path.join(here, "../public");
  app.use("*", serveStatic({ root: publicDir }));
  const spa = serveStatic({ root: publicDir, path: "index.html" });
  app.get("*", (c, next) => (isApi(c.req.path) ? next() : spa(c, next)));
  serve({ fetch: app.fetch, port });
  console.log(\`Covara running at http://localhost:\${port}\`);
}
`;
};

export const renderNodeIndex = (options: ScaffoldOptions): string => {
  if (options.frontend === "react") return renderNodeReactIndex(options);
  return options.db === "sqlite" ? NODE_SQLITE_INDEX : NODE_POSTGRES_INDEX;
};

export const CLOUDFLARE_D1_WORKER = `import { drizzle } from "drizzle-orm/d1";
import {
  createCovara,
  createDurableObjectKV,
  setGlobalKV,
  initializeEventSubscription,
  type CovaraApp,
  type DurableObjectNamespaceLike,
} from "covara";
import { todos } from "./schema";

export { CovaraKVDurableObject } from "covara";

interface Env {
  DB: D1Database;
  COVARA_KV: DurableObjectNamespaceLike;
}

let app: CovaraApp | undefined;

const buildApp = (env: Env): CovaraApp => {
  setGlobalKV(createDurableObjectKV(env.COVARA_KV));
  void initializeEventSubscription();

  const db = drizzle(env.DB);
  return createCovara({ cors: true, adminUI: true }).resource(todos, {
    db,
    id: todos.id,
    // Public CRUD so the starter works end-to-end. Lock this down with auth
    // scopes before deploying: https://github.com/kahveciderin/covara#auth
    auth: { public: { read: true, create: true, update: true, delete: true } },
  });
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= buildApp(env);
    return app.fetch(request, env, ctx);
  },
};
`;

export const CLOUDFLARE_POSTGRES_WORKER = `import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createCovara,
  createDurableObjectKV,
  setGlobalKV,
  initializeEventSubscription,
  type CovaraApp,
  type DurableObjectNamespaceLike,
} from "covara";
import { todos } from "./schema";

export { CovaraKVDurableObject } from "covara";

interface Env {
  DATABASE_URL: string;
  COVARA_KV: DurableObjectNamespaceLike;
}

let app: CovaraApp | undefined;

const buildApp = (env: Env): CovaraApp => {
  setGlobalKV(createDurableObjectKV(env.COVARA_KV));
  void initializeEventSubscription();

  const client = postgres(env.DATABASE_URL, { max: 5, fetch_types: false });
  const db = drizzle(client);
  return createCovara({ cors: true, adminUI: true }).resource(todos, {
    db,
    id: todos.id,
    // Public CRUD so the starter works end-to-end. Lock this down with auth
    // scopes before deploying: https://github.com/kahveciderin/covara#auth
    auth: { public: { read: true, create: true, update: true, delete: true } },
  });
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= buildApp(env);
    return app.fetch(request, env, ctx);
  },
};
`;

export const renderWorker = (options: ScaffoldOptions): string =>
  options.db === "sqlite" ? CLOUDFLARE_D1_WORKER : CLOUDFLARE_POSTGRES_WORKER;
