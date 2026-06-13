import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "@/cli/index";

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covara-entry-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isMainModule (CLI entry detection)", () => {
  it("returns true when invoked through a bin symlink (npx / global install)", () => {
    const dir = makeTempDir();
    const realFile = path.join(dir, "index.js");
    fs.writeFileSync(realFile, "// cli\n");
    // Mimic node_modules/.bin/covara -> ../covara/dist/cli/index.js
    const binLink = path.join(dir, "covara-bin");
    fs.symlinkSync(realFile, binLink);

    const metaUrl = pathToFileURL(realFile).href;
    expect(isMainModule(metaUrl, binLink)).toBe(true);
  });

  it("returns true when invoked by its real path", () => {
    const dir = makeTempDir();
    const realFile = path.join(dir, "index.js");
    fs.writeFileSync(realFile, "// cli\n");
    expect(isMainModule(pathToFileURL(realFile).href, realFile)).toBe(true);
  });

  it("returns false when a different module is the entry point (e.g. imported in tests)", () => {
    const dir = makeTempDir();
    const realFile = path.join(dir, "index.js");
    const other = path.join(dir, "runner.js");
    fs.writeFileSync(realFile, "// cli\n");
    fs.writeFileSync(other, "// runner\n");
    expect(isMainModule(pathToFileURL(realFile).href, other)).toBe(false);
  });

  it("returns false when there is no argv[1]", () => {
    expect(isMainModule(pathToFileURL("/x/index.js").href, undefined)).toBe(false);
  });
});
