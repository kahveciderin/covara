import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { SSEWriter } from "@/server/sse";
import {
  createSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  clearAllSubscriptions,
  type EventRenderer,
} from "@/resource/subscription";
import { changelog } from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

let kv: KVAdapter;

const createMockWriter = () => {
  const chunks: string[] = [];
  const writer = {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    closed: false,
    bufferedBytes: 0,
    backpressured: false,
    close: vi.fn(),
    onClose: vi.fn(),
    getChunks: () => chunks,
  };
  return writer as unknown as SSEWriter & { getChunks: () => string[] };
};

const passthroughFilter = {
  compile: () => ({ execute: () => true }),
  convert: (expr: string) => expr,
  execute: () => true,
  clearCache: () => {},
};

describe("subscription renderer hook", () => {
  beforeAll(async () => {
    kv = createMemoryKV("renderer-test");
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

  it("emits the renderer's output instead of JSON when a renderer is registered", async () => {
    const writer = createMockWriter();
    const renderer: EventRenderer = (event) =>
      `event: ${event.type}\ndata: <li id="row">html</li>\n\n`;

    registerHandler("html-handler", writer, "invalidate", renderer);
    await createSubscription({
      resource: "todos",
      filter: "*",
      handlerId: "html-handler",
      authId: null,
    });

    await pushInsertsToSubscriptions(
      "todos",
      passthroughFilter as never,
      [{ id: "1", title: "a" }],
      "id"
    );

    const chunks = (writer as unknown as { getChunks: () => string[] }).getChunks();
    const joined = chunks.join("");
    expect(joined).toContain(`<li id="row">html</li>`);
    expect(joined).toContain("event: added");
    expect(joined).not.toContain(`"object"`); // not JSON

    await unregisterHandler("html-handler");
  });

  it("preserves the default JSON wire format when no renderer is registered", async () => {
    const writer = createMockWriter();

    registerHandler("json-handler", writer);
    await createSubscription({
      resource: "todos",
      filter: "*",
      handlerId: "json-handler",
      authId: null,
    });

    await pushInsertsToSubscriptions(
      "todos",
      passthroughFilter as never,
      [{ id: "2", title: "b" }],
      "id"
    );

    const chunks = (writer as unknown as { getChunks: () => string[] }).getChunks();
    const dataChunk = chunks.find((c) => c.startsWith("data: "));
    expect(dataChunk).toBeDefined();
    const parsed = JSON.parse(dataChunk!.slice(6).trim());
    expect(parsed.type).toBe("added");
    expect(parsed.object).toMatchObject({ id: "2", title: "b" });

    await unregisterHandler("json-handler");
  });
});
