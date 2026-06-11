import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createSSEStream, type SSEWriter } from "@/server/sse";
import { createResourceFilter } from "@/resource/filter";
import {
  registerHandler,
  unregisterHandler,
  createSubscription,
  pushInsertsToSubscriptions,
  clearAllSubscriptions,
  type BackpressurePolicy,
} from "@/resource/subscription";

const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

describe("SSE writer backpressure signal", () => {
  it("reports backpressured once the buffer is full", () => {
    const { writer } = createSSEStream({ maxQueueBytes: 64 });
    expect(writer.backpressured).toBe(false);
    // Write well past the 64-byte high-water mark without anything consuming.
    writer.write("x".repeat(256));
    expect(writer.backpressured).toBe(true);
  });

  it("is not backpressured after close", () => {
    const { writer } = createSSEStream({ maxQueueBytes: 64 });
    writer.write("x".repeat(256));
    writer.close();
    expect(writer.backpressured).toBe(false);
  });
});

// A writer stub that lets the test drive the backpressure signal and observe
// whether the subscription layer closed it / what it wrote.
const makeStubWriter = (overrides: Partial<SSEWriter> = {}): SSEWriter & {
  writes: string[];
  closedFlag: boolean;
} => {
  const state = { writes: [] as string[], closedFlag: false };
  return {
    writes: state.writes,
    get closedFlag() {
      return state.closedFlag;
    },
    write(chunk: string) {
      state.writes.push(chunk);
      return true;
    },
    close() {
      state.closedFlag = true;
    },
    get closed() {
      return state.closedFlag;
    },
    bufferedBytes: 0,
    backpressured: true,
    onClose() {},
    ...overrides,
  } as SSEWriter & { writes: string[]; closedFlag: boolean };
};

describe("Subscription backpressure policy", () => {
  const filter = createResourceFilter(todos, {});

  beforeEach(async () => {
    await clearAllSubscriptions();
  });

  afterEach(async () => {
    await clearAllSubscriptions();
  });

  const setup = async (policy: BackpressurePolicy) => {
    const handlerId = `h-${policy}`;
    const writer = makeStubWriter();
    registerHandler(handlerId, writer, policy);
    await createSubscription({
      resource: "todos",
      filter: "",
      handlerId,
      authId: null,
    });
    return { handlerId, writer };
  };

  it("invalidate policy: closes the connection and sends an invalidate frame", async () => {
    const { handlerId, writer } = await setup("invalidate");

    await pushInsertsToSubscriptions("todos", filter, [{ id: "1", title: "a" }], "id");

    expect(writer.closedFlag).toBe(true);
    expect(writer.writes.some((w) => w.includes("invalidate"))).toBe(true);
    await unregisterHandler(handlerId);
  });

  it("disconnect policy: closes the connection without an invalidate frame", async () => {
    const { handlerId, writer } = await setup("disconnect");

    await pushInsertsToSubscriptions("todos", filter, [{ id: "1", title: "a" }], "id");

    expect(writer.closedFlag).toBe(true);
    expect(writer.writes.some((w) => w.includes("invalidate"))).toBe(false);
    await unregisterHandler(handlerId);
  });

  it("drop policy: keeps the connection open and does not write the event", async () => {
    const { handlerId, writer } = await setup("drop");

    await pushInsertsToSubscriptions("todos", filter, [{ id: "1", title: "a" }], "id");

    expect(writer.closedFlag).toBe(false);
    expect(writer.writes).toHaveLength(0);
    await unregisterHandler(handlerId);
  });
});
