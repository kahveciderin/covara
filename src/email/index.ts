import { EmailAdapter, EmailMessage, SendEmailOptions, SendEmailResult } from "./types";

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
export const sendEmail = (
  message: EmailMessage,
  options?: SendEmailOptions
): Promise<SendEmailResult> => getGlobalEmail().send(message, options);

export const sendEmailBatch = async (
  messages: EmailMessage[],
  options?: SendEmailOptions
): Promise<SendEmailResult[]> => {
  const adapter = getGlobalEmail();
  if (adapter.sendBatch) return adapter.sendBatch(messages, options);
  return Promise.all(
    messages.map((m, index) =>
      adapter.send(
        m,
        options?.idempotencyKey ? { idempotencyKey: `${options.idempotencyKey}:${index}` } : undefined
      )
    )
  );
};

export * from "./types";
export * from "./builder";
export * from "./resend";
export * from "./cloudflare";
export * from "./errors";
export * from "./durable";
