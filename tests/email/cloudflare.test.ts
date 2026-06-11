import { describe, it, expect, vi } from "vitest";
import {
  buildMimeMessage,
  createCloudflareEmailAdapter,
  CloudflareEmailBinding,
  CloudflareEmailMessage,
} from "@/email/cloudflare";
import { EmailMessage } from "@/email/types";

const createFakeBinding = (): {
  binding: CloudflareEmailBinding;
  sent: CloudflareEmailMessage[];
} => {
  const sent: CloudflareEmailMessage[] = [];
  return {
    sent,
    binding: {
      send: async (message: CloudflareEmailMessage) => {
        sent.push(message);
      },
    },
  };
};

describe("buildMimeMessage", () => {
  it("produces multipart/alternative MIME with html and text parts and headers", () => {
    const message: EmailMessage = {
      from: { email: "from@example.com", name: "Sender" },
      to: "to@example.com",
      subject: "Subject Line",
      html: "<p>Hello</p>",
      text: "Hello",
    };

    const mime = buildMimeMessage(message);

    expect(mime).toContain("From: Sender <from@example.com>");
    expect(mime).toContain("To: to@example.com");
    expect(mime).toContain("Subject: Subject Line");
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(mime).toContain('Content-Type: text/html; charset="utf-8"');
    expect(mime).toContain("Hello");
    expect(mime).toContain("<p>Hello</p>");
    expect(mime).toContain("\r\n");
  });

  it("includes cc and reply-to and custom headers", () => {
    const mime = buildMimeMessage({
      from: "a@b.com",
      to: ["t1@x.com", "t2@x.com"],
      cc: "cc@x.com",
      replyTo: "reply@x.com",
      subject: "s",
      text: "body",
      headers: { "X-Test": "v" },
    });

    expect(mime).toContain("To: t1@x.com, t2@x.com");
    expect(mime).toContain("Cc: cc@x.com");
    expect(mime).toContain("Reply-To: reply@x.com");
    expect(mime).toContain("X-Test: v");
  });

  it("wraps attachments in multipart/mixed with base64 content", () => {
    const mime = buildMimeMessage({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      text: "body",
      attachments: [
        { filename: "hi.txt", content: new Uint8Array([72, 105]), contentType: "text/plain" },
      ],
    });

    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain('Content-Disposition: attachment; filename="hi.txt"');
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain(Buffer.from("Hi").toString("base64"));
  });
});

describe("Cloudflare Email Adapter", () => {
  it("calls the binding with from, first recipient, and raw MIME", async () => {
    const { binding, sent } = createFakeBinding();
    const adapter = createCloudflareEmailAdapter({ binding });

    const result = await adapter.send({
      from: "from@example.com",
      to: "to@example.com",
      subject: "Hi",
      html: "<p>x</p>",
      text: "x",
    });

    expect(result).toEqual({ provider: "cloudflare-email" });
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("from@example.com");
    expect(sent[0].to).toBe("to@example.com");
    expect(sent[0].raw).toContain("Subject: Hi");
    expect(sent[0].raw).toContain("<p>x</p>");
  });

  it("applies the default from when message omits it", async () => {
    const { binding, sent } = createFakeBinding();
    const adapter = createCloudflareEmailAdapter({
      binding,
      from: { email: "default@example.com", name: "Default" },
    });

    await adapter.send({ from: "", to: "to@example.com", subject: "s", text: "b" });

    expect(sent[0].from).toBe("Default <default@example.com>");
    expect(sent[0].raw).toContain("From: Default <default@example.com>");
  });

  it("throws when no from is available", async () => {
    const { binding } = createFakeBinding();
    const adapter = createCloudflareEmailAdapter({ binding });

    await expect(
      adapter.send({ from: "", to: "to@example.com", subject: "s", text: "b" })
    ).rejects.toThrow(/cloudflare-email.*from/);
  });

  it("sends one envelope per to/cc/bcc recipient with the same raw MIME", async () => {
    const { binding, sent } = createFakeBinding();
    const adapter = createCloudflareEmailAdapter({ binding });

    await adapter.send({
      from: "a@b.com",
      to: ["one@example.com", "two@example.com"],
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      subject: "s",
      text: "b",
    });

    expect(sent.map((m) => m.to)).toEqual([
      "one@example.com",
      "two@example.com",
      "cc@example.com",
      "bcc@example.com",
    ]);
    // Same MIME body delivered to every envelope; bcc is NOT in the headers.
    expect(new Set(sent.map((m) => m.raw)).size).toBe(1);
    expect(sent[0].raw).not.toContain("bcc@example.com");
    expect(sent[0].raw).toContain("Cc: cc@example.com");
  });

  it("throws when there are no recipients", async () => {
    const { binding } = createFakeBinding();
    const adapter = createCloudflareEmailAdapter({ binding });

    await expect(
      adapter.send({ from: "a@b.com", to: [], subject: "s", text: "b" })
    ).rejects.toThrow(/cloudflare-email.*recipient/);
  });

  it("propagates binding errors with a clear message", async () => {
    const binding: CloudflareEmailBinding = {
      send: vi.fn().mockRejectedValue(new Error("address not verified")),
    };
    const adapter = createCloudflareEmailAdapter({ binding });

    await expect(
      adapter.send({ from: "a@b.com", to: "c@d.com", subject: "s", text: "b" })
    ).rejects.toThrow(/cloudflare-email: send failed: address not verified/);
  });
});
