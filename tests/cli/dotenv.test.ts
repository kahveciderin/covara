import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv, loadDotEnv } from "@/cli/dotenv";

describe("CLI dotenv loader", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-dotenv-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses key=value lines, skipping comments and blanks", () => {
    const map = parseEnv("# comment\nPORT=3000\n\nDB_FILE_NAME=file:./dev.db\n");
    expect(map).toEqual({ PORT: "3000", DB_FILE_NAME: "file:./dev.db" });
  });

  it("strips surrounding single or double quotes from values", () => {
    const map = parseEnv(`A="quoted"\nB='single'\nC=bare`);
    expect(map).toEqual({ A: "quoted", B: "single", C: "bare" });
  });

  it("keeps '=' that appear inside the value", () => {
    const map = parseEnv("DATABASE_URL=postgres://u:p@h/db?x=1");
    expect(map.DATABASE_URL).toBe("postgres://u:p@h/db?x=1");
  });

  it("loads .env into the target env object", () => {
    fs.writeFileSync(path.join(dir, ".env"), "DB_FILE_NAME=file:./dev.db\nPORT=4000\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv(dir, env);
    expect(env.DB_FILE_NAME).toBe("file:./dev.db");
    expect(env.PORT).toBe("4000");
  });

  it("does not override variables already set in the environment", () => {
    fs.writeFileSync(path.join(dir, ".env"), "PORT=4000\n");
    const env: NodeJS.ProcessEnv = { PORT: "9999" };
    loadDotEnv(dir, env);
    expect(env.PORT).toBe("9999");
  });

  it("is a no-op when no .env file exists", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadDotEnv(dir, env)).not.toThrow();
    expect(env).toEqual({});
  });
});
