import { describe, it, expect, vi } from "vitest";
import {
  buildMimeMessage,
  createCloudflareEmailAdapter,
  CloudflareEmailBinding,
  CloudflareEmailMessage,
  CloudflareEmailMessageConstructor,
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

  it("puts the multipart/alternative Content-Type in the header block, not the body", () => {
    const mime = buildMimeMessage({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    // Everything before the first blank line is the header block; anything after
    // is the body. The multipart Content-Type MUST be a header, or the message
    // ships with no Content-Type and no parseable boundary.
    const headerBlock = mime.split("\r\n\r\n")[0];
    expect(headerBlock).toContain('Content-Type: multipart/alternative; boundary="');
    expect(headerBlock).toContain("MIME-Version: 1.0");
    // The body starts with the alternative boundary, not a stray Content-Type.
    const body = mime.slice(headerBlock.length + 4);
    expect(body.startsWith("--")).toBe(true);
    expect(body).not.toContain("multipart/alternative");
  });

  it("puts the multipart/mixed Content-Type in the header block (with attachments)", () => {
    const mime = buildMimeMessage({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      text: "body",
      html: "<p>body</p>",
      attachments: [
        { filename: "hi.txt", content: new Uint8Array([72, 105]), contentType: "text/plain" },
      ],
    });

    const headerBlock = mime.split("\r\n\r\n")[0];
    expect(headerBlock).toContain('Content-Type: multipart/mixed; boundary="');
    // The alternative part still carries its own Content-Type inside the mixed body.
    const body = mime.slice(headerBlock.length + 4);
    expect(body).toContain('Content-Type: multipart/alternative; boundary="');
    expect(body).toContain('Content-Type: text/html; charset="utf-8"');
  });

  it("includes RFC-5322 Date and Message-ID headers", () => {
    const mime = buildMimeMessage({
      from: "sender@example.com",
      to: "c@d.com",
      subject: "s",
      text: "hi",
      html: "<p>hi</p>",
    });

    const headerBlock = mime.split("\r\n\r\n")[0];
    // Both are RFC 5322 §3.6 mandatory; production Cloudflare send_email rejects
    // a message without them.
    expect(headerBlock).toMatch(
      /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m
    );
    expect(headerBlock).toMatch(/^Message-ID: <.+@example\.com>$/m);
  });

  it("does not duplicate a caller-supplied Date or Message-ID", () => {
    const mime = buildMimeMessage({
      from: "s@example.com",
      to: "c@d.com",
      subject: "s",
      text: "hi",
      headers: {
        Date: "Mon, 01 Jan 2024 00:00:00 +0000",
        "Message-ID": "<custom@id>",
      },
    });

    const headerBlock = mime.split("\r\n\r\n")[0];
    expect(headerBlock.match(/^Date:/gim) ?? []).toHaveLength(1);
    expect(headerBlock.match(/^Message-ID:/gim) ?? []).toHaveLength(1);
    expect(headerBlock).toContain("Date: Mon, 01 Jan 2024 00:00:00 +0000");
    expect(headerBlock).toContain("Message-ID: <custom@id>");
  });

  it("normalizes bare-LF body content to CRLF", () => {
    const mime = buildMimeMessage({
      from: "s@example.com",
      to: "c@d.com",
      subject: "s",
      text: "line1\nline2\nline3",
      html: "<p>a</p>\n<p>b</p>",
    });

    const body = mime.slice(mime.indexOf("\r\n\r\n") + 4);
    // No bare LF anywhere in the body (every \n is preceded by \r).
    expect(/[^\r]\n/.test(body)).toBe(false);
    expect(body).toContain("line1\r\nline2\r\nline3");
    expect(body).toContain("<p>a</p>\r\n<p>b</p>");
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

  it("sends a real EmailMessage instance built from messageClass (not a plain object)", async () => {
    // Production workerd needs a cloudflare:email EmailMessage instance; a plain
    // { from, to, raw } object fails with the misleading "text or html must have
    // content". The adapter must construct via the provided class.
    class FakeEmailMessage {
      constructor(
        public readonly from: string,
        public readonly to: string,
        public readonly raw: string
      ) {}
    }
    const sent: unknown[] = [];
    const binding: CloudflareEmailBinding = {
      send: async (m) => {
        sent.push(m);
      },
    };
    const adapter = createCloudflareEmailAdapter({
      binding,
      messageClass: FakeEmailMessage as unknown as CloudflareEmailMessageConstructor,
    });

    await adapter.send({
      from: "a@b.com",
      to: ["x@y.com", "z@y.com"],
      subject: "s",
      text: "t",
      html: "<p>t</p>",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeInstanceOf(FakeEmailMessage);
    expect(sent[1]).toBeInstanceOf(FakeEmailMessage);
    const first = sent[0] as FakeEmailMessage;
    expect(first.from).toBe("a@b.com");
    expect(first.to).toBe("x@y.com");
    expect(first.raw).toContain("Subject: s");
    expect(first.raw).toContain("Message-ID:");
    expect((sent[1] as FakeEmailMessage).to).toBe("z@y.com");
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
