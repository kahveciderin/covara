import { defineConfig } from 'drizzle-kit';

try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {}

export default defineConfig({
  out: './example/drizzle',
  schema: './example/src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME ?? 'sqlite.db',
  },
});