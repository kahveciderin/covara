import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ResolvedProfile } from "./config.js";

const workerPath = (): string => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(dir, "worker.js");
  return fs.existsSync(js) ? js : path.join(dir, "worker.ts");
};

export const findTsx = (cwd: string): { cmd: string; prefix: string[] } => {
  const bin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const local = path.join(cwd, "node_modules", ".bin", bin);
  if (fs.existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: "npx", prefix: ["--yes", "tsx"] };
};

const baseJob = (profile: ResolvedProfile, schemaPath: string) => ({
  dialect: profile.dialect,
  url: profile.url,
  authToken: profile.authToken,
  schemaPath,
});

const runWorker = (cwd: string, job: Record<string, unknown>): Promise<any> => {
  const { cmd, prefix } = findTsx(cwd);
  const resultFile = path.join(os.tmpdir(), `covara-result-${crypto.randomUUID()}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, workerPath()], {
      cwd,
      env: {
        ...process.env,
        COVARA_JOB: JSON.stringify(job),
        COVARA_RESULT_FILE: resultFile,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!fs.existsSync(resultFile)) {
        reject(new Error(`schema worker produced no result (exit ${code})`));
        return;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed);
      } catch (e) {
        reject(e);
      } finally {
        fs.rmSync(resultFile, { force: true });
      }
    });
  });
};

export interface PushResult {
  hasDataLoss: boolean;
  warnings: string[];
  statementsToExecute: string[];
  applied: boolean;
}

const DESTRUCTIVE = /\b(DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE\s+.*\bDROP\b)/i;

export const isDestructive = (result: {
  hasDataLoss: boolean;
  statementsToExecute: string[];
}): boolean =>
  result.hasDataLoss ||
  result.statementsToExecute.some((s) => DESTRUCTIVE.test(s));

export const pushSchema = (
  cwd: string,
  profile: ResolvedProfile,
  schemaPath: string,
  opts: { force?: boolean } = {}
): Promise<PushResult> =>
  runWorker(cwd, { op: "push", ...baseJob(profile, schemaPath), force: !!opts.force }) as Promise<PushResult>;

export const queryData = (
  cwd: string,
  profile: ResolvedProfile,
  schemaPath: string,
  table: string,
  opts: { limit?: number; filter?: string } = {}
): Promise<{ rows: unknown[] }> =>
  runWorker(cwd, {
    op: "data",
    ...baseJob(profile, schemaPath),
    table,
    limit: opts.limit,
    filter: opts.filter,
  }) as Promise<{ rows: unknown[] }>;

export const importRows = (
  cwd: string,
  profile: ResolvedProfile,
  schemaPath: string,
  table: string,
  rows: Record<string, unknown>[]
): Promise<{ inserted: number }> =>
  runWorker(cwd, { op: "import", ...baseJob(profile, schemaPath), table, rows }) as Promise<{
    inserted: number;
  }>;

export const startStudio = (
  cwd: string,
  profile: ResolvedProfile,
  schemaPath: string,
  port?: number
): Promise<number> => {
  const { cmd, prefix } = findTsx(cwd);
  const job = { op: "studio", ...baseJob(profile, schemaPath), port };
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, workerPath()], {
      cwd,
      env: { ...process.env, COVARA_JOB: JSON.stringify(job) },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
};
