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

const app = createCovara({ cors: true }).resource(todos, {
  db,
  id: todos.id,
  auth: { public: true },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
});

console.log(\`Covara running at http://localhost:\${server.port}\`);
console.log(\`Try: curl http://localhost:\${server.port}/api/todos\`);
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

const app = createCovara({ cors: true }).resource(todos, {
  db,
  id: todos.id,
  auth: { public: true },
});

const server = await startServer(app, {
  port: Number(process.env.PORT ?? 3000),
});

console.log(\`Covara running at http://localhost:\${server.port}\`);
console.log(\`Try: curl http://localhost:\${server.port}/api/todos\`);
`;

export const renderNodeIndex = (options: ScaffoldOptions): string =>
  options.db === "sqlite" ? NODE_SQLITE_INDEX : NODE_POSTGRES_INDEX;

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
  return createCovara({ cors: true }).resource(todos, {
    db,
    id: todos.id,
    auth: { public: true },
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
  return createCovara({ cors: true }).resource(todos, {
    db,
    id: todos.id,
    auth: { public: true },
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
