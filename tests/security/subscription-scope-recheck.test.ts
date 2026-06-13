import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { rsql } from "@/auth/rsql";
import { createTestApp, post, SSECollector, flushAsync } from "../helpers/hono";

const docsTable = sqliteTable("docs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  org: text("org").notNull(),
  title: text("title").notNull(),
});

describe("Subscription scope re-check (out-of-band permission changes)", () => {
  let app: Hono;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let collectors: SSECollector[];
  // External, row-independent permission state the scope resolver reads on each
  // call — flipping it simulates losing/gaining org membership mid-subscription.
  let memberOfAcme: boolean;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "covara-scope-recheck-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    collectors = [];
    memberOfAcme = true;
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `t-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS docs`);
    await libsqlClient.execute(`
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org TEXT NOT NULL,
        title TEXT NOT NULL
      )
    `);

    app = createTestApp({ user: { id: "u1" } });
    app.route(
      "/docs",
      useResource(docsTable, {
        id: docsTable.id,
        db,
        auth: {
          // Scope is a function of external membership, not of the row — exactly
          // the case that a connect-time snapshot can't catch.
          read: async () =>
            memberOfAcme ? rsql`org=="acme"` : rsql`org=="__none__"`,
        },
        sse: { scopeRecheckMs: 40 },
      })
    );
  });

  afterEach(async () => {
    for (const collector of collectors) collector.close();
    await flushAsync();
    if (libsqlClient) libsqlClient.close();
  });

  const connect = async (path: string) => {
    const { collector, response } = await SSECollector.connect(app, path);
    if (collector) collectors.push(collector);
    return { collector, response };
  };

  it("emits removed when the subscriber loses scope out-of-band, and added when it returns", async () => {
    const created = await post(app, "/docs", { org: "acme", title: "Spec" });
    expect(created.status).toBe(201);
    const docId = created.body.id;

    const { collector } = await connect("/docs/subscribe");
    // Existing snapshot includes the in-scope doc.
    await collector.waitFor(
      (e) => e.data?.type === "existing" && String(e.data?.object?.id) === String(docId),
      2000
    );

    // Revoke membership: the row is unchanged, but the resolved scope no longer
    // includes it. The periodic re-check must emit removed.
    memberOfAcme = false;
    const removed = await collector.waitFor(
      (e) => e.data?.type === "removed" && String(e.data?.objectId) === String(docId),
      2000
    );
    expect(removed).toBeTruthy();

    // Restore membership: the doc re-enters scope -> added.
    memberOfAcme = true;
    const added = await collector.waitFor(
      (e) => e.data?.type === "added" && String(e.data?.object?.id) === String(docId),
      2000
    );
    expect(added).toBeTruthy();
  });

  it("after losing scope, live mutations to the now-out-of-scope row are not delivered", async () => {
    const created = await post(app, "/docs", { org: "acme", title: "Spec" });
    const docId = created.body.id;

    const { collector } = await connect("/docs/subscribe");
    await collector.waitFor((e) => e.data?.type === "existing", 2000);

    memberOfAcme = false;
    await collector.waitFor(
      (e) => e.data?.type === "removed" && String(e.data?.objectId) === String(docId),
      2000
    );

    // A mutation to the doc the subscriber can no longer see must not leak via the
    // live path — the recheck updated the compiled scope filter, not just the snapshot.
    const before = collector.events.length;
    await post(app, "/docs", { org: "acme", title: "Another" });
    await flushAsync(150);
    const leaked = collector.events
      .slice(before)
      .some((e) => e.data?.object?.org === "acme");
    expect(leaked).toBe(false);
  });
});
