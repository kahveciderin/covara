import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveProfile, resolveSchemaPath } from "../config.js";
import { pushSchema, findTsx } from "../drizzle-bridge.js";
import { parseArgs, getString, getBool } from "../args.js";
import { generateTypes } from "../../client/typegen.js";

const ENTRY_CANDIDATES = [
  "src/main.ts",
  "src/index.ts",
  "src/server.ts",
  "main.ts",
  "index.ts",
];

const findEntry = (cwd: string, explicit?: string): string | null => {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    return fs.existsSync(p) ? p : null;
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const p = path.resolve(cwd, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

export const devCommand = async (args: string[]): Promise<number> => {
  const parsed = parseArgs(args, { booleans: ["no-server"] });
  const cwd = process.cwd();

  let profile;
  let schemaPath: string;
  try {
    profile = resolveProfile(cwd, {
      profile: getString(parsed, "profile"),
      url: getString(parsed, "url"),
    });
    schemaPath = resolveSchemaPath(cwd);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const serverUrl =
    getString(parsed, "server-url") ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const typesOut = getString(parsed, "types-out");
  const runServer = !getBool(parsed, "no-server") && parsed.flags.server !== false;

  let serverChild: ChildProcess | null = null;
  if (runServer) {
    const entry = findEntry(cwd, parsed.positionals[0] ?? getString(parsed, "entry"));
    if (!entry) {
      console.error("error: could not find a server entry — pass `covara dev <entry>`");
      return 1;
    }
    const { cmd, prefix } = findTsx(cwd);
    console.log(`[covara] starting server: tsx watch ${path.relative(cwd, entry)}`);
    serverChild = spawn(cmd, [...prefix, "watch", entry], { cwd, stdio: "inherit" });
  }

  let syncing = false;
  let pending = false;
  const sync = async (): Promise<void> => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    try {
      const result = await pushSchema(cwd, profile, schemaPath);
      if (!result.applied) {
        console.log(
          "[covara] schema: destructive change detected — not auto-applied. Run `covara push --force`:"
        );
        for (const stmt of result.statementsToExecute) console.log(`   ${stmt}`);
      } else if (result.statementsToExecute.length > 0) {
        console.log(`[covara] schema: applied ${result.statementsToExecute.length} change(s)`);
        if (typesOut) {
          try {
            const generated = await generateTypes({
              serverUrl,
              output: "typescript",
              includeClient: true,
            });
            fs.writeFileSync(path.resolve(cwd, typesOut), generated.code);
            console.log(`[covara] types: regenerated ${typesOut}`);
          } catch {
            console.log("[covara] types: server not ready yet, skipping regen");
          }
        }
      }
    } catch (e) {
      console.error(`[covara] schema error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      syncing = false;
      if (pending) {
        pending = false;
        void sync();
      }
    }
  };

  await sync();

  let timer: NodeJS.Timeout | undefined;
  try {
    fs.watch(schemaPath, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), 300);
    });
  } catch {
    console.error(`[covara] could not watch ${schemaPath}`);
  }
  console.log(`[covara] watching ${path.relative(cwd, schemaPath)} for schema changes`);

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      if (serverChild) serverChild.kill();
      resolve(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (serverChild) serverChild.on("close", () => resolve(0));
  });
};
