export interface EmailAddress {
  email: string;
  name?: string;
}

export type EmailRecipient = string | EmailAddress | (string | EmailAddress)[];

export interface EmailAttachment {
  filename: string;
  // Base64 string or raw bytes; adapters encode as needed.
  content: string | Uint8Array;
  contentType?: string;
}

export interface EmailMessage {
  from: string | EmailAddress;
  to: EmailRecipient;
  subject: string;
  html?: string;
  text?: string;
  cc?: EmailRecipient;
  bcc?: EmailRecipient;
  replyTo?: string | EmailAddress;
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface SendEmailResult {
  id?: string;
  provider: string;
}

export interface EmailAdapter {
  readonly provider: string;
  send(message: EmailMessage): Promise<SendEmailResult>;
  // Optional batch send; the registry/helpers fall back to N sends when absent.
  sendBatch?(messages: EmailMessage[]): Promise<SendEmailResult[]>;
}

export const normalizeAddress = (addr: string | EmailAddress): EmailAddress =>
  typeof addr === "string" ? { email: addr } : addr;

export const normalizeRecipients = (r: EmailRecipient | undefined): EmailAddress[] => {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.map(normalizeAddress);
};

export const formatAddress = (addr: string | EmailAddress): string => {
  const a = normalizeAddress(addr);
  return a.name ? `${a.name} <${a.email}>` : a.email;
};
