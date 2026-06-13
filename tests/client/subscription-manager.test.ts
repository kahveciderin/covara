import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubscriptionManager, createSubscription } from "../../src/client/subscription-manager";
import { Transport } from "../../src/client/transport";

interface TestItem {
  id: string;
  name: string;
  status: string;
}

describe("SubscriptionManager", () => {
  let mockTransport: Transport;
  let mockEventSource: {
    addEventListener: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onerror: ((e: Event) => void) | null;
  };
  let eventListeners: Map<string, (e: MessageEvent) => void>;

  beforeEach(() => {
    eventListeners = new Map();

    mockEventSource = {
      addEventListener: vi.fn((event: string, handler: (e: MessageEvent) => void) => {
        eventListeners.set(event, handler);
      }),
      close: vi.fn(),
      onerror: null,
    };

    mockTransport = {
      request: vi.fn(),
      createEventSource: vi.fn(() => mockEventSource as unknown as EventSource),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  function triggerEvent(type: string, data: object) {
    const handler = eventListeners.get(type);
    if (handler) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  describe("initialization", () => {
    it("should create subscription and connect", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      expect(mockTransport.createEventSource).toHaveBeenCalledWith(
        "/items/subscribe",
        {}
      );
      expect(subscription.state.isConnected).toBe(false);
      expect(subscription.items).toEqual([]);
    });

    it("should connect with filter", () => {
      new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        options: { filter: 'status=="active"' },
      });

      expect(mockTransport.createEventSource).toHaveBeenCalledWith(
        "/items/subscribe",
        { filter: 'status=="active"' }
      );
    });

    it("should connect with resumeFrom", () => {
      new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        options: { resumeFrom: 100 },
      });

      expect(mockTransport.createEventSource).toHaveBeenCalledWith(
        "/items/subscribe",
        { resumeFrom: "100" }
      );
    });
  });

  describe("connected event", () => {
    it("should handle connected event", () => {
      const onConnected = vi.fn();
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        callbacks: { onConnected },
      });

      triggerEvent("connected", { seq: 50 });

      expect(subscription.state.isConnected).toBe(true);
      expect(subscription.state.lastSeq).toBe(50);
      expect(subscription.state.error).toBeNull();
      expect(onConnected).toHaveBeenCalledWith(50);
    });

    it("should reset reconnect attempts on connect", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      (subscription as any).reconnectAttempts = 5;
      triggerEvent("connected", { seq: 0 });

      expect((subscription as any).reconnectAttempts).toBe(0);
    });
  });

  describe("event handling", () => {
    let subscription: SubscriptionManager<TestItem>;
    let callbacks: {
      onAdded: ReturnType<typeof vi.fn>;
      onChanged: ReturnType<typeof vi.fn>;
      onRemoved: ReturnType<typeof vi.fn>;
      onInvalidate: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      callbacks = {
        onAdded: vi.fn(),
        onChanged: vi.fn(),
        onRemoved: vi.fn(),
        onInvalidate: vi.fn(),
      };

      subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        callbacks,
      });
    });

    it("should handle existing event", () => {
      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "Item 1", status: "active" },
      });

      expect(subscription.items).toHaveLength(1);
      expect(subscription.items[0].name).toBe("Item 1");
      expect(callbacks.onAdded).not.toHaveBeenCalled();
    });

    it("should handle added event", () => {
      triggerEvent("message", {
        type: "added",
        seq: 1,
        object: { id: "1", name: "New Item", status: "active" },
      });

      expect(subscription.items).toHaveLength(1);
      expect(subscription.items[0].name).toBe("New Item");
      expect(callbacks.onAdded).toHaveBeenCalledWith(
        { id: "1", name: "New Item", status: "active" },
        undefined
      );
    });

    it("should handle added event with meta.optimisticId", () => {
      triggerEvent("message", {
        type: "added",
        seq: 1,
        object: { id: "server-1", name: "New Item", status: "active" },
        meta: { optimisticId: "optimistic-123" },
      });

      expect(subscription.items).toHaveLength(1);
      expect(callbacks.onAdded).toHaveBeenCalledWith(
        { id: "server-1", name: "New Item", status: "active" },
        { optimisticId: "optimistic-123" }
      );
    });

    it("should handle changed event", () => {
      // add item first
      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "Original", status: "active" },
      });

      triggerEvent("message", {
        type: "changed",
        seq: 2,
        object: { id: "1", name: "Updated", status: "active" },
        previousObjectId: undefined,
      });

      expect(subscription.items).toHaveLength(1);
      expect(subscription.items[0].name).toBe("Updated");
      expect(callbacks.onChanged).toHaveBeenCalledWith(
        { id: "1", name: "Updated", status: "active" },
        undefined
      );
    });

    it("should handle changed event with previousObjectId", () => {
      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "old-id", name: "Item", status: "active" },
      });

      triggerEvent("message", {
        type: "changed",
        seq: 2,
        object: { id: "new-id", name: "Item", status: "active" },
        previousObjectId: "old-id",
      });

      expect(callbacks.onChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: "new-id" }),
        "old-id"
      );
    });

    it("should handle removed event", () => {
      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "Item", status: "active" },
      });

      expect(subscription.items).toHaveLength(1);

      triggerEvent("message", {
        type: "removed",
        seq: 2,
        objectId: "1",
      });

      expect(subscription.items).toHaveLength(0);
      expect(callbacks.onRemoved).toHaveBeenCalledWith("1");
    });

    it("should handle invalidate event", () => {
      vi.useFakeTimers();

      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "Item", status: "active" },
      });

      triggerEvent("message", {
        type: "invalidate",
        seq: 100,
        reason: "Server restart",
      });

      expect(subscription.items).toHaveLength(0);
      expect(subscription.state.lastSeq).toBe(0);
      expect(callbacks.onInvalidate).toHaveBeenCalledWith("Server restart");

      vi.useRealTimers();
    });

    it("should update lastSeq on events", () => {
      triggerEvent("message", { type: "existing", seq: 10, object: { id: "1", name: "a", status: "x" } });
      expect(subscription.state.lastSeq).toBe(10);

      triggerEvent("message", { type: "added", seq: 15, object: { id: "2", name: "b", status: "y" } });
      expect(subscription.state.lastSeq).toBe(15);

      // seq going backward should not update
      triggerEvent("message", { type: "changed", seq: 12, object: { id: "1", name: "c", status: "z" } });
      expect(subscription.state.lastSeq).toBe(15);
    });

    it("should handle parse errors gracefully", () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const handler = eventListeners.get("message");
      if (handler) {
        handler({ data: "invalid json" } as MessageEvent);
      }

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });

  describe("error handling and reconnection", () => {
    it("should handle disconnection", () => {
      const onDisconnected = vi.fn();
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        callbacks: { onDisconnected },
      });

      triggerEvent("connected", { seq: 0 });
      expect(subscription.state.isConnected).toBe(true);

      // trigger error
      mockEventSource.onerror?.(new Event("error"));

      expect(subscription.state.isConnected).toBe(false);
      expect(onDisconnected).toHaveBeenCalled();
    });

    it("should schedule reconnect on error", () => {
      vi.useFakeTimers();

      new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        rng: () => 1,
      });

      // clear initial call
      vi.clearAllMocks();

      // trigger error
      mockEventSource.onerror?.(new Event("error"));

      // should not reconnect immediately
      expect(mockTransport.createEventSource).not.toHaveBeenCalled();

      // advance time
      vi.advanceTimersByTime(1000);

      expect(mockTransport.createEventSource).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should use exponential backoff for reconnection", () => {
      vi.useFakeTimers();

      new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        rng: () => 1,
      });

      vi.clearAllMocks();

      // first error
      mockEventSource.onerror?.(new Event("error"));
      vi.advanceTimersByTime(1000);
      expect(mockTransport.createEventSource).toHaveBeenCalledTimes(1);

      // reset mock and setup new event source
      vi.clearAllMocks();
      mockEventSource.onerror?.(new Event("error"));

      // second reconnect should take longer (2000ms)
      vi.advanceTimersByTime(1000);
      expect(mockTransport.createEventSource).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(mockTransport.createEventSource).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should cap backoff at 30 seconds", () => {
      vi.useFakeTimers();

      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        rng: () => 1,
      });

      // set high reconnect attempts (but below max to allow scheduling)
      (subscription as any).reconnectAttempts = 8;

      vi.clearAllMocks();
      mockEventSource.onerror?.(new Event("error"));

      // backoff formula: min(1000 * 2^8, 30000) = min(256000, 30000) = 30000
      // should reconnect after 30 seconds max
      vi.advanceTimersByTime(30000);
      expect(mockTransport.createEventSource).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should stop reconnecting after max attempts", () => {
      vi.useFakeTimers();

      const onError = vi.fn();
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        callbacks: { onError },
      });

      (subscription as any).reconnectAttempts = 10;
      (subscription as any).maxReconnectAttempts = 10;

      vi.clearAllMocks();
      mockEventSource.onerror?.(new Event("error"));

      vi.advanceTimersByTime(60000);
      expect(mockTransport.createEventSource).not.toHaveBeenCalled();
      expect(subscription.state.error).not.toBeNull();
      expect(onError).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should not reconnect after unsubscribe", () => {
      vi.useFakeTimers();

      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      vi.clearAllMocks();
      subscription.unsubscribe();
      mockEventSource.onerror?.(new Event("error"));

      vi.advanceTimersByTime(5000);
      expect(mockTransport.createEventSource).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should close the abandoned EventSource when reconnecting after an error", () => {
      vi.useFakeTimers();

      const created: Array<{
        close: ReturnType<typeof vi.fn>;
        onerror: ((e: Event) => void) | null;
      }> = [];
      const transport: Transport = {
        request: vi.fn(),
        setHeader: vi.fn(),
        removeHeader: vi.fn(),
        createEventSource: vi.fn(() => {
          const es = { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
          created.push(es);
          return es as unknown as EventSource;
        }),
      };

      new SubscriptionManager<TestItem>({
        transport,
        resourcePath: "/items",
        idField: "id",
        rng: () => 1,
      });

      expect(created).toHaveLength(1);

      // The connection errors; the manager schedules its own reconnect.
      created[0]!.onerror?.(new Event("error"));
      vi.advanceTimersByTime(1000);

      // A fresh EventSource is created for the reconnect...
      expect(created).toHaveLength(2);
      // ...and the abandoned one MUST be closed, otherwise the browser keeps its
      // own auto-reconnect alive on it, leading to duplicate connections/events.
      expect(created[0]!.close).toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe("reconnect method", () => {
    it("should manually reconnect", () => {
      vi.useFakeTimers();

      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      vi.clearAllMocks();
      subscription.reconnect();

      expect(mockEventSource.close).toHaveBeenCalled();
      expect(mockTransport.createEventSource).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("should reset reconnect attempts on manual reconnect", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      (subscription as any).reconnectAttempts = 5;
      subscription.reconnect();

      expect((subscription as any).reconnectAttempts).toBe(0);
    });
  });

  describe("unsubscribe", () => {
    it("should close event source", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      subscription.unsubscribe();

      expect(mockEventSource.close).toHaveBeenCalled();
    });

    it("should clear reconnect timeout", () => {
      vi.useFakeTimers();

      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      // schedule a reconnect
      mockEventSource.onerror?.(new Event("error"));

      subscription.unsubscribe();

      vi.advanceTimersByTime(5000);
      // should not reconnect after unsubscribe
      expect(mockTransport.createEventSource).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("should clear state", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      triggerEvent("connected", { seq: 0 });
      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "Item", status: "active" },
      });

      expect(subscription.items).toHaveLength(1);

      subscription.unsubscribe();

      expect(subscription.state.isConnected).toBe(false);
      expect(subscription.items).toHaveLength(0);
    });

    it("should set isUnsubscribed flag", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      subscription.unsubscribe();

      expect((subscription as any).isUnsubscribed).toBe(true);
    });
  });

  describe("state getter", () => {
    it("should return current state", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
        options: { resumeFrom: 50 },
      });

      const state = subscription.state;

      expect(state.isConnected).toBe(false);
      expect(state.lastSeq).toBe(50);
      expect(state.items).toBeInstanceOf(Map);
      expect(state.error).toBeNull();
    });
  });

  describe("items getter", () => {
    it("should return array of items", () => {
      const subscription = new SubscriptionManager<TestItem>({
        transport: mockTransport,
        resourcePath: "/items",
        idField: "id",
      });

      triggerEvent("message", {
        type: "existing",
        seq: 1,
        object: { id: "1", name: "First", status: "active" },
      });
      triggerEvent("message", {
        type: "existing",
        seq: 2,
        object: { id: "2", name: "Second", status: "inactive" },
      });

      const items = subscription.items;

      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(2);
    });
  });
});

describe("createSubscription", () => {
  it("should create SubscriptionManager instance", () => {
    const mockEventSource = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null,
    };

    const mockTransport = {
      request: vi.fn(),
      createEventSource: vi.fn(() => mockEventSource as unknown as EventSource),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    const subscription = createSubscription<{ id: string }>({
      transport: mockTransport,
      resourcePath: "/items",
      idField: "id",
    });

    expect(subscription).toBeDefined();
    expect(typeof subscription.unsubscribe).toBe("function");
    expect(typeof subscription.reconnect).toBe("function");
    expect(subscription.state).toBeDefined();
    expect(subscription.items).toBeDefined();
  });
});
