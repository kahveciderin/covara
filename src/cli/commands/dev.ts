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

export interface ChildHandle {
  kill: (signal?: NodeJS.Signals | number) => void;
  readonly exitCode: number | null;
  onClose: (cb: () => void) => void;
}

export interface DevShutdownOptions {
  child?: ChildHandle | null;
  cleanup: () => void;
  exit: (code: number) => void;
  schedule: (fn: () => void, ms: number) => () => void;
  forceKillMs?: number;
}

// Coordinates a clean shutdown of `covara dev`: forward SIGTERM to the spawned
// server, escalate to SIGKILL if it doesn't exit, and always run `cleanup`
// (close the schema watcher, clear timers) so the process can actually exit.
// A second signal force-kills immediately. Extracted for unit testing because
// real signal handling is awkward to drive in tests.
export const createDevShutdown = (
  opts: DevShutdownOptions
): { onSignal: () => void } => {
  const { child, cleanup, exit, schedule, forceKillMs = 3000 } = opts;
  let stopping = false;
  let cancelForce: (() => void) | undefined;
  let finished = false;

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    cancelForce?.();
    cleanup();
    exit(code);
  };

  if (child) child.onClose(() => finish(0));

  const onSignal = (): void => {
    if (stopping) {
      child?.kill("SIGKILL");
      finish(0);
      return;
    }
    stopping = true;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      cancelForce = schedule(() => {
        child.kill("SIGKILL");
        finish(0);
      }, forceKillMs);
    } else {
      finish(0);
    }
  };

  return { onSignal };
};

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
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(schemaPath, () => {
      clearTimeout(timer);
      timer = setTimeout(() => void sync(), 300);
    });
  } catch {
    console.error(`[covara] could not watch ${schemaPath}`);
  }
  console.log(`[covara] watching ${path.relative(cwd, schemaPath)} for schema changes`);

  const child: ChildHandle | null = serverChild
    ? {
        kill: (signal) => serverChild!.kill(signal as NodeJS.Signals),
        get exitCode() {
          return serverChild!.exitCode;
        },
        onClose: (cb) => serverChild!.on("close", cb),
      }
    : null;

  let onSignal: () => void = () => {};
  const controller = createDevShutdown({
    child,
    cleanup: () => {
      clearTimeout(timer);
      watcher?.close();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
    exit: (code) => process.exit(code),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    },
  });
  onSignal = controller.onSignal;

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return new Promise<number>(() => {
    // Resolves only via process.exit() from the shutdown handler above.
  });
};
