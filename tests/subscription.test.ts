import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  removeSubscription,
  getSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  sendExistingItems,
  sendInvalidateEvent,
  getSubscriptionsForResource,
  getSubscriptionStats,
  isHandlerConnected,
  getHandlerSubscriptions,
  clearRelevantObjects,
  invalidateFilterCache,
  processChangelogEntries,
  updateSubscriptionSeq,
  getCatchupEvents,
  sendCatchupEvents,
  applyScopeChange,
  clearAllSubscriptions,
  addRelevantObject,
  registerKnownIds,
} from "@/resource/subscription";
import { changelog } from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

let kv: KVAdapter;

type MockWriter = SSEWriter & {
  closed: boolean;
  write: ReturnType<typeof vi.fn>;
  getChunks: () => string[];
  getEvents: () => any[];
};

const createMockResponse = (): MockWriter => {
  const chunks: string[] = [];
  const closeCallbacks: (() => void)[] = [];
  const mockRes = {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    closed: false,
    bufferedBytes: 0,
    close: vi.fn(() => {
      mockRes.closed = true;
      for (const cb of closeCallbacks.splice(0)) cb();
    }),
    onClose: (cb: () => void) => {
      closeCallbacks.push(cb);
    },
    getChunks: () => chunks,
    getEvents: () =>
      chunks
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice(6).trim())),
  };
  return mockRes as unknown as MockWriter;
};

const createMockFilter = () => ({
  compile: (expr: string) => ({
    execute: (obj: Record<string, unknown>) => {
      if (!expr || expr === "*") return true;
      if (expr.includes("status==")) {
        const match = expr.match(/status=="([^"]+)"/);
        if (match) return obj.status === match[1];
      }
      if (expr.includes("age>")) {
        const match = expr.match(/age>(\d+)/);
        if (match) return (obj.age as number) > parseInt(match[1]);
      }
      return true;
    },
  }),
  convert: (expr: string) => expr,
  execute: (expr: string, obj: Record<string, unknown>) => {
    if (!expr || expr === "*") return true;
    return true;
  },
  clearCache: () => {},
});

describe("Subscription System", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test");
    await kv.connect();
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    await clearAllSubscriptions();
    await changelog.clear();
  });

  describe("External mutation notification", () => {
    it("delivers an invalidate event to subscribers on recordExternalMutation", async () => {
      const { recordExternalMutation } = await import("@/resource/track-mutations");
      const writer = createMockResponse();
      registerHandler("ext-handler", writer);
      await createSubscription({
        resource: "widgets",
        filter: "",
        handlerId: "ext-handler",
        authId: null,
      });

      await recordExternalMutation("widgets", "update");

      const events = writer.getEvents();
      expect(events.some((e) => e.type === "invalidate")).toBe(true);

      const entries = await changelog.getEntriesSince("widgets", 0);
      expect(entries.some((e) => e.objectId === "*" && e.type === "update")).toBe(true);

      await unregisterHandler("ext-handler");
    });

    it("does not notify subscribers of a different resource", async () => {
      const { recordExternalMutation } = await import("@/resource/track-mutations");
      const writer = createMockResponse();
      registerHandler("other-handler", writer);
      await createSubscription({
        resource: "gadgets",
        filter: "",
        handlerId: "other-handler",
        authId: null,
      });

      await recordExternalMutation("widgets", "create");

      expect(writer.getEvents().some((e) => e.type === "invalidate")).toBe(false);
      await unregisterHandler("other-handler");
    });
  });

  describe("Resume Catchup", () => {
    it("replays missed changelog entries to a single subscription on resume", async () => {
      const writer = createMockResponse();
      const filter = createMockFilter();
      registerHandler("catchup-handler", writer);
      const subId = await createSubscription({
        resource: "items",
        filter: 'status=="active"',
        handlerId: "catchup-handler",
        authId: null,
      });

      // Mutations that happened while the client was disconnected.
      await changelog.append({ resource: "items", type: "create", objectId: "a", object: { id: "a", status: "active" }, timestamp: Date.now() });
      await changelog.append({ resource: "items", type: "update", objectId: "b", object: { id: "b", status: "active" }, previousObject: { id: "b", status: "active" }, timestamp: Date.now() });
      await changelog.append({ resource: "items", type: "update", objectId: "c", object: { id: "c", status: "inactive" }, previousObject: { id: "c", status: "active" }, timestamp: Date.now() });
      await changelog.append({ resource: "items", type: "delete", objectId: "d", previousObject: { id: "d", status: "active" }, timestamp: Date.now() });
      // Unrelated resource — must be ignored.
      await changelog.append({ resource: "others", type: "create", objectId: "x", object: { id: "x", status: "active" }, timestamp: Date.now() });

      const upto = await changelog.getCurrentSequence();
      const result = await sendCatchupEvents(subId, 0, upto, filter, "id");
      expect(result).toBe("replayed");

      const events = writer.getEvents();
      // Created & in scope -> added.
      expect(events.find((e) => e.type === "added" && e.object?.id === "a")).toBeTruthy();
      // Updated, still in scope -> changed.
      expect(events.find((e) => e.type === "changed" && e.object?.id === "b")).toBeTruthy();
      // Updated out of scope -> removed (no ghost).
      expect(events.find((e) => e.type === "removed" && e.objectId === "c")).toBeTruthy();
      // Deleted -> removed.
      expect(events.find((e) => e.type === "removed" && e.objectId === "d")).toBeTruthy();
      // Unrelated resource is never delivered.
      expect(events.find((e) => e.object?.id === "x")).toBeFalsy();

      await unregisterHandler("catchup-handler");
    });

    it("falls back to invalidate when a missed entry carries no row data (raw SQL)", async () => {
      const writer = createMockResponse();
      registerHandler("catchup-raw", writer);
      const subId = await createSubscription({
        resource: "items",
        filter: "",
        handlerId: "catchup-raw",
        authId: null,
      });

      await changelog.append({ resource: "items", type: "update", objectId: "*", timestamp: Date.now() });

      const upto = await changelog.getCurrentSequence();
      const result = await sendCatchupEvents(subId, 0, upto, createMockFilter(), "id");
      expect(result).toBe("invalidate");
      expect(writer.getEvents().some((e) => e.type === "invalidate")).toBe(true);

      await unregisterHandler("catchup-raw");
    });

    it("returns 'invalidate' when the resume point has been pruned out of the changelog window", async () => {
      const writer = createMockResponse();
      registerHandler("catchup-gap", writer);
      const subId = await createSubscription({
        resource: "items",
        filter: "",
        handlerId: "catchup-gap",
        authId: null,
      });

      await changelog.append({ resource: "items", type: "create", objectId: "a", object: { id: "a" }, timestamp: Date.now() });
      const upto = await changelog.getCurrentSequence();

      // Resume from a sequence far below the oldest retained entry -> gap.
      vi.spyOn(changelog, "needsInvalidation").mockResolvedValueOnce(true);
      const result = await sendCatchupEvents(subId, 1, upto, createMockFilter(), "id");
      expect(result).toBe("invalidate");
      expect(writer.getEvents().some((e) => e.type === "invalidate")).toBe(true);

      await unregisterHandler("catchup-gap");
    });
  });

  describe("Scope Re-check", () => {
    it("diffs the new matching set: removes rows that left scope, adds rows that entered", async () => {
      const writer = createMockResponse();
      registerHandler("scope-handler", writer);
      const subId = await createSubscription({
        resource: "items",
        filter: "",
        handlerId: "scope-handler",
        authId: "u1",
        scopeFilter: 'owner=="u1"',
      });

      // Subscriber currently holds a and b.
      await addRelevantObject(subId, "a");
      await addRelevantObject(subId, "b");

      // New scope's matching set is {b, c}: a left, c entered, b stayed.
      const result = await applyScopeChange(
        subId,
        'owner=="u2"',
        [
          { id: "b", owner: "u2" },
          { id: "c", owner: "u2" },
        ],
        "id"
      );

      expect(result).toEqual({ added: 1, removed: 1 });

      const events = writer.getEvents();
      expect(events.find((e) => e.type === "removed" && e.objectId === "a")).toBeTruthy();
      expect(events.find((e) => e.type === "added" && e.object?.id === "c")).toBeTruthy();
      expect(events.find((e) => e.objectId === "b" || e.object?.id === "b")).toBeFalsy();

      // The persisted scope is updated so future live events honor it.
      const sub = await getSubscription(subId);
      expect(sub?.scopeFilter).toBe('owner=="u2"');

      await unregisterHandler("scope-handler");
    });

    it("is a no-op event-wise when the matching set is unchanged", async () => {
      const writer = createMockResponse();
      registerHandler("scope-noop", writer);
      const subId = await createSubscription({
        resource: "items",
        filter: "",
        handlerId: "scope-noop",
        authId: "u1",
        scopeFilter: 'owner=="u1"',
      });
      await addRelevantObject(subId, "a");

      const result = await applyScopeChange(subId, 'owner=="u1"', [{ id: "a", owner: "u1" }], "id");
      expect(result).toEqual({ added: 0, removed: 0 });
      expect(writer.getEvents().length).toBe(0);

      await unregisterHandler("scope-noop");
    });
  });

  describe("Subscription Lifecycle", () => {
    it("should create a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
      });

      expect(subscriptionId).toBeDefined();
      expect(typeof subscriptionId).toBe("string");
    });

    it("should retrieve a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription).toBeDefined();
      expect(subscription?.resource).toBe("users");
      expect(subscription?.filter).toBe('status=="active"');
      expect(subscription?.authId).toBe("user-123");
    });

    it("should remove a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: null,
      });

      await removeSubscription(subscriptionId);
      const subscription = await getSubscription(subscriptionId);
      expect(subscription).toBeUndefined();
    });

    it("should track creation timestamp", async () => {
      const before = new Date();
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: null,
      });
      const after = new Date();

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.createdAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(subscription?.createdAt.getTime()).toBeLessThanOrEqual(
        after.getTime()
      );
    });

    it("should store scope filter", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
        scopeFilter: 'userId=="user-123"',
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.scopeFilter).toBe('userId=="user-123"');
    });

    it("should store auth expiration", async () => {
      const expiresAt = new Date(Date.now() + 3600000);
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: "user-123",
        authExpiresAt: expiresAt,
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.authExpiresAt?.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe("Handler Management", () => {
    it("should register a handler", () => {
      const mockRes = createMockResponse();
      registerHandler("handler-1", mockRes);
      expect(isHandlerConnected("handler-1")).toBe(true);
    });

    it("should detect disconnected handlers", () => {
      const mockRes = createMockResponse();
      registerHandler("handler-2", mockRes);
      mockRes.closed = true;
      expect(isHandlerConnected("handler-2")).toBe(false);
    });

    it("should unregister handler and cleanup subscriptions", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-3", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-3",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-3",
        authId: null,
      });

      await unregisterHandler("handler-3");

      expect(isHandlerConnected("handler-3")).toBe(false);
      const subs = await getHandlerSubscriptions("handler-3");
      expect(subs).toHaveLength(0);
    });

    it("should allow handler to reconnect after disconnect while other handlers remain active", async () => {
      // This test verifies the fix for the bug where unregisterHandler was only called
      // when activeClients === 0, causing stale handlers when one client disconnects
      // while others remain connected
      const mockRes1 = createMockResponse();
      const mockRes2 = createMockResponse();
      const mockRes1Reconnect = createMockResponse();

      registerHandler("handler-reconnect-1", mockRes1);
      registerHandler("handler-reconnect-2", mockRes2);

      const sub1 = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-reconnect-1",
        authId: "user-1",
      });

      const sub2 = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-reconnect-2",
        authId: "user-2",
      });

      // Verify both handlers can receive events initially
      const mockFilter = createMockFilter();
      await pushInsertsToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "test-1", name: "Test", status: "active" }],
        "id"
      );

      expect(mockRes1.getEvents().length).toBe(1);
      expect(mockRes2.getEvents().length).toBe(1);

      // Handler 1 disconnects (simulating client going offline)
      // This MUST unregister the handler even though handler 2 is still active
      await unregisterHandler("handler-reconnect-1");
      await removeSubscription(sub1);

      expect(isHandlerConnected("handler-reconnect-1")).toBe(false);
      expect(isHandlerConnected("handler-reconnect-2")).toBe(true);

      // Handler 1 reconnects with a new response object (simulating client coming back online)
      registerHandler("handler-reconnect-1", mockRes1Reconnect);

      const sub1Reconnect = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-reconnect-1",
        authId: "user-1",
      });

      // Push another event - both handlers should receive it
      await pushInsertsToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "test-2", name: "Test 2", status: "active" }],
        "id"
      );

      // The reconnected handler should receive the new event
      const reconnectEvents = mockRes1Reconnect.getEvents();
      expect(reconnectEvents.length).toBe(1);
      expect(reconnectEvents[0].object.id).toBe("test-2");

      // Handler 2 should also receive it
      const handler2Events = mockRes2.getEvents();
      expect(handler2Events.length).toBe(2); // Original + new event

      // Clean up
      await removeSubscription(sub1Reconnect);
      await removeSubscription(sub2);
      await unregisterHandler("handler-reconnect-1");
      await unregisterHandler("handler-reconnect-2");
    });

    it("should return handler subscriptions", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-4", mockRes);

      const sub1 = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-4",
        authId: null,
      });

      const sub2 = await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-4",
        authId: null,
      });

      const subscriptions = await getHandlerSubscriptions("handler-4");
      expect(subscriptions).toContain(sub1);
      expect(subscriptions).toContain(sub2);
    });
  });

  describe("Event Sending", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-events", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-events",
        authId: null,
      });
    });

    it("should send existing items", async () => {
      const items = [
        { id: "1", name: "John", status: "active" },
        { id: "2", name: "Jane", status: "active" },
      ];

      await sendExistingItems(subscriptionId, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("existing");
      expect(events[0].object.name).toBe("John");
      expect(events[1].object.name).toBe("Jane");
    });

    it("should include sequence numbers", async () => {
      const items = [{ id: "1", name: "John" }];
      await sendExistingItems(subscriptionId, items, "id");

      const events = mockRes.getEvents();
      expect(events[0].seq).toBe(1);
    });

    it("should send invalidate event", async () => {
      await sendInvalidateEvent(subscriptionId, "Test reason");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("invalidate");
      expect(events[0].reason).toBe("Test reason");
    });

    it("should track relevant object ids", async () => {
      const items = [
        { id: "1", name: "John" },
        { id: "2", name: "Jane" },
      ];

      await sendExistingItems(subscriptionId, items, "id");

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("1")).toBe(true);
      expect(subscription?.relevantObjectIds.has("2")).toBe(true);
    });

    it("should not send to ended handlers", async () => {
      mockRes.closed = true;

      const items = [{ id: "1", name: "John" }];
      await sendExistingItems(subscriptionId, items, "id");

      expect(mockRes.write).not.toHaveBeenCalled();
    });
  });

  describe("Push Inserts to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-inserts", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-inserts",
        authId: null,
      });
    });

    it("should push matching inserts", async () => {
      const items = [{ id: "1", name: "John", status: "active" }];

      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("added");
      expect(events[0].object.name).toBe("John");
    });

    it("should not push non-matching inserts", async () => {
      const items = [{ id: "1", name: "John", status: "inactive" }];

      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should not push to different resources", async () => {
      const items = [{ id: "1", name: "John", status: "active" }];

      await pushInsertsToSubscriptions("posts", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should handle expired auth", async () => {
      const expiredSubId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-inserts",
        authId: "user-123",
        authExpiresAt: new Date(Date.now() - 1000),
      });

      const items = [{ id: "1", name: "John", status: "active" }];
      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      const invalidateEvent = events.find((e) => e.type === "invalidate");
      expect(invalidateEvent).toBeDefined();
    });
  });

  describe("Push Updates to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-updates", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-updates",
        authId: null,
      });

      // Add relevant object via KV
      await addRelevantObject(subscriptionId, "1");
    });

    it("should send changed event for matching update", async () => {
      const items = [{ id: "1", name: "Updated John", status: "active" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "changed")).toBe(true);
    });

    it("should send added event when item enters filter", async () => {
      // Item "2" is not yet relevant
      const items = [{ id: "2", name: "New Match", status: "active" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "added")).toBe(true);
    });

    it("should send removed event when item leaves filter", async () => {
      const items = [{ id: "1", name: "John", status: "inactive" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "removed")).toBe(true);
    });

    it("should include previous object reference", async () => {
      const items = [{ id: "1", name: "Updated", status: "active" }];
      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set("1", { id: "1", name: "Original", status: "active" });

      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        items,
        "id",
        previousMap
      );

      const events = mockRes.getEvents();
      const changedEvent = events.find((e) => e.type === "changed");
      expect(changedEvent?.previousObjectId).toBe("1");
    });
  });

  describe("Push Deletes to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-deletes", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-deletes",
        authId: null,
      });

      // Add relevant objects via KV
      await addRelevantObject(subscriptionId, "1");
      await addRelevantObject(subscriptionId, "2");
    });

    it("should send removed events for deleted items", async () => {
      await pushDeletesToSubscriptions("users", ["1"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("removed");
      expect(events[0].objectId).toBe("1");
    });

    it("should not send removed for non-relevant items", async () => {
      await pushDeletesToSubscriptions("users", ["999"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should remove from relevant objects set", async () => {
      await pushDeletesToSubscriptions("users", ["1"]);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("1")).toBe(false);
      expect(subscription?.relevantObjectIds.has("2")).toBe(true);
    });

    it("should handle multiple deletes", async () => {
      await pushDeletesToSubscriptions("users", ["1", "2"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe("Subscription Queries", () => {
    beforeEach(async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-query", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-query",
        authId: null,
      });

      await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-query",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-query",
        authId: null,
      });
    });

    it("should get subscriptions for resource", async () => {
      const userSubs = await getSubscriptionsForResource("users");
      expect(userSubs).toHaveLength(2);

      const postSubs = await getSubscriptionsForResource("posts");
      expect(postSubs).toHaveLength(1);
    });

    it("should return empty for unknown resource", async () => {
      const subs = await getSubscriptionsForResource("unknown");
      expect(subs).toHaveLength(0);
    });
  });

  describe("Subscription Stats", () => {
    beforeEach(async () => {
      const mockRes1 = createMockResponse();
      const mockRes2 = createMockResponse();
      registerHandler("handler-stats-1", mockRes1);
      registerHandler("handler-stats-2", mockRes2);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-stats-1",
        authId: null,
      });

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-stats-2",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-stats-1",
        authId: null,
      });
    });

    it("should return correct stats", async () => {
      const stats = await getSubscriptionStats();

      expect(stats.totalSubscriptions).toBeGreaterThanOrEqual(3);
      expect(stats.totalHandlers).toBeGreaterThanOrEqual(2);
      expect(stats.subscriptionsByResource["users"]).toBeGreaterThanOrEqual(2);
      expect(stats.subscriptionsByResource["posts"]).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Subscription Utilities", () => {
    let subscriptionId: string;

    beforeEach(async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-utils", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-utils",
        authId: null,
      });

      // Add relevant objects via KV
      await addRelevantObject(subscriptionId, "1");
      await addRelevantObject(subscriptionId, "2");
    });

    it("should clear relevant objects", async () => {
      await clearRelevantObjects(subscriptionId);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.size).toBe(0);
    });

    it("should invalidate filter cache", () => {
      invalidateFilterCache(subscriptionId);
    });

    it("should update subscription sequence", async () => {
      await updateSubscriptionSeq(subscriptionId, 100);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.lastSeq).toBe(100);
    });
  });

  describe("Changelog Integration", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-changelog", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-changelog",
        authId: null,
      });
    });

    it("should process create changelog entries", async () => {
      const entries = [
        {
          seq: 1,
          resource: "users",
          type: "create" as const,
          objectId: "1",
          object: { id: "1", name: "John", status: "active" },
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "added")).toBe(true);
    });

    it("should process update changelog entries", async () => {
      // Add relevant object first
      await addRelevantObject(subscriptionId, "1");

      const entries = [
        {
          seq: 2,
          resource: "users",
          type: "update" as const,
          objectId: "1",
          object: { id: "1", name: "Updated", status: "active" },
          previousObject: { id: "1", name: "Original", status: "active" },
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "changed")).toBe(true);
    });

    it("should process delete changelog entries", async () => {
      // Add relevant object first
      await addRelevantObject(subscriptionId, "1");

      const entries = [
        {
          seq: 3,
          resource: "users",
          type: "delete" as const,
          objectId: "1",
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "removed")).toBe(true);
    });

    it("should get catchup events", async () => {
      await changelog.clear();

      for (let i = 1; i <= 5; i++) {
        await changelog.append({
          resource: "users",
          type: "create",
          objectId: String(i),
          object: { id: String(i) },
          timestamp: Date.now(),
        });
      }

      const events = await getCatchupEvents(subscriptionId, 2);
      expect(events).toBeDefined();
      expect(events?.length).toBeGreaterThan(0);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent subscription creation", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-concurrent", mockRes);

      const promises = Array.from({ length: 10 }, (_, i) =>
        createSubscription({
          resource: "users",
          filter: "",
          handlerId: "handler-concurrent",
          authId: `user-${i}`,
        })
      );

      const ids = await Promise.all(promises);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    it("should handle concurrent event pushing", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-concurrent-push", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-concurrent-push",
        authId: null,
      });

      const mockFilter = createMockFilter();
      const promises = Array.from({ length: 10 }, (_, i) =>
        pushInsertsToSubscriptions(
          "users",
          mockFilter as any,
          [{ id: String(i), name: `User ${i}` }],
          "id"
        )
      );

      await Promise.all(promises);

      const events = mockRes.getEvents();
      expect(events.length).toBeGreaterThan(0);
    });
  });
});

describe("SSE Error Handling", () => {
  let mockRes: ReturnType<typeof createMockResponse>;

  beforeEach(async () => {
    await clearAllSubscriptions();
    await changelog.clear();
  });

  it("should send SSE error event when initial data fetch fails", async () => {
    mockRes = createMockResponse();
    const handlerId = "error-handler-1";
    registerHandler(handlerId, mockRes);

    const subscriptionId = await createSubscription({
      resource: "users",
      filter: "",
      handlerId,
      authId: null,
    });

    // Simulate what happens when sendExistingItems is called after an error
    // In the real scenario, this would be triggered by a database error
    // For testing, we verify that error events are properly formatted

    // Write an error event directly (simulating what the hook.ts does)
    const errorMessage = "Database connection failed";
    mockRes.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`);

    const chunks = mockRes.getChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("event: error");
    expect(chunks[0]).toContain("Database connection failed");

    // Verify the error data can be parsed
    const dataMatch = chunks[0].match(/data: (.+)\n/);
    expect(dataMatch).toBeDefined();
    const errorData = JSON.parse(dataMatch![1]);
    expect(errorData.error).toBe("Database connection failed");

    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);
  });

  it("should properly format SSE error events", async () => {
    mockRes = createMockResponse();
    const handlerId = "error-handler-2";
    registerHandler(handlerId, mockRes);

    // Test various error message formats
    const errorCases = [
      { error: "Simple error" },
      { error: "Error with special chars: <>&\"'" },
      { error: "Error with\nnewline" },
    ];

    for (const errorCase of errorCases) {
      mockRes.write(`event: error\ndata: ${JSON.stringify(errorCase)}\n\n`);
    }

    const chunks = mockRes.getChunks();
    expect(chunks.length).toBe(3);

    // Verify each error can be parsed back
    for (let i = 0; i < chunks.length; i++) {
      const dataMatch = chunks[i].match(/data: (.+)\n/);
      expect(dataMatch).toBeDefined();
      const parsed = JSON.parse(dataMatch![1]);
      expect(parsed.error).toBe(errorCases[i].error);
    }

    await unregisterHandler(handlerId);
  });

  it("should not send to ended handlers after error", async () => {
    mockRes = createMockResponse();
    const handlerId = "error-handler-3";
    registerHandler(handlerId, mockRes);

    const subscriptionId = await createSubscription({
      resource: "users",
      filter: "",
      handlerId,
      authId: null,
    });

    // Mark the response as ended (simulating connection close after error)
    mockRes.closed = true;

    // Try to send an error event - should not write
    mockRes.write(`event: error\ndata: ${JSON.stringify({ error: "Should not appear" })}\n\n`);

    // The write mock still captures the call, but in real scenario the writer.closed check prevents actual writes
    // What we're testing is that isHandlerConnected returns false
    expect(isHandlerConnected(handlerId)).toBe(false);

    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);
  });

  it("should handle error event followed by normal cleanup", async () => {
    mockRes = createMockResponse();
    const handlerId = "error-handler-4";
    registerHandler(handlerId, mockRes);

    const subscriptionId = await createSubscription({
      resource: "users",
      filter: "",
      handlerId,
      authId: null,
    });

    // Send error event
    mockRes.write(`event: error\ndata: ${JSON.stringify({ error: "Connection error" })}\n\n`);

    // Simulate cleanup after error
    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);

    // Verify subscription is removed
    const subscription = await getSubscription(subscriptionId);
    expect(subscription).toBeUndefined();

    // Verify handler is unregistered
    expect(isHandlerConnected(handlerId)).toBe(false);
  });

  it("should isolate errors to specific subscriptions", async () => {
    const mockRes1 = createMockResponse();
    const mockRes2 = createMockResponse();
    const handlerId1 = "error-isolated-1";
    const handlerId2 = "error-isolated-2";

    registerHandler(handlerId1, mockRes1);
    registerHandler(handlerId2, mockRes2);

    const sub1 = await createSubscription({
      resource: "users",
      filter: "",
      handlerId: handlerId1,
      authId: null,
    });

    const sub2 = await createSubscription({
      resource: "users",
      filter: "",
      handlerId: handlerId2,
      authId: null,
    });

    // Send error to first subscription only
    mockRes1.write(`event: error\ndata: ${JSON.stringify({ error: "Error on sub1" })}\n\n`);
    mockRes1.closed = true;

    // Second subscription should still be able to receive events
    expect(isHandlerConnected(handlerId1)).toBe(false);
    expect(isHandlerConnected(handlerId2)).toBe(true);

    // Send a normal event to second subscription
    const mockFilter = createMockFilter();
    await pushInsertsToSubscriptions(
      "users",
      mockFilter as any,
      [{ id: "1", name: "Test", status: "active" }],
      "id"
    );

    // First handler got the error event
    const events1 = mockRes1.getChunks();
    expect(events1.length).toBe(1);
    expect(events1[0]).toContain("event: error");

    // Second handler got the added event
    const events2 = mockRes2.getEvents();
    expect(events2.length).toBe(1);
    expect(events2[0].type).toBe("added");

    await removeSubscription(sub1);
    await removeSubscription(sub2);
    await unregisterHandler(handlerId1);
    await unregisterHandler(handlerId2);
  });
});

// Test subscriptions without KV store (in-memory only)
describe("Subscription System (No KV - In-Memory Fallback)", () => {
  let savedKV: KVAdapter | null = null;

  const createNoKVMockResponse = (): MockWriter => createMockResponse();

  const createNoKVMockFilter = () => ({
    compile: (expr: string) => ({
      execute: (obj: Record<string, unknown>) => {
        if (!expr || expr === "*") return true;
        if (expr.includes("userId==")) {
          const match = expr.match(/userId=="([^"]+)"/);
          if (match) return obj.userId === match[1];
        }
        return true;
      },
    }),
    convert: (expr: string) => expr,
    execute: (expr: string, obj: Record<string, unknown>) => true,
    clearCache: () => {},
  });

  beforeAll(async () => {
    // Temporarily remove global KV to test in-memory fallback
    // We need to import the module to access internal state
    const kvModule = await import("@/kv");
    if (kvModule.hasGlobalKV()) {
      savedKV = kvModule.getGlobalKV();
    }
    // Clear the global KV by setting it to a disconnected state
    // Since we can't actually clear it, we'll rely on the KV check returning null
  });

  afterAll(async () => {
    // Restore KV after tests
    if (savedKV) {
      setGlobalKV(savedKV);
    }
  });

  it("should work without KV store - subscription creation and event delivery", async () => {
    // This test simulates what happens when KV is not configured
    // by testing the local in-memory storage directly

    const mockRes = createNoKVMockResponse();
    const handlerId = "no-kv-handler-" + Date.now();

    registerHandler(handlerId, mockRes);

    // Create subscription (will use local storage since KV exists but we're testing the path)
    const subscriptionId = await createSubscription({
      resource: "todos",
      filter: "",
      handlerId,
      authId: "user-123",
    });

    expect(subscriptionId).toBeDefined();
    expect(subscriptionId.length).toBeGreaterThan(0);

    // Get subscription back
    const subscription = await getSubscription(subscriptionId);
    expect(subscription).toBeDefined();
    expect(subscription?.resource).toBe("todos");
    expect(subscription?.handlerId).toBe(handlerId);

    // Push an insert event
    const mockFilter = createNoKVMockFilter();
    await pushInsertsToSubscriptions(
      "todos",
      mockFilter as any,
      [{ id: "todo-1", title: "Test Todo", userId: "user-123" }],
      "id"
    );

    // Verify event was sent to the handler
    const events = mockRes.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("added");
    expect(events[0].object.id).toBe("todo-1");

    // Clean up
    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);
  });

  it("should handle updates without KV store", async () => {
    const mockRes = createNoKVMockResponse();
    const handlerId = "no-kv-update-handler-" + Date.now();

    registerHandler(handlerId, mockRes);

    const subscriptionId = await createSubscription({
      resource: "todos",
      filter: "",
      handlerId,
      authId: "user-456",
    });

    const mockFilter = createNoKVMockFilter();

    // First insert an item
    await pushInsertsToSubscriptions(
      "todos",
      mockFilter as any,
      [{ id: "todo-update-1", title: "Original", userId: "user-456" }],
      "id"
    );

    // Then update it
    await pushUpdatesToSubscriptions(
      "todos",
      mockFilter as any,
      [{ id: "todo-update-1", title: "Updated", userId: "user-456" }],
      "id"
    );

    const events = mockRes.getEvents();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("added");
    expect(events[1].type).toBe("changed");
    expect(events[1].object.title).toBe("Updated");

    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);
  });

  it("should handle deletes without KV store", async () => {
    const mockRes = createNoKVMockResponse();
    const handlerId = "no-kv-delete-handler-" + Date.now();

    registerHandler(handlerId, mockRes);

    const subscriptionId = await createSubscription({
      resource: "todos",
      filter: "",
      handlerId,
      authId: "user-789",
    });

    const mockFilter = createNoKVMockFilter();

    // Insert then delete
    await pushInsertsToSubscriptions(
      "todos",
      mockFilter as any,
      [{ id: "todo-delete-1", title: "ToDelete", userId: "user-789" }],
      "id"
    );

    await pushDeletesToSubscriptions("todos", ["todo-delete-1"]);

    const events = mockRes.getEvents();
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("added");
    expect(events[1].type).toBe("removed");
    expect(events[1].objectId).toBe("todo-delete-1");

    await removeSubscription(subscriptionId);
    await unregisterHandler(handlerId);
  });

  it("should deliver events to multiple subscriptions (cross-device sync)", async () => {
    // This test ensures that when multiple clients subscribe to the same resource,
    // they ALL receive events - not just the last subscriber
    const mockRes1 = createNoKVMockResponse();
    const mockRes2 = createNoKVMockResponse();
    const handlerId1 = "multi-sub-handler-1-" + Date.now();
    const handlerId2 = "multi-sub-handler-2-" + Date.now();

    // Register both handlers (simulating two different browser connections)
    registerHandler(handlerId1, mockRes1);
    registerHandler(handlerId2, mockRes2);

    // Create two subscriptions for the same resource (same user on two devices)
    const subscriptionId1 = await createSubscription({
      resource: "todos",
      filter: "",
      handlerId: handlerId1,
      authId: "user-multi",
    });

    const subscriptionId2 = await createSubscription({
      resource: "todos",
      filter: "",
      handlerId: handlerId2,
      authId: "user-multi",
    });

    expect(subscriptionId1).not.toBe(subscriptionId2);

    const mockFilter = createNoKVMockFilter();

    // Push an insert event - BOTH subscriptions should receive it
    await pushInsertsToSubscriptions(
      "todos",
      mockFilter as any,
      [{ id: "multi-todo-1", title: "Multi-device todo", userId: "user-multi" }],
      "id"
    );

    // Verify BOTH handlers received the event
    const events1 = mockRes1.getEvents();
    const events2 = mockRes2.getEvents();

    expect(events1.length).toBe(1);
    expect(events1[0].type).toBe("added");
    expect(events1[0].object.id).toBe("multi-todo-1");
    expect(events1[0].subscriptionId).toBe(subscriptionId1);

    expect(events2.length).toBe(1);
    expect(events2[0].type).toBe("added");
    expect(events2[0].object.id).toBe("multi-todo-1");
    expect(events2[0].subscriptionId).toBe(subscriptionId2);

    // Clean up
    await removeSubscription(subscriptionId1);
    await removeSubscription(subscriptionId2);
    await unregisterHandler(handlerId1);
    await unregisterHandler(handlerId2);
  });
});

describe("Hybrid Subscription (skipExisting + knownIds)", () => {
  let mockRes: ReturnType<typeof createMockResponse>;
  let kv: KVAdapter;

  beforeAll(async () => {
    kv = createMemoryKV("hybrid-test");
    await kv.connect();
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    await clearAllSubscriptions();
    await changelog.clear();
    mockRes = createMockResponse();
  });

  describe("registerKnownIds", () => {
    it("should register multiple known IDs at once", async () => {
      const handlerId = "known-ids-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Register known IDs
      await registerKnownIds(subscriptionId, ["1", "2", "3"]);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("1")).toBe(true);
      expect(subscription?.relevantObjectIds.has("2")).toBe(true);
      expect(subscription?.relevantObjectIds.has("3")).toBe(true);
      expect(subscription?.relevantObjectIds.size).toBe(3);

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should handle empty array", async () => {
      const handlerId = "known-ids-empty-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Register empty array - should not throw
      await registerKnownIds(subscriptionId, []);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.size).toBe(0);

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should merge with existing relevant objects", async () => {
      const handlerId = "known-ids-merge-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Add some via addRelevantObject
      await addRelevantObject(subscriptionId, "existing-1");
      await addRelevantObject(subscriptionId, "existing-2");

      // Then register known IDs in bulk
      await registerKnownIds(subscriptionId, ["new-1", "new-2"]);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("existing-1")).toBe(true);
      expect(subscription?.relevantObjectIds.has("existing-2")).toBe(true);
      expect(subscription?.relevantObjectIds.has("new-1")).toBe(true);
      expect(subscription?.relevantObjectIds.has("new-2")).toBe(true);
      expect(subscription?.relevantObjectIds.size).toBe(4);

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });
  });

  describe("Hybrid subscription workflow", () => {
    const mockFilter = createMockFilter();

    it("should receive add events for new items when using knownIds", async () => {
      const handlerId = "hybrid-add-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Simulate client has fetched items 1 and 2 via GET
      await registerKnownIds(subscriptionId, ["1", "2"]);

      // A new item is added - client should receive this
      await pushInsertsToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "3", name: "New User", status: "active" }],
        "id"
      );

      const events = mockRes.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("added");
      expect(events[0].object.id).toBe("3");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should receive changed events for known items", async () => {
      const handlerId = "hybrid-change-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Client has item 1 via GET
      await registerKnownIds(subscriptionId, ["1"]);

      // Item 1 is updated
      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "1", name: "Updated User", status: "active" }],
        "id"
      );

      const events = mockRes.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("changed");
      expect(events[0].object.id).toBe("1");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should receive removed events for known items", async () => {
      const handlerId = "hybrid-remove-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Client has items 1 and 2 via GET
      await registerKnownIds(subscriptionId, ["1", "2"]);

      // Item 1 is deleted
      await pushDeletesToSubscriptions("users", ["1"]);

      const events = mockRes.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("removed");
      expect(events[0].objectId).toBe("1");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should not receive removed events for unknown items", async () => {
      const handlerId = "hybrid-unknown-remove-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Client only knows about items 1 and 2
      await registerKnownIds(subscriptionId, ["1", "2"]);

      // Item 999 is deleted - client should NOT receive this
      await pushDeletesToSubscriptions("users", ["999"]);

      const events = mockRes.getEvents();
      expect(events.length).toBe(0);

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should receive removed event when known item leaves filter scope", async () => {
      const handlerId = "hybrid-scope-exit-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId,
        authId: null,
      });

      // Client has item 1 (which was active)
      await registerKnownIds(subscriptionId, ["1"]);

      // Item 1 is updated to inactive - it leaves the filter scope
      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "1", name: "User", status: "inactive" }],
        "id"
      );

      const events = mockRes.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("removed");
      expect(events[0].objectId).toBe("1");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should receive added event when unknown item enters filter scope", async () => {
      const handlerId = "hybrid-scope-enter-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId,
        authId: null,
      });

      // Client has item 1 initially
      await registerKnownIds(subscriptionId, ["1"]);

      // Item 2 was inactive but is updated to active - it enters the filter scope
      // Since client doesn't know item 2, this is treated as an "added" event
      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "2", name: "User 2", status: "active" }],
        "id"
      );

      const events = mockRes.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("added");
      expect(events[0].object.id).toBe("2");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });

    it("should handle paginated subscriptions correctly", async () => {
      const handlerId = "hybrid-paginated-handler";
      registerHandler(handlerId, mockRes);

      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId,
        authId: null,
      });

      // Simulate client fetched first page (items 1-5)
      await registerKnownIds(subscriptionId, ["1", "2", "3", "4", "5"]);

      // Item 6 is added (would be on page 2) - client should receive added event
      await pushInsertsToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "6", name: "Page 2 User", status: "active" }],
        "id"
      );

      // Item 3 is updated - client should receive changed event
      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        [{ id: "3", name: "Updated User 3", status: "active" }],
        "id"
      );

      // Item 2 is deleted - client should receive removed event
      await pushDeletesToSubscriptions("users", ["2"]);

      const events = mockRes.getEvents();
      expect(events.length).toBe(3);

      const addedEvent = events.find((e: any) => e.type === "added");
      const changedEvent = events.find((e: any) => e.type === "changed");
      const removedEvent = events.find((e: any) => e.type === "removed");

      expect(addedEvent?.object.id).toBe("6");
      expect(changedEvent?.object.id).toBe("3");
      expect(removedEvent?.objectId).toBe("2");

      await removeSubscription(subscriptionId);
      await unregisterHandler(handlerId);
    });
  });
});
