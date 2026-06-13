import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Job {
  op: "push" | "data" | "studio" | "import";
  dialect: "sqlite" | "postgres";
  url: string;
  authToken?: string;
  schemaPath: string;
  force?: boolean;
  table?: string;
  filter?: string;
  limit?: number;
  port?: number;
  rows?: Record<string, unknown>[];
}

const emit = (obj: unknown): void => {
  const file = process.env.COVARA_RESULT_FILE;
  if (file) fs.writeFileSync(file, JSON.stringify(obj));
  else process.stdout.write(JSON.stringify(obj) + "\n");
};

const buildDb = async (job: Job): Promise<unknown> => {
  if (job.dialect === "sqlite") {
    const { drizzle } = await import("drizzle-orm/libsql");
    const { createClient } = await import("@libsql/client");
    return drizzle(createClient({ url: job.url, authToken: job.authToken }));
  }
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgresModule = "postgres";
  const postgres = (await import(postgresModule)).default;
  return drizzle(postgres(job.url));
};

const loadSchema = async (schemaPath: string): Promise<Record<string, unknown>> => {
  const abs = path.isAbsolute(schemaPath) ? schemaPath : path.resolve(process.cwd(), schemaPath);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
};

const findTable = (imports: Record<string, unknown>, name: string): unknown => {
  if (imports[name]) return imports[name];
  for (const value of Object.values(imports)) {
    const sym = value as Record<symbol, unknown> | null;
    if (sym && typeof sym === "object") {
      for (const s of Object.getOwnPropertySymbols(sym)) {
        if (String(s).includes("Name") && sym[s] === name) return value;
      }
    }
  }
  return undefined;
};

const runPush = async (job: Job): Promise<void> => {
  const imports = await loadSchema(job.schemaPath);
  const db = await buildDb(job);
  const api = await import("drizzle-kit/api");
  const push =
    job.dialect === "sqlite" ? (api as any).pushSQLiteSchema : (api as any).pushSchema;
  const result = await push(imports, db);
  const applied = !result.hasDataLoss || job.force === true;
  if (applied) await result.apply();
  emit({
    hasDataLoss: result.hasDataLoss,
    warnings: result.warnings ?? [],
    statementsToExecute: result.statementsToExecute ?? [],
    applied,
  });
};

const runData = async (job: Job): Promise<void> => {
  const imports = await loadSchema(job.schemaPath);
  const table = findTable(imports, job.table ?? "");
  if (!table) {
    emit({ error: `table not found in schema: ${job.table}` });
    return;
  }
  const db = (await buildDb(job)) as {
    select: () => { from: (t: unknown) => { limit: (n: number) => Promise<unknown[]> } };
  };
  const rows = await db.select().from(table).limit(Math.min(job.limit ?? 50, 1000));
  emit({ rows });
};

const runImport = async (job: Job): Promise<void> => {
  const imports = await loadSchema(job.schemaPath);
  const table = findTable(imports, job.table ?? "");
  if (!table) {
    emit({ error: `table not found in schema: ${job.table}` });
    return;
  }
  const rows = job.rows ?? [];
  const db = (await buildDb(job)) as {
    insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
  };
  let inserted = 0;
  for (const row of rows) {
    await db.insert(table).values(row);
    inserted++;
  }
  emit({ inserted });
};

const runStudio = async (job: Job): Promise<void> => {
  const imports = await loadSchema(job.schemaPath);
  const api = await import("drizzle-kit/api");
  const start =
    job.dialect === "sqlite"
      ? (api as any).startStudioSQLiteServer
      : (api as any).startStudioPostgresServer;
  const credentials =
    job.dialect === "sqlite"
      ? { url: job.url, authToken: job.authToken }
      : { url: job.url };
  await start(imports, credentials, { port: job.port ?? 4983 });
};

const main = async (): Promise<void> => {
  const raw = process.env.COVARA_JOB;
  if (!raw) {
    emit({ error: "missing COVARA_JOB" });
    process.exitCode = 1;
    return;
  }
  const job = JSON.parse(raw) as Job;
  try {
    if (job.op === "push") await runPush(job);
    else if (job.op === "data") await runData(job);
    else if (job.op === "import") await runImport(job);
    else if (job.op === "studio") await runStudio(job);
    else emit({ error: `unknown op: ${job.op}` });
  } catch (e) {
    emit({ error: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  }
};

void main();
