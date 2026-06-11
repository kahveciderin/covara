import { createEnv, envVariable } from "covara/env";
import { z } from "zod";

try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {}

const opensearchUrl = process.env.OPENSEARCH_URL;

export const env = createEnv({
  serverConfig: {
    port: envVariable(process.env.PORT, z.string().min(1).transform(Number)),
  },
  dbConfig: {
    dbFileName: envVariable(process.env.DB_FILE_NAME, z.string().min(1)),
  },
  searchConfig: {
    opensearchUrl: envVariable(opensearchUrl, z.string().optional()),
  },
  NODE_ENV: z.enum(["development", "production"]),
  PUBLIC_VERSION: z.string().min(1),
  PUBLIC_OPENSEARCH_ENABLED: z.boolean().default(!!opensearchUrl),
});
