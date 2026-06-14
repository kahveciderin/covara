import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  logAdminAction,
  getAdminAuditLog,
  getAdminAuditLogAsync,
  setAdminAuditAdapter,
  setAdminAuditSink,
  clearAdminAuditLog,
  type AdminAuditEntry,
} from "@/ui/admin-auth";
import {
  createInMemoryLogAdapter,
  createKVLogAdapter,
} from "@/observability/log-adapter";
import { createMemoryKV } from "@/kv/memory";
import { setGlobalKV, clearGlobalKV } from "@/kv";

const action = (operation: string): Omit<AdminAuditEntry, "timestamp"> => ({
  userId: "admin",
  userEmail: "admin@test.com",
  operation,
});

describe("admin audit adapter wiring", () => {
  beforeEach(() => {
    clearGlobalKV();
    setAdminAuditSink(null);
  });
  afterEach(() => {
    setAdminAuditSink(null);
    clearGlobalKV();
  });

  it("routes writes to an injected adapter and still fires the audit sink", () => {
    const adapter = createInMemoryLogAdapter<AdminAuditEntry>({
      maxEntries: 50,
      order: "newest-first",
    });
    setAdminAuditAdapter(adapter);
    const sinkSeen: string[] = [];
    setAdminAuditSink((e) => {
      sinkSeen.push(e.operation);
    });

    logAdminAction(action("impersonate_execute"));

    expect(adapter.querySync().map((e) => e.operation)).toEqual([
      "impersonate_execute",
    ]);
    expect(getAdminAuditLog().map((e) => e.operation)).toEqual([
      "impersonate_execute",
    ]);
    expect(sinkSeen).toEqual(["impersonate_execute"]);
  });

  it("serves authoritative entries from KV via getAdminAuditLogAsync", async () => {
    const kv = createMemoryKV();
    await kv.connect();
    setGlobalKV(kv);
    setAdminAuditAdapter(
      createKVLogAdapter<AdminAuditEntry>({
        maxEntries: 100,
        order: "newest-first",
        keyPrefix: "covara:obs:audit-test",
      })
    );

    logAdminAction(action("api_explorer_execute"));
    logAdminAction(action("data_explorer_list"));
    await new Promise((r) => setTimeout(r, 10));

    const entries = await getAdminAuditLogAsync(10, 0);
    expect(entries.map((e) => e.operation)).toEqual([
      "data_explorer_list",
      "api_explorer_execute",
    ]);

    clearAdminAuditLog();
  });
});
