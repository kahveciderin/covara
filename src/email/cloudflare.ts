import {
  EmailAdapter,
  EmailAddress,
  EmailAttachment,
  EmailMessage,
  SendEmailResult,
  formatAddress,
  normalizeAddress,
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

// The real binding is `send(message: EmailMessage)` where EmailMessage is the
// class from the `cloudflare:email` built-in — production workerd reads the body
// off that instance and CANNOT read it from a plain `{ from, to, raw }` object
// (that only works under miniflare, which duck-types). So the payload is typed
// `unknown`: an EmailMessage instance in production, the plain object only as a
// last-resort fallback off-Workers.
export interface CloudflareEmailBinding {
  send(message: unknown): Promise<unknown>;
}

// The `cloudflare:email` EmailMessage constructor: `new EmailMessage(from, to, raw)`.
export type CloudflareEmailMessageConstructor = new (
  from: string,
  to: string,
  raw: string
) => unknown;

export interface CloudflareEmailAdapterConfig {
  binding: CloudflareEmailBinding;
  from?: string | EmailMessage["from"];
  // The EmailMessage class from `cloudflare:email`. Passing it explicitly is
  // recommended and avoids the dynamic import:
  //   import { EmailMessage } from "cloudflare:email";
  //   createCloudflareEmailAdapter({ binding: env.EMAIL, messageClass: EmailMessage });
  // If omitted, the adapter loads it dynamically at send time on Workers.
  messageClass?: CloudflareEmailMessageConstructor;
}

// `cloudflare:email` is a Workers-only built-in; a static import breaks Node
// bundling. Load it dynamically (variable specifier so bundlers/tsc don't try to
// resolve it) and cache the result — null off-Workers, where we fall back to the
// plain object (miniflare/tests).
let cfEmailCtor: Promise<CloudflareEmailMessageConstructor | null> | undefined;
const loadCloudflareEmailMessage = (): Promise<CloudflareEmailMessageConstructor | null> => {
  if (!cfEmailCtor) {
    const specifier = "cloudflare:email";
    cfEmailCtor = import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)
      .then((mod) => (mod?.EmailMessage as CloudflareEmailMessageConstructor) ?? null)
      .catch(() => null);
  }
  return cfEmailCtor;
};

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

// RFC 5322 requires CRLF line endings. User-supplied text/html often carries bare
// LF (or lone CR); normalize every line ending to CRLF so a body line can't
// prematurely break the MIME structure. Idempotent.
const normalizeCRLF = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, CRLF);

const RFC5322_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC5322_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const pad2 = (n: number): string => String(n).padStart(2, "0");

// RFC 5322 §3.3 date, e.g. "Wed, 21 Oct 2015 07:28:00 +0000".
const formatRfc5322Date = (date: Date): string =>
  `${RFC5322_DAYS[date.getUTCDay()]}, ${pad2(date.getUTCDate())} ` +
  `${RFC5322_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
  `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`;

// RFC 5322 Message-ID: "<unique@domain>", domain taken from the sender.
const generateMessageId = (from: string | EmailAddress): string => {
  const email = normalizeAddress(from).email;
  const at = email.lastIndexOf("@");
  const domain = at >= 0 && at < email.length - 1 ? email.slice(at + 1) : "localhost";
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const unique =
    cryptoObj?.randomUUID?.() ??
    `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  return `<${unique}@${domain}>`;
};

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

// Build the multipart/alternative body, returning the `Content-Type` header
// separately from the body. The caller must place `contentType` in the header
// block (before the blank line that ends the headers) when this is the top-level
// content, or use it as the part header inside a multipart/mixed wrapper.
const alternativeBody = (
  message: EmailMessage
): { contentType: string; body: string } => {
  const altBound = boundary("alt");
  const parts: string[] = [];

  if (message.text !== undefined) {
    parts.push(
      [
        `--${altBound}`,
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: 7bit",
        "",
        normalizeCRLF(message.text),
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
        normalizeCRLF(message.html),
      ].join(CRLF)
    );
  }

  parts.push(`--${altBound}--`);

  return {
    contentType: `Content-Type: multipart/alternative; boundary="${altBound}"`,
    body: parts.join(CRLF + CRLF),
  };
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

  // Date and Message-ID are mandatory (RFC 5322 §3.6); production Cloudflare
  // send_email rejects a message without them (surfacing a misleading "text or
  // html must have content"). Add both unless the caller supplied their own.
  const customHeaderNames = new Set(
    Object.keys(message.headers ?? {}).map((name) => name.toLowerCase())
  );
  if (!customHeaderNames.has("date")) {
    headers.push(`Date: ${formatRfc5322Date(new Date())}`);
  }
  if (!customHeaderNames.has("message-id")) {
    headers.push(`Message-ID: ${generateMessageId(message.from)}`);
  }

  if (message.headers) {
    for (const [name, value] of Object.entries(message.headers)) {
      headers.push(`${name}: ${value}`);
    }
  }

  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const { contentType, body } = alternativeBody(message);

  if (!hasAttachments) {
    // The multipart/alternative Content-Type must live in the header block
    // (before the blank line), not in the body — otherwise the message goes out
    // with no Content-Type and no parseable boundary.
    headers.push(contentType);
    return [headers.join(CRLF), "", body].join(CRLF);
  }

  const mixedBound = boundary("mixed");
  const attachmentParts = (message.attachments ?? []).map((a) =>
    attachmentPart(a, mixedBound)
  );

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBound}"`);

  // Inside the mixed wrapper, the alternative Content-Type is the part header for
  // this segment (blank line separates it from the alternative parts).
  const segments = [
    `--${mixedBound}`,
    [contentType, "", body].join(CRLF),
    ...attachmentParts,
    `--${mixedBound}--`,
  ];

  return [headers.join(CRLF), "", segments.join(CRLF)].join(CRLF);
};

export class CloudflareEmailAdapter implements EmailAdapter {
  readonly provider = "cloudflare-email";
  private binding: CloudflareEmailBinding;
  private defaultFrom?: string | EmailMessage["from"];
  private messageClass?: CloudflareEmailMessageConstructor;

  constructor(config: CloudflareEmailAdapterConfig) {
    this.binding = config.binding;
    this.defaultFrom = config.from;
    this.messageClass = config.messageClass;
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

    // Production workerd requires a real cloudflare:email EmailMessage instance;
    // a plain { from, to, raw } object is only read correctly by miniflare. Use
    // the configured/loaded constructor when available, falling back to the plain
    // object off-Workers (tests/local) so the adapter stays Node-testable.
    const ctor = this.messageClass ?? (await loadCloudflareEmailMessage());

    try {
      for (const recipient of envelopes) {
        const payload = ctor
          ? new ctor(from, recipient.email, raw)
          : { from, to: recipient.email, raw };
        await this.binding.send(payload);
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
