import fs from "node:fs";
import path from "node:path";

export type Dialect = "sqlite" | "postgres";

export interface Profile {
  dialect: Dialect;
  url: string;
  authToken?: string;
}

export interface CovaraConfig {
  schema?: string;
  active?: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedProfile extends Profile {
  name: string;
}

const CONFIG_DIR = ".covara";
const CONFIG_FILE = "config.json";

const DEFAULT_SCHEMA_PATHS = [
  "src/db/schema.ts",
  "src/schema.ts",
  "db/schema.ts",
  "schema.ts",
];

export const configPath = (cwd: string): string =>
  path.join(cwd, CONFIG_DIR, CONFIG_FILE);

export const loadConfig = (cwd: string): CovaraConfig => {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) return { profiles: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CovaraConfig;
    return { ...parsed, profiles: parsed.profiles ?? {} };
  } catch {
    return { profiles: {} };
  }
};

export const saveConfig = (cwd: string, config: CovaraConfig): void => {
  const dir = path.join(cwd, CONFIG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(cwd), JSON.stringify(config, null, 2) + "\n");
};

export const dialectFromUrl = (url: string): Dialect => {
  if (/^postgres(ql)?:\/\//.test(url)) return "postgres";
  return "sqlite";
};

const synthFromEnv = (env: NodeJS.ProcessEnv): Profile | null => {
  const dbUrl = env.DATABASE_URL;
  if (dbUrl) {
    return { dialect: dialectFromUrl(dbUrl), url: dbUrl, authToken: env.DATABASE_AUTH_TOKEN };
  }
  const file = env.DB_FILE_NAME;
  if (file) {
    return { dialect: "sqlite", url: file.startsWith("file:") ? file : `file:${file}` };
  }
  return null;
};

export interface ResolveOptions {
  profile?: string;
  url?: string;
  dialect?: Dialect;
  authToken?: string;
  env?: NodeJS.ProcessEnv;
}

export const resolveProfile = (
  cwd: string,
  opts: ResolveOptions = {}
): ResolvedProfile => {
  const env = opts.env ?? process.env;

  if (opts.url) {
    return {
      name: "inline",
      dialect: opts.dialect ?? dialectFromUrl(opts.url),
      url: opts.url,
      authToken: opts.authToken,
    };
  }

  const config = loadConfig(cwd);
  const name = opts.profile ?? config.active;

  if (name) {
    const profile = config.profiles[name];
    if (!profile) {
      const known = Object.keys(config.profiles).join(", ") || "(none)";
      throw new Error(`unknown profile "${name}" (known: ${known})`);
    }
    return { name, ...profile };
  }

  const synth = synthFromEnv(env);
  if (synth) return { name: "local", ...synth };

  throw new Error(
    "no database profile configured — run `covara db add <name> --url <url>` or set DATABASE_URL/DB_FILE_NAME"
  );
};

export const resolveSchemaPath = (cwd: string, config?: CovaraConfig): string => {
  const cfg = config ?? loadConfig(cwd);
  if (cfg.schema) return path.resolve(cwd, cfg.schema);
  for (const candidate of DEFAULT_SCHEMA_PATHS) {
    const full = path.resolve(cwd, candidate);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    "could not locate the Drizzle schema — set \"schema\" in .covara/config.json"
  );
};
