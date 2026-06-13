import { spawnSync } from "node:child_process";

export const migrateCommand = (args: string[]): number => {
  const sep = args.indexOf("--");
  const extra = sep === -1 ? args : args.slice(sep + 1);
  const cmd = ["drizzle-kit", "migrate", ...extra];
  const result = spawnSync("npx", cmd, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  return result.status ?? 1;
};
