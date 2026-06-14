import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pin the generated `covara` dependency to the version of the CLI doing the
// scaffolding — that version is, by definition, published (it's the same package
// the user invoked), so `npm install` always resolves. Falls back to the literal
// below only if the CLI's own package.json can't be located.
const FALLBACK_COVARA_VERSION = "^0.9.0";

export const resolveCovaraVersion = (): string => {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "covara" && pkg.version) {
          return `^${pkg.version}`;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to the fallback
  }
  return FALLBACK_COVARA_VERSION;
};

export const VERSIONS = {
  covara: resolveCovaraVersion(),
  hono: "^4.12.25",
  honoNodeServer: "^1.13.7",
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
  react: "^18.3.1",
  reactDom: "^18.3.1",
  typesReact: "^18.3.12",
  typesReactDom: "^18.3.1",
  viteReactPlugin: "^4.3.4",
  vite: "^6.0.5",
} as const;
