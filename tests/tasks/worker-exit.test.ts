import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

const secondsToExit = (mode: string) =>
  new Promise<number | null>((done) => {
    const started = Date.now();
    const child = spawn(resolve(root, "node_modules/.bin/tsx"), ["tests/fixtures/worker-exit.ts", mode], { cwd: root });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, 8000);
    child.on("exit", () => {
      clearTimeout(timer);
      done((Date.now() - started) / 1000);
    });
  });

describe("a stopped worker lets the process exit", () => {
  it.each(["done", "abort", "hang"])("after a task that %s", async (mode) => {
    expect(await secondsToExit(mode)).not.toBeNull();
  }, 15_000);
});
