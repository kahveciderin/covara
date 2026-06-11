import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const validateResourceName = (name: string): string | undefined => {
  if (name.length === 0) return "resource name is required";
  if (name.length > 100) return "resource name must be 100 characters or fewer";
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    return "resource name must be kebab-case (lowercase letters, digits and hyphens, starting with a letter)";
  }
  return undefined;
};

const toCamel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const toPascal = (name: string): string => {
  const camel = toCamel(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
};

const toSnake = (name: string): string => name.replace(/-/g, "_");

export type ResourceDialect = "sqlite" | "postgres";

export const detectDialect = (cwd: string): ResourceDialect => {
  const configPath = path.join(cwd, "drizzle.config.ts");
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf8");
    if (content.includes("postgresql")) return "postgres";
  }
  return "sqlite";
};

export const renderResourceTable = (
  name: string,
  dialect: ResourceDialect
): string => {
  const varName = toCamel(name);
  const tableName = toSnake(name);

  if (dialect === "postgres") {
    return `import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ${varName} = pgTable("${tableName}", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
`;
  }

  return `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const ${varName} = sqliteTable("${tableName}", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
`;
};

export const renderResourceRegistration = (name: string): string => {
  const varName = toCamel(name);
  const pascal = toPascal(name);
  return `// 1. Re-export the table from your schema, e.g.:
//      export * from "./resources/${name}.js";
//
// 2. Import it where you build the app:
//      import { ${varName} } from "./resources/${name}.js";
//
// 3. Register the resource on your Covara app:
//      app.resource(${varName}, {
//        db,
//        id: ${varName}.id,
//        auth: { public: true },
//      });
//
// The endpoints are mounted at /api/${name} (${pascal}).`;
};

export interface GenerateResourceResult {
  files: string[];
  registration: string;
}

export const generateResource = (
  name: string,
  cwd: string
): GenerateResourceResult => {
  const error = validateResourceName(name);
  if (error) throw new Error(error);

  const dialect = detectDialect(cwd);
  const dir = path.join(cwd, "src", "resources");
  const file = path.join(dir, `${name}.ts`);

  if (fs.existsSync(file)) {
    throw new Error(`resource file already exists: ${path.relative(cwd, file)}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, renderResourceTable(name, dialect));

  return {
    files: [path.relative(cwd, file)],
    registration: renderResourceRegistration(name),
  };
};

export interface GenerateMigrationResult {
  status: number;
  command: string;
}

export const generateMigration = (
  cwd: string,
  extraArgs: string[] = []
): GenerateMigrationResult => {
  if (!fs.existsSync(path.join(cwd, "drizzle.config.ts"))) {
    throw new Error(
      "no drizzle.config.ts found in the current directory; run this inside a Covara project"
    );
  }

  const args = ["drizzle-kit", "generate", ...extraArgs];
  const result = spawnSync("npx", args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return { status: result.status ?? 1, command: `npx ${args.join(" ")}` };
};
