import type { ScaffoldOptions } from "../options.js";
import { VERSIONS } from "./versions.js";

export const renderPackageJson = (options: ScaffoldOptions): string => {
  const dependencies: Record<string, string> = {
    "covara": VERSIONS.covara,
    "drizzle-orm": VERSIONS.drizzleOrm,
    hono: VERSIONS.hono,
    zod: VERSIONS.zod,
  };

  const devDependencies: Record<string, string> = {
    "drizzle-kit": VERSIONS.drizzleKit,
    typescript: VERSIONS.typescript,
  };

  let scripts: Record<string, string>;
  const react = options.frontend === "react";

  if (react) {
    dependencies.react = VERSIONS.react;
    dependencies["react-dom"] = VERSIONS.reactDom;
    devDependencies["@vitejs/plugin-react"] = VERSIONS.viteReactPlugin;
    devDependencies["@types/react"] = VERSIONS.typesReact;
    devDependencies["@types/react-dom"] = VERSIONS.typesReactDom;
    devDependencies.vite = VERSIONS.vite;
  }

  if (options.template === "node") {
    if (options.db === "sqlite") {
      dependencies["@libsql/client"] = VERSIONS.libsql;
    } else {
      dependencies.postgres = VERSIONS.postgres;
    }
    devDependencies["@types/node"] = VERSIONS.typesNode;
    devDependencies.tsx = VERSIONS.tsx;
    devDependencies.vitest = VERSIONS.vitest;
    if (react) {
      // The dev server embeds Vite in-process and routes /api + /__covara to
      // the Hono app via @hono/node-server's request listener.
      dependencies["@hono/node-server"] = VERSIONS.honoNodeServer;
      scripts = {
        // Single-process dev: Vite (HMR) + API + admin + live typegen + DB
        // live-reload, no build step. NODE_ENV=development selects the Vite path;
        // covara dev watches the schema and regenerates the typed client live.
        dev: "NODE_ENV=development covara dev --types-out frontend/src/generated/api-types.ts",
        build: "vite build --config frontend/vite.config.ts && tsc -p tsconfig.json",
        start: "node dist/index.js",
        test: "vitest run",
        lint: "tsc -p tsconfig.json --noEmit",
        types: "covara types --out frontend/src/generated/api-types.ts",
        "db:generate": "drizzle-kit generate",
        "db:push": "drizzle-kit push",
      };
    } else {
      scripts = {
        dev: "tsx watch src/index.ts",
        build: "tsc -p tsconfig.json",
        start: "node dist/index.js",
        test: "vitest run",
        lint: "tsc -p tsconfig.json --noEmit",
        "db:generate": "drizzle-kit generate",
        "db:push": "drizzle-kit push",
      };
    }
  } else {
    if (options.db === "postgres") {
      dependencies.postgres = VERSIONS.postgres;
    }
    devDependencies["@cloudflare/workers-types"] = VERSIONS.workersTypes;
    devDependencies.wrangler = VERSIONS.wrangler;
    if (react) {
      scripts = {
        // wrangler serves the built SPA via [assets]; `dev:web` runs Vite (HMR)
        // proxying /api + /__covara to `wrangler dev` on :8787.
        dev: "vite build --config frontend/vite.config.ts && wrangler dev",
        "dev:web": "vite --config frontend/vite.config.ts",
        build: "vite build --config frontend/vite.config.ts",
        deploy: "vite build --config frontend/vite.config.ts && wrangler deploy",
        typecheck: "tsc -p tsconfig.json",
        lint: "tsc -p tsconfig.json",
        types: "covara types --out frontend/src/generated/api-types.ts",
        "cf-typegen": "wrangler types",
        "db:generate": "drizzle-kit generate",
        "db:push": "drizzle-kit push",
      };
    } else {
      scripts = {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        typecheck: "tsc -p tsconfig.json",
        lint: "tsc -p tsconfig.json",
        "cf-typegen": "wrangler types",
        "db:generate": "drizzle-kit generate",
        "db:push": "drizzle-kit push",
      };
    }
  }

  const pkg = {
    name: options.name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts,
    dependencies: sortKeys(dependencies),
    devDependencies: sortKeys(devDependencies),
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
};

const sortKeys = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  );
