#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  scaffoldProject,
  detectPackageManager,
  installDependencies,
  renderNextSteps,
} from "./create.js";
import {
  TEMPLATES,
  DATABASES,
  FRONTENDS,
  type DbName,
  type FrontendName,
  type ScaffoldOptions,
  type TemplateName,
} from "./options.js";
import { generateResource, generateMigration } from "./generate.js";
import { dbCommand } from "./commands/db.js";
import { pushCommand } from "./commands/push.js";
import { migrateCommand } from "./commands/migrate.js";
import { studioCommand } from "./commands/studio.js";
import { devCommand } from "./commands/dev.js";
import { dataCommand } from "./commands/data.js";
import { typesCommand } from "./commands/types.js";
import { envCommand } from "./commands/env.js";
import { runCommand } from "./commands/run.js";
import { seedCommand } from "./commands/seed.js";
import { exportCommand, importCommand } from "./commands/import-export.js";
import { loadDotEnv } from "./dotenv.js";

export type CommandHandler = (args: string[]) => number | Promise<number>;
const COMMANDS: Record<string, CommandHandler> = {
  db: dbCommand,
  push: pushCommand,
  migrate: migrateCommand,
  studio: studioCommand,
  dev: devCommand,
  data: dataCommand,
  types: typesCommand,
  env: envCommand,
  run: runCommand,
  seed: seedCommand,
  export: exportCommand,
  import: importCommand,
};

const HELP = `covara - CLI for the Covara framework

Usage:
  covara <command> [options]

Project:
  create <app-name>           Scaffold a new Covara project
  generate resource <name>    Scaffold a Drizzle table + registration snippet
  generate migration          Generate a migration file (drizzle-kit)

Develop:
  dev [entry]                 Watch schema → auto-apply additive changes +
                              regenerate types; runs the server (tsx watch)
                              flags: --types-out <path> --server-url <url>
                                     --profile <name> --no-server

Schema & database:
  push                        Apply schema to the DB (additive auto;
                              prompts on destructive; --force to apply)
  migrate                     Apply migration files (drizzle-kit migrate)
  studio                      Open Drizzle Studio for the active profile
  db <list|use|add|current|remove>   Manage connection profiles

Data:
  data <table> [--limit n]    Browse rows
  export <table> [--out f --format json|jsonl|csv]
  import <table> --file f      Import rows (json|jsonl|csv)
  seed [file]                 Run a seed script (tsx)

Other:
  run <resource>.<rpc> [json] Invoke an RPC on a running server
  types [--out f]             Generate the typed client from a running server
  env <list|get|set|remove>   Manage the project .env

Common options:
  --profile <name>            DB profile (default: active / env)
  --url <url>                 Inline DB url (overrides profile)

  covara help | --version
`;

const readVersion = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "covara" && pkg.version) {
          return pkg.version;
        }
      } catch {
        return "unknown";
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
};

interface ParsedCreateArgs {
  name: string;
  template: TemplateName;
  db: DbName;
  frontend: FrontendName;
  install: boolean;
}

const parseCreateArgs = (args: string[]): ParsedCreateArgs => {
  let name: string | undefined;
  let template: TemplateName = "node";
  let db: DbName = "sqlite";
  let frontend: FrontendName = "none";
  let install = true;

  const readValue = (flag: string, inline: string | undefined, rest: string[]): string => {
    if (inline !== undefined) return inline;
    const next = rest.shift();
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return next;
  };

  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "--no-install") {
      install = false;
    } else if (arg === "--template" || arg.startsWith("--template=")) {
      const value = readValue("--template", arg.includes("=") ? arg.split("=").slice(1).join("=") : undefined, rest);
      if (!TEMPLATES.includes(value as TemplateName)) {
        throw new Error(`invalid template "${value}" (expected: ${TEMPLATES.join(" | ")})`);
      }
      template = value as TemplateName;
    } else if (arg === "--db" || arg.startsWith("--db=")) {
      const value = readValue("--db", arg.includes("=") ? arg.split("=").slice(1).join("=") : undefined, rest);
      if (!DATABASES.includes(value as DbName)) {
        throw new Error(`invalid db "${value}" (expected: ${DATABASES.join(" | ")})`);
      }
      db = value as DbName;
    } else if (arg === "--frontend" || arg.startsWith("--frontend=")) {
      const value = readValue("--frontend", arg.includes("=") ? arg.split("=").slice(1).join("=") : undefined, rest);
      if (!FRONTENDS.includes(value as FrontendName)) {
        throw new Error(`invalid frontend "${value}" (expected: ${FRONTENDS.join(" | ")})`);
      }
      frontend = value as FrontendName;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}"`);
    } else if (name === undefined) {
      name = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }

  if (name === undefined) {
    throw new Error("missing <app-name> (usage: covara create <app-name>)");
  }

  return { name, template, db, frontend, install };
};

const runCreate = (args: string[]): number => {
  const parsed = parseCreateArgs(args);
  const options: ScaffoldOptions = {
    name: parsed.name,
    template: parsed.template,
    db: parsed.db,
    frontend: parsed.frontend,
  };
  const targetDir = path.resolve(process.cwd(), parsed.name);

  const result = scaffoldProject(options, targetDir);
  for (const file of result.files) {
    console.log(`  created ${path.join(parsed.name, file)}`);
  }

  const packageManager = detectPackageManager();
  let installed = false;
  if (parsed.install) {
    console.log(`\nInstalling dependencies with ${packageManager}...`);
    try {
      installed = installDependencies(targetDir, packageManager);
    } catch {
      installed = false;
    }
    if (!installed) {
      console.warn(
        `warning: ${packageManager} install failed, run it manually inside ${parsed.name}`
      );
    }
  }

  console.log(renderNextSteps(options, packageManager, installed));
  return 0;
};

const runGenerate = (args: string[]): number => {
  const [kind, ...rest] = args;

  if (!kind) {
    console.error("error: missing generate target (resource | migration)\n");
    console.log(HELP);
    return 1;
  }

  if (kind === "resource") {
    const name = rest.find((arg) => !arg.startsWith("-"));
    if (!name) {
      throw new Error("missing <name> (usage: covara generate resource <name>)");
    }
    const result = generateResource(name, process.cwd());
    for (const file of result.files) {
      console.log(`  created ${file}`);
    }
    console.log("\nRegister the resource:\n");
    console.log(result.registration);
    console.log("");
    return 0;
  }

  if (kind === "migration") {
    const sep = rest.indexOf("--");
    const extra = sep === -1 ? rest : rest.slice(sep + 1);
    const result = generateMigration(process.cwd(), extra);
    return result.status;
  }

  console.error(`error: unknown generate target "${kind}"\n`);
  console.log(HELP);
  return 1;
};

export const runCli = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;

  loadDotEnv(process.cwd());

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return command ? 0 : 1;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(readVersion());
    return 0;
  }

  if (command === "create") {
    return runCreate(rest);
  }

  if (command === "generate" || command === "g") {
    return runGenerate(rest);
  }

  const handler = COMMANDS[command];
  if (handler) {
    return handler(rest);
  }

  console.error(`error: unknown command "${command}"\n`);
  console.log(HELP);
  return 1;
};

// Whether this module is the process entry point. Compares real (symlink-
// resolved) paths: when installed, the bin runs through a symlink
// (node_modules/.bin/covara -> ../covara/dist/cli/index.js), so a raw
// import.meta.url vs argv[1] comparison would never match and the CLI would
// silently no-op under `npx`/global installs.
export const isMainModule = (
  metaUrl: string,
  argv1: string | undefined
): boolean => {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(argv1);
  } catch {
    // Fall back to a direct URL comparison if realpath fails (e.g. argv1 is not
    // a real file on disk in some sandboxed runners).
    try {
      return metaUrl === pathToFileURL(argv1).href;
    } catch {
      return false;
    }
  }
};

const invokedDirectly = isMainModule(import.meta.url, process.argv[1]);

if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
