import { EmailAdapter, EmailMessage, SendEmailResult } from "./types";

let globalEmailAdapter: EmailAdapter | null = null;

export const setGlobalEmail = (adapter: EmailAdapter): void => {
  globalEmailAdapter = adapter;
};

export const getGlobalEmail = (): EmailAdapter => {
  if (!globalEmailAdapter) {
    throw new Error("No global email adapter configured. Call setGlobalEmail() first.");
  }
  return globalEmailAdapter;
};

export const hasGlobalEmail = (): boolean => globalEmailAdapter !== null;

export const clearGlobalEmail = (): void => {
  globalEmailAdapter = null;
};

// Send via the configured global adapter.
export const sendEmail = (message: EmailMessage): Promise<SendEmailResult> =>
  getGlobalEmail().send(message);

export const sendEmailBatch = async (messages: EmailMessage[]): Promise<SendEmailResult[]> => {
  const adapter = getGlobalEmail();
  if (adapter.sendBatch) return adapter.sendBatch(messages);
  return Promise.all(messages.map((m) => adapter.send(m)));
};

export * from "./types";
export * from "./builder";
export * from "./resend";
export * from "./cloudflare";
