import {
  EmailAdapter,
  EmailAttachment,
  EmailMessage,
  SendEmailResult,
  formatAddress,
  normalizeRecipients,
} from "./types";

// Structural type for the Cloudflare Email Service send binding
// (https://developers.cloudflare.com/email-service/). The service is in beta and
// its binding sends one envelope recipient per call with the full message as a
// MIME `raw` string. We model it structurally (zero @cloudflare/workers-types
// imports) so the adapter stays Node-testable; confirm the exact binding shape
// against your Workers runtime before relying on it in production.
export interface CloudflareEmailMessage {
  from: string;
  to: string;
  raw: string;
}

export interface CloudflareEmailBinding {
  send(message: CloudflareEmailMessage): Promise<unknown>;
}

export interface CloudflareEmailAdapterConfig {
  binding: CloudflareEmailBinding;
  from?: string | EmailMessage["from"];
}

const CRLF = "\r\n";

const base64 = (content: string | Uint8Array): string => {
  if (typeof content === "string") {
    if (typeof btoa === "function") {
      let binary = "";
      for (let i = 0; i < content.length; i++) {
        binary += String.fromCharCode(content.charCodeAt(i) & 0xff);
      }
      return btoa(binary);
    }
    return Buffer.from(content, "utf-8").toString("base64");
  }
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < content.length; i++) {
      binary += String.fromCharCode(content[i]);
    }
    return btoa(binary);
  }
  return Buffer.from(content).toString("base64");
};

const chunk76 = (value: string): string => {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 76) {
    parts.push(value.slice(i, i + 76));
  }
  return parts.join(CRLF);
};

const boundary = (label: string): string =>
  `----=_covara_${label}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const attachmentPart = (
  attachment: EmailAttachment,
  bound: string
): string => {
  const contentType = attachment.contentType ?? "application/octet-stream";
  return [
    `--${bound}`,
    `Content-Type: ${contentType}; name="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "",
    chunk76(base64(attachment.content)),
  ].join(CRLF);
};

const alternativeBody = (message: EmailMessage): string => {
  const altBound = boundary("alt");
  const parts: string[] = [];

  if (message.text !== undefined) {
    parts.push(
      [
        `--${altBound}`,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        message.text,
      ].join(CRLF)
    );
  }

  if (message.html !== undefined) {
    parts.push(
      [
        `--${altBound}`,
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        message.html,
      ].join(CRLF)
    );
  }

  parts.push(`--${altBound}--`);

  return [
    `Content-Type: multipart/alternative; boundary="${altBound}"`,
    "",
    parts.join(CRLF + CRLF),
  ].join(CRLF);
};

export const buildMimeMessage = (message: EmailMessage): string => {
  const headers: string[] = [];
  headers.push(`From: ${formatAddress(message.from)}`);
  headers.push(`To: ${normalizeRecipients(message.to).map(formatAddress).join(", ")}`);

  const cc = normalizeRecipients(message.cc);
  if (cc.length > 0) headers.push(`Cc: ${cc.map(formatAddress).join(", ")}`);

  if (message.replyTo !== undefined) {
    headers.push(`Reply-To: ${formatAddress(message.replyTo)}`);
  }

  headers.push(`Subject: ${message.subject}`);
  headers.push("MIME-Version: 1.0");

  if (message.headers) {
    for (const [name, value] of Object.entries(message.headers)) {
      headers.push(`${name}: ${value}`);
    }
  }

  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const body = alternativeBody(message);

  if (!hasAttachments) {
    return [headers.join(CRLF), "", body].join(CRLF);
  }

  const mixedBound = boundary("mixed");
  const attachmentParts = (message.attachments ?? []).map((a) =>
    attachmentPart(a, mixedBound)
  );

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBound}"`);

  const segments = [
    `--${mixedBound}`,
    body,
    ...attachmentParts,
    `--${mixedBound}--`,
  ];

  return [headers.join(CRLF), "", segments.join(CRLF)].join(CRLF);
};

export class CloudflareEmailAdapter implements EmailAdapter {
  readonly provider = "cloudflare-email";
  private binding: CloudflareEmailBinding;
  private defaultFrom?: string | EmailMessage["from"];

  constructor(config: CloudflareEmailAdapterConfig) {
    this.binding = config.binding;
    this.defaultFrom = config.from;
  }

  private resolve(message: EmailMessage): EmailMessage {
    if (message.from !== undefined && message.from !== "") return message;
    if (this.defaultFrom === undefined) {
      throw new Error("cloudflare-email: no 'from' address provided");
    }
    return { ...message, from: this.defaultFrom };
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    const resolved = this.resolve(message);
    // The CF binding delivers to one envelope recipient per call; the MIME `raw`
    // carries the To/Cc headers. Send one envelope per to+cc+bcc recipient so
    // every addressee (including bcc, which is intentionally absent from the
    // headers) actually receives the message.
    const envelopes = [
      ...normalizeRecipients(resolved.to),
      ...normalizeRecipients(resolved.cc),
      ...normalizeRecipients(resolved.bcc),
    ];
    if (envelopes.length === 0) {
      throw new Error("cloudflare-email: at least one recipient is required");
    }

    const from = formatAddress(resolved.from);
    const raw = buildMimeMessage(resolved);

    try {
      for (const recipient of envelopes) {
        await this.binding.send({ from, to: recipient.email, raw });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`cloudflare-email: send failed: ${detail}`);
    }

    return { provider: this.provider };
  }
}

export const createCloudflareEmailAdapter = (
  config: CloudflareEmailAdapterConfig
): EmailAdapter => new CloudflareEmailAdapter(config);
