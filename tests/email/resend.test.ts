import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createResendAdapter } from "@/email/resend";
import { EmailMessage } from "@/email/types";

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const errResponse = (status: number, body: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  }) as unknown as Response;

describe("Resend Email Adapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends with correct URL, headers, and body mapping", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: "email_123" }));
    const adapter = createResendAdapter({ apiKey: "re_test" });

    const message: EmailMessage = {
      from: { email: "from@example.com", name: "Sender" },
      to: "to@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      cc: ["cc@example.com"],
      bcc: [{ email: "bcc@example.com", name: "BCC" }],
      replyTo: "reply@example.com",
      attachments: [{ filename: "a.txt", content: "SGVsbG8=" }],
      headers: { "X-Custom": "1" },
      tags: { env: "prod" },
    };

    const result = await adapter.send(message);

    expect(result).toEqual({ id: "email_123", provider: "resend" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.from).toBe("Sender <from@example.com>");
    expect(body.to).toEqual(["to@example.com"]);
    expect(body.subject).toBe("Hello");
    expect(body.html).toBe("<p>Hi</p>");
    expect(body.text).toBe("Hi");
    expect(body.cc).toEqual(["cc@example.com"]);
    expect(body.bcc).toEqual(["BCC <bcc@example.com>"]);
    expect(body.reply_to).toBe("reply@example.com");
    expect(body.attachments).toEqual([{ filename: "a.txt", content: "SGVsbG8=" }]);
    expect(body.headers).toEqual({ "X-Custom": "1" });
    expect(body.tags).toEqual([{ name: "env", value: "prod" }]);
  });

  it("base64-encodes binary attachment content", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: "x" }));
    const adapter = createResendAdapter({ apiKey: "re_test" });

    await adapter.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      attachments: [{ filename: "bin", content: new Uint8Array([72, 105]) }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.attachments[0].content).toBe(Buffer.from("Hi").toString("base64"));
  });

  it("omits optional fields when not provided", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ id: "x" }));
    const adapter = createResendAdapter({ apiKey: "re_test" });

    await adapter.send({ from: "a@b.com", to: "c@d.com", subject: "s" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.cc).toBeUndefined();
    expect(body.bcc).toBeUndefined();
    expect(body.reply_to).toBeUndefined();
    expect(body.attachments).toBeUndefined();
    expect(body.tags).toBeUndefined();
  });

  it("throws with status and provider on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(422, "invalid"));
    const adapter = createResendAdapter({ apiKey: "re_test" });

    await expect(
      adapter.send({ from: "a@b.com", to: "c@d.com", subject: "s" })
    ).rejects.toThrow(/resend.*422.*invalid/);
  });

  it("sends a batch to the batch endpoint and returns one result per message", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ data: [{ id: "b1" }, { id: "b2" }] })
    );
    const adapter = createResendAdapter({ apiKey: "re_test" });

    const results = await adapter.sendBatch!([
      { from: "a@b.com", to: "1@x.com", subject: "one" },
      { from: "a@b.com", to: "2@x.com", subject: "two" },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails/batch");
    const body = JSON.parse(init.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].subject).toBe("one");

    expect(results).toEqual([
      { id: "b1", provider: "resend" },
      { id: "b2", provider: "resend" },
    ]);
  });

  it("batch throws on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(500, "boom"));
    const adapter = createResendAdapter({ apiKey: "re_test" });

    await expect(
      adapter.sendBatch!([{ from: "a@b.com", to: "c@d.com", subject: "s" }])
    ).rejects.toThrow(/resend.*500/);
  });
});
