import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldProject } from "@/cli/create";
import {
  generateResource,
  renderResourceTable,
  detectDialect,
  validateResourceName,
} from "@/cli/generate";
import type { ScaffoldOptions } from "@/cli/options";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-tpl-test-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const scaffold = (options: ScaffoldOptions) => {
  const targetDir = path.join(makeTempDir(), options.name);
  scaffoldProject(options, targetDir);
  return targetDir;
};

const read = (dir: string, file: string): string =>
  fs.readFileSync(path.join(dir, file), "utf8");

const readJson = (dir: string, file: string): Record<string, any> =>
  JSON.parse(read(dir, file));

describe("cloudflare deployment scaffold", () => {
  it("produces a complete wrangler.toml with nodejs_compat, D1 and DO markers", () => {
    const dir = scaffold({ name: "edge-app", template: "cloudflare", db: "sqlite" });
    const wrangler = read(dir, "wrangler.toml");
    expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
    expect(wrangler).toContain("[[d1_databases]]");
    expect(wrangler).toContain('binding = "DB"');
    expect(wrangler).toContain("[durable_objects]");
    expect(wrangler).toContain("CovaraKVDurableObject");
    expect(wrangler).toContain("[[migrations]]");
    expect(wrangler).toContain("new_sqlite_classes");
    expect(wrangler).toContain("kv_namespaces");
    expect(wrangler).toContain("[build]");
  });

  it("worker entry exports a default fetch handler", () => {
    const dir = scaffold({ name: "edge-app", template: "cloudflare", db: "sqlite" });
    const worker = read(dir, "src/worker.ts");
    expect(worker).toContain("export default");
    expect(worker).toContain("app.fetch");
    expect(worker).toContain("CovaraKVDurableObject");
  });

  it("adds wrangler deploy and cf-typegen scripts", () => {
    const dir = scaffold({ name: "edge-app", template: "cloudflare", db: "sqlite" });
    const pkg = readJson(dir, "package.json");
    expect(pkg.scripts.deploy).toBe("wrangler deploy");
    expect(pkg.scripts["cf-typegen"]).toBe("wrangler types");
  });

  it("writes a CI workflow and a DB-specific .env.example", () => {
    const sqlite = scaffold({ name: "edge-app", template: "cloudflare", db: "sqlite" });
    expect(read(sqlite, ".github/workflows/ci.yml")).toContain("npm run build");
    expect(read(sqlite, ".env.example")).toContain("CLOUDFLARE_ACCOUNT_ID");

    const pg = scaffold({ name: "edge-pg", template: "cloudflare", db: "postgres" });
    expect(read(pg, ".env.example")).toContain("DATABASE_URL");
  });
});

describe("node deployment scaffold", () => {
  it("produces a multi-stage Dockerfile with non-root user and healthcheck", () => {
    const dir = scaffold({ name: "my-app", template: "node", db: "sqlite" });
    const dockerfile = read(dir, "Dockerfile");
    expect(dockerfile).toContain("FROM node:22-slim AS build");
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile).toContain("USER covara");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/healthz");
  });

  it("produces a .dockerignore and docker-compose with app + postgres + redis", () => {
    const dir = scaffold({ name: "my-app", template: "node", db: "postgres" });
    expect(read(dir, ".dockerignore")).toContain("node_modules");
    const compose = read(dir, "docker-compose.yml");
    expect(compose).toContain("app:");
    expect(compose).toContain("postgres:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("DATABASE_URL");
  });

  it("omits postgres service for sqlite but keeps redis", () => {
    const dir = scaffold({ name: "my-app", template: "node", db: "sqlite" });
    const compose = read(dir, "docker-compose.yml");
    expect(compose).toContain("redis:");
    expect(compose).not.toContain("postgres:");
    expect(compose).toContain("DB_FILE_NAME");
  });

  it("writes a CI workflow", () => {
    const dir = scaffold({ name: "my-app", template: "node", db: "sqlite" });
    const ci = read(dir, ".github/workflows/ci.yml");
    expect(ci).toContain("name: CI");
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run build");
  });

  it("has production build/start/test/lint scripts in package.json", () => {
    const dir = scaffold({ name: "my-app", template: "node", db: "sqlite" });
    const pkg = readJson(dir, "package.json");
    expect(pkg.scripts.build).toContain("tsc");
    expect(pkg.scripts.start).toContain("node dist");
    expect(pkg.scripts.test).toBeDefined();
    expect(pkg.scripts.lint).toBeDefined();
    expect(pkg.devDependencies.vitest).toBeDefined();
  });

  it(".env.example matches sqlite vs postgres DB choice", () => {
    const sqlite = scaffold({ name: "my-app", template: "node", db: "sqlite" });
    expect(read(sqlite, ".env.example")).toContain("DB_FILE_NAME");

    const pg = scaffold({ name: "pg-app", template: "node", db: "postgres" });
    const env = read(pg, ".env.example");
    expect(env).toContain("DATABASE_URL");
    expect(env).not.toContain("DB_FILE_NAME");
  });
});

describe("AGENTS.md scaffold", () => {
  it("writes AGENTS.md for every template variant", () => {
    const variants: ScaffoldOptions[] = [
      { name: "node-app", template: "node", db: "sqlite" },
      { name: "node-pg", template: "node", db: "postgres" },
      { name: "node-react", template: "node", db: "sqlite", frontend: "react" },
      { name: "edge-app", template: "cloudflare", db: "sqlite" },
      { name: "edge-react", template: "cloudflare", db: "postgres", frontend: "react" },
    ];
    for (const options of variants) {
      const dir = scaffold(options);
      const agents = read(dir, "AGENTS.md");
      expect(agents).toContain("# AGENTS.md");
      expect(agents).toContain(options.name);
      expect(agents).toContain("src/schema.ts");
    }
  });

  it("links to the docs site and llms.txt", () => {
    const dir = scaffold({ name: "node-app", template: "node", db: "sqlite" });
    const agents = read(dir, "AGENTS.md");
    expect(agents).toContain("https://kahveciderin.github.io/covara/");
    expect(agents).toContain("https://kahveciderin.github.io/covara/llms.txt");
    expect(agents).toContain("https://kahveciderin.github.io/covara/llms-full.txt");
  });

  it("references the correct entry file per template", () => {
    const node = read(scaffold({ name: "node-app", template: "node", db: "sqlite" }), "AGENTS.md");
    expect(node).toContain("src/index.ts");
    expect(node).not.toContain("src/worker.ts");

    const edge = read(
      scaffold({ name: "edge-app", template: "cloudflare", db: "sqlite" }),
      "AGENTS.md"
    );
    expect(edge).toContain("src/worker.ts");
    expect(edge).toContain("npm run deploy");
  });

  it("documents the frontend type generation only for the react variant", () => {
    const react = read(
      scaffold({ name: "node-react", template: "node", db: "sqlite", frontend: "react" }),
      "AGENTS.md"
    );
    expect(react).toContain("frontend/src/generated/api-types.ts");
    expect(react).toContain("npm run types");

    const backend = read(
      scaffold({ name: "node-app", template: "node", db: "sqlite" }),
      "AGENTS.md"
    );
    expect(backend).not.toContain("frontend/");
  });

  it("explains covara dev handles reload, frontend, and schema sync with force push for destructive changes", () => {
    const react = read(
      scaffold({ name: "node-react", template: "node", db: "sqlite", frontend: "react" }),
      "AGENTS.md"
    );
    expect(react).toContain("covara dev");
    expect(react).toContain("live-reload");
    expect(react).toContain("Vite HMR");
    expect(react).toContain("covara push --force");

    const backend = read(
      scaffold({ name: "node-app", template: "node", db: "sqlite" }),
      "AGENTS.md"
    );
    expect(backend).toContain("covara push --force");
    expect(backend).not.toContain("Vite HMR");
  });

  it("warns that the starter resource is public", () => {
    const dir = scaffold({ name: "node-app", template: "node", db: "sqlite" });
    const agents = read(dir, "AGENTS.md");
    expect(agents.toLowerCase()).toContain("public");
    expect(agents).toContain("auth");
  });
});

describe("generate resource", () => {
  it("produces a table file containing the resource name", () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "drizzle.config.ts"), 'dialect: "sqlite"');
    const result = generateResource("blog-post", cwd);
    expect(result.files).toEqual(["src/resources/blog-post.ts"]);
    const content = read(cwd, "src/resources/blog-post.ts");
    expect(content).toContain("sqliteTable");
    expect(content).toContain('"blog_post"');
    expect(content).toContain("export const blogPost");
    expect(result.registration).toContain("blogPost");
    expect(result.registration).toContain("/api/blog-post");
  });

  it("detects the postgres dialect from drizzle.config.ts", () => {
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "drizzle.config.ts"), 'dialect: "postgresql"');
    expect(detectDialect(cwd)).toBe("postgres");
    const table = renderResourceTable("widget", "postgres");
    expect(table).toContain("pgTable");
    expect(table).toContain("export const widget");
  });

  it("refuses to overwrite an existing resource file", () => {
    const cwd = makeTempDir();
    generateResource("thing", cwd);
    expect(() => generateResource("thing", cwd)).toThrow(/already exists/);
  });

  it("rejects invalid resource names", () => {
    expect(validateResourceName("Bad Name")).toBeDefined();
    expect(validateResourceName("")).toBeDefined();
    expect(validateResourceName("good-name")).toBeUndefined();
  });
});
