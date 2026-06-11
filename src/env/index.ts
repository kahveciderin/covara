import { z } from "zod";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { readEnv } from "@/server/env";

type ProcessedEnvVarConfig<Public extends boolean> = {
  public?: Public;
};

class ProcessedEnvVar<T, Public extends boolean = boolean> {
  constructor(
    public value: T,
    public config?: ProcessedEnvVarConfig<Public>
  ) {}
}

type JoinWithUnderscore<T extends readonly string[]> = T extends []
  ? ""
  : T extends [infer H extends string]
    ? H
    : T extends [infer H extends string, ...infer R extends string[]]
      ? `${H}_${JoinWithUnderscore<R>}`
      : string;

type PathIsPublic<Path extends readonly string[]> =
  JoinWithUnderscore<Path> extends `PUBLIC_${string}` ? true : false;

type PruneNever<T> = {
  [K in keyof T as T[K] extends never
    ? never
    : T[K] extends Record<string, any>
      ? keyof PruneNever<T[K]> extends never
        ? never
        : K
      : K]: T[K] extends Record<string, any> ? PruneNever<T[K]> : T[K];
};

type PublicEnv<T, Path extends readonly string[] = []> =
  T extends ProcessedEnvVar<infer U, infer P extends boolean>
    ? P extends true
      ? U
      : never
    : T extends z.ZodTypeAny
      ? PathIsPublic<Path> extends true
        ? z.infer<T>
        : never
      : T extends Record<string, any>
        ? PruneNever<{
            [K in keyof T]: PublicEnv<T[K], [...Path, Extract<K, string>]>;
          }>
        : never;

type EnvLeaf = z.ZodTypeAny | ProcessedEnvVar<any, any>;

type EnvSchema = {
  [K: string]: EnvLeaf | EnvSchema;
};

type InferEnv<T> =
  T extends ProcessedEnvVar<infer U>
    ? U
    : T extends z.ZodTypeAny
      ? z.infer<T>
      : T extends Record<string, any>
        ? { [K in keyof T]: InferEnv<T[K]> }
        : never;

const isZodType = (x: any): x is z.ZodTypeAny =>
  !!x && typeof x === "object" && typeof x.safeParse === "function";

const recursivelyParseSchema = <T>(
  s: T,
  path: string[]
): { value: InferEnv<T>; publicPaths: string[][] } => {
  let toProcess: any = s;
  const publicPaths: string[][] = [];

  if (isZodType(toProcess)) {
    const key = path.join("_");
    const parsed = toProcess.safeParse(readEnv(key));
    if (!parsed.success) {
      throw new Error(
        `Environment variable validation error for ${key}: ${parsed.error.message}`
      );
    }
    toProcess = new ProcessedEnvVar(parsed.data, {
      public: key.startsWith("PUBLIC_"),
    });
  }

  if (toProcess instanceof ProcessedEnvVar) {
    const value = toProcess.value as InferEnv<T>;

    return {
      value,
      publicPaths: toProcess.config?.public ? [path] : [],
    };
  }

  const result: Record<string, unknown> = {};
  for (const key in toProcess) {
    const data = recursivelyParseSchema(toProcess[key], [...path, key]);
    result[key] = data.value;
    publicPaths.push(...data.publicPaths);
  }
  return { value: result as InferEnv<T>, publicPaths };
};

export function envVariable<Z extends z.ZodTypeAny>(
  source: string | undefined,
  zodType: Z
): ProcessedEnvVar<z.infer<Z>, false>;

export function envVariable<Z extends z.ZodTypeAny>(
  source: string | undefined,
  zodType: Z,
  config: ProcessedEnvVarConfig<true>
): ProcessedEnvVar<z.infer<Z>, true>;

export function envVariable<Z extends z.ZodTypeAny>(
  source: string | undefined,
  zodType: Z,
  config: ProcessedEnvVarConfig<false>
): ProcessedEnvVar<z.infer<Z>, false>;

export function envVariable<Z extends z.ZodTypeAny, P extends boolean = false>(
  source: string | undefined,
  zodType: Z,
  config?: ProcessedEnvVarConfig<P>
): ProcessedEnvVar<z.infer<Z>> {
  const parsed = zodType.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Environment variable validation error: ${parsed.error.message}`
    );
  }
  return new ProcessedEnvVar(parsed.data, config);
}

const constructPublicEnv = <T>(
  envVars: InferEnv<T>,
  publicPaths: string[][]
): PublicEnv<T> => {
  const publicEnv: PublicEnv<T> = {} as PublicEnv<T>;

  for (const path of publicPaths) {
    let currentSrc: any = envVars;
    let currentDest: any = publicEnv;

    for (let i = 0; i < path.length; i++) {
      const key = path[i];
      if (i === path.length - 1) {
        currentDest[key] = currentSrc[key];
      } else {
        currentDest[key] = currentDest[key] || {};
        currentDest = currentDest[key];
        currentSrc = currentSrc[key];
      }
    }
  }

  return publicEnv;
};

export const createEnv = <S extends EnvSchema>(
  schema: S & { getPublicEnvironmentVariables?: never }
): InferEnv<S> & {
  getPublicEnvironmentVariables: () => PublicEnv<S>;
} => {
  const parsedSchema = recursivelyParseSchema(schema, []);
  const envVars = parsedSchema.value;
  const publicEnv = constructPublicEnv(envVars, parsedSchema.publicPaths);

  return {
    ...(envVars as InferEnv<S>),
    getPublicEnvironmentVariables: () => publicEnv,
  };
};

export interface PublicEnvConfig {
  cacheControl?: string;
  headers?: Record<string, string>;
  exposeSchema?: boolean;
}

interface EnvWithPublicGetter {
  getPublicEnvironmentVariables: () => unknown;
}

export interface EnvSchemaField {
  path: string[];
  type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
}

export interface PublicEnvSchema {
  fields: EnvSchemaField[];
  timestamp: string;
}

const inferValueType = (
  value: unknown
): "string" | "number" | "boolean" | "object" | "array" | "unknown" => {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "unknown";
};

const extractSchemaFromValue = (
  value: unknown,
  currentPath: string[] = []
): EnvSchemaField[] => {
  const fields: EnvSchemaField[] = [];

  if (value === null || value === undefined) {
    return fields;
  }

  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) {
    for (const [key, val] of Object.entries(value)) {
      const newPath = [...currentPath, key];
      if (
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val) &&
        Object.keys(val).length > 0
      ) {
        fields.push(...extractSchemaFromValue(val, newPath));
      } else {
        fields.push({
          path: newPath,
          type: inferValueType(val),
        });
      }
    }
  }

  return fields;
};

const computeETag = (value: unknown): string => {
  const json = JSON.stringify(value);
  const hash = createHash("md5").update(json).digest("hex").slice(0, 16);
  return `"${hash}"`;
};

export const usePublicEnv = (
  env: EnvWithPublicGetter,
  config?: PublicEnvConfig
): Hono => {
  const router = new Hono();
  const publicEnv = env.getPublicEnvironmentVariables();
  const publicEnvJson = JSON.stringify(publicEnv);
  const etag = computeETag(publicEnv);
  const cacheControl = config?.cacheControl ?? "public, max-age=3600";
  const exposeSchema = config?.exposeSchema ?? true;

  router.get("/", (c) => {
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch === etag) {
      return c.body(null, 304);
    }

    c.header("Cache-Control", cacheControl);
    c.header("ETag", etag);
    if (config?.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        c.header(key, value);
      }
    }
    c.header("Content-Type", "application/json");
    return c.body(publicEnvJson);
  });

  if (exposeSchema) {
    router.get("/schema", (c) => {
      const schema: PublicEnvSchema = {
        fields: extractSchemaFromValue(publicEnv),
        timestamp: new Date().toISOString(),
      };
      return c.json(schema);
    });
  }

  return router;
};
