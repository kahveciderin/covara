import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateAppName, type ScaffoldOptions } from "./options.js";
import { buildProjectFiles } from "./templates/index.js";

export interface ScaffoldResult {
  targetDir: string;
  files: string[];
}

export const scaffoldProject = (
  options: ScaffoldOptions,
  targetDir: string
): ScaffoldResult => {
  const nameError = validateAppName(options.name);
  if (nameError) {
    throw new Error(nameError);
  }

  if (fs.existsSync(targetDir)) {
    if (!fs.statSync(targetDir).isDirectory()) {
      throw new Error(`${targetDir} exists and is not a directory`);
    }
    if (fs.readdirSync(targetDir).length > 0) {
      throw new Error(`directory ${targetDir} is not empty, refusing to overwrite`);
    }
  }

  const files = buildProjectFiles(options);
  const written: string[] = [];

  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    written.push(relPath);
  }

  return { targetDir, files: written.sort() };
};

export const detectPackageManager = (
  userAgent: string | undefined = process.env.npm_config_user_agent
): string => {
  if (!userAgent) return "npm";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun")) return "bun";
  return "npm";
};

export const installDependencies = (
  targetDir: string,
  packageManager: string
): boolean => {
  const result = spawnSync(packageManager, ["install"], {
    cwd: targetDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status === 0;
};

export const renderNextSteps = (
  options: ScaffoldOptions,
  packageManager: string,
  installed: boolean
): string => {
  const run = (script: string): string =>
    packageManager === "npm" ? `npm run ${script}` : `${packageManager} ${script}`;

  const steps: string[] = [`cd ${options.name}`];

  if (!installed) {
    steps.push(`${packageManager} install`);
  }

  if (options.template === "node") {
    steps.push("cp .env.example .env");
    // covara dev auto-applies additive schema changes on start — no db:push.
    steps.push(run("dev"));
  } else if (options.db === "sqlite") {
    steps.push(`wrangler d1 create ${options.name}-db   # then copy database_id into wrangler.toml`);
    steps.push(run("db:generate"));
    steps.push(`wrangler d1 migrations apply ${options.name}-db --local`);
    steps.push(run("dev"));
  } else {
    steps.push(`echo 'DATABASE_URL=postgres://...' > .dev.vars`);
    steps.push(run("db:push"));
    steps.push(run("dev"));
  }

  return [
    "",
    `Created ${options.name} (template: ${options.template}, db: ${options.db})`,
    "",
    "Next steps:",
    ...steps.map((step) => `  ${step}`),
    "",
  ].join("\n");
};
