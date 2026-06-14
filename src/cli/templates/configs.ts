import type { ScaffoldOptions } from "../options.js";

export const NODE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
`;

export const CLOUDFLARE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
`;

export const NODE_SQLITE_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DB_FILE_NAME ?? "file:./dev.db",
  },
});
`;

export const NODE_POSTGRES_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
`;

export const CLOUDFLARE_D1_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
});
`;

export const CLOUDFLARE_POSTGRES_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
`;

export const renderDrizzleConfig = (options: ScaffoldOptions): string => {
  if (options.template === "node") {
    return options.db === "sqlite"
      ? NODE_SQLITE_DRIZZLE_CONFIG
      : NODE_POSTGRES_DRIZZLE_CONFIG;
  }
  return options.db === "sqlite"
    ? CLOUDFLARE_D1_DRIZZLE_CONFIG
    : CLOUDFLARE_POSTGRES_DRIZZLE_CONFIG;
};

export const renderWranglerToml = (options: ScaffoldOptions): string => {
  const assets =
    options.frontend === "react"
      ? `
# Static assets (the built React SPA). The worker handles /api and /__covara;
# everything else is served from ./public with SPA fallback.
[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/__covara/*"]
`
      : "";
  const header = `name = "${options.name}"
main = "src/worker.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]
${assets}
[build]
command = ""

[observability]
enabled = true

# Durable Object backing Covara's KV (subscriptions, rate limits, sessions)
[durable_objects]
bindings = [{ name = "COVARA_KV", class_name = "CovaraKVDurableObject" }]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CovaraKVDurableObject"]

# Optional KV namespace (e.g. caching, feature flags).
# Create with: wrangler kv namespace create CACHE
# [[kv_namespaces]]
# binding = "CACHE"
# id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
`;

  if (options.db === "sqlite") {
    return `${header}
[[d1_databases]]
binding = "DB"
database_name = "${options.name}-db"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
`;
  }

  return `${header}
# Set your connection string as a secret:
#   wrangler secret put DATABASE_URL
# For production workloads, prefer Cloudflare Hyperdrive for connection pooling:
# [[hyperdrive]]
# binding = "HYPERDRIVE"
# id = "REPLACE_WITH_YOUR_HYPERDRIVE_ID"
`;
};

export const renderGitignore = (options: ScaffoldOptions): string => {
  const lines = ["node_modules/", "dist/", ".env", ".env.*", "!.env.example"];
  if (options.frontend === "react" && options.template === "cloudflare") {
    lines.push("public/");
  }
  if (options.db === "sqlite") {
    lines.push("*.db", "*.db-journal");
  }
  if (options.template === "cloudflare") {
    lines.push(".wrangler/", ".dev.vars");
  }
  return `${lines.join("\n")}\n`;
};

export const renderEnvExample = (options: ScaffoldOptions): string => {
  if (options.template === "cloudflare") {
    if (options.db === "sqlite") {
      return `# drizzle-kit D1 HTTP driver credentials (for \`npm run db:push\`)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_DATABASE_ID=
CLOUDFLARE_D1_TOKEN=
`;
    }
    return `# Set as a Worker secret in production: wrangler secret put DATABASE_URL
DATABASE_URL=postgres://user:password@localhost:5432/${options.name.replace(/-/g, "_")}
`;
  }

  const lines = ["PORT=3000"];
  if (options.db === "sqlite") {
    lines.push("DB_FILE_NAME=file:./dev.db");
  } else {
    lines.push(
      `DATABASE_URL=postgres://user:password@localhost:5432/${options.name.replace(/-/g, "_")}`
    );
  }
  lines.push("# Optional: Redis for sessions, subscriptions and task queue");
  lines.push("# REDIS_URL=redis://localhost:6379");
  return `${lines.join("\n")}\n`;
};
