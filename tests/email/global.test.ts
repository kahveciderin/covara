import { describe, it, expect, afterEach, vi } from "vitest";
import { clearGlobalEmail, sendEmail, sendEmailBatch, setGlobalEmail } from "@/email";
import type { EmailAdapter } from "@/email/types";

const msg = { from: "a@b.com", to: "c@d.com", subject: "s", text: "t" };

describe("global email helpers", () => {
  afterEach(() => clearGlobalEmail());

  it("forwards the idempotency key to the adapter", async () => {
    const send = vi.fn().mockResolvedValue({ id: "1", provider: "p" });
    setGlobalEmail({ provider: "p", send });
    await sendEmail(msg, { idempotencyKey: "k" });
    expect(send).toHaveBeenCalledWith(msg, { idempotencyKey: "k" });
  });

  it("derives per-message keys when falling back to individual sends", async () => {
    const send = vi.fn().mockResolvedValue({ id: "1", provider: "p" });
    setGlobalEmail({ provider: "p", send });
    await sendEmailBatch([msg, msg], { idempotencyKey: "b" });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: "b:0" },
      { idempotencyKey: "b:1" },
    ]);
  });

  it("passes the key through to a native batch API", async () => {
    const sendBatch = vi.fn().mockResolvedValue([]);
    const adapter: EmailAdapter = { provider: "p", send: vi.fn(), sendBatch };
    setGlobalEmail(adapter);
    await sendEmailBatch([msg], { idempotencyKey: "b" });
    expect(sendBatch).toHaveBeenCalledWith([msg], { idempotencyKey: "b" });
  });
});
