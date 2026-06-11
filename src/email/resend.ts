import {
  EmailAdapter,
  EmailAttachment,
  EmailMessage,
  SendEmailResult,
  formatAddress,
  normalizeRecipients,
} from "./types";

export interface ResendAdapterConfig {
  apiKey: string;
}

interface ResendAttachment {
  filename: string;
  content: string;
}

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  attachments?: ResendAttachment[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

const RESEND_SEND_URL = "https://api.resend.com/emails";
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";

const toBase64 = (content: string | Uint8Array): string => {
  if (typeof content === "string") return content;
  let binary = "";
  for (let i = 0; i < content.length; i++) {
    binary += String.fromCharCode(content[i]);
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(content).toString("base64");
};

const mapAttachments = (
  attachments: EmailAttachment[] | undefined
): ResendAttachment[] | undefined => {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: toBase64(a.content),
  }));
};

const mapTags = (
  tags: Record<string, string> | undefined
): { name: string; value: string }[] | undefined => {
  if (!tags) return undefined;
  const entries = Object.entries(tags);
  if (entries.length === 0) return undefined;
  return entries.map(([name, value]) => ({ name, value }));
};

const mapRecipients = (
  recipients: EmailMessage["to"] | undefined
): string[] | undefined => {
  const list = normalizeRecipients(recipients);
  if (list.length === 0) return undefined;
  return list.map(formatAddress);
};

const toPayload = (message: EmailMessage): ResendPayload => {
  const payload: ResendPayload = {
    from: formatAddress(message.from),
    to: mapRecipients(message.to) ?? [],
    subject: message.subject,
  };

  if (message.html !== undefined) payload.html = message.html;
  if (message.text !== undefined) payload.text = message.text;

  const cc = mapRecipients(message.cc);
  if (cc) payload.cc = cc;

  const bcc = mapRecipients(message.bcc);
  if (bcc) payload.bcc = bcc;

  if (message.replyTo !== undefined) payload.reply_to = formatAddress(message.replyTo);

  const attachments = mapAttachments(message.attachments);
  if (attachments) payload.attachments = attachments;

  if (message.headers) payload.headers = message.headers;

  const tags = mapTags(message.tags);
  if (tags) payload.tags = tags;

  return payload;
};

export class ResendAdapter implements EmailAdapter {
  readonly provider = "resend";
  private apiKey: string;

  constructor(config: ResendAdapterConfig) {
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async fail(response: Response): Promise<never> {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new Error(
      `resend: send failed with status ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  async send(message: EmailMessage): Promise<SendEmailResult> {
    const response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toPayload(message)),
    });

    if (!response.ok) return this.fail(response);

    const data = (await response.json()) as { id?: string };
    return { id: data.id, provider: this.provider };
  }

  async sendBatch(messages: EmailMessage[]): Promise<SendEmailResult[]> {
    const response = await fetch(RESEND_BATCH_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(messages.map(toPayload)),
    });

    if (!response.ok) return this.fail(response);

    const data = (await response.json()) as { data?: { id?: string }[] };
    const results = data.data ?? [];
    return messages.map((_, index) => ({
      id: results[index]?.id,
      provider: this.provider,
    }));
  }
}

export const createResendAdapter = (config: ResendAdapterConfig): EmailAdapter =>
  new ResendAdapter(config);
