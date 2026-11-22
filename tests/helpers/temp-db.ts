import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

export const openTempDb = async (ddl: string) => {
  const dir = mkdtempSync(join(tmpdir(), "covara-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  await client.executeMultiple(ddl);
  return {
    client,
    db: drizzle(client),
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export type TempDb = Awaited<ReturnType<typeof openTempDb>>;
