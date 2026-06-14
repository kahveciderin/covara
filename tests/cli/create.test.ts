import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldProject, detectPackageManager } from "@/cli/create";
import type { ScaffoldOptions } from "@/cli/options";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-cli-test-"));
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
  const result = scaffoldProject(options, targetDir);
  return { targetDir, result };
};

const readJson = (dir: string, file: string): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));

const read = (dir: string, file: string): string =>
  fs.readFileSync(path.join(dir, file), "utf8");

describe("scaffoldProject", () => {
  describe("node + sqlite", () => {
    const options: ScaffoldOptions = {
      name: "my-app",
      template: "node",
      db: "sqlite",
    };

    it("writes the expected files", () => {
      const { targetDir, result } = scaffold(options);
      const expected = [
        ".dockerignore",
        ".env.example",
        ".github/workflows/ci.yml",
        ".gitignore",
        "Dockerfile",
        "README.md",
        "docker-compose.yml",
        "drizzle.config.ts",
        "package.json",
        "src/index.ts",
        "src/schema.ts",
        "tsconfig.json",
      ];
      expect(result.files).toEqual(expected);
      for (const file of expected) {
        expect(fs.existsSync(path.join(targetDir, file))).toBe(true);
      }
      expect(fs.existsSync(path.join(targetDir, "wrangler.toml"))).toBe(false);
      expect(fs.existsSync(path.join(targetDir, "src/worker.ts"))).toBe(false);
    });

    it("writes a valid package.json with the right deps", () => {
      const { targetDir } = scaffold(options);
      const pkg = readJson(targetDir, "package.json");
      expect(pkg.name).toBe("my-app");
      expect(pkg.type).toBe("module");
      expect(Object.keys(pkg.dependencies)).toEqual(
        expect.arrayContaining([
          "covara",
          "@libsql/client",
          "drizzle-orm",
          "hono",
          "zod",
        ])
      );
      expect(pkg.dependencies.postgres).toBeUndefined();
      expect(Object.keys(pkg.devDependencies)).toEqual(
        expect.arrayContaining(["typescript", "tsx", "drizzle-kit", "@types/node"])
      );
      expect(pkg.devDependencies.wrangler).toBeUndefined();
      expect(pkg.scripts.dev).toContain("tsx watch");
      expect(pkg.scripts.build).toContain("tsc");
      expect(pkg.scripts.start).toContain("node dist");
      expect(pkg.scripts["db:generate"]).toBe("drizzle-kit generate");
      expect(pkg.scripts["db:push"]).toBe("drizzle-kit push");
    });

    it("generates a sqlite schema and libsql entrypoint", () => {
      const { targetDir } = scaffold(options);
      const schema = read(targetDir, "src/schema.ts");
      expect(schema).toContain("sqliteTable");
      expect(schema).toContain('"todos"');
      expect(schema).toContain("createdAt");
      const index = read(targetDir, "src/index.ts");
      expect(index).toContain('from "@libsql/client"');
      expect(index).toContain('from "drizzle-orm/libsql"');
      expect(index).toContain("createCovara");
      expect(index).toContain('startServer } from "covara/node"');
      // Starter ships fully-public CRUD so it works end-to-end out of the box.
      expect(index).toContain("public: { read: true, create: true, update: true, delete: true }");
      expect(index).toContain("process.env.PORT");
      expect(index).toContain("process.env.DB_FILE_NAME");
      const drizzleConfig = read(targetDir, "drizzle.config.ts");
      expect(drizzleConfig).toContain('dialect: "sqlite"');
      expect(read(targetDir, ".env.example")).toContain("DB_FILE_NAME");
    });
  });

  describe("node + postgres", () => {
    const options: ScaffoldOptions = {
      name: "pg-app",
      template: "node",
      db: "postgres",
    };

    it("writes a postgres variant", () => {
      const { targetDir } = scaffold(options);
      const pkg = readJson(targetDir, "package.json");
      expect(pkg.dependencies.postgres).toBeDefined();
      expect(pkg.dependencies["@libsql/client"]).toBeUndefined();
      const schema = read(targetDir, "src/schema.ts");
      expect(schema).toContain("pgTable");
      expect(schema).toContain("boolean");
      expect(schema).toContain("timestamp");
      const index = read(targetDir, "src/index.ts");
      expect(index).toContain('from "postgres"');
      expect(index).toContain('from "drizzle-orm/postgres-js"');
      expect(index).toContain("process.env.DATABASE_URL");
      expect(read(targetDir, "drizzle.config.ts")).toContain(
        'dialect: "postgresql"'
      );
      expect(read(targetDir, ".env.example")).toContain("DATABASE_URL");
    });
  });

  describe("cloudflare + sqlite (D1)", () => {
    const options: ScaffoldOptions = {
      name: "edge-app",
      template: "cloudflare",
      db: "sqlite",
    };

    it("writes the expected files", () => {
      const { targetDir, result } = scaffold(options);
      expect(result.files).toEqual([
        ".env.example",
        ".github/workflows/ci.yml",
        ".gitignore",
        "README.md",
        "drizzle.config.ts",
        "package.json",
        "src/schema.ts",
        "src/worker.ts",
        "tsconfig.json",
        "wrangler.toml",
      ]);
      expect(fs.existsSync(path.join(targetDir, "src/index.ts"))).toBe(false);
      expect(fs.existsSync(path.join(targetDir, "Dockerfile"))).toBe(false);
    });

    it("configures a D1 worker", () => {
      const { targetDir } = scaffold(options);
      const pkg = readJson(targetDir, "package.json");
      expect(pkg.devDependencies.wrangler).toBeDefined();
      expect(pkg.devDependencies["@cloudflare/workers-types"]).toBeDefined();
      expect(pkg.dependencies.postgres).toBeUndefined();
      expect(pkg.scripts.deploy).toBe("wrangler deploy");
      expect(pkg.scripts.dev).toBe("wrangler dev");
      const worker = read(targetDir, "src/worker.ts");
      expect(worker).toContain('from "drizzle-orm/d1"');
      expect(worker).toContain("drizzle(env.DB)");
      expect(worker).toContain("export default");
      expect(worker).toContain("app ??= buildApp(env)");
      const wrangler = read(targetDir, "wrangler.toml");
      expect(wrangler).toContain('name = "edge-app"');
      expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
      expect(wrangler).toContain("[[d1_databases]]");
      expect(wrangler).toContain('binding = "DB"');
      const drizzleConfig = read(targetDir, "drizzle.config.ts");
      expect(drizzleConfig).toContain('driver: "d1-http"');
      expect(read(targetDir, "README.md")).toContain("CPU time");
    });
  });

  describe("cloudflare + postgres", () => {
    const options: ScaffoldOptions = {
      name: "edge-pg",
      template: "cloudflare",
      db: "postgres",
    };

    it("configures a postgres worker", () => {
      const { targetDir } = scaffold(options);
      const pkg = readJson(targetDir, "package.json");
      expect(pkg.dependencies.postgres).toBeDefined();
      expect(pkg.devDependencies.wrangler).toBeDefined();
      const worker = read(targetDir, "src/worker.ts");
      expect(worker).toContain('from "drizzle-orm/postgres-js"');
      expect(worker).toContain("env.DATABASE_URL");
      const wrangler = read(targetDir, "wrangler.toml");
      expect(wrangler).toContain('compatibility_flags = ["nodejs_compat"]');
      expect(wrangler).toContain("DATABASE_URL");
      expect(wrangler).not.toContain("[[d1_databases]]");
      expect(read(targetDir, "README.md")).toContain("CPU time");
    });
  });

  describe("all variants produce valid JSON package.json", () => {
    const variants: ScaffoldOptions[] = [
      { name: "a-one", template: "node", db: "sqlite" },
      { name: "a-two", template: "node", db: "postgres" },
      { name: "a-three", template: "cloudflare", db: "sqlite" },
      { name: "a-four", template: "cloudflare", db: "postgres" },
    ];

    for (const variant of variants) {
      it(`${variant.template} + ${variant.db}`, () => {
        const { targetDir } = scaffold(variant);
        const pkg = readJson(targetDir, "package.json");
        expect(pkg.name).toBe(variant.name);
        expect(pkg.dependencies["covara"]).toBeDefined();
        // The covara dep is pinned to the CLI's own (published) version so a
        // freshly created project always installs — not a hand-synced literal.
        const cliVersion = readJson(process.cwd(), "package.json").version as string;
        expect(pkg.dependencies["covara"]).toBe(`^${cliVersion}`);
        expect(pkg.dependencies.hono).toBeDefined();
        expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
        expect(pkg.dependencies.zod).toBeDefined();
        expect(pkg.devDependencies["drizzle-kit"]).toBeDefined();
        expect(pkg.devDependencies.typescript).toBeDefined();
        expect(read(targetDir, ".gitignore")).toContain("node_modules");
        expect(read(targetDir, "README.md")).toContain(variant.name);
      });
    }
  });

  describe("node + sqlite + react frontend", () => {
    const options: ScaffoldOptions = {
      name: "react-app",
      template: "node",
      db: "sqlite",
      frontend: "react",
    };

    it("emits the frontend files only when --frontend react", () => {
      const { targetDir, result } = scaffold(options);
      const frontendFiles = [
        "frontend/vite.config.ts",
        "frontend/tsconfig.json",
        "frontend/index.html",
        "frontend/src/main.tsx",
        "frontend/src/App.tsx",
        "frontend/src/styles.css",
        "frontend/src/generated/api-types.ts",
      ];
      for (const file of frontendFiles) {
        expect(result.files).toContain(file);
        expect(fs.existsSync(path.join(targetDir, file))).toBe(true);
      }

      // Default (no frontend) emits none of them.
      const plain = scaffold({ name: "plain-app", template: "node", db: "sqlite" });
      for (const file of frontendFiles) {
        expect(plain.result.files).not.toContain(file);
      }
    });

    it("wires react deps, the single-process dev server, and live typegen", () => {
      const { targetDir } = scaffold(options);
      const pkg = readJson(targetDir, "package.json");
      expect(Object.keys(pkg.dependencies)).toEqual(
        expect.arrayContaining(["react", "react-dom", "@hono/node-server"])
      );
      expect(Object.keys(pkg.devDependencies)).toEqual(
        expect.arrayContaining(["vite", "@vitejs/plugin-react", "@types/react"])
      );
      expect(pkg.scripts.dev).toContain("covara dev");
      expect(pkg.scripts.dev).toContain("--types-out frontend/src/generated/api-types.ts");
      expect(pkg.scripts.build).toContain("vite build");
      expect(pkg.scripts.types).toContain("covara types");

      const index = read(targetDir, "src/index.ts");
      expect(index).toContain("getRequestListener");
      expect(index).toContain('process.env.NODE_ENV === "development"');
      expect(index).toContain('import("vite")');
      expect(index).toContain("middlewareMode");
      expect(index).toContain("serveStatic");
      expect(index).toContain('p.startsWith("/api")');
      expect(index).toContain('p.startsWith("/__covara")');

      const app = read(targetDir, "frontend/src/App.tsx");
      expect(app).toContain('from "covara/client/react"');
      expect(app).toContain("useLiveList");

      expect(read(targetDir, ".gitignore")).toContain("public/");
      expect(read(targetDir, "Dockerfile")).toContain("/app/public ./public");
    });
  });

  describe("cloudflare + react serves the SPA via [assets]", () => {
    it("adds the assets block and a build step", () => {
      const { targetDir } = scaffold({
        name: "edge-react",
        template: "cloudflare",
        db: "sqlite",
        frontend: "react",
      });
      const wrangler = read(targetDir, "wrangler.toml");
      expect(wrangler).toContain("[assets]");
      expect(wrangler).toContain('directory = "./public"');
      expect(wrangler).toContain('run_worker_first = ["/api/*", "/__covara/*"]');
      const pkg = readJson(targetDir, "package.json");
      expect(pkg.scripts.build).toContain("vite build");
      expect(fs.existsSync(path.join(targetDir, "frontend/src/App.tsx"))).toBe(true);
    });
  });

  describe("target directory safety", () => {
    it("refuses to write into a non-empty directory", () => {
      const base = makeTempDir();
      const targetDir = path.join(base, "occupied");
      fs.mkdirSync(targetDir);
      fs.writeFileSync(path.join(targetDir, "existing.txt"), "data");
      expect(() =>
        scaffoldProject(
          { name: "occupied", template: "node", db: "sqlite" },
          targetDir
        )
      ).toThrow(/not empty/);
      expect(fs.readdirSync(targetDir)).toEqual(["existing.txt"]);
    });

    it("accepts an existing empty directory", () => {
      const base = makeTempDir();
      const targetDir = path.join(base, "empty-dir");
      fs.mkdirSync(targetDir);
      const result = scaffoldProject(
        { name: "empty-dir", template: "node", db: "sqlite" },
        targetDir
      );
      expect(result.files.length).toBeGreaterThan(0);
    });

    it("refuses when the target exists as a file", () => {
      const base = makeTempDir();
      const targetDir = path.join(base, "a-file");
      fs.writeFileSync(targetDir, "not a dir");
      expect(() =>
        scaffoldProject(
          { name: "a-file", template: "node", db: "sqlite" },
          targetDir
        )
      ).toThrow(/not a directory/);
    });
  });

  describe("app name validation", () => {
    const invalidNames = [
      "",
      "MyApp",
      "my app",
      "my_app",
      "../evil",
      "foo/bar",
      "..",
      ".",
      "-leading",
      "trailing-",
      "double--dash",
      "1starts-with-digit",
      "a".repeat(101),
    ];

    for (const name of invalidNames) {
      it(`rejects ${JSON.stringify(name)}`, () => {
        const base = makeTempDir();
        expect(() =>
          scaffoldProject(
            { name, template: "node", db: "sqlite" },
            path.join(base, "out")
          )
        ).toThrow();
        expect(fs.readdirSync(base)).toEqual([]);
      });
    }

    const validNames = ["app", "my-app", "app2", "a-1-b-2"];
    for (const name of validNames) {
      it(`accepts ${JSON.stringify(name)}`, () => {
        const base = makeTempDir();
        expect(() =>
          scaffoldProject(
            { name, template: "node", db: "sqlite" },
            path.join(base, name)
          )
        ).not.toThrow();
      });
    }
  });
});

describe("detectPackageManager", () => {
  it("detects pnpm", () => {
    expect(detectPackageManager("pnpm/9.0.0 npm/? node/v22.0.0")).toBe("pnpm");
  });

  it("detects yarn", () => {
    expect(detectPackageManager("yarn/4.0.0 npm/? node/v22.0.0")).toBe("yarn");
  });

  it("detects bun", () => {
    expect(detectPackageManager("bun/1.1.0 npm/? node/v22.0.0")).toBe("bun");
  });

  it("falls back to npm", () => {
    expect(detectPackageManager("npm/10.0.0 node/v22.0.0")).toBe("npm");
    // Passing undefined falls back to process.env.npm_config_user_agent,
    // which is set when the test suite itself runs under pnpm/yarn/bun.
    vi.stubEnv("npm_config_user_agent", "");
    try {
      expect(detectPackageManager(undefined)).toBe("npm");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
