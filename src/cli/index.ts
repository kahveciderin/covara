#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scaffoldProject,
  detectPackageManager,
  installDependencies,
  renderNextSteps,
} from "./create.js";
import {
  TEMPLATES,
  DATABASES,
  type DbName,
  type ScaffoldOptions,
  type TemplateName,
} from "./options.js";
import { generateResource, generateMigration } from "./generate.js";

const HELP = `concave - scaffolding CLI for the Concave framework

Usage:
  concave create <app-name> [options]
  concave generate resource <name>
  concave generate migration [-- drizzle-kit args]
  concave help
  concave --version

Commands:
  create <app-name>           Scaffold a new Concave project
  generate resource <name>    Scaffold a Drizzle table + registration snippet
  generate migration          Generate a migration via drizzle-kit

Options for create:
  --template <node|cloudflare>   Deployment target (default: node)
  --db <sqlite|postgres>         Database (default: sqlite)
  --no-install                   Skip installing dependencies
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
        if (pkg.name === "@kahveciderin/concave" && pkg.version) {
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
  install: boolean;
}

const parseCreateArgs = (args: string[]): ParsedCreateArgs => {
  let name: string | undefined;
  let template: TemplateName = "node";
  let db: DbName = "sqlite";
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
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option "${arg}"`);
    } else if (name === undefined) {
      name = arg;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }

  if (name === undefined) {
    throw new Error("missing <app-name> (usage: concave create <app-name>)");
  }

  return { name, template, db, install };
};

const runCreate = (args: string[]): number => {
  const parsed = parseCreateArgs(args);
  const options: ScaffoldOptions = {
    name: parsed.name,
    template: parsed.template,
    db: parsed.db,
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
      throw new Error("missing <name> (usage: concave generate resource <name>)");
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

export const runCli = (argv: string[]): number => {
  const [command, ...rest] = argv;

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

  console.error(`error: unknown command "${command}"\n`);
  console.log(HELP);
  return 1;
};

try {
  process.exitCode = runCli(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
