import { describe, it, expect, afterEach, vi } from "vitest";
import { CovaraKVDurableObject } from "@/kv/durable-object";

describe("Durable Object upgrade response", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("carries the socket when the global Response accepts status 101 but drops webSocket", async () => {
    const socket = () => ({ send() {}, close() {}, accept() {}, addEventListener() {}, serializeAttachment() {} });
    const client = socket();
    vi.stubGlobal("WebSocketPair", function () {
      return { 0: client, 1: socket() };
    });
    vi.stubGlobal(
      "Response",
      class {
        status: number;
        constructor(_body: unknown, init?: { status?: number }) {
          this.status = init?.status ?? 200;
        }
      }
    );
    const state = { storage: {}, acceptWebSocket() {}, getWebSockets: () => [] };
    const object = new CovaraKVDurableObject(state as any, {} as any);
    const response = await object.fetch(
      new Request("https://covara-kv/subscribe?channels=a", { headers: { Upgrade: "websocket" } })
    );
    expect((response as any).webSocket).toBe(client);
  });
});
