import { describe, it, expect } from "vitest";
import { parseArgs, getString, getBool } from "@/cli/args";

describe("parseArgs", () => {
  it("collects positionals", () => {
    const r = parseArgs(["resource", "todos"]);
    expect(r.positionals).toEqual(["resource", "todos"]);
  });

  it("parses --flag value and --flag=value", () => {
    const r = parseArgs(["--url", "file:x.db", "--dialect=postgres"]);
    expect(getString(r, "url")).toBe("file:x.db");
    expect(getString(r, "dialect")).toBe("postgres");
  });

  it("treats a declared boolean as true and consumes no value", () => {
    const r = parseArgs(["--force", "todos"], { booleans: ["force"] });
    expect(getBool(r, "force")).toBe(true);
    expect(r.positionals).toEqual(["todos"]);
  });

  it("treats --flag with no following value as a boolean", () => {
    const r = parseArgs(["--watch"]);
    expect(getBool(r, "watch")).toBe(true);
  });

  it("supports --no-flag negation", () => {
    const r = parseArgs(["--no-install"]);
    expect(r.flags.install).toBe(false);
  });

  it("resolves aliases", () => {
    const r = parseArgs(["-t", "tok"], { aliases: { t: "token" } });
    expect(getString(r, "token")).toBe("tok");
  });

  it("captures passthrough args after --", () => {
    const r = parseArgs(["generate", "--", "--custom", "x"]);
    expect(r.positionals).toEqual(["generate"]);
    expect(r.passthrough).toEqual(["--custom", "x"]);
  });
});
