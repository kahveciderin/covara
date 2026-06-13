import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findTsx } from "../drizzle-bridge.js";

const SEED_CANDIDATES = [
  "src/db/seed.ts",
  "src/seed.ts",
  "seed.ts",
  "scripts/seed.ts",
];

export const seedCommand = (args: string[]): number => {
  const cwd = process.cwd();
  const explicit = args.find((a) => !a.startsWith("-"));
  let file = explicit ? path.resolve(cwd, explicit) : null;
  if (!file) {
    for (const candidate of SEED_CANDIDATES) {
      const p = path.resolve(cwd, candidate);
      if (fs.existsSync(p)) {
        file = p;
        break;
      }
    }
  }
  if (!file || !fs.existsSync(file)) {
    console.error("error: no seed script found — pass `covara seed <file>`");
    return 1;
  }
  const { cmd, prefix } = findTsx(cwd);
  const result = spawnSync(cmd, [...prefix, file], { cwd, stdio: "inherit" });
  return result.status ?? 1;
};
