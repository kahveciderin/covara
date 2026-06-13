import type { ScaffoldOptions } from "../options.js";

const VERSIONS = {
  covara: "^0.8.0",
  hono: "^4.12.25",
  drizzleOrm: "^0.45.1",
  zod: "^4.3.5",
  libsql: "^0.17.0",
  postgres: "^3.4.7",
  typescript: "^5.9.3",
  tsx: "^4.21.0",
  drizzleKit: "^0.31.8",
  typesNode: "^25.0.8",
  wrangler: "^4.0.0",
  workersTypes: "^4.0.0",
  vitest: "^3.0.0",
} as const;

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

  if (options.template === "node") {
    if (options.db === "sqlite") {
      dependencies["@libsql/client"] = VERSIONS.libsql;
    } else {
      dependencies.postgres = VERSIONS.postgres;
    }
    devDependencies["@types/node"] = VERSIONS.typesNode;
    devDependencies.tsx = VERSIONS.tsx;
    scripts = {
      dev: "tsx watch src/index.ts",
      build: "tsc -p tsconfig.json",
      start: "node dist/index.js",
      test: "vitest run",
      lint: "tsc -p tsconfig.json --noEmit",
      "db:generate": "drizzle-kit generate",
      "db:push": "drizzle-kit push",
    };
    devDependencies.vitest = VERSIONS.vitest;
  } else {
    if (options.db === "postgres") {
      dependencies.postgres = VERSIONS.postgres;
    }
    devDependencies["@cloudflare/workers-types"] = VERSIONS.workersTypes;
    devDependencies.wrangler = VERSIONS.wrangler;
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
