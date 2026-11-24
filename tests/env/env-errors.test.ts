import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createEnv, envVariable, EnvValidationError } from "@/env";

const SECRET = "sk-live-9f8e7d6c5b4a";

const thrown = (fn: () => unknown): EnvValidationError => {
  try {
    fn();
  } catch (error) {
    return error as EnvValidationError;
  }
  throw new Error("expected a throw");
};

describe("createEnv errors", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ["A", "B", "C", "MODE", "JSON_CFG", "DB_URL", "DB_POOL"]) delete process.env[key];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reports every failing variable in one error", () => {
    process.env.B = "short";
    process.env.DB_POOL = "lots";
    const error = thrown(() =>
      createEnv({
        A: z.string(),
        B: z.string().min(10),
        C: z.string().default("ok"),
        DB: { URL: z.string(), POOL: z.coerce.number().int() },
      })
    );
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error.issues.map((i) => i.key)).toEqual(["A", "B", "DB_URL", "DB_POOL"]);
    for (const key of ["A", "B", "DB_URL", "DB_POOL"]) expect(error.message).toContain(`${key}: `);
    expect(error.issues[0].message).toBe("required (not set)");
  });

  it("keeps the old prefix for a single failure", () => {
    expect(() => createEnv({ A: z.string() })).toThrow("Environment variable validation error for A");
  });

  it("never echoes the value when zod puts it in the message", () => {
    process.env.MODE = SECRET;
    const error = thrown(() =>
      createEnv({
        MODE: z.string().superRefine((v, ctx) => ctx.addIssue({ code: "custom", message: `Invalid enum value, received '${v}'` })),
      })
    );
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("MODE: ");
    expect(JSON.stringify(error.issues)).not.toContain(SECRET);
  });

  it("never echoes the value when a transform throws", () => {
    process.env.JSON_CFG = `${SECRET}{`;
    const error = thrown(() => createEnv({ JSON_CFG: z.string().transform((v) => JSON.parse(v)) }));
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("JSON_CFG: ");
    expect(error.cause).toBeUndefined();
  });

  it("names the rule for zod's own messages", () => {
    process.env.MODE = SECRET;
    const error = thrown(() => createEnv({ MODE: z.enum(["development", "production"]) }));
    expect(error.message).toContain("MODE: ");
    expect(error.message).toContain("development");
    expect(error.message).not.toContain(SECRET);
  });

  it("envVariable does not echo the value either", () => {
    const error = thrown(() =>
      envVariable(SECRET, z.string().refine(() => false, { message: `bad ${SECRET}` }))
    );
    expect(error.message).toContain("Environment variable validation error");
    expect(error.message).not.toContain(SECRET);
  });

  it("envVariable reports a throwing transform without the value", () => {
    const error = thrown(() => envVariable(`${SECRET}{`, z.string().transform((v) => JSON.parse(v))));
    expect(error.message).not.toContain(SECRET);
  });
});
