import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  resolveProfile,
  dialectFromUrl,
} from "@/cli/config";

describe("CLI config + profiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("infers dialect from url scheme", () => {
    expect(dialectFromUrl("postgres://h/db")).toBe("postgres");
    expect(dialectFromUrl("postgresql://h/db")).toBe("postgres");
    expect(dialectFromUrl("file:./dev.db")).toBe("sqlite");
    expect(dialectFromUrl("libsql://x.turso.io")).toBe("sqlite");
  });

  it("round-trips config", () => {
    saveConfig(dir, { active: "local", profiles: { local: { dialect: "sqlite", url: "file:x.db" } } });
    const cfg = loadConfig(dir);
    expect(cfg.active).toBe("local");
    expect(cfg.profiles.local.url).toBe("file:x.db");
  });

  it("returns empty profiles when no config exists", () => {
    expect(loadConfig(dir)).toEqual({ profiles: {} });
  });

  it("resolves the active profile", () => {
    saveConfig(dir, { active: "prod", profiles: { prod: { dialect: "postgres", url: "postgres://h/db" } } });
    const p = resolveProfile(dir);
    expect(p.name).toBe("prod");
    expect(p.dialect).toBe("postgres");
  });

  it("honors an explicit --profile override", () => {
    saveConfig(dir, {
      active: "prod",
      profiles: {
        prod: { dialect: "postgres", url: "postgres://h/db" },
        staging: { dialect: "sqlite", url: "file:s.db" },
      },
    });
    expect(resolveProfile(dir, { profile: "staging" }).name).toBe("staging");
  });

  it("throws on an unknown profile name", () => {
    saveConfig(dir, { profiles: { local: { dialect: "sqlite", url: "file:x.db" } } });
    expect(() => resolveProfile(dir, { profile: "ghost" })).toThrow(/unknown profile/);
  });

  it("falls back to an inline --url", () => {
    const p = resolveProfile(dir, { url: "postgres://h/db" });
    expect(p.name).toBe("inline");
    expect(p.dialect).toBe("postgres");
  });

  it("synthesizes a local profile from DB_FILE_NAME", () => {
    const p = resolveProfile(dir, { env: { DB_FILE_NAME: "dev.db" } as NodeJS.ProcessEnv });
    expect(p.name).toBe("local");
    expect(p.dialect).toBe("sqlite");
    expect(p.url).toBe("file:dev.db");
  });

  it("synthesizes from DATABASE_URL", () => {
    const p = resolveProfile(dir, { env: { DATABASE_URL: "postgres://h/db" } as NodeJS.ProcessEnv });
    expect(p.dialect).toBe("postgres");
  });

  it("throws when nothing is configured", () => {
    expect(() => resolveProfile(dir, { env: {} as NodeJS.ProcessEnv })).toThrow(/no database profile/);
  });
});
