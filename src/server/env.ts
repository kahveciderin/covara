interface ProcessLike {
  env?: Record<string, string | undefined>;
}

export const readEnv = (key: string): string | undefined => {
  const proc = (globalThis as { process?: ProcessLike }).process;
  return proc?.env?.[key];
};

export const isDebugEnabled = (): boolean => readEnv("COVARA_DEBUG") === "1";

export const isProduction = (): boolean => readEnv("NODE_ENV") === "production";
